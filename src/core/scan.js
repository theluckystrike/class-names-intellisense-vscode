'use strict';
// A small, linear CSS / SCSS / Less selector scanner. It finds the class and id names that a style sheet defines,
// with the line of the rule, the full selector and the first declarations (for hover). No dependencies.
// It never throws on broken input: unbalanced braces, unterminated strings and comments end the scan quietly.
// SCSS and Less nesting is resolved, so `.card { &__title {} }` gives `card__title`.

const OPAQUE_AT = new Set(['keyframes', '-webkit-keyframes', '-moz-keyframes', 'font-face', 'mixin', 'function', 'page',
  'property', 'counter-style', 'font-feature-values', 'font-palette-values', 'view-transition', 'return', 'starting-style-x']);
const MAX_RESOLVED = 200; // selector combinations per rule (deep nesting with lists can explode)
const MAX_BODY = 260;
const MAX_SEL = 200;

/** Splits a selector list on top-level commas (not in parens, brackets or strings). */
function splitList(s) {
  const out = [];
  let depth = 0, q = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (q) { if (c === 92) i++; else if (c === q) q = 0; continue; }
    if (c === 34 || c === 39) q = c;
    else if (c === 40 || c === 91) depth++;
    else if ((c === 41 || c === 93) && depth > 0) depth--;
    else if (c === 44 && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Resolves nested selectors against the parent list (SCSS / Less `&`). */
function resolve(parents, own) {
  if (!parents || parents.length === 0) return own.map((s) => s.replace(/&/g, '').trim()).filter(Boolean);
  const out = [];
  for (const p of parents) {
    for (const s of own) {
      out.push(s.includes('&') ? s.replace(/&/g, p) : p + ' ' + s);
      if (out.length >= MAX_RESOLVED) return out;
    }
  }
  return out;
}

function unescapeCss(s) {
  if (s.indexOf('\\') < 0) return s;
  return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (m, hex, ch) => {
    if (hex) { const cp = parseInt(hex, 16); return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; }
    return ch;
  });
}

const NAME_START = '(?:\\\\[0-9a-fA-F]{1,6}\\s?|\\\\[^\\n0-9a-fA-F]|[_a-zA-Z\\u00A0-\\uFFFF]|-(?=[_a-zA-Z\\u00A0-\\uFFFF\\\\-]))';
const NAME_CHAR = '(?:\\\\[0-9a-fA-F]{1,6}\\s?|\\\\[^\\n0-9a-fA-F]|[\\w\\u00A0-\\uFFFF-])';
const CLASS_RE = new RegExp('\\.(' + NAME_START + NAME_CHAR + '*)', 'g');
const ID_RE = new RegExp('#(' + NAME_CHAR + '+)', 'g');

/** Class and id names in one resolved selector. Interpolations were replaced with \0 before. */
function namesInSelector(sel, out) {
  // Attribute selectors and strings do not define classes.
  const s = sel.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""').replace(/(?<!\\)\[(?:\\.|[^\]\\])*\]/g, '[]');
  for (const [re, kind] of [[CLASS_RE, 'c'], [ID_RE, 'i']]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      const before = m.index > 0 ? s.charCodeAt(m.index - 1) : 32;
      const after = s.charCodeAt(m.index + m[0].length);
      // A name glued to an interpolation is not a usable name; ".m(" is a Less mixin call or definition.
      if (before === 0 || after === 0 || after === 40) continue;
      if (before === 92) continue; // an escaped '.' or '#' inside another name
      const name = unescapeCss(m[1]);
      if (name) out.push([kind, name]);
    }
  }
}

function isMixinDef(prelude) {
  // Less: `.m() {`, `.m(@a; @b) when (iscolor(@a)) {`, `#ns.m() {`
  return /^[.#][\w-]+(?:[.#][\w-]+)*\s*\([^)]*\)\s*(?:when\b.*)?$/s.test(prelude);
}

/**
 * Scans style sheet text.
 * opts.lang: 'css' | 'scss' | 'less' (line comments and nesting rules depend on it).
 * opts.maxEntries: stop after this many names (the result says truncated).
 * Returns { entries: [{ n, k, l, c, sel, body }], rules, truncated, broken }.
 *   n = name, k = 'c' (class) or 'i' (id), l = 0-based line, c = 0-based column, sel = full selector, body = declarations.
 */
function scanStyles(text, opts = {}) {
  const lang = opts.lang || 'css';
  const maxEntries = opts.maxEntries || 50000;
  const lineComments = lang === 'scss' || lang === 'less';
  const n = text.length;
  const entries = [];
  const stack = []; // frames: { type: 'rule' | 'at' | 'opaque', sels, decls, declLen, ents }
  let stmtStart = 0, stmtLine = 0, line = 0, lineStart = 0, paren = 0, rules = 0, truncated = false, broken = false;

  const top = () => stack[stack.length - 1];
  const parentSels = () => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const f = stack[k];
      if (f.type === 'rule' || (f.type === 'at' && f.sels !== undefined)) return f.sels;
    }
    return null;
  };
  const inOpaque = () => stack.some((f) => f.type === 'opaque');
  const addDecl = (end) => {
    const f = top();
    if (!f || f.type !== 'rule' || f.declLen >= MAX_BODY) return;
    let d = text.slice(stmtStart, end);
    if (d.indexOf('/*') >= 0) d = d.replace(/\/\*[\s\S]*?(\*\/|$)/g, '');
    d = d.replace(/\s+/g, ' ').trim();
    if (!d || d.indexOf(':') < 1) return;
    f.decls.push(d);
    f.declLen += d.length + 2;
  };
  // Line and column of the first non-space, non-comment char of the current statement.
  const stmtPos = () => {
    let i = stmtStart, l = stmtLine, ls = -1;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 10) { l++; ls = i; i++; continue; }
      if (c === 32 || c === 9 || c === 13 || c === 12) { i++; continue; }
      if (c === 47 && text.charCodeAt(i + 1) === 42) { const e = text.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; for (let j = i; j < end; j++) if (text.charCodeAt(j) === 10) { l++; ls = j; } i = end; continue; }
      if (lineComments && c === 47 && text.charCodeAt(i + 1) === 47) { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
      break;
    }
    const col = ls < 0 ? i - (stmtLineStart) : i - ls - 1;
    return [l, Math.max(0, col)];
  };
  let stmtLineStart = 0;
  const newStmt = (i) => { stmtStart = i; stmtLine = line; stmtLineStart = lineStart; };

  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) { line++; lineStart = i + 1; continue; }
    if (c === 47) { // '/'
      const d = text.charCodeAt(i + 1);
      if (d === 42) { // block comment
        const e = text.indexOf('*/', i + 2);
        const end = e < 0 ? n : e + 2;
        for (let j = i; j < end; j++) if (text.charCodeAt(j) === 10) { line++; lineStart = j + 1; }
        if (e < 0) broken = true;
        i = end - 1; continue;
      }
      if (d === 47 && lineComments && paren === 0) { const e = text.indexOf('\n', i); i = (e < 0 ? n : e) - 1; continue; }
      continue;
    }
    if (c === 34 || c === 39) { // string
      let j = i + 1;
      for (; j < n; j++) {
        const x = text.charCodeAt(j);
        if (x === 92) { if (text.charCodeAt(j + 1) === 10) { line++; lineStart = j + 2; } j++; continue; }
        if (x === c) break;
        if (x === 10) { broken = true; break; } // unterminated string ends at the line end
      }
      i = j; if (text.charCodeAt(j) === 10) { line++; lineStart = j + 1; }
      continue;
    }
    if (c === 92) { i++; continue; } // escaped char, e.g. `.md\:flex` or `.w-1\/2`
    if ((c === 35 || c === 64) && text.charCodeAt(i + 1) === 123) { // #{...} (SCSS) or @{...} (Less) interpolation
      let depth = 0, j = i + 1;
      for (; j < n; j++) {
        const x = text.charCodeAt(j);
        if (x === 10) { line++; lineStart = j + 1; }
        if (x === 123) depth++;
        else if (x === 125 && --depth === 0) break;
      }
      i = j; continue;
    }
    if (c === 40) { paren++; continue; }
    if (c === 41) { if (paren > 0) paren--; continue; }
    if (c === 59) { // ';'
      if (paren > 0) continue; // data: URLs have ';' inside url(...)
      addDecl(i); newStmt(i + 1); continue;
    }
    if (c === 123) { // '{'
      paren = 0;
      let prelude = text.slice(stmtStart, i);
      if (prelude.indexOf('/') >= 0) prelude = prelude.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(lineComments ? /\/\/[^\n]*/g : /$^/, ' ');
      prelude = prelude.replace(/[#@]\{(?:[^{}]|\{[^{}]*\})*\}/g, '\u0000').trim();
      const [pl, pc] = stmtPos();
      let frame;
      if (inOpaque()) frame = { type: 'opaque' };
      else if (prelude.charCodeAt(0) === 64) { // at-rule
        const name = (/^@([\w-]+)/.exec(prelude) || [, ''])[1].toLowerCase();
        if (name === 'at-root') {
          const rest = prelude.slice(8).trim();
          if (rest && !rest.startsWith('(')) frame = ruleFrame(splitList(rest), null);
          else frame = { type: 'at', sels: null };
        } else if (OPAQUE_AT.has(name) || /^@[\w-]+\s*:/.test(prelude)) frame = { type: 'opaque' };
        else frame = { type: 'at', sels: parentSels() };
      } else if (lang !== 'css' && /^[\w-]+\s*:(\s|$)/.test(prelude) && !/[.#&]/.test(prelude)) {
        frame = { type: 'opaque' }; // SCSS nested property: `font: { family: x; }`
      } else if (!prelude) frame = { type: 'at', sels: parentSels() };
      else {
        const own = splitList(prelude).filter((s) => !(lang === 'less' && isMixinDef(s)) && !s.startsWith('%'));
        if (own.length === 0) frame = { type: 'opaque' };
        else frame = ruleFrame(own, parentSels());
      }
      stack.push(frame);
      if (frame.type === 'rule' && !truncated) {
        rules++;
        const seen = new Set();
        const found = [];
        for (const sel of frame.sels) namesInSelector(sel, found);
        const selText = frame.sels.join(', ').replace(/\u0000/g, '#{…}');
        const shownSel = selText.length > MAX_SEL ? selText.slice(0, MAX_SEL - 1) + '…' : selText;
        for (const [k, name] of found) {
          const key = k + name;
          if (seen.has(key)) continue;
          seen.add(key);
          const e = { n: name, k, l: pl, c: pc, sel: shownSel, body: '' };
          frame.ents.push(e);
          entries.push(e);
          if (entries.length >= maxEntries) { truncated = true; break; }
        }
      }
      newStmt(i + 1);
      continue;
    }
    if (c === 125) { // '}'
      paren = 0;
      const f = stack.pop();
      if (!f) { broken = true; newStmt(i + 1); continue; }
      if (f.type === 'rule') {
        stack.push(f); addDecl(i); stack.pop();
        if (f.ents.length) { const body = f.decls.join('; '); for (const e of f.ents) e.body = body; }
      }
      newStmt(i + 1);
      continue;
    }
  }
  if (stack.length) {
    broken = true;
    while (stack.length) { const f = stack.pop(); if (f.type === 'rule' && f.ents.length) { const b = f.decls.join('; '); for (const e of f.ents) e.body = b; } }
  }
  return { entries, rules, truncated, broken };

  function ruleFrame(own, parents) {
    return { type: 'rule', sels: resolve(parents, own), decls: [], declLen: 0, ents: [] };
  }
}

/** 'css' | 'scss' | 'less' from a file name, or '' when it is not a style sheet. */
function styleLang(fileName) {
  const m = /\.(css|scss|less|pcss|postcss)$/i.exec(String(fileName || ''));
  if (!m) return '';
  const x = m[1].toLowerCase();
  return x === 'pcss' || x === 'postcss' ? 'scss' : x;
}

module.exports = { scanStyles, splitList, resolve, namesInSelector, unescapeCss, styleLang, isMixinDef };
