'use strict';
// Reads the parts of a template or script file that bring in styles: <style> blocks, <link rel="stylesheet">,
// <style src>, and CSS module imports. Pure text work, no file access and no network.

const MAX_DOC = 3 * 1024 * 1024; // larger documents are not searched for <style> and <link> (completion still works)

/** <style> blocks: [{ lang, text, line, module }]. line is the 0-based line where the block text starts. */
function styleBlocks(text) {
  if (!text || text.length > MAX_DOC || text.indexOf('<style') < 0) return [];
  const out = [];
  const re = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;
  let m;
  while ((m = re.exec(text)) && out.length < 50) {
    const attrs = m[1];
    if (/\bsrc\s*=/.test(attrs)) continue;
    const lang = (/\blang\s*=\s*["']?(scss|sass|less|css|postcss|stylus)/i.exec(attrs) || [, 'css'])[1].toLowerCase();
    if (lang === 'sass' || lang === 'stylus') continue; // indented syntaxes are not read
    const start = m.index + m[0].indexOf('>') + 1;
    const line = countLines(text, start);
    const mod = /\bmodule\b/.exec(attrs);
    out.push({ lang: lang === 'postcss' ? 'scss' : lang, text: m[2], line, module: mod ? ((/\bmodule\s*=\s*["']([\w$]+)["']/.exec(attrs) || [, '$style'])[1]) : '' });
  }
  return out;
}

function countLines(text, end) {
  let n = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < end; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/** Style sheet references: <link rel="stylesheet" href>, <style src>, and <link href="*.css"> without rel. */
function linkedSheets(text) {
  if (!text || text.length > MAX_DOC) return [];
  const out = [];
  const re = /<link\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(text)) && out.length < 100) {
    const a = m[1];
    const href = attr(a, 'href');
    if (!href) continue;
    const rel = (attr(a, 'rel') || '').toLowerCase();
    if (rel.split(/\s+/).includes('stylesheet') || (!rel && /\.(css|scss|less)(\?|#|$)/i.test(href))) out.push(href);
  }
  const re2 = /<style\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  while ((m = re2.exec(text)) && out.length < 100) out.push(m[1]);
  return out;
}

function attr(a, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(a);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
}

/** true when href points outside this computer (we never fetch it). */
function isRemote(href) {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(href) || /^(data|blob):/i.test(href);
}

/** 'bootstrap5' | 'bulma' | '' for a CDN link, so we can offer the bundled class list. */
function cdnFramework(href) {
  const h = String(href || '').toLowerCase();
  if (/bootstrap(@|\/)5|bootstrap\/5\.|bootstrap@\^?5|twitter-bootstrap\/5/.test(h) && /\.css/.test(h)) return 'bootstrap5';
  if (/bootstrap/.test(h) && /bootstrap(\.min)?\.css/.test(h) && !/bootstrap(@|\/)[34]/.test(h)) return 'bootstrap5';
  if (/bulma/.test(h) && /\.css/.test(h)) return 'bulma';
  return '';
}

/**
 * CSS module bindings in a JS/TS file: Map binding -> import path.
 * import styles from './a.module.css'; import * as s from './b.scss'; const c = require('./c.module.less')
 */
function moduleImports(text) {
  const out = new Map();
  if (!text) return out;
  const head = text.length > MAX_DOC ? text.slice(0, MAX_DOC) : text;
  const ext = String.raw`\.(?:css|scss|less|pcss|postcss)(?:\?[\w=&-]*)?`;
  const res = [
    new RegExp(String.raw`import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\}\s*)?from\s*["']([^"']+${ext})["']`, 'g'),
    new RegExp(String.raw`import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+${ext})["']`, 'g'),
    new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+${ext})["']\s*\)`, 'g'),
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(head))) out.set(m[1], m[2].replace(/\?.*$/, ''));
  }
  return out;
}

/** Converts .gitignore lines to VS Code glob patterns (simple cases; negations are left out). */
function gitignoreGlobs(text, prefix = '') {
  const out = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.replace(/\s+$/, '');
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    line = line.replace(/^\\/, '');
    const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
    let p = line.replace(/^\//, '').replace(/\/$/, '');
    if (!p || /[{}]/.test(p)) continue;
    const base = (prefix ? prefix.replace(/\/$/, '') + '/' : '') + (anchored ? '' : '**/');
    out.push(base + p, base + p + '/**');
  }
  return [...new Set(out)];
}

module.exports = { styleBlocks, linkedSheets, isRemote, cdnFramework, moduleImports, gitignoreGlobs, MAX_DOC, countLines };
