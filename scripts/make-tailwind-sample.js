'use strict';
// Makes samples/tailwind-site/dist/output.css: the rules of a real Tailwind 2.2 build (MIT) for a set of utility
// prefixes, as a purged production build would keep them. Run: node scripts/make-tailwind-sample.js <tailwind.css>
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(process.argv[2], 'utf8');
const keep = /^\.(?:\\?(?:hover|md|lg|focus)\\:)?(?:bg-(?:white|gray|blue)|text-|font-|p[xytrbl]?-|m[xytrbl]?-|mx-auto|max-w-|grid|gap-|col-|flex|items-|justify-|rounded|shadow|block|inline|hidden|uppercase|tracking-|leading-|w-|h-|border)/;
const out = ['/*! tailwindcss v2.2.19 | MIT License | https://tailwindcss.com (purged sample) */'];
// Top-level rules and @media blocks of the dist file: one rule per line group, so a simple splitter is enough.
const re = /(@media[^{]+\{)([\s\S]*?\n\})\n|([^{}@][^{}]*)\{([^{}]*)\}/g;
let m, n = 0;
while ((m = re.exec(src))) {
  if (m[1]) {
    const inner = [];
    const r2 = /([^{}]+)\{([^{}]*)\}/g; let k;
    while ((k = r2.exec(m[2]))) { const sel = k[1].trim(); if (keep.test(sel) && !/[0-9]\\\/|-\d{2,}\b/.test(sel) && !/(?:yellow|red|green|indigo|purple|pink)/.test(sel)) inner.push(`  ${sel} {${k[2]}}`); }
    if (inner.length) out.push(m[1].trim() + '\n' + inner.slice(0, 400).join('\n') + '\n}');
  } else {
    const sel = m[3].trim();
    if (keep.test(sel) && !/(?:yellow|red|green|indigo|purple|pink)/.test(sel)) { out.push(`${sel} {${m[4]}}`); n++; }
  }
}
const dest = path.join(__dirname, '..', 'samples', 'tailwind-site', 'dist', 'output.css');
fs.writeFileSync(dest, out.join('\n') + '\n');
console.log(dest, n, 'rules', (fs.statSync(dest).size / 1024).toFixed(0) + ' KB');
