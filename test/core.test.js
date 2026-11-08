'use strict';
// Pure parts: the style sheet scanner, the cursor context finder, document helpers and the index.
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanStyles, styleLang, splitList } = require('../src/core/scan');
const { completionContext, wordAfterLength } = require('../src/core/context');
const { styleBlocks, linkedSheets, isRemote, cdnFramework, moduleImports, gitignoreGlobs } = require('../src/core/doc');
const { ClassIndex, globToRegExp, makeMatcher } = require('../src/core/index');

const names = (r, k = 'c') => [...new Set(r.entries.filter((e) => e.k === k).map((e) => e.n))];

test('plain CSS: classes, ids, compound and pseudo selectors, at-rules', () => {
  const r = scanStyles(`/* .not-me */ .a, div.b > .c:hover::before { color: red }
#main .d:not(.e) {} @media (min-width: 1px) { .f { x: 1 } } @supports (display: grid) { .g {} }
@font-face { font-family: x; } @keyframes spin { from { a: 1 } 50.5% { b: 2 } }
a[class~="h"] .i {} .j[data-x=".k"] {}`);
  assert.deepEqual(names(r).sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'i', 'j']);
  assert.deepEqual(names(r, 'i'), ['main']);
  assert.equal(r.broken, false);
});

test('escaped Tailwind names are unescaped', () => {
  const r = scanStyles('.md\\:flex{} .hover\\:bg-blue-500:hover{} .w-1\\/2{} .p-\\[2px\\]{} .\\!mt-0{} .\\31 0{}');
  assert.deepEqual(names(r), ['md:flex', 'hover:bg-blue-500', 'w-1/2', 'p-[2px]', '!mt-0', '10']);
});

test('SCSS nesting: &__elem, &--mod, &.state, parent lists, @media inside a rule, interpolation dropped', () => {
  const r = scanStyles(`$x: 1;
.card { padding: 1px; // .comment {}
  &__title { a: b } &--big, &.is-on { c: d } .inner & { e: f }
  @media (min-width: 1px) { &-m { g: h } }
  .btn-#{$x} { i: j }
}
.a, .b { &-x { k: l } }
@mixin m { .from-mixin { m: n } }
%placeholder { o: p }
.font { font: { family: x; size: 1px; } }`, { lang: 'scss' });
  const n = names(r);
  for (const x of ['card', 'card__title', 'card--big', 'is-on', 'inner', 'card-m', 'a-x', 'b-x', 'font']) assert.ok(n.includes(x), x);
  for (const x of ['comment', 'btn-', 'from-mixin', 'placeholder', 'family']) assert.ok(!n.includes(x), x);
  const title = r.entries.find((e) => e.n === 'card__title');
  assert.equal(title.sel, '.card__title');
  assert.equal(title.body, 'a: b');
  assert.equal(title.l, 2);
});

test('Less: mixin definitions are not classes, mixin calls are not rules, &-suffix works', () => {
  const r = scanStyles(`.rounded() { border-radius: 2px; }
.m(@a; @b) when (iscolor(@a)) { color: @a; }
.panel { .rounded(); &-header { a: b } &.is-collapsed &-body { c: d } }
@detached: { .inside { x: y } };
#ns { .mixin() { z: 1 } }`, { lang: 'less' });
  const n = names(r);
  assert.deepEqual(n.sort(), ['is-collapsed', 'panel', 'panel-body', 'panel-header']);
  assert.deepEqual(names(r, 'i'), ['ns']);
});

test('body snippet: declarations of the rule, not of nested rules; data URLs keep their ;', () => {
  const r = scanStyles('.x { color: red; background: url(data:image/svg+xml;base64,AAA=); .y { z: 1 } margin: 0 }', { lang: 'scss' });
  const x = r.entries.find((e) => e.n === 'x');
  assert.equal(x.body, 'color: red; background: url(data:image/svg+xml;base64,AAA=); margin: 0');
});

test('broken input never throws and keeps names before the error', () => {
  for (const t of ['.a { color: "red', '.a { .b {', '}}}} .c {}', '/* never closed .d {}', '.e { x: 1 } @media {', '"\n.f {}', '#{', '.g { } }']) {
    const r = scanStyles(t, { lang: 'scss' });
    assert.ok(Array.isArray(r.entries));
  }
  const r = scanStyles('.ok { a: b }\n.bad { color: red;\n.also { x: 1 }', { lang: 'scss' });
  assert.ok(names(r).includes('ok'));
  assert.equal(r.broken, true);
});

test('maxEntries stops early and says so', () => {
  const css = Array.from({ length: 5000 }, (_, i) => `.c${i}{a:b}`).join('\n');
  const r = scanStyles(css, { maxEntries: 100 });
  assert.equal(r.entries.length, 100);
  assert.equal(r.truncated, true);
});

test('100,000 selectors scan in linear time', () => {
  const css = Array.from({ length: 100000 }, (_, i) => `.sel-${i} { color: #${(i % 4096).toString(16).padStart(3, '0')}; }`).join('\n');
  const t0 = Date.now();
  const r = scanStyles(css, { maxEntries: 200000 });
  assert.equal(r.entries.length, 100000);
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
});

test('lines and columns point at the rule', () => {
  const r = scanStyles('\n\n  /* x */\n  .a,\n  .b { c: d }\n.e {}');
  const a = r.entries.find((e) => e.n === 'a');
  const e = r.entries.find((x) => x.n === 'e');
  assert.equal(a.l, 3); assert.equal(a.c, 2);
  assert.equal(e.l, 5); assert.equal(e.c, 0);
});

test('styleLang and splitList', () => {
  assert.equal(styleLang('a/b.module.scss'), 'scss');
  assert.equal(styleLang('x.LESS'), 'less');
  assert.equal(styleLang('x.pcss'), 'scss');
  assert.equal(styleLang('x.js'), '');
  assert.deepEqual(splitList('.a, .b:is(.c, .d), [x="1,2"]'), ['.a', '.b:is(.c, .d)', '[x="1,2"]']);
});

const ctx = (t, o) => completionContext(t, { modules: { styles: 'x', $style: 'y' }, ...o });

test('context: HTML and template class attributes', () => {
  assert.deepEqual(ctx('<div class="btn bt'), { kind: 'class', prefix: 'bt', existing: ['btn'] });
  assert.equal(ctx('<div class="btn" title="x'), null);
  assert.equal(ctx('<div class="a">text cla'), null);
  assert.equal(ctx('<div class="{{ $a ? "x" : "y" }} car').prefix, 'car');
  assert.equal(ctx('<div class="{{ $a'), null);
  assert.equal(ctx('<div class="<?php echo $x; ?> nav').prefix, 'nav');
  assert.equal(ctx('<div class="<%= x %> nav').prefix, 'nav');
  assert.equal(ctx('<div class="{% if a %}x{% endif %} y').prefix, 'y');
  assert.equal(ctx('<div class=un').prefix, 'un');
  assert.equal(ctx("<div class='a b").prefix, 'b');
  assert.deepEqual(ctx('<div\n  class="\n   one\n   tw').existing, ['one']);
  assert.equal(ctx('el.className = "x'), null);
});

test('context: ids', () => {
  assert.deepEqual(ctx('<a id="he'), { kind: 'id', prefix: 'he', existing: [] });
  assert.equal(ctx('<a id="one tw'), null);
});

test('context: JSX, clsx, cn, template literals', () => {
  assert.equal(ctx('<div className="x').prefix, 'x');
  assert.equal(ctx('<div className={"x').prefix, 'x');
  assert.equal(ctx('<div className={clsx("a", on && "b').prefix, 'b');
  assert.equal(ctx('<div className={clsx("a", on && b'), null);
  assert.equal(ctx('<div className={`p-4 ${x} fl').prefix, 'fl');
  assert.equal(ctx("const c = cn('a', 'b").prefix, 'b');
  assert.equal(ctx("const c = cn('a'); foo('"), null);
  assert.equal(ctx("const v = cva('base', { variants: { size: { sm: 'text-").prefix, 'text-');
  assert.equal(ctx("const c = twMerge(`a\n b").prefix, 'b');
  assert.equal(ctx("foo.cn('x"), null);
  assert.equal(ctx("const c = myFn('x", { functions: ['myFn'] }).prefix, 'x');
  assert.equal(ctx("const c = clsx('x", { functions: [] }), null);
});

test('context: Vue, Angular, Svelte, Astro', () => {
  assert.equal(ctx(`<div :class="{ active: on, 'text-`).prefix, 'text-');
  assert.equal(ctx('<div :class="{ active: o'), null);
  assert.equal(ctx(`<div v-bind:class="['a', 'b`).prefix, 'b');
  assert.equal(ctx(`<div [ngClass]="{'is-`).prefix, 'is-');
  assert.equal(ctx('<li class:act').prefix, 'act');
  assert.equal(ctx('<li class:act', { svelte: false }), null);
  assert.equal(ctx('<div class:list={["a", "b').prefix, 'b');
});

test('context: CSS modules', () => {
  assert.deepEqual(ctx('styles.ti'), { kind: 'module', module: 'styles', prefix: 'ti', existing: [], access: 'dot' });
  assert.equal(ctx("styles['ti").access, 'bracket');
  assert.equal(ctx('$style.n').module, '$style');
  assert.equal(ctx('other.ti'), null);
  assert.equal(ctx('a.styles.ti'), null);
});

test('context costs the same on a huge prefix (window)', () => {
  const big = '<p>' + 'x'.repeat(20 * 1024 * 1024) + '</p><div class="ab';
  const t0 = Date.now();
  assert.equal(ctx(big).prefix, 'ab');
  assert.ok(Date.now() - t0 < 200);
});

test('wordAfterLength stops at quotes and spaces', () => {
  assert.equal(wordAfterLength('n-primary other"'), 9);
  assert.equal(wordAfterLength('" x'), 0);
});

test('doc helpers: style blocks, links, CDN detection, module imports', () => {
  const html = '<link rel="stylesheet" href="css/a.css"><link href=b.css><link rel=icon href=x.png>\n<style lang="scss" scoped>\n.a { &-b {} }\n</style><style module>.m{}</style><style src="./c.less"></style>';
  const b = styleBlocks(html);
  assert.equal(b.length, 2);
  assert.equal(b[0].lang, 'scss'); assert.equal(b[0].line, 1);
  assert.equal(b[1].module, '$style');
  assert.deepEqual(linkedSheets(html), ['css/a.css', 'b.css', './c.less']);
  assert.ok(isRemote('https://cdn.x/a.css')); assert.ok(isRemote('//cdn.x/a.css')); assert.ok(!isRemote('css/a.css'));
  assert.equal(cdnFramework('https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css'), 'bootstrap5');
  assert.equal(cdnFramework('https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/5.3.0/css/bootstrap.min.css'), 'bootstrap5');
  assert.equal(cdnFramework('https://cdn.jsdelivr.net/npm/bootstrap@4.6.2/dist/css/bootstrap.min.css'), '');
  assert.equal(cdnFramework('https://cdn.jsdelivr.net/npm/bulma@1.0.2/css/bulma.min.css'), 'bulma');
  const m = moduleImports("import styles from './Button.module.css';\nimport * as s from \"../x.scss\";\nconst c = require('./c.module.less');\nimport x from './x.js';");
  assert.deepEqual([...m.entries()], [['styles', './Button.module.css'], ['s', '../x.scss'], ['c', './c.module.less']]);
});

test('gitignore globs and the glob matcher', () => {
  const g = gitignoreGlobs('# c\n/vendor\nbuild/\n*.min.css\n!keep.css\npublic/assets\n');
  assert.deepEqual(g, ['vendor', 'vendor/**', '**/build', '**/build/**', '**/*.min.css', '**/*.min.css/**', 'public/assets', 'public/assets/**']);
  const m = makeMatcher(['**/node_modules/**', 'vendor/**', '**/*.min.css', '{a,b}/x.css']);
  assert.ok(m('web/node_modules/bootstrap/a.css'));
  assert.ok(m('vendor/x/y.css'));
  assert.ok(m('css/app.min.css'));
  assert.ok(m('b/x.css'));
  assert.ok(!m('css/app.css'));
  assert.ok(globToRegExp('**/*.css').test('a.css'));
});

test('index: add, replace, remove, list, defs, skip', () => {
  const ix = new ClassIndex();
  ix.setFile('f1', scanStyles('.a{} .b{} #x{}').entries);
  ix.setFile('f2', scanStyles('.a{} .c{}').entries);
  assert.equal(ix.defs('c', 'a').length, 2);
  assert.deepEqual(ix.list('c').map((r) => r[0]).sort(), ['a', 'b', 'c']);
  ix.setFile('f1', scanStyles('.b{}').entries);
  assert.equal(ix.defs('c', 'a').length, 1);
  assert.equal(ix.defs('i', 'x').length, 0);
  ix.removeFile('f2');
  assert.deepEqual(ix.list('c').map((r) => r[0]), ['b']);
  ix.skip('f3', 'too large');
  assert.deepEqual(ix.stats(), { sheets: 1, frameworks: 0, classes: 1, ids: 0, entries: 1, skipped: 1 });
  assert.deepEqual(ix.list('c', new Set(['f1'])).map((r) => r[0]), ['b']);
});
