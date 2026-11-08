'use strict';
// HTML CSS Support & CSS Class IntelliSense: class and id completion, go to definition and hover from the
// workspace style sheets, <style> blocks, linked sheets and CSS modules. Completion only: it never edits text
// while you type. Local files only: no network request of any kind.
const vscode = require('vscode');
const { scanStyles, styleLang } = require('./core/scan');
const { completionContext, wordAfterLength, CLASS_CHAR, WINDOW } = require('./core/context');
const { styleBlocks, linkedSheets, isRemote, cdnFramework, moduleImports, gitignoreGlobs, MAX_DOC } = require('./core/doc');
const { ClassIndex, makeMatcher } = require('./core/index');
const { createRatingPrompt } = require('./rate');
const { registerSupport, footerMarkdown, showLinks } = require('./support');

const EXT_ID = 'zovo.zovo-html-css-class-intellisense';
const SECTION = 'htmlCssClass';
const NAME = 'HTML CSS Class IntelliSense';
const STYLE_GLOB = '**/*.{css,scss,less,pcss,postcss}';
const FRAMEWORKS = { bootstrap5: { file: 'bootstrap5.json', label: 'Bootstrap 5' }, bulma: { file: 'bulma.json', label: 'Bulma' } };
const STYLE_LANGS = new Set(['css', 'scss', 'less', 'postcss']);
const MAX_ITEMS = 5000;

let rating = { success() {}, failure() {} };
const index = new ClassIndex();
const state = { gen: 0, running: null, lastMs: 0, lastFiles: 0, truncatedFiles: false, heapMb: 0, ready: false, error: '' };
let out; // output channel
let status; // status bar item
const docCache = new Map(); // uri -> { version, blocks, links, modules, cdn }
const linkedCache = new Map(); // uri -> { mtime, size, entries | null, reason }
const counted = new Set();

function cfg() { return vscode.workspace.getConfiguration(SECTION); }
function log(msg) { if (out) out.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }
function fmt(n) { return Number(n).toLocaleString('en-US'); }

// ---------------------------------------------------------------- indexing

function excludeGlobs() {
  const ex = ['**/node_modules/**', '**/.git/**']; // always, even when the user replaces htmlCssClass.exclude
  const filesEx = vscode.workspace.getConfiguration('files').get('exclude') || {};
  for (const [g, on] of Object.entries(filesEx)) if (on === true) ex.push(g);
  for (const g of cfg().get('exclude', [])) if (typeof g === 'string' && g) ex.push(g);
  return ex;
}

async function gitignoreFor(folder) {
  if (!cfg().get('useGitignore', true)) return [];
  try {
    const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.gitignore'));
    return gitignoreGlobs(new TextDecoder().decode(raw));
  } catch { return []; }
}

function braceGlob(list) {
  const clean = [...new Set(list.map((g) => g.replace(/^\.\//, '')).filter((g) => g && !/[{}]/.test(g)))];
  const braced = list.filter((g) => /[{}]/.test(g));
  if (!clean.length && !braced.length) return null;
  // Globs with their own braces cannot sit inside one brace list; they are matched again after the search.
  return clean.length ? (clean.length === 1 ? clean[0] : `{${clean.join(',')}}`) : braced[0];
}

async function readStyleFile(uri, maxBytes) {
  let st;
  try { st = await vscode.workspace.fs.stat(uri); } catch (e) { return { reason: 'cannot read: ' + (e.code || e.message) }; }
  if (st.type & vscode.FileType.Directory) return { reason: 'is a folder' };
  if (st.size > maxBytes) return { reason: `${(st.size / 1048576).toFixed(1)} MB, over the ${(maxBytes / 1048576).toFixed(1)} MB limit (setting htmlCssClass.maxFileSizeKB)`, size: st.size, mtime: st.mtime };
  let raw;
  try { raw = await vscode.workspace.fs.readFile(uri); } catch (e) { return { reason: 'cannot read: ' + (e.code || e.message) }; }
  const text = new TextDecoder().decode(raw);
  const r = scanStyles(text, { lang: styleLang(uri.path) || 'css', maxEntries: cfg().get('maxNamesPerFile', 50000) });
  return { entries: r.entries, size: st.size, mtime: st.mtime, broken: r.broken, truncated: r.truncated };
}

function relPath(uri) {
  const f = vscode.workspace.getWorkspaceFolder(uri);
  if (!f) return uri.fsPath || uri.path;
  const rel = uri.path.slice(f.uri.path.length).replace(/^\//, '');
  return (vscode.workspace.workspaceFolders || []).length > 1 ? `${f.name}/${rel}` : rel;
}

let matchExcluded = () => false;

async function buildIndex(reason) {
  const gen = ++state.gen;
  const t0 = Date.now();
  const heap0 = process.memoryUsage().heapUsed;
  state.ready = false;
  updateStatus();
  const folders = vscode.workspace.workspaceFolders || [];
  const maxFiles = Math.max(1, cfg().get('maxFiles', 5000));
  const maxBytes = Math.max(1, cfg().get('maxFileSizeKB', 2048)) * 1024;
  const run = (async () => {
    const found = new Map();
    const ex = excludeGlobs();
    const gi = [];
    for (const f of folders) gi.push(...await gitignoreFor(f));
    const all = [...ex, ...gi];
    matchExcluded = makeMatcher(all);
    if (folders.length) {
      const uris = await vscode.workspace.findFiles(STYLE_GLOB, braceGlob(all), maxFiles + 1);
      for (const u of uris) if (!matchExcluded(relPath(u))) found.set(u.toString(), u);
      for (const pkg of cfg().get('includePackages', [])) {
        if (typeof pkg !== 'string' || !/^(@[\w.-]+\/)?[\w.-]+$/.test(pkg)) continue;
        const more = await vscode.workspace.findFiles(`**/node_modules/${pkg}/**/*.{css,scss,less}`, '**/node_modules/*/node_modules/**', 500);
        for (const u of more) found.set(u.toString(), u);
      }
    }
    if (gen !== state.gen) return;
    let list = [...found.values()];
    state.truncatedFiles = list.length > maxFiles;
    if (state.truncatedFiles) list = list.slice(0, maxFiles);
    // Drop sheets that are gone; keep framework lists and the files we are about to read.
    const keep = new Set(list.map((u) => u.toString()));
    for (const key of [...index.files.keys(), ...index.skipped.keys()]) if (!key.startsWith('framework:') && !keep.has(key)) index.removeFile(key);
    let done = 0;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Indexing CSS classes' }, async (p) => {
      for (let i = 0; i < list.length; i += 16) {
        if (gen !== state.gen) return;
        const batch = list.slice(i, i + 16);
        const results = await Promise.all(batch.map((u) => readStyleFile(u, maxBytes)));
        if (gen !== state.gen) return;
        batch.forEach((u, k) => {
          const r = results[k];
          if (r.entries) index.setFile(u.toString(), r.entries, { lang: styleLang(u.path), size: r.size, label: relPath(u), broken: r.broken, truncated: r.truncated });
          else index.skip(u.toString(), r.reason);
        });
        done += batch.length;
        p.report({ message: `${done}/${list.length}` });
        await new Promise((r) => setImmediate(r));
      }
    });
    if (gen !== state.gen) return;
    loadFrameworks();
    state.lastMs = Date.now() - t0;
    state.lastFiles = list.length;
    state.heapMb = Math.max(0, (process.memoryUsage().heapUsed - heap0) / 1048576);
    state.ready = true;
    state.error = '';
    const s = index.stats();
    log(`Indexed ${fmt(s.sheets)} style sheets in ${fmt(state.lastMs)} ms (${reason}): ${fmt(s.classes)} classes, ${fmt(s.ids)} ids, heap +${state.heapMb.toFixed(1)} MB.`);
    if (state.truncatedFiles) log(`Stopped at ${fmt(maxFiles)} style sheets (setting htmlCssClass.maxFiles). Add folders to htmlCssClass.exclude or raise the limit.`);
    for (const [key, why] of index.skipped) log(`Skipped ${labelOf(key)}: ${why}`);
    for (const [key, f] of index.files) if (f.broken) log(`Note: ${f.label} has a syntax error; the names before it are indexed.`);
    for (const [key, f] of index.files) if (f.truncated) log(`Note: ${f.label} has more names than htmlCssClass.maxNamesPerFile; the first ones are indexed.`);
    notifySkipped();
    for (const d of vscode.workspace.textDocuments) validate(d);
  })();
  state.running = run;
  try { await run; } catch (e) {
    state.error = String(e && e.message || e);
    log('Index error: ' + state.error);
    rating.failure();
  }
  updateStatus();
}

function labelOf(key) {
  const f = index.files.get(key);
  if (f) return f.label;
  try { return relPath(vscode.Uri.parse(key)); } catch { return key; }
}

let skippedNoted = false;
async function notifySkipped() {
  const big = [...index.skipped.values()].filter((r) => /limit/.test(r)).length;
  if (!big || skippedNoted || !ctxRef) return;
  skippedNoted = true;
  const key = 'htmlCssClass.skippedNoted';
  const prev = ctxRef.workspaceState.get(key, 0);
  if (prev === big) return;
  await ctxRef.workspaceState.update(key, big);
  const pick = await vscode.window.showInformationMessage(
    `${NAME}: skipped ${big} style sheet${big > 1 ? 's' : ''} over the size limit. Everything else is indexed.`, 'Show list', 'Change limit');
  if (pick === 'Show list') showReport();
  if (pick === 'Change limit') vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.maxFileSizeKB`);
}

const frameworkCache = new Map();
function frameworkEntries(name) {
  if (frameworkCache.has(name)) return frameworkCache.get(name);
  const fw = FRAMEWORKS[name];
  let entries = [];
  try {
    const data = JSON.parse(require('fs').readFileSync(require('path').join(ctxRef.extensionPath, 'data', fw.file), 'utf8'));
    entries = data.classes.map(([n, sel, body]) => ({ n, k: 'c', l: 0, c: 0, sel, body }));
  } catch (e) { log(`Cannot load the ${fw.label} list: ${e.message}`); }
  frameworkCache.set(name, entries);
  return entries;
}

function enabledFrameworks() {
  return new Set((cfg().get('frameworks', []) || []).filter((x) => FRAMEWORKS[x]));
}

function loadFrameworks() {
  const on = enabledFrameworks();
  for (const name of Object.keys(FRAMEWORKS)) {
    const key = 'framework:' + name;
    if (on.has(name) && !index.files.has(key)) index.setFile(key, frameworkEntries(name).map((e) => ({ ...e })), { label: FRAMEWORKS[name].label });
    if (!on.has(name) && index.files.has(key)) index.removeFile(key);
  }
}

// ------------------------------------------------------------ live updates

const pending = new Map();
function queueFile(uri, deleted) {
  const key = uri.toString();
  clearTimeout(pending.get(key));
  pending.set(key, setTimeout(async () => {
    pending.delete(key);
    if (deleted) { index.removeFile(key); linkedCache.delete(key); updateStatus(); return; }
    if (!vscode.workspace.getWorkspaceFolder(uri) || matchExcluded(relPath(uri))) return;
    if (!index.files.has(key) && !index.skipped.has(key) && index.files.size + index.skipped.size >= cfg().get('maxFiles', 5000)) return;
    const r = await readStyleFile(uri, cfg().get('maxFileSizeKB', 2048) * 1024);
    if (r.entries) index.setFile(key, r.entries, { lang: styleLang(uri.path), size: r.size, label: relPath(uri), broken: r.broken });
    else if (r.reason) index.skip(key, r.reason);
    linkedCache.delete(key);
    updateStatus();
  }, 300));
}

// An open, unsaved style sheet: index its current text so new classes complete before the file is saved.
function onStyleDocChange(doc) {
  if (!STYLE_LANGS.has(doc.languageId) || doc.uri.scheme !== 'file') return;
  const key = doc.uri.toString();
  if (!index.files.has(key)) return;
  clearTimeout(pending.get('doc:' + key));
  pending.set('doc:' + key, setTimeout(() => {
    pending.delete('doc:' + key);
    const text = doc.getText();
    if (text.length > cfg().get('maxFileSizeKB', 2048) * 1024) return;
    const r = scanStyles(text, { lang: styleLang(doc.uri.path) || doc.languageId, maxEntries: cfg().get('maxNamesPerFile', 50000) });
    index.setFile(key, r.entries, { lang: doc.languageId, size: text.length, label: relPath(doc.uri), broken: r.broken });
    updateStatus();
  }, 500));
}

// ------------------------------------------------------------ per document

function docInfo(doc) {
  const key = doc.uri.toString();
  const c = docCache.get(key);
  if (c && c.version === doc.version) return c;
  if (doc.lineCount > 200000) { // huge generated files: no <style>/<link> parsing
    const info = { version: doc.version, blocks: [], links: [], modules: new Map(), cdn: new Set(), size: 0 };
    docCache.set(key, info);
    return info;
  }
  const text = doc.getText();
  if (text.length > MAX_DOC) {
    const info = { version: doc.version, blocks: [], links: [], modules: new Map(), cdn: new Set(), size: text.length };
    docCache.set(key, info);
    return info;
  }
  const blocks = styleBlocks(text).map((b) => ({ ...b, entries: scanStyles(b.text, { lang: b.lang, maxEntries: 20000 }).entries.map((e) => ({ ...e, l: e.l + b.line, f: key, blk: true })) }));
  const links = linkedSheets(text);
  const modules = moduleImports(text);
  for (const b of blocks) if (b.module) modules.set(b.module, { block: b });
  const cdn = new Set(links.filter(isRemote).map(cdnFramework).filter(Boolean));
  const info = { version: doc.version, blocks, links, modules, cdn, size: text.length };
  docCache.set(key, info);
  if (docCache.size > 50) docCache.delete(docCache.keys().next().value);
  if (cdn.size) offerFramework(cdn);
  return info;
}

function resolveRef(doc, href, isImport) {
  const clean = href.replace(/[?#].*$/, '');
  if (!clean || isRemote(href) || /[{}<>$]/.test(clean)) return null;
  try {
    if (clean.startsWith('/')) {
      const f = vscode.workspace.getWorkspaceFolder(doc.uri) || (vscode.workspace.workspaceFolders || [])[0];
      if (!f) return null;
      return vscode.Uri.joinPath(f.uri, clean);
    }
    if (isImport && (clean.startsWith('~') || (!clean.startsWith('.') && /^@?[\w-]+\//.test(clean)))) {
      // Package import (`bootstrap/dist/css/bootstrap.css`, `~bulma/css/bulma.css`): look in node_modules above the file.
      const f = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (!f) return null;
      return vscode.Uri.joinPath(f.uri, 'node_modules', clean.replace(/^~/, ''));
    }
    return vscode.Uri.joinPath(doc.uri, '..', clean);
  } catch { return null; }
}

/** Entries of a referenced sheet: from the index when it is there, else read once (size-checked) and cached. */
async function sheetEntries(uri) {
  const key = uri.toString();
  const e = index.fileEntries(key);
  if (e) return { key, entries: e };
  if (index.skipped.has(key)) return { key, entries: [], reason: index.skipped.get(key) };
  let st;
  try { st = await vscode.workspace.fs.stat(uri); } catch { return { key, entries: [], reason: 'not found' }; }
  const c = linkedCache.get(key);
  if (c && c.mtime === st.mtime && c.size === st.size) return { key, entries: c.entries || [], reason: c.reason };
  const r = await readStyleFile(uri, cfg().get('maxFileSizeKB', 2048) * 1024);
  const entries = (r.entries || []).map((x) => ({ ...x, f: key }));
  linkedCache.set(key, { mtime: st.mtime, size: st.size, entries, reason: r.reason });
  if (linkedCache.size > 100) linkedCache.delete(linkedCache.keys().next().value);
  if (r.reason) log(`Linked sheet ${uri.fsPath || uri.path} not read: ${r.reason}`);
  return { key, entries, reason: r.reason };
}

async function localSources(doc, info) {
  const lists = [];
  for (const b of info.blocks) lists.push({ key: doc.uri.toString(), label: '<style>', entries: b.entries });
  for (const href of info.links) {
    const u = resolveRef(doc, href);
    if (!u) continue;
    const s = await sheetEntries(u);
    lists.push({ key: s.key, label: u.path.split('/').pop(), entries: s.entries });
  }
  return lists;
}

let offerShown = false;
async function offerFramework(cdn) {
  if (offerShown || !ctxRef) return;
  const on = enabledFrameworks();
  const missing = [...cdn].filter((x) => !on.has(x) && !ctxRef.globalState.get('htmlCssClass.noOffer.' + x));
  if (!missing.length) return;
  offerShown = true;
  const name = missing.map((x) => FRAMEWORKS[x].label).join(' and ');
  const pick = await vscode.window.showInformationMessage(
    `This page loads ${name} from a CDN. Add the ${name} class names to completions? The list ships with the extension; nothing is downloaded.`,
    'Add classes', 'Not now', "Don't ask again");
  if (pick === 'Add classes') {
    const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await cfg().update('frameworks', [...new Set([...on, ...missing])], target);
  } else if (pick === "Don't ask again") {
    for (const x of missing) await ctxRef.globalState.update('htmlCssClass.noOffer.' + x, true);
  }
}

// ------------------------------------------------------------ providers

function contextAt(doc, pos) {
  const offset = doc.offsetAt(pos);
  const before = doc.getText(new vscode.Range(doc.positionAt(Math.max(0, offset - WINDOW)), pos));
  const info = docInfo(doc);
  const ctx = completionContext(before, {
    functions: cfg().get('classFunctions'),
    modules: info.modules,
    svelte: doc.languageId === 'svelte',
  });
  return { ctx, info };
}

function isIdent(s) { return /^[A-Za-z_$][\w$]*$/.test(s); }

function cssSnippet(e) {
  const body = e.body ? e.body.split('; ').map((d) => '  ' + d + ';').join('\n') : '';
  return '```css\n' + e.sel + ' {' + (body ? '\n' + body + '\n' : ' ') + '}\n```';
}

function whereLabel(key) {
  if (key.startsWith('framework:')) return FRAMEWORKS[key.slice(10)]?.label || key;
  const f = index.files.get(key);
  if (f) return f.label;
  try { return relPath(vscode.Uri.parse(key)); } catch { return key; }
}

function defLink(e) {
  if (e.f.startsWith('framework:')) return whereLabel(e.f) + ' (bundled list)';
  const u = vscode.Uri.parse(e.f);
  return `[${e.blk ? '<style> in ' : ''}${whereLabel(e.f)}:${e.l + 1}](${u.with({ fragment: `L${e.l + 1},${e.c + 1}` }).toString()})`;
}

function docOf(e) {
  const md = new vscode.MarkdownString(cssSnippet(e) + '\n\n' + defLink(e));
  md.isTrusted = false;
  return md;
}

const itemDefs = new WeakMap();

async function provideCompletion(doc, pos) {
  if (docTooLarge(doc)) return undefined;
  const { ctx, info } = contextAt(doc, pos);
  if (!ctx) return undefined;
  if (ctx.kind === 'id' && !cfg().get('suggestIds', true)) return undefined;
  const lineText = doc.lineAt(pos.line).text;
  const afterLen = ctx.kind === 'module' ? (lineText.slice(pos.character).match(/^[\w$-]*/) || [''])[0].length : wordAfterLength(lineText.slice(pos.character));
  const start = pos.translate(0, -ctx.prefix.length);
  const range = { inserting: new vscode.Range(start, pos), replacing: new vscode.Range(start, pos.translate(0, afterLen)) };
  const items = [];
  const seen = new Set(ctx.existing);
  const kindCode = ctx.kind === 'id' ? 'i' : 'c';
  let cut = false;
  const pre = ctx.prefix.toLowerCase();
  // Big indexes (monorepos, Tailwind builds): send at most MAX_ITEMS per request, names that start with the typed
  // text first, then fuzzy matches (in order, first letter at a word start), and ask again as the word grows.
  const wanted = (n) => {
    if (!pre) return true;
    const x = n.toLowerCase();
    let i = x[0] === pre[0] ? 1 : -1;
    if (i < 0) {
      for (const sep of ['-', '_', ':', '/', '.']) { const k = x.indexOf(sep + pre[0]); if (k >= 0 && (i < 0 || k + 2 < i)) i = k + 2; }
      if (i < 0) return false;
    }
    for (let j = 1; j < pre.length; j++) { i = x.indexOf(pre[j], i); if (i < 0) return false; i++; }
    return true;
  };
  const add = (e, sort, count) => {
    if (seen.has(e.n)) return;
    if (items.length >= MAX_ITEMS || (bigIndex && !wanted(e.n))) { cut = true; return; }
    seen.add(e.n);
    const where = e.blk ? '<style>' : whereLabel(e.f);
    const it = new vscode.CompletionItem({ label: e.n, description: where + (count > 1 ? ` +${count - 1}` : '') },
      ctx.kind === 'id' ? vscode.CompletionItemKind.Reference : vscode.CompletionItemKind.Value);
    it.range = range;
    it.sortText = sort + e.n;
    it.command = { command: 'htmlCssClass.accepted', title: '', arguments: [doc.uri.toString()] };
    itemDefs.set(it, e);
    items.push(it);
  };
  const bigIndex = index.names[kindCode].size > MAX_ITEMS;

  if (ctx.kind === 'module') {
    const m = info.modules.get(ctx.module);
    let entries = [];
    if (m && m.block) entries = m.block.entries;
    else if (typeof m === 'string') { const u = resolveRef(doc, m, true); if (u) entries = (await sheetEntries(u)).entries; }
    for (const e of entries) {
      if (e.k !== 'c' || seen.has(e.n)) continue;
      if (ctx.access === 'dot' && !isIdent(e.n)) {
        // styles.btn-primary is not valid JS: insert styles['btn-primary'] instead (replaces the dot on accept).
        seen.add(e.n);
        const dotPos = start.translate(0, -1);
        const it = new vscode.CompletionItem({ label: e.n, description: `['${e.n}']` }, vscode.CompletionItemKind.Field);
        it.range = new vscode.Range(dotPos, pos.translate(0, afterLen));
        it.filterText = '.' + e.n;
        it.insertText = `['${e.n}']`;
        it.sortText = '1' + e.n;
        itemDefs.set(it, e);
        items.push(it);
        continue;
      }
      seen.add(e.n);
      const it = new vscode.CompletionItem({ label: e.n, description: whereLabel(e.f) }, vscode.CompletionItemKind.Field);
      it.range = range;
      it.sortText = '0' + e.n;
      it.command = { command: 'htmlCssClass.accepted', title: '', arguments: [doc.uri.toString()] };
      itemDefs.set(it, e);
      items.push(it);
    }
    return new vscode.CompletionList(items, false);
  }

  for (const src of await localSources(doc, info)) for (const e of src.entries) if (e.k === kindCode) add(e, '0', 1);
  const cdnOn = enabledFrameworks();
  const all = index.list(kindCode);
  if (bigIndex && pre) for (const [n, e, count] of all) if (!e.f.startsWith('framework:') && n.toLowerCase().startsWith(pre)) add(e, '1', count);
  for (const [, e, count] of all) {
    if (e.f.startsWith('framework:')) continue;
    add(e, '1', count);
  }
  for (const name of cdnOn) for (const e of index.fileEntries('framework:' + name) || []) if (e.k === kindCode) add(e, '2', 1);
  return new vscode.CompletionList(items, !state.ready || cut);
}

function resolveCompletion(item) {
  const e = itemDefs.get(item);
  if (e && !item.documentation) {
    item.documentation = docOf(e);
    item.detail = e.f.startsWith('framework:') ? whereLabel(e.f) : `${whereLabel(e.f)}:${e.l + 1}`;
  }
  return item;
}

function docTooLarge(doc) {
  // Completion reads only a window of text, but very large generated files are not worth parsing for <style>.
  try { return doc.lineCount > 2000000; } catch { return false; }
}

function wordRangeAt(doc, pos) {
  const line = doc.lineAt(pos.line).text;
  let s = pos.character, e = pos.character;
  while (s > 0 && CLASS_CHAR.test(line[s - 1])) s--;
  while (e < line.length && CLASS_CHAR.test(line[e])) e++;
  if (s === e) return null;
  return new vscode.Range(pos.line, s, pos.line, e);
}

/** The class or id under the cursor and its definitions. */
async function lookup(doc, pos) {
  // styles.name / styles['name'] first (JS words), then a class or id name in an attribute.
  let range = doc.getWordRangeAtPosition(pos, /[\w$-]+/);
  let ctx = null, info = null;
  if (range) {
    ({ ctx, info } = contextAt(doc, range.end));
    if (!ctx || ctx.kind !== 'module') ctx = null;
  }
  if (!ctx) {
    range = wordRangeAt(doc, pos);
    if (!range) return null;
    ({ ctx, info } = contextAt(doc, range.end));
    if (!ctx || ctx.kind === 'module') return null;
  }
  const name = doc.getText(range);
  if (!name) return null;
  let defs = [];
  if (ctx.kind === 'module') {
    const m = info.modules.get(ctx.module);
    let entries = [];
    if (m && m.block) entries = m.block.entries;
    else if (typeof m === 'string') { const u = resolveRef(doc, m, true); if (u) entries = (await sheetEntries(u)).entries; }
    defs = entries.filter((e) => e.k === 'c' && e.n === name);
  } else {
    const k = ctx.kind === 'id' ? 'i' : 'c';
    for (const src of await localSources(doc, info)) for (const e of src.entries) if (e.k === k && e.n === name) defs.push(e);
    for (const e of index.defs(k, name)) if (!defs.includes(e)) defs.push(e);
  }
  return { name, range, defs, kind: ctx.kind };
}

async function provideDefinition(doc, pos) {
  const r = await lookup(doc, pos);
  if (!r || !r.defs.length) return undefined;
  return r.defs.filter((e) => !e.f.startsWith('framework:')).slice(0, 50).map((e) => new vscode.Location(vscode.Uri.parse(e.f), new vscode.Position(e.l, e.c)));
}

async function provideHover(doc, pos) {
  if (!cfg().get('hover', true)) return undefined;
  const r = await lookup(doc, pos);
  if (!r || !r.defs.length) return undefined;
  const shown = r.defs.slice(0, 3);
  const md = new vscode.MarkdownString(shown.map((e) => cssSnippet(e) + '\n' + defLink(e)).join('\n\n---\n\n')
    + (r.defs.length > 3 ? `\n\n${r.defs.length - 3} more definitions (Go to Definition lists them all).` : ''));
  return new vscode.Hover(md, r.range);
}

// ------------------------------------------------------------ unknown class hints (off by default)

let diags;
const validateTimers = new Map();
function validate(doc) {
  if (!diags) return;
  const key = doc.uri.toString();
  if (!cfg().get('validate', false) || !state.ready || !languages().includes(doc.languageId)) { diags.delete(doc.uri); return; }
  clearTimeout(validateTimers.get(key));
  validateTimers.set(key, setTimeout(async () => {
    validateTimers.delete(key);
    const text = doc.getText();
    if (text.length > MAX_DOC) return;
    const info = docInfo(doc);
    const local = new Set();
    for (const src of await localSources(doc, info)) for (const e of src.entries) if (e.k === 'c') local.add(e.n);
    const out = [];
    const re = /(?:^|[\s"'])(?:class|className)\s*=\s*(["'])([^"'<>{}$]*)\1/g;
    let m;
    while ((m = re.exec(text)) && out.length < 500) {
      const valStart = m.index + m[0].length - 1 - m[2].length;
      const tokRe = /\S+/g;
      let t;
      while ((t = tokRe.exec(m[2]))) {
        const name = t[0];
        if (local.has(name) || index.names.c.has(name) || /[{}<>%@$]/.test(name)) continue;
        const s = doc.positionAt(valStart + t.index);
        const d = new vscode.Diagnostic(new vscode.Range(s, s.translate(0, name.length)), `Unknown CSS class "${name}": no indexed style sheet defines it.`, vscode.DiagnosticSeverity.Hint);
        d.source = NAME;
        out.push(d);
      }
    }
    diags.set(doc.uri, out);
  }, 400));
}

// ------------------------------------------------------------ status, report, commands

function languages() {
  return cfg().get('languages', DEFAULT_LANGUAGES);
}

function updateStatus() {
  if (!status) return;
  const ed = vscode.window.activeTextEditor;
  const show = cfg().get('showStatusBar', true) && ed && (languages().includes(ed.document.languageId) || STYLE_LANGS.has(ed.document.languageId));
  if (!show) { status.hide(); return; }
  const s = index.stats();
  status.text = state.ready ? `$(symbol-class) ${fmt(s.classes)}${s.skipped ? ' $(warning)' : ''}` : '$(sync~spin) CSS classes';
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.supportThemeIcons = true;
  md.appendMarkdown(`**${NAME}**\n\n`);
  if (state.ready) {
    md.appendMarkdown(`${fmt(s.classes)} classes and ${fmt(s.ids)} ids from ${fmt(s.sheets)} style sheets` + (s.frameworks ? ` and ${s.frameworks} bundled list${s.frameworks > 1 ? 's' : ''}` : '') + `, indexed in ${fmt(state.lastMs)} ms.\n\n`);
    if (s.skipped) md.appendMarkdown(`$(warning) ${s.skipped} skipped (too large or unreadable).\n\n`);
    if (state.truncatedFiles) md.appendMarkdown(`$(warning) Stopped at ${fmt(cfg().get('maxFiles', 5000))} style sheets.\n\n`);
  } else md.appendMarkdown(state.error ? `Index error: ${state.error}\n\n` : 'Indexing style sheets…\n\n');
  md.appendMarkdown('[Index report](command:htmlCssClass.showReport) · [Re-index](command:htmlCssClass.reindex) · [Settings](command:workbench.action.openSettings?%5B%22htmlCssClass%22%5D)');
  if (showLinks(vscode, SECTION)) md.appendMarkdown('\n\n---\n\n' + footerMarkdown(SECTION));
  status.tooltip = md;
  status.command = 'htmlCssClass.showReport';
  status.show();
}

function showReport() {
  const s = index.stats();
  out.appendLine('');
  out.appendLine(`=== ${NAME}: index report ===`);
  out.appendLine(`${fmt(s.sheets)} style sheets, ${fmt(s.classes)} classes, ${fmt(s.ids)} ids, last run ${fmt(state.lastMs)} ms, heap +${state.heapMb.toFixed(1)} MB.`);
  const rows = [...index.files.entries()].map(([k, f]) => [f.label, f.entries.length, f.broken]).sort((a, b) => b[1] - a[1]);
  for (const [label, n, broken] of rows.slice(0, 200)) out.appendLine(`  ${String(n).padStart(7)}  ${label}${broken ? '  (syntax error, partly read)' : ''}`);
  if (rows.length > 200) out.appendLine(`  … and ${rows.length - 200} more`);
  if (index.skipped.size) {
    out.appendLine('Skipped:');
    for (const [k, why] of index.skipped) out.appendLine(`  ${labelOf(k)}: ${why}`);
  }
  out.appendLine('Nothing was sent anywhere: the index lives in memory only.');
  out.show(true);
}

const DEFAULT_LANGUAGES = ['html', 'php', 'blade', 'twig', 'erb', 'handlebars', 'vue', 'vue-html', 'svelte', 'astro', 'javascriptreact',
  'typescriptreact', 'javascript', 'typescript', 'razor', 'aspnetcorerazor', 'django-html', 'jinja-html', 'jinja', 'nunjucks', 'liquid',
  'edge', 'html-eex', 'phoenix-heex', 'heex', 'templ', 'mdx', 'markdown'];

let ctxRef = null;

function activate(context) {
  ctxRef = context;
  out = vscode.window.createOutputChannel(NAME);
  context.subscriptions.push(out);
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: SECTION, name: NAME });
  registerSupport({ vscode, context, prefix: SECTION, selfId: EXT_ID });

  const selector = [];
  for (const language of languages()) for (const scheme of ['file', 'untitled', 'vscode-vfs', 'vscode-remote']) selector.push({ language, scheme });
  const triggers = ['"', "'", ' ', '`', '.', '[', ':', '{', '('];
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(selector, { provideCompletionItems: provideCompletion, resolveCompletionItem: resolveCompletion }, ...triggers),
    vscode.languages.registerDefinitionProvider(selector, { provideDefinition }),
    vscode.languages.registerHoverProvider(selector, { provideHover }),
  );
  diags = vscode.languages.createDiagnosticCollection('htmlCssClass');
  context.subscriptions.push(diags);

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.name = NAME;
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.commands.registerCommand('htmlCssClass.reindex', () => buildIndex('command')),
    vscode.commands.registerCommand('htmlCssClass.showReport', showReport),
    vscode.commands.registerCommand('htmlCssClass.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#htmlCssClass.start`, false)),
    vscode.commands.registerCommand('htmlCssClass.accepted', (uri) => {
      if (!uri || counted.has(uri)) return;
      counted.add(uri);
      try { rating.success(vscode.Uri.parse(uri)); } catch { rating.success(); }
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher(STYLE_GLOB);
  context.subscriptions.push(watcher,
    watcher.onDidCreate((u) => queueFile(u)),
    watcher.onDidChange((u) => queueFile(u)),
    watcher.onDidDelete((u) => queueFile(u, true)),
    vscode.workspace.onDidChangeTextDocument((e) => { onStyleDocChange(e.document); validate(e.document); }),
    vscode.workspace.onDidOpenTextDocument((d) => validate(d)),
    vscode.workspace.onDidCloseTextDocument((d) => { docCache.delete(d.uri.toString()); if (diags) diags.delete(d.uri); }),
    vscode.window.onDidChangeActiveTextEditor((ed) => { updateStatus(); if (ed && languages().includes(ed.document.languageId)) docInfo(ed.document); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => buildIndex('folders changed')),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (['maxFiles', 'maxFileSizeKB', 'exclude', 'includePackages', 'useGitignore', 'maxNamesPerFile'].some((k) => e.affectsConfiguration(`${SECTION}.${k}`)) || e.affectsConfiguration('files.exclude')) buildIndex('settings changed');
      else if (e.affectsConfiguration(`${SECTION}.frameworks`)) { loadFrameworks(); updateStatus(); }
      if (e.affectsConfiguration(SECTION)) { updateStatus(); for (const d of vscode.workspace.textDocuments) validate(d); }
    }),
  );
  updateStatus();
  buildIndex('startup');
  const ed = vscode.window.activeTextEditor;
  if (ed && languages().includes(ed.document.languageId)) docInfo(ed.document);
  return { index, state, buildIndex };
}

function deactivate() {
  state.gen++;
  for (const t of pending.values()) clearTimeout(t);
  for (const t of validateTimers.values()) clearTimeout(t);
}

module.exports = { activate, deactivate, DEFAULT_LANGUAGES, _test: { index, state, docInfo, resolveRef, provideCompletion, provideHover, provideDefinition, braceGlob } };
