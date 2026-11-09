// Real VS Code gate for Class Names IntelliSense & CSS Support for HTML Templates.
// node scripts/e2e-vscode.mjs <vsix> <workDir> <wsFolder> <monorepoFolder> [port]
// Installs the vsix into an isolated profile, opens real template files, types in class attributes, reads the
// suggest widget rows from the workbench DOM, checks hover, definition, notifications, status bar, support picker,
// the rating ask (fake clock), extension host sockets, CPU and memory, and saves screenshots.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installVsix, launch, sleep, CLI } from './vsc.mjs';

const [vsix, work, WS, MONO, portArg] = process.argv.slice(2);
const PORT = Number(portArg || 9266);
const SHOTS = path.join(work, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const ok = (name, pass, info = '') => { results.push({ name, pass: !!pass, info: String(info).slice(0, 400) }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? '  | ' + String(info).slice(0, 200) : ''}`); };

const BASE = {
  'editor.fontSize': 15, 'editor.minimap.enabled': false, 'workbench.activityBar.location': 'hidden', 'breadcrumbs.enabled': false,
  'editor.quickSuggestions': { other: true, comments: false, strings: true }, 'editor.suggest.preview': false, 'html.autoClosingTags': false,
  'editor.hover.delay': 200, 'files.hotExit': 'off', 'workbench.editor.enablePreview': false, 'emmet.showExpandedAbbreviation': 'never',
  'html.suggest.html5': false, 'editor.wordBasedSuggestions': 'off', 'css.validate': false,
  'extensions.ignoreRecommendations': true, 'files.autoSave': 'off', 'workbench.editor.closeEmptyGroups': true,
};

function posOf(file, marker, delta = 0) {
  const t = fs.readFileSync(file, 'utf8');
  const i = t.indexOf(marker);
  if (i < 0) throw new Error(`marker not found in ${file}: ${marker}`);
  const o = i + marker.length + delta;
  const before = t.slice(0, o).split('\n');
  return { line: before.length, col: before[before.length - 1].length + 1 };
}

async function activeTitle(vs) { return vs.wbEval(`(document.querySelector('.tabs-container .tab.active') || {}).textContent || ''`); }

async function openAt(vs, file, marker, delta = 0) {
  const { line, col } = posOf(file, marker, delta);
  try { await vs.command('View: Close All Editors'); } catch {}
  await vs.waitFor(async () => !(await activeTitle(vs)), 3000);
  vs.open(file);
  const base = path.basename(file);
  await vs.waitFor(async () => (await activeTitle(vs)).includes(base), 15000);
  await sleep(600);
  // FIN1: wait for the Go to Line box before typing, then check the cursor in the status bar; one retry (busy machine)
  const want = `Ln ${line}, Col ${col}`;
  const cur = () => vs.wbEval(`(() => { const e = [...document.querySelectorAll('.statusbar-item')].find(x => /^Ln \\d+, Col \\d+/.test(x.textContent.trim())); return e ? e.textContent.trim() : ''; })()`);
  for (let k = 0; k < 2; k++) {
    await vs.command('Go to Line/Column');
    await vs.waitFor(() => vs.wbEval(`(() => { const w = document.querySelector('.quick-input-widget'); return !!(w && w.style.display !== 'none' && w.offsetParent !== null); })()`), 4000, 100);
    await vs.type(`${line}:${col}`);
    await sleep(300);
    await vs.key('Enter', 'Enter');
    await sleep(400);
    if (await vs.waitFor(async () => ((await cur()).startsWith(want) ? true : null), 2500, 150)) return;
    await vs.key('Escape', 'Escape');
  }
}

async function suggestRows(vs, wantAny, ms = 8000) {
  return vs.waitFor(async () => {
    const r = await vs.wbEval(`(() => { const w = document.querySelector('.editor-widget.suggest-widget'); if (!w || !w.classList.contains('visible')) return null;
      return [...w.querySelectorAll('.monaco-list-row')].map(r => ({ name: (r.querySelector('.label-name') || r).textContent.trim(), desc: (r.querySelector('.details-label') || r.querySelector('.label-description') || {}).textContent || '' })); })()`);
    if (!r || !r.length) return null;
    if (wantAny && !r.some((x) => wantAny.includes(x.name))) return null;
    return r;
  }, ms, 150);
}

async function trigger(vs) {
  await vs.key(' ', 'Space', 2, 32); // Ctrl+Space: trigger suggest
  await sleep(200);
}

async function check(vs, name, file, marker, typed, expect, opts = {}) {
  try {
    await openAt(vs, file, marker, opts.delta || 0);
    if (typed) { await vs.type(typed); await sleep(400); await vs.key('Escape', 'Escape'); await sleep(150); }
    const t0 = Date.now();
    await trigger(vs);
    let rows = await suggestRows(vs, expect, opts.ms || 8000);
    if (!rows) { await vs.key('Escape', 'Escape'); await sleep(300); await trigger(vs); rows = await suggestRows(vs, expect, 4000); } // FIN1: the suggest list does not refresh by itself when the first request came before the index; ask once more, as a user would
    const ms = Date.now() - t0;
    if (!rows) rows = await suggestRows(vs, null, 500) || [];
    const names = rows.map((r) => r.name);
    const pass = expect.every((x) => names.includes(x));
    if (opts.shot) {
      if (opts.details) { await trigger(vs); await sleep(700); }
      await vs.shot(path.join(SHOTS, opts.shot));
    }
    ok(name, pass, `${ms} ms; rows: ${names.slice(0, 8).join(', ')}${rows[0] ? ' [' + rows[0].desc.trim() + ']' : ''}`);
    if (!pass) { try { await vs.shot(path.join(SHOTS, 'FAIL-' + name.replace(/\W+/g, '_').slice(0, 40) + '.png')); } catch {} } // FIN1
    await vs.key('Escape', 'Escape');
    if (typed) await vs.command('File: Revert File'); // drop the typing
    return { pass, ms, names };
  } catch (e) {
    ok(name, false, e.message);
    return { pass: false };
  }
}

function extHostPid(ud) {
  const r = spawnSync('ps', ['-axo', 'pid=,rss=,%cpu=,command='], { encoding: 'utf8' });
  const line = r.stdout.split('\n').find((l) => l.includes(ud) && /extensionHost|node\.mojom\.NodeService/.test(l) && !/fileWatcher|ptyHost|shared-process/.test(l));
  if (!line) return null;
  const [pid, rss, cpu] = line.trim().split(/\s+/);
  return { pid: Number(pid), rssMb: Number(rss) / 1024, cpu: Number(cpu) };
}

function sockets(pid) {
  const r = spawnSync('lsof', ['-a', '-p', String(pid), '-i', '-n', '-P'], { encoding: 'utf8' });
  return (r.stdout || '').trim().split('\n').filter((l) => l && !l.startsWith('COMMAND'));
}

async function cpuIdle(pid, seconds = 10) {
  const samples = [];
  for (let i = 0; i < seconds; i++) {
    const r = spawnSync('ps', ['-o', '%cpu=', '-p', String(pid)], { encoding: 'utf8' });
    samples.push(Number((r.stdout || '0').trim()));
    await sleep(1000);
  }
  return samples;
}

function readLog(vs, re) {
  for (const f of vs.extHostLogs()) {
    if (!/Class Names IntelliSense|htmlCssClass|output/i.test(f)) continue;
    try { const t = fs.readFileSync(f, 'utf8'); const m = t.match(re); if (m) return { file: f, text: t, m }; } catch {}
  }
  return null;
}

async function notifText(vs) { return (await vs.notifications()).join(' || '); }

async function clickToastButton(vs, label) {
  const b = JSON.parse(await vs.wbEval(`(() => { const b = [...document.querySelectorAll('.notifications-toasts .monaco-button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return 'null'; const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
  if (!b) return false;
  await vs.click(b.x, b.y);
  return true;
}

async function closeSidebar(vs) {
  try { await vs.command('View: Close Primary Side Bar'); } catch {}
  try { await vs.command('View: Close Secondary Side Bar'); } catch {}
}

// Moves the mouse over the text cursor so the editor shows its hover (the real way users see it).
async function hoverAtCursor(vs) {
  const c = JSON.parse(await vs.wbEval(`(() => { const e = document.querySelector('.monaco-editor.focused .cursor') || document.querySelector('.monaco-editor .cursor'); if (!e) return 'null'; const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + 3, y: r.y + r.height / 2 }); })()`));
  if (!c) return false;
  await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x - 20, y: c.y }, vs.wb);
  await sleep(100);
  await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y }, vs.wb);
  return true;
}

// ---------------------------------------------------------------------------------------------- phase A
async function phaseA() {
  const dir = path.join(work, 'A');
  const inst = installVsix(dir, vsix);
  ok('install vsix into real VS Code', inst.code === 0, inst.out.trim().split('\n').pop());
  // Real Vue and Svelte users have these installed: they give .vue and .svelte files their language ids.
  const lang = spawnSync(CLI, ['--user-data-dir', path.join(dir, 'ud'), '--extensions-dir', path.join(dir, 'ext'), '--install-extension', 'Vue.volar', '--install-extension', 'svelte.svelte-vscode'], { encoding: 'utf8', timeout: 240000 });
  ok('install Vue (Vue.volar) and Svelte (svelte.svelte-vscode) language extensions', lang.status === 0, (lang.stdout || '').trim().split('\n').slice(-2).join(' '));
  const vs = await launch(dir, PORT, WS, BASE);
  try {
    await sleep(4000);
    await closeSidebar(vs);
    const P = (p) => path.join(WS, p);
    // Activation happens on the first template file.
    await check(vs, 'HTML: linked sheets, <style> block (plain site, 3 CSS files)', P('plain-site/index.html'), '<table id="opening-hours" class="', 'card--', ['card--featured']);
    const idx = await vs.waitFor(() => readLog(vs, /Indexed ([\d,]+) style sheets in ([\d,]+) ms[^\n]*?([\d,]+) classes, ([\d,]+) ids, heap \+([\d.]+) MB/), 30000, 500);
    ok('index built (log line)', !!idx, idx ? idx.m[0] : 'no log');
    const statusText = await vs.wbEval(`(() => { const i = document.querySelector('.statusbar-item .codicon-symbol-class'); return i ? i.closest('.statusbar-item').textContent.trim() : ''; })()`);
    ok('status bar shows the class count', /\d/.test(statusText), statusText);
    await check(vs, 'README shot: completion with file names', P('plain-site/index.html'), '<table id="opening-hours" class="', 'btn', ['btn-primary', 'btn-outline'], { shot: 'completion-dark.png', details: true });
    await check(vs, 'HTML: id completion from CSS #ids', P('plain-site/index.html'), '<main', ' id="news', ['newsletter-form']);
    // Hover + definition
    {
      await openAt(vs, P('plain-site/index.html'), 'class="card card--feat');
      await hoverAtCursor(vs);
      const hv = await vs.waitFor(() => vs.wbEval(`(() => { const h = [...document.querySelectorAll('.monaco-hover')].find(x => x.offsetParent && x.textContent.includes('card--featured')); return h ? h.textContent : null; })()`), 6000);
      ok('hover shows the CSS rule and file:line', hv && /card--featured/.test(hv) && /components\.css:5/.test(hv), hv);
      await vs.shot(path.join(SHOTS, 'hover-dark.png'));
      await vs.key('Escape', 'Escape');
      await vs.key('F12', 'F12', 0, 123);
      const t = await vs.waitFor(async () => { const a = await activeTitle(vs); return a.includes('components.css') ? a : null; }, 6000);
      ok('F12 opens the rule in components.css', !!t, t || await activeTitle(vs));
    }
    // Bootstrap from a CDN: the offer, then the bundled list
    {
      vs.open(P('bootstrap-cdn/index.html'));
      const offer = await vs.waitFor(async () => { const n = await notifText(vs); return /loads Bootstrap 5 from a CDN/.test(n) ? n : null; }, 10000);
      ok('CDN page: offer to add the bundled Bootstrap 5 list', !!offer, offer);
      if (offer) await clickToastButton(vs, 'Add classes');
      await sleep(1500);
      await check(vs, 'Bootstrap 5 (CDN) bundled class list', P('bootstrap-cdn/index.html'), '<span class="', 'navbar-ex', ['navbar-expand-lg']);
    }
    await check(vs, 'React TSX: CSS module after styles.', P('react-modules/src/Button.tsx'), 'const x = styles.', '', ['button', 'icon-only', 'isLoading'], { shot: 'css-modules-dark.png', details: true });
    await check(vs, 'React TSX: className string (global app.css)', P('react-modules/src/Button.tsx'), 'className="toolbar ', 'toolbar-s', ['toolbar-spacer']);
    await check(vs, 'React JSX: cn() string', P('react-modules/src/App.jsx'), "dense && '", 'toolbar-s', ['toolbar-spacer']);
    await check(vs, 'Vue SFC: :class object string, SCSS nesting', P('vue-scss/src/components/TodoCard.vue'), "'todo-card__", '', ['todo-card__title', 'todo-card__meta']);
    await check(vs, 'Vue SFC: $style module', P('vue-scss/src/components/TodoCard.vue'), '$style.', '', ['note', 'noteWarning']);
    await check(vs, 'Vue SFC: theme.scss (&--raised)', P('vue-scss/src/components/TodoCard.vue'), 'class="todo-card ', 'surface--', ['surface--raised', 'surface--sunken']);
    await check(vs, 'Svelte: class attribute from <style>', P('svelte-app/src/Nav.svelte'), 'class="nav__link ', 'nav__link--', ['nav__link--muted']);
    await check(vs, 'Blade: value with {{ }} parts', P('laravel-blade/resources/views/dashboard.blade.php'), "'project-row--archived' : '' }} ", 'project-row__', ['project-row__name']);
    await check(vs, 'Blade (real Laravel welcome view): Tailwind from its own <style>', P('laravel-blade/resources/views/welcome.blade.php'), 'class="relative min-h-screen ', 'dark:bg-', ['dark:bg-black']);
    await check(vs, 'Angular: [ngClass] object key string', P('angular-app/src/app/hero-list.component.html'), "'': hero.retired", 'hero-item--r', ['hero-item--retired'], { delta: -15 });
    await check(vs, 'Tailwind: classes from the built CSS file', P('tailwind-site/index.html'), 'hover:bg-blue-700 ', 'md:grid', ['md:grid-cols-3']);
    await check(vs, 'PHP + Less: value with <?php ?>, Less &-suffix', P('less-theme/page.php'), "'is-collapsed' : ''; ?> ", 'panel-h', ['panel-header']);
    await check(vs, 'Real Bootstrap 5.3 dist CSS (linked)', P('real/page.html'), 'class="btn btn-', 'outline-sec', ['btn-outline-secondary']);
    await check(vs, 'Real animate.css (linked)', P('real/page.html'), 'class="animate__', 'fadeInU', ['animate__fadeInUp']);
    // Hostile
    {
      let n = await notifText(vs);
      if (!/skipped 2 style sheets over the size limit/.test(n)) { // FIN1: the toast may have moved to the notification center by now
        try { await vs.command('Notifications: Show Notifications'); await sleep(800); n += ' || ' + await vs.wbEval(`(document.querySelector('.notifications-center') || {}).textContent || ''`); await vs.command('Notifications: Hide Notifications'); } catch {}
      }
      ok('hostile: one message about skipped over-size sheets', /skipped 2 style sheets over the size limit/i.test(n), n);
      const r = await check(vs, 'hostile: broken SCSS read up to the error', P('hostile/hostile.html'), 'class="ok-', '', ['ok-before']);
      ok('hostile: completion fast with a 50 MB linked sheet (skipped)', r.ms !== undefined && r.ms < 3000, r.ms + ' ms');
      await check(vs, 'hostile: symlink loop folder indexed once, no hang', P('hostile/hostile.html'), 'class="', 'loop-', ['loop-ok']);
      const log = readLog(vs, /Skipped [^\n]*huge-50mb\.min\.css: ([^\n]+)/);
      ok('hostile: 50 MB minified CSS skipped without reading', !!log, log ? log.m[0] : '');
      const log2 = readLog(vs, /Skipped [^\n]*selectors-100k\.css: ([^\n]+)/);
      ok('hostile: 100,000-selector sheet (4.3 MB) skipped by the default limit', !!log2, log2 ? log2.m[0] : '');
    }
    // Support picker
    {
      await vs.command('Class Names IntelliSense: More free extensions');
      const qp = await vs.waitFor(() => vs.wbEval(`(() => { const w = document.querySelector('.quick-input-widget'); return w && w.offsetParent ? w.textContent : null; })()`), 5000);
      ok('support: More free extensions picker, related first', qp && /Related to this extension/.test(qp) && /SVG Viewer/.test(qp), (qp || '').slice(0, 160));
      await vs.key('Escape', 'Escape');
      const tip = JSON.parse(await vs.wbEval(`(() => { const i = document.querySelector('.statusbar-item .codicon-symbol-class'); const e = i && i.closest('.statusbar-item'); if (!e) return 'null'; const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
      if (tip) {
        await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tip.x, y: tip.y }, vs.wb);
        const hv = await vs.waitFor(() => vs.wbEval(`(() => { const h = [...document.querySelectorAll('.monaco-hover, .workbench-hover')].find(x => x.offsetParent && /Re-index/.test(x.textContent)); return h ? h.textContent : null; })()`), 6000);
        ok('support: status tooltip has Rate · More free viewers · Sponsor', hv && /Rate/.test(hv) && /Sponsor/.test(hv) && /More free/.test(hv), hv);
        await vs.shot(path.join(SHOTS, 'status-tooltip.png'));
      } else ok('support: status tooltip', false, 'status item not found');
    }
    // Raise the size limit: the 100,000-selector sheet is indexed and completion stays fast
    {
      const sp = path.join(dir, 'ud', 'User', 'settings.json');
      const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
      s['htmlCssClass.maxFileSizeKB'] = 8192;
      s['htmlCssClass.maxNamesPerFile'] = 200000; // FIN1: 100,000 selectors = 200,000 names; the default cap (50,000) stops at gen-sel-24999 by design
      fs.writeFileSync(sp, JSON.stringify(s, null, 1));
      const idx2 = await vs.waitFor(() => { const r = readLog(vs, /Indexed [^\n]*\(settings changed\)[^\n]*/); return r; }, 30000, 500);
      ok('100,000 selectors: indexed after raising the limit', !!idx2, idx2 ? idx2.m[0] : '');
      const r = await check(vs, '100,000 selectors: completion', P('hostile/hostile.html'), 'class="', 'gen-sel-9999', ['gen-sel-9999', 'gen-sel-99999']);
      ok('100,000 selectors: completion under 3 s', r.ms !== undefined && r.ms < 3000, r.ms + ' ms');
    }
    // Extension host: sockets, memory, idle CPU
    const eh = extHostPid(path.join(dir, 'ud'));
    if (eh) {
      const so = sockets(eh.pid);
      ok('no network: extension host has 0 internet sockets', so.length === 0, so.join(' ; ') || 'lsof -i: none');
      const cpu = await cpuIdle(eh.pid, 8);
      ok('idle CPU after indexing (ext host, 8 x 1 s)', Math.max(...cpu) < 5, cpu.join(' '));
      ok('ext host memory (RSS)', eh.rssMb < 1500, eh.rssMb.toFixed(0) + ' MB');
    } else ok('extension host process found', false);
    // Light theme
    {
      const sp = path.join(dir, 'ud', 'User', 'settings.json');
      const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
      s['workbench.colorTheme'] = 'Default Light Modern';
      s['htmlCssClass.maxFileSizeKB'] = 2048;
      fs.writeFileSync(sp, JSON.stringify(s, null, 1));
      await sleep(2500);
      await check(vs, 'light theme: completion', P('plain-site/index.html'), '<table id="opening-hours" class="', 'btn', ['btn-primary'], { shot: 'completion-light.png', details: true });
      await openAt(vs, P('plain-site/index.html'), 'class="card card--feat');
      await hoverAtCursor(vs);
      await sleep(1500);
      await vs.shot(path.join(SHOTS, 'hover-light.png'));
    }
    const errs = vs.console.filter((c) => /htmlCssClass|zovo-html-css|class-intellisense/i.test(c.text));
    ok('no console errors from the extension', errs.length === 0, JSON.stringify(errs).slice(0, 300));
    const exlog = vs.extHostLogs().filter((f) => /exthost\.log$/.test(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const exErr = exlog.split('\n').filter((l) => /zovo-html-css|htmlCssClass/i.test(l) && /error|exception|failed/i.test(l));
    ok('no extension host errors for this extension', exErr.length === 0, exErr.slice(0, 3).join(' ; '));
  } finally { await vs.close(); }
}

// ---------------------------------------------------------------------------------------------- phase B
async function phaseB() {
  const dir = path.join(work, 'B');
  installVsix(dir, vsix);
  const files = spawnSync('sh', ['-c', `find "${MONO}" -type f | wc -l; find "${MONO}" -type f \\( -name '*.css' -o -name '*.scss' -o -name '*.less' \\) | wc -l`], { encoding: 'utf8' }).stdout.trim().split(/\s+/);
  const vs = await launch(dir, PORT, MONO, BASE);
  try {
    await sleep(3000);
    await closeSidebar(vs);
    const page = path.join(MONO, 'apps/web/index.html');
    const r = await check(vs, `monorepo (${files[0]} files, ${files[1]} style sheets): uikit Less class`, page, '<div class="', 'uk-button-p', ['uk-button-primary'], { ms: 30000 });
    const idx = await vs.waitFor(() => readLog(vs, /Indexed ([\d,]+) style sheets in ([\d,]+) ms[^\n]*?([\d,]+) classes, ([\d,]+) ids, heap \+([\d.]+) MB/), 60000, 500);
    ok('monorepo: index time and heap (log)', !!idx && Number(idx.m[2].replace(/,/g, '')) < 3000, idx ? idx.m[0] : 'no log');
    await check(vs, 'monorepo: Primer CSS class', page, '<div class="', 'color-bg-acc', ['color-bg-accent']);
    await check(vs, 'monorepo: Foundation SCSS class', page, '<div class="', 'callout', ['callout']);
    const eh = extHostPid(path.join(dir, 'ud'));
    if (eh) {
      const cpu = await cpuIdle(eh.pid, 10);
      ok('monorepo: idle CPU after indexing (10 x 1 s)', Math.max(...cpu) < 5, cpu.join(' '));
      ok('monorepo: ext host RSS under 400 MB', eh.rssMb < 400, eh.rssMb.toFixed(0) + ' MB');
      ok('monorepo: ext host has 0 internet sockets', sockets(eh.pid).length === 0, sockets(eh.pid).join(' ; ') || 'none');
    }
    await vs.shot(path.join(SHOTS, 'monorepo.png'));
  } finally { await vs.close(); }
}

// ---------------------------------------------------------------------------------------------- phase C: rating ask v2.1
async function acceptOne(vs, file, marker, typed) {
  await openAt(vs, file, marker);
  if (typed) await vs.type(typed);
  await trigger(vs);
  const rows = await suggestRows(vs, null, 6000);
  if (!rows) return false;
  await vs.key('Enter', 'Enter');
  await sleep(500);
  return true;
}
async function phaseC() {
  const dir = path.join(work, 'C');
  installVsix(dir, vsix);
  const P = (p) => path.join(WS, p);
  let vs = await launch(dir, PORT, WS, BASE);
  try {
    await sleep(3000);
    const a = await acceptOne(vs, P('plain-site/index.html'), '<table id="opening-hours" class="', 'btn-p');
    const b = await acceptOne(vs, P('tailwind-site/index.html'), 'hover:bg-blue-700 ', 'md:grid');
    await sleep(4000);
    const n1 = await notifText(vs);
    ok('rating: no ask in the first session', a && b && !/useful\?/.test(n1), `accepted ${a} ${b}; toasts: ${n1}`);
  } finally { await vs.close(); }
  process.env.ZOVO_RATING_CLOCK_OFFSET_HOURS = '5';
  vs = await launch(dir, PORT, WS, BASE);
  try {
    await sleep(3000);
    const c = await acceptOne(vs, P('less-theme/page.php'), "'is-collapsed' : ''; ?> ", 'panel-h');
    const ask = await vs.waitFor(async () => { const n = await notifText(vs); return /useful\?/.test(n) ? n : null; }, 10000);
    ok('rating: ask after 2 files in 2 sessions 4+ h apart (fake clock +5 h)', c && ask && /Rate it/.test(ask) && /Later/.test(ask) && /No thanks/.test(ask), ask || await notifText(vs));
    await vs.shot(path.join(SHOTS, 'rating-ask.png'));
  } finally { await vs.close(); delete process.env.ZOVO_RATING_CLOCK_OFFSET_HOURS; }
}

const only = process.env.PHASES || 'ABC';
try {
  if (only.includes('A')) await phaseA();
  if (only.includes('B')) await phaseB();
  if (only.includes('C')) await phaseC();
} catch (e) { ok('gate crashed', false, e.stack); }
const pass = results.filter((r) => r.pass).length;
fs.writeFileSync(path.join(work, 'gate-results.json'), JSON.stringify({ when: new Date().toISOString(), vsix, pass, total: results.length, results }, null, 1));
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
