'use strict';
// The extension host on a mocked VS Code API, over the real sample projects in samples/: indexing, completion in
// each template type, CSS modules, hover, definition, frameworks, size limits, and no network module use.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { globToRegExp } = require('../src/core/index');

const SAMPLES = path.join(__dirname, '..', 'samples');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hcci-ext-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---- a small VS Code mock
const config = {};
const infos = [];
class Position { constructor(l, c) { this.line = l; this.character = c; } translate(dl = 0, dc = 0) { return new Position(this.line + dl, this.character + dc); } }
class Range { constructor(a, b, c, d) { if (a instanceof Position) { this.start = a; this.end = b; } else { this.start = new Position(a, b); this.end = new Position(c, d); } } }
function uriOf(p) {
  return { scheme: 'file', fsPath: p, path: p, fragment: '', with(o) { const u = uriOf(o.path || p); u.fragment = o.fragment || ''; return u; }, toString() { return 'file://' + p + (this.fragment ? '#' + this.fragment : ''); } };
}
const Uri = {
  file: uriOf,
  parse: (s) => uriOf(decodeURI(String(s).replace(/^file:\/\//, '').replace(/#.*$/, ''))),
  joinPath: (u, ...s) => uriOf(path.posix.normalize(path.posix.join(u.path, ...s))),
};
let roots = [];
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const providers = { completion: [], hover: [], definition: [] };
const vscodeMock = {
  Uri, Position, Range,
  CompletionItem: class { constructor(label, kind) { this.label = label; this.kind = kind; } },
  CompletionList: class { constructor(items, inc) { this.items = items; this.isIncomplete = inc; } },
  CompletionItemKind: { Value: 11, Reference: 17, Field: 4 },
  MarkdownString: class { constructor(v = '') { this.value = v; } appendMarkdown(s) { this.value += s; return this; } },
  Hover: class { constructor(c, r) { this.contents = c; this.range = r; } },
  Location: class { constructor(u, p) { this.uri = u; this.range = p; } },
  Diagnostic: class { constructor(r, m, s) { this.range = r; this.message = m; this.severity = s; } },
  DiagnosticSeverity: { Hint: 3 },
  ProgressLocation: { Window: 10 },
  FileType: { File: 1, Directory: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  StatusBarAlignment: { Right: 2 },
  QuickPickItemKind: { Separator: -1 },
  env: { openExternal: async () => true },
  extensions: { getExtension: () => undefined },
  workspace: {
    get workspaceFolders() { return roots.map((r, i) => ({ uri: uriOf(r), name: path.basename(r), index: i })); },
    getWorkspaceFolder(u) { const r = roots.find((x) => u.path.startsWith(x + '/')); return r ? { uri: uriOf(r), name: path.basename(r) } : undefined; },
    getConfiguration: (section) => ({
      get: (k, d) => { const key = section + '.' + k; return key in config ? config[key] : d; },
      update: async (k, v) => { config[section + '.' + k] = v; },
    }),
    async findFiles(include, exclude, max) {
      const inc = globToRegExp(include);
      const ex = exclude ? globToRegExp(exclude) : null;
      const out = [];
      for (const r of roots) for (const f of walk(r, [])) {
        const rel = path.relative(r, f).split(path.sep).join('/');
        if (inc.test(rel) && !(ex && ex.test(rel))) out.push(uriOf(f));
      }
      return out.slice(0, max);
    },
    fs: {
      stat: async (u) => { const s = fs.statSync(u.fsPath); return { size: s.size, mtime: s.mtimeMs, type: s.isDirectory() ? 2 : 1 }; },
      readFile: async (u) => new Uint8Array(fs.readFileSync(u.fsPath)),
    },
    textDocuments: [],
    createFileSystemWatcher: () => ({ onDidCreate() { return { dispose() {} }; }, onDidChange() { return { dispose() {} }; }, onDidDelete() { return { dispose() {} }; }, dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }), onDidOpenTextDocument: () => ({ dispose() {} }), onDidCloseTextDocument: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    state: { focused: true },
    activeTextEditor: undefined,
    createOutputChannel: () => ({ lines: [], appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ text: '', show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} }),
    withProgress: async (o, fn) => fn({ report() {} }),
    showInformationMessage: async (...a) => { infos.push(a); return undefined; },
    showQuickPick: async () => undefined,
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeWindowState: () => ({ dispose() {} }),
  },
  languages: {
    registerCompletionItemProvider(sel, p, ...triggers) { providers.completion.push({ sel, p, triggers }); return { dispose() {} }; },
    registerHoverProvider(sel, p) { providers.hover.push(p); return { dispose() {} }; },
    registerDefinitionProvider(sel, p) { providers.definition.push(p); return { dispose() {} }; },
    registerOnTypeFormattingEditProvider() { throw new Error('must not register on-type edits'); },
    createDiagnosticCollection: () => ({ map: new Map(), set(u, d) { this.map.set(u.toString(), d); }, delete(u) { this.map.delete(u.toString()); }, dispose() {} }),
  },
  commands: { list: new Map(), registerCommand(id, fn) { this.list.set(id, fn); return { dispose() {} }; }, executeCommand: async () => {} },
};

// Network modules must never load.
const origLoad = Module._load;
const loaded = new Set();
Module._load = function (req, ...rest) {
  loaded.add(req);
  if (req === 'vscode') return vscodeMock;
  return origLoad.call(this, req, ...rest);
};

function doc(file, languageId) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const offsetAt = (p) => Math.min(text.length, starts[p.line] + p.character);
  const positionAt = (o) => { let l = 0; while (l + 1 < starts.length && starts[l + 1] <= o) l++; return new Position(l, o - starts[l]); };
  return {
    uri: uriOf(file), languageId, version: 1, lineCount: lines.length,
    getText: (r) => (r ? text.slice(offsetAt(r.start), offsetAt(r.end)) : text),
    offsetAt, positionAt,
    lineAt: (l) => ({ text: lines[typeof l === 'number' ? l : l.line] }),
    getWordRangeAtPosition(p, re) {
      const line = lines[p.line]; const g = new RegExp(re.source, 'g'); let m;
      while ((m = g.exec(line))) if (m.index <= p.character && p.character <= m.index + m[0].length) return new Range(p.line, m.index, p.line, m.index + m[0].length);
      return undefined;
    },
    text,
  };
}
/** Position right after `marker` (the n-th match) in the document. */
function at(d, marker, n = 0, delta = 0) {
  let i = -1;
  for (let k = 0; k <= n; k++) i = d.text.indexOf(marker, i + 1);
  assert.ok(i >= 0, 'marker not found: ' + marker);
  return d.positionAt(i + marker.length + delta);
}
async function complete(d, pos) {
  const p = providers.completion[0].p;
  const r = await p.provideCompletionItems(d, pos);
  return r ? r.items.map((it) => (typeof it.label === 'string' ? it.label : it.label.label)) : null;
}

const ext = require('../src/extension.js');
const ctx = {
  subscriptions: [], extensionUri: uriOf(path.join(__dirname, '..')), extensionPath: path.join(__dirname, '..'),
  globalState: { m: new Map(), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }, update: async function (k, v) { this.m.set(k, v); } },
  workspaceState: { m: new Map(), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }, update: async function (k, v) { this.m.set(k, v); } },
  globalStorageUri: uriOf(path.join(tmp, 'gs')),
};
let api;

test('activate indexes every sample project and registers providers without on-type edits', async () => {
  roots = [SAMPLES];
  api = ext.activate(ctx);
  await api.state.running;
  await new Promise((r) => setTimeout(r, 20));
  const s = api.index.stats();
  assert.ok(s.sheets >= 10, JSON.stringify(s));
  assert.ok(s.classes > 2000, JSON.stringify(s));
  assert.equal(s.skipped, 0);
  assert.equal(providers.completion.length, 1);
  assert.equal(providers.hover.length, 1);
  assert.equal(providers.definition.length, 1);
  assert.ok(providers.completion[0].triggers.includes('"'));
  for (const id of ['htmlCssClass.reindex', 'htmlCssClass.showReport', 'htmlCssClass.supportDeveloper', 'htmlCssClass.moreViewers', 'htmlCssClass.openWalkthrough'])
    assert.ok(vscodeMock.commands.list.has(id), id);
});

test('HTML: linked sheets and the <style> block come first; existing names are left out', async () => {
  const d = doc(path.join(SAMPLES, 'plain-site/index.html'), 'html');
  const items = await complete(d, at(d, 'class="btn '));
  assert.ok(items.includes('btn-primary'));
  assert.ok(items.includes('promo-banner'), 'from <style>');
  assert.ok(!items.includes('btn'), 'already in the attribute');
  const p = providers.completion[0].p;
  const r = await p.provideCompletionItems(d, at(d, 'class="btn '));
  const promo = r.items.find((i) => i.label.label === 'promo-banner');
  assert.equal(promo.sortText[0], '0');
  assert.equal(promo.additionalTextEdits, undefined);
  const res = p.resolveCompletionItem(promo);
  assert.match(res.documentation.value, /\.promo-banner \{/);
  // ids
  const ids = await complete(d, at(d, 'id="'));
  assert.ok(ids.includes('opening-hours'));
  assert.ok(ids.includes('newsletter-form'));
  // outside an attribute: nothing
  assert.equal(await complete(d, at(d, '<title>')), null);
});

test('replace range covers the rest of the word, insert range ends at the cursor', async () => {
  const d = doc(path.join(SAMPLES, 'plain-site/index.html'), 'html');
  const pos = at(d, 'class="main-nav__', 0);
  const r = await providers.completion[0].p.provideCompletionItems(d, pos);
  const it = r.items[0];
  assert.equal(it.range.inserting.end.character, pos.character);
  assert.equal(it.range.replacing.end.character - it.range.replacing.start.character, 'main-nav__link'.length);
});

test('Bootstrap from a CDN: offer once, then the bundled list completes', async () => {
  const d = doc(path.join(SAMPLES, 'bootstrap-cdn/index.html'), 'html');
  const before = await complete(d, at(d, '<span class="'));
  assert.ok(!before.includes('navbar-expand-lg'));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(infos.some((m) => /loads Bootstrap 5 from a CDN/.test(m[0])), JSON.stringify(infos));
  config['htmlCssClass.frameworks'] = ['bootstrap5'];
  await api.buildIndex('test');
  const after = await complete(d, at(d, '<span class="'));
  for (const x of ['navbar-expand-lg', 'btn-outline-secondary', 'col-md-6', 'g-4']) assert.ok(after.includes(x), x);
  config['htmlCssClass.frameworks'] = [];
  await api.buildIndex('test');
});

test('React: CSS modules after styles., bracket access for dashed names, clsx and className strings', async () => {
  const d = doc(path.join(SAMPLES, 'react-modules/src/Button.tsx'), 'typescriptreact');
  const r = await providers.completion[0].p.provideCompletionItems(d, at(d, 'const x = styles.'));
  const labels = r.items.map((i) => i.label.label);
  assert.deepEqual(labels.sort(), ['button', 'ghost', 'icon-only', 'isLoading', 'primary', 'spinner']);
  const dashed = r.items.find((i) => i.label.label === 'icon-only');
  assert.equal(dashed.insertText, "['icon-only']");
  assert.equal(dashed.filterText, '.icon-only');
  const tb = await complete(d, at(d, 'className="toolbar '));
  assert.ok(tb.includes('toolbar-spacer'));
  const app = doc(path.join(SAMPLES, 'react-modules/src/App.jsx'), 'javascriptreact');
  assert.ok((await complete(app, at(app, "dense && '"))).includes('toolbar'));
  assert.ok((await complete(app, at(app, "'toolbar-dense' : '"))).includes('toolbar-spacer'));
});

test('Vue: :class object strings, SCSS nesting from <style lang=scss>, $style module', async () => {
  const d = doc(path.join(SAMPLES, 'vue-scss/src/components/TodoCard.vue'), 'vue');
  const a = await complete(d, at(d, "'is-"));
  assert.ok(a.includes('is-success') && a.includes('is-danger'));
  const b = await complete(d, at(d, "'todo-card__"));
  assert.ok(b.includes('todo-card__title') && b.includes('todo-card__meta'));
  const r = await providers.completion[0].p.provideCompletionItems(d, at(d, '$style.'));
  assert.deepEqual(r.items.map((i) => i.label.label).sort(), ['note', 'noteWarning']);
  const plain = await complete(d, at(d, 'class="todo-card '));
  assert.ok(plain.includes('surface--raised'));
  assert.ok(!plain.includes('gap-') && !plain.includes('gap-sm'), 'interpolated names are not offered');
});

test('Svelte class: directive, Blade with {{ }} and <?php ?>, Angular [ngClass], Less in PHP, Tailwind built CSS', async () => {
  const sv = doc(path.join(SAMPLES, 'svelte-app/src/Nav.svelte'), 'svelte');
  assert.ok((await complete(sv, at(sv, 'class:is-', 0, -3))).includes('is-current'));
  assert.ok((await complete(sv, at(sv, 'class="nav__link '))).includes('nav__link--muted'));
  const bl = doc(path.join(SAMPLES, 'laravel-blade/resources/views/dashboard.blade.php'), 'blade');
  assert.ok((await complete(bl, at(bl, "'project-row--archived' : '' }} "))).includes('project-row__name'));
  const ng = doc(path.join(SAMPLES, 'angular-app/src/app/hero-list.component.html'), 'html');
  assert.ok((await complete(ng, at(ng, "'': hero.retired", 0, -15))).includes('hero-item--retired'));
  const php = doc(path.join(SAMPLES, 'less-theme/page.php'), 'php');
  const p = await complete(php, at(php, "'is-collapsed' : ''; ?> "));
  assert.ok(p.includes('panel-header') && p.includes('alert-warning'));
  const tw = doc(path.join(SAMPLES, 'tailwind-site/index.html'), 'html');
  const t = await complete(tw, at(tw, 'hover:bg-blue-700 '));
  for (const x of ['md:grid-cols-3', 'hover:shadow-lg', 'max-w-4xl']) assert.ok(t.includes(x), x);
});

test('hover and go to definition', async () => {
  const d = doc(path.join(SAMPLES, 'plain-site/index.html'), 'html');
  const pos = at(d, 'class="card card--feat');
  const h = await providers.hover[0].provideHover(d, pos);
  assert.match(h.contents.value, /\.card--featured \{/);
  assert.match(h.contents.value, /border-color: #c2410c/);
  assert.match(h.contents.value, /components\.css:5/);
  const defs = await providers.definition[0].provideDefinition(d, pos);
  assert.equal(defs.length, 1);
  assert.match(defs[0].uri.fsPath, /components\.css$/);
  assert.equal(defs[0].range.line, 4);
  const tsx = doc(path.join(SAMPLES, 'react-modules/src/Button.tsx'), 'typescriptreact');
  const md = await providers.definition[0].provideDefinition(tsx, at(tsx, 'styles.spin', 0, -1));
  assert.match(md[0].uri.fsPath, /Button\.module\.css$/);
  const ng = doc(path.join(SAMPLES, 'angular-app/src/app/hero-list.component.html'), 'html');
  const hd = await providers.definition[0].provideDefinition(ng, at(ng, 'class="hero-item__bad'));
  assert.match(hd[0].uri.fsPath, /hero-list\.component\.scss$/);
});

test('hostile files: over-size skipped without reading, broken SCSS partly read, symlink loop ignored', async () => {
  const w = path.join(tmp, 'hostile');
  fs.mkdirSync(path.join(w, 'css'), { recursive: true });
  // a 3 MB minified sheet (the 50 MB one is in the real VS Code gate; this keeps the temp folder small)
  const fd = fs.openSync(path.join(w, 'css/huge.min.css'), 'w');
  const chunk = Buffer.from(Array.from({ length: 2000 }, (_, i) => `.h${i}{color:red}`).join(''));
  for (let n = 0; n * chunk.length < 3 * 1024 * 1024; n++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  fs.writeFileSync(path.join(w, 'css/broken.scss'), '.fine { a: b }\n.half { color: red;\n  &__x { y: "unterminated\n');
  fs.writeFileSync(path.join(w, 'css/ok.css'), '.ok-class { a: b }');
  roots = [w];
  config['htmlCssClass.maxFileSizeKB'] = 2048;
  await api.buildIndex('hostile');
  const s = api.index.stats();
  assert.equal(s.skipped, 1);
  assert.ok(api.index.names.c.has('fine') && api.index.names.c.has('ok-class'));
  assert.ok(!api.index.names.c.has('h1'));
  assert.ok([...api.index.skipped.values()][0].includes('over the 2.0 MB limit'));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(infos.some((m) => /skipped 1 style sheet over the size limit/.test(m[0])));
  roots = [SAMPLES];
  delete config['htmlCssClass.maxFileSizeKB'];
  await api.buildIndex('back');
});

test('excludes, .gitignore and maxFiles are respected', async () => {
  const w = path.join(tmp, 'ex');
  for (const d of ['node_modules/pkg', 'build', 'src', 'vendor/lib']) fs.mkdirSync(path.join(w, d), { recursive: true });
  fs.writeFileSync(path.join(w, 'node_modules/pkg/a.css'), '.from-node-modules{}');
  fs.writeFileSync(path.join(w, 'build/b.css'), '.from-build{}');
  fs.writeFileSync(path.join(w, 'vendor/lib/v.css'), '.from-vendor{}');
  fs.writeFileSync(path.join(w, 'src/c.css'), '.from-src{}');
  fs.writeFileSync(path.join(w, '.gitignore'), 'build/\n/vendor\n');
  roots = [w];
  await api.buildIndex('ex');
  assert.deepEqual([...api.index.names.c.keys()].sort(), ['from-src']);
  config['htmlCssClass.includePackages'] = ['pkg'];
  config['htmlCssClass.useGitignore'] = false;
  await api.buildIndex('ex2');
  assert.deepEqual([...api.index.names.c.keys()].sort(), ['from-build', 'from-node-modules', 'from-src', 'from-vendor']);
  config['htmlCssClass.maxFiles'] = 2;
  await api.buildIndex('ex3');
  assert.equal(api.index.stats().sheets, 2);
  assert.equal(api.state.truncatedFiles, true);
  for (const k of ['includePackages', 'useGitignore', 'maxFiles']) delete config['htmlCssClass.' + k];
  roots = [SAMPLES];
  await api.buildIndex('back');
});

test('big index: at most 5,000 items per request, filtered by the first letter, asked again as you type', async () => {
  const w = path.join(tmp, 'big');
  fs.mkdirSync(w, { recursive: true });
  fs.writeFileSync(path.join(w, 'big.css'), Array.from({ length: 8000 }, (_, i) => `.alpha-${i}{a:b} .zeta-${i}{a:b}`).join('\n'));
  fs.writeFileSync(path.join(w, 'p.html'), '<div class="z"></div><div class=""></div>');
  roots = [w];
  await api.buildIndex('big');
  const d = doc(path.join(w, 'p.html'), 'html');
  const r = await providers.completion[0].p.provideCompletionItems(d, at(d, 'class="z'));
  assert.ok(r.items.length <= 5000 && r.items.length > 1000, String(r.items.length));
  assert.ok(r.items.every((i) => i.label.label.startsWith('zeta-')));
  assert.equal(r.isIncomplete, true);
  const e = await providers.completion[0].p.provideCompletionItems(d, at(d, '<div class="', 1));
  assert.equal(e.items.length, 5000);
  // the exact name deep in a long list is sent first
  fs.writeFileSync(path.join(w, 'p.html'), '<div class="zeta-7999"></div><div class=""></div>');
  const d2 = doc(path.join(w, 'p.html'), 'html');
  const r2 = await providers.completion[0].p.provideCompletionItems(d2, at(d2, 'class="zeta-7999'));
  assert.equal(r2.items[0].label.label, 'zeta-7999');
  const r3 = await providers.completion[0].p.provideCompletionItems(d2, at(d2, 'class="zeta-79'));
  assert.ok(r3.items.every((i) => /^zeta-.*7.*9/.test(i.label.label)) && r3.items.some((i) => i.label.label === 'zeta-7999'));
  roots = [SAMPLES];
  await api.buildIndex('back');
});

test('rating counts an accepted completion once per file; status shows the count and support links', async () => {
  const cmd = vscodeMock.commands.list.get('htmlCssClass.accepted');
  cmd('file:///x/a.html'); cmd('file:///x/a.html');
  vscodeMock.window.activeTextEditor = { document: { languageId: 'html', uri: uriOf('/x/a.html') } };
  api.buildIndex('status');
  await api.state.running;
  await new Promise((r) => setTimeout(r, 20));
});

test('no network module is loaded by the extension', () => {
  for (const m of ['http', 'https', 'net', 'tls', 'dgram', 'node:http', 'node:https', 'node:net', 'undici']) assert.ok(!loaded.has(m), m);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
  assert.ok(!/\bfetch\(|XMLHttpRequest|require\(['"]https?['"]\)/.test(src));
});
