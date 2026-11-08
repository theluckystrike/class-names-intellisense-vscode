'use strict';
// Finds out whether the cursor is in a place where a CSS class or id name goes, from the text before the cursor.
// Works on a window of text (the caller passes the last few thousand chars), so it costs the same in a 50 MB file.
// Pure: no VS Code API, so the tests call it directly.

const WINDOW = 6000;

const DEFAULT_FUNCTIONS = ['clsx', 'cn', 'cx', 'classnames', 'classNames', 'twMerge', 'twJoin', 'cva', 'tv', 'classList', 'ctl'];
// Attributes whose value is a plain list of class names.
const PLAIN_CLASS = new Set(['class', 'classname', 'classlist', 'ngclass', 'stylename', 'tw', 'v-bind:class-plain']);
// Attributes whose value is a JS expression (class names are inside its string literals).
const JS_CLASS = new Set([':class', 'v-bind:class', '[class]', '[ngclass]', 'x-bind:class', ':classname', 'class:list', 'v-bind:classname']);
const ID_ATTRS = new Set(['id', ':id', 'v-bind:id', '[id]']);

const ATTR_RE = /(?:^|[\s"'`{(,])((?:v-bind|x-bind)?:?(?:class|className|classList|ngClass|styleName|tw|id)|\[(?:class|ngClass|id)\]|class:list)\s*=\s*(?=["'`{]|[\w-])/g;
const CLASS_CHAR = /[^\s"'`{}()<>=,;\\]/;

function lastMatch(re, text) {
  re.lastIndex = 0;
  let m, last = null;
  while ((m = re.exec(text))) { last = m; if (m[0].length === 0) re.lastIndex++; }
  return last;
}

/** Index just past a template region that starts at i ({{ }}, {% %}, {# #}, <? ?>, <% %>, @{{ }}), or -1. */
function skipTemplate(t, i) {
  const two = t.slice(i, i + 2);
  const close = { '{{': '}}', '{%': '%}', '{#': '#}', '<?': '?>', '<%': '%>', '${': '}' }[two];
  if (!close) return -1;
  const e = t.indexOf(close, i + 2);
  return e < 0 ? Infinity : e + close.length;
}

/**
 * Scans JS-ish code from `from` to the end of t. Returns { inString: bool, strStart, depthEnd } where inString tells
 * whether the end of t is inside a string or template literal text, and closed is true when the bracket that opened
 * the region (depth 0 at `from`) was closed before the end.
 * open: the number of brackets already open at `from` (1 for `{` of a JSX expression, 1 for `(` of a call).
 */
function scanJs(t, from, open, endQuote) {
  let depth = open, i = from;
  const tpl = []; // stack of brace depths at which a template literal resumes
  let q = 0, strStart = -1;
  for (; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (q) {
      if (c === 92) { i++; continue; }
      if (q === 96 && c === 36 && t.charCodeAt(i + 1) === 123) { tpl.push(depth); depth++; q = 0; i++; continue; }
      if (c === q) { q = 0; continue; }
      if (c === 10 && q !== 96) { q = 0; continue; }
      continue;
    }
    if (endQuote && c === endQuote) return { inString: false, closed: true };
    if (c === 34 || c === 39 || c === 96) { q = c; strStart = i + 1; continue; }
    if (c === 47 && t.charCodeAt(i + 1) === 47) { const e = t.indexOf('\n', i); if (e < 0) return { inString: false, closed: false, comment: true }; i = e; continue; }
    if (c === 47 && t.charCodeAt(i + 1) === 42) { const e = t.indexOf('*/', i + 2); if (e < 0) return { inString: false, closed: false, comment: true }; i = e + 1; continue; }
    if (c === 40 || c === 91 || c === 123) depth++;
    else if (c === 41 || c === 93 || c === 125) {
      depth--;
      if (c === 125 && tpl.length && tpl[tpl.length - 1] === depth) { tpl.pop(); q = 96; strStart = i + 1; continue; }
      if (depth <= 0) return { inString: false, closed: true };
    }
  }
  return { inString: q !== 0, strStart, closed: false, quote: q };
}

function wordBefore(t) {
  let i = t.length;
  while (i > 0 && CLASS_CHAR.test(t[i - 1])) i--;
  return i;
}

function tokensOf(s) {
  return s.split(/[\s"'`{}(),;]+/).filter((x) => x && !/[<>=?:$]/.test(x));
}

/**
 * The completion context at the end of `before`.
 * opts.functions: names of class helper functions (clsx, cn, ...).
 * opts.modules: Map or object { bindingName: anything } of CSS module bindings in this file (styles, $style, ...).
 * opts.svelte: true to support `class:name` directives.
 * Returns null, or { kind: 'class' | 'id' | 'module', prefix, existing: string[], module?: binding, bracket?: quote }.
 */
function completionContext(before, opts = {}) {
  const t = before.length > WINDOW ? before.slice(before.length - WINDOW) : before;
  const fnNames = opts.functions || DEFAULT_FUNCTIONS;
  const modules = opts.modules || null;

  // CSS modules: styles.na|  or  styles['na|
  if (modules) {
    const dot = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)(\??\.)([\w$]*)$/.exec(t);
    if (dot && has(modules, dot[1])) return { kind: 'module', module: dot[1], prefix: dot[3], existing: [], access: 'dot' };
    const br = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\[\s*(["'`])([^"'`\]]*)$/.exec(t);
    if (br && has(modules, br[1])) return { kind: 'module', module: br[1], prefix: br[3], existing: [], access: 'bracket', quote: br[2] };
  }

  const attr = attributeContext(t);
  if (attr) return attr;

  // Helper calls: clsx('a', cond && 'b|')  cn(`x ${y} |`)  tw`...|`
  if (fnNames.length) {
    const esc = fnNames.map((f) => f.replace(/[$]/g, '\\$')).join('|');
    const re = new RegExp('(?:^|[^\\w$.])(?:' + esc + ')\\s*(\\(|`)', 'g');
    const m = lastMatch(re, t);
    if (m) {
      const from = m.index + m[0].length;
      const r = m[1] === '`' ? { inString: true, ...scanJs('`' + t.slice(from), 0, 0) } : scanJs(t, from, 1);
      if (r.inString && !r.closed) {
        const region = m[1] === '`' ? t.slice(from) : t.slice(r.strStart);
        return classAt(t, region, 'class');
      }
    }
  }

  // Svelte: class:name={...}
  if (opts.svelte !== false) {
    const sv = /<[\w:-]+\b[^<>]*\sclass:([\w-]*)$/.exec(t);
    if (sv && !insideQuotes(t.slice(t.lastIndexOf('<')))) return { kind: 'class', prefix: sv[1], existing: [], directive: true };
  }
  return null;
}

function has(m, k) { return m instanceof Map ? m.has(k) : Object.prototype.hasOwnProperty.call(m, k); }

function insideQuotes(tag) {
  let q = 0;
  for (let i = 0; i < tag.length; i++) {
    const c = tag.charCodeAt(i);
    if (q) { if (c === q) q = 0; } else if (c === 34 || c === 39) q = c;
  }
  return q !== 0;
}

function classAt(t, region, kind) {
  const start = wordBefore(t);
  const prefix = t.slice(start);
  const existing = tokensOf(region.slice(0, Math.max(0, region.length - prefix.length)));
  return { kind, prefix, existing };
}

function attributeContext(t) {
  const m = lastMatch(ATTR_RE, t);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const isId = ID_ATTRS.has(name);
  const isJs = JS_CLASS.has(name);
  if (!isId && !isJs && !PLAIN_CLASS.has(name)) return null;
  // Must be an attribute in a tag or JSX, not `x.className = ` in plain JS. A preceding '.' means a property access.
  const pre = t[m.index + m[0].indexOf(m[1]) - 1];
  if (pre === '.') return null;
  const vStart = m.index + m[0].length;
  const d = t[vStart];
  if (d === undefined) return null;
  const kind = isId ? 'id' : 'class';
  if (d === '{') {
    // JSX: className={...}, Astro class:list={[...]}
    const r = scanJs(t, vStart + 1, 1);
    if (r.inString && !r.closed) return classAt(t, t.slice(r.strStart), kind);
    return null;
  }
  if (d === '"' || d === "'" || d === '`') {
    const from = vStart + 1;
    if (isJs) {
      // :class="{ active: on, 'text-red': bad }" -> inner string literals hold the names.
      const r = scanJs(t, from, 1, d.charCodeAt(0));
      if (r.inString && !r.closed) return classAt(t, t.slice(r.strStart), kind);
      return null;
    }
    // Plain value: up to the closing quote, stepping over template regions ({{ }}, {% %}, <?php ?>, <%= %>).
    let i = from;
    while (i < t.length) {
      const c = t[i];
      if (c === d) return null; // the attribute closed before the cursor
      if (c === '{' || c === '<' || c === '$') {
        const e = skipTemplate(t, i);
        if (e === Infinity) return null; // the cursor is inside {{ ... }}
        if (e > 0) { i = e; continue; }
      }
      if (c === '\n' && d === '`') { i++; continue; }
      i++;
    }
    const region = t.slice(from);
    if (kind === 'id') {
      const start = wordBefore(t);
      if (/\s/.test(region.slice(0, region.length - (t.length - start)))) return null; // an id is one word
      return { kind, prefix: t.slice(start), existing: [] };
    }
    return classAt(t, stripTemplates(region), kind);
  }
  // Unquoted HTML value: class=btn|
  const rest = t.slice(vStart);
  if (/^[\w-]*$/.test(rest)) return { kind, prefix: rest, existing: [] };
  return null;
}

function stripTemplates(s) {
  return s.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|<\?[\s\S]*?\?>|<%[\s\S]*?%>|\$\{[^}]*\}/g, ' ');
}

/** Number of class-name chars right after the cursor (to replace the rest of the word on accept). */
function wordAfterLength(after) {
  let i = 0;
  while (i < after.length && i < 200 && CLASS_CHAR.test(after[i])) i++;
  return i;
}

module.exports = { completionContext, wordAfterLength, scanJs, DEFAULT_FUNCTIONS, WINDOW, CLASS_CHAR };
