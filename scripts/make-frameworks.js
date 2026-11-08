'use strict';
// Builds data/<framework>.json (class name, selector, first declarations) from the MIT-licensed dist CSS of
// Bootstrap 5 and Bulma. Run: node scripts/make-frameworks.js <bootstrap.css> <bulma.css>
// The JSON ships in the package so CDN users get completions without any download.
const fs = require('fs');
const path = require('path');
const { scanStyles } = require('../src/core/scan.js');

function build(file, name, version, license) {
  const r = scanStyles(fs.readFileSync(file, 'utf8'), { lang: 'css', maxEntries: 200000 });
  const seen = new Map();
  for (const e of r.entries) {
    if (e.k !== 'c' || seen.has(e.n)) continue;
    seen.set(e.n, [e.n, e.sel.length > 90 ? e.sel.slice(0, 89) + '…' : e.sel, e.body.length > 160 ? e.body.slice(0, 159) + '…' : e.body]);
  }
  const out = { name, version, license, classes: [...seen.values()] };
  const dest = path.join(__dirname, '..', 'data', name.toLowerCase().replace(/\s+/g, '') + '.json');
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(dest, out.classes.length, 'classes', (fs.statSync(dest).size / 1024).toFixed(0) + ' KB');
}
const [bs, bu] = process.argv.slice(2);
build(bs, 'Bootstrap5', JSON.parse(fs.readFileSync(path.join(path.dirname(bs), '../../package.json'))).version, 'MIT, (c) The Bootstrap Authors');
build(bu, 'Bulma', JSON.parse(fs.readFileSync(path.join(path.dirname(bu), '../package.json'))).version, 'MIT, (c) Jeremy Thomas');
