'use strict';
// The class and id index: per-file entries from scan.js and a name -> definitions map built from them.
// Pure (no VS Code API). Files are keyed by a string (a URI or "framework:<name>").

class ClassIndex {
  constructor() {
    this.files = new Map(); // key -> { entries, lang, size, label }
    this.names = { c: new Map(), i: new Map() }; // name -> [entry, ...] (each entry has .f = file key)
    this.skipped = new Map(); // key -> reason
    this.version = 0;
  }

  setFile(key, entries, meta = {}) {
    this.removeFile(key, true);
    this.skipped.delete(key);
    for (const e of entries) {
      e.f = key;
      const m = this.names[e.k];
      if (!m) continue;
      const list = m.get(e.n);
      if (list) list.push(e); else m.set(e.n, [e]);
    }
    this.files.set(key, { entries, lang: meta.lang || 'css', size: meta.size || 0, label: meta.label || key, broken: !!meta.broken, truncated: !!meta.truncated });
    this.version++;
  }

  removeFile(key, quiet) {
    const f = this.files.get(key);
    if (f) {
      for (const e of f.entries) {
        const m = this.names[e.k];
        const list = m && m.get(e.n);
        if (!list) continue;
        const rest = list.filter((x) => x.f !== key);
        if (rest.length) m.set(e.n, rest); else m.delete(e.n);
      }
      this.files.delete(key);
    }
    this.skipped.delete(key);
    if (!quiet) this.version++;
  }

  skip(key, reason) {
    this.removeFile(key, true);
    this.skipped.set(key, reason);
    this.version++;
  }

  clear() {
    this.files.clear(); this.names.c.clear(); this.names.i.clear(); this.skipped.clear(); this.version++;
  }

  /** Definitions of a name ('c' or 'i'), optionally only from some files. */
  defs(kind, name, onlyFiles) {
    const list = this.names[kind].get(name) || [];
    return onlyFiles ? list.filter((e) => onlyFiles.has(e.f)) : list;
  }

  /** Names of one kind with their first definition: [[name, entry, count], ...]. */
  list(kind, onlyFiles) {
    const out = [];
    if (onlyFiles) {
      const seen = new Map();
      for (const key of onlyFiles) {
        const f = this.files.get(key);
        if (!f) continue;
        for (const e of f.entries) if (e.k === kind) { const s = seen.get(e.n); if (s) s[2]++; else { const row = [e.n, e, 1]; seen.set(e.n, row); out.push(row); } }
      }
      return out;
    }
    for (const [name, list] of this.names[kind]) out.push([name, list[0], list.length]);
    return out;
  }

  fileEntries(key) {
    const f = this.files.get(key);
    return f ? f.entries : null;
  }

  stats() {
    let fw = 0, sheets = 0, entries = 0;
    for (const [k, f] of this.files) { if (k.startsWith('framework:')) fw++; else sheets++; entries += f.entries.length; }
    return { sheets, frameworks: fw, classes: this.names.c.size, ids: this.names.i.size, entries, skipped: this.skipped.size };
  }
}

/** A tiny glob matcher for exclude checks on watcher events: **, *, ?, {a,b}. */
function globToRegExp(glob) {
  let re = '';
  let inBrace = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { inBrace++; re += '(?:'; }
    else if (c === '}' && inBrace) { inBrace--; re += ')'; }
    else if (c === ',' && inBrace) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function makeMatcher(globs) {
  const res = globs.map(globToRegExp);
  return (rel) => res.some((r) => r.test(rel));
}

module.exports = { ClassIndex, globToRegExp, makeMatcher };
