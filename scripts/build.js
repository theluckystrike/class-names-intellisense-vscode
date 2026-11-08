'use strict';
// Bundles the extension host with esbuild. No runtime dependencies; the framework lists are bundled JSON.
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const prod = process.argv.includes('--production');
esbuild.build({ bundle: true, minify: prod, sourcemap: false, legalComments: 'none', logLevel: 'warning', absWorkingDir: root,
  entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] })
  .then(() => console.log(`built: extension ${(fs.statSync(path.join(root, 'dist/extension.js')).size / 1024).toFixed(0)} KB`))
  .catch((e) => { console.error(e); process.exit(1); });
