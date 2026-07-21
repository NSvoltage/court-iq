#!/usr/bin/env node
/*
 * Court IQ build — concatenates the browser modules + the sample match into the
 * HTML template and writes a single self-contained dist/index.html.
 * Zero dependencies (Node built-ins only). Order matters: vendor first, then
 * the engine layers (base -> augment -> career), then the sample data.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MODULES = [
  'src/vendor/fflate.js',    // CSP-safe unzip (vendored)
  'src/vendor/xlsxlite.js',  // minimal .xlsx reader
  'src/engine/base.js',      // window.SVEngine  — measured + first-order inferred model
  'src/engine/integrity.js', // window.SVIntegrity — classify/reconstruct/correct/verify (before augment)
  'src/engine/augment.js',   // window.SVEngine3 — shot quality, reconstructed outcomes, patterns
  'src/engine/career.js',    // window.Career    — longitudinal fingerprints, trends, insights
];

function build() {
  // Embed the sample match; neutralise any "</" so it can't close the <script> early.
  const sample = read('src/data/sample-match.json').replace(/<\//g, '<\\/');
  const assets = MODULES.map(read).join('\n') + '\nwindow.SAMPLE_RAW=' + sample + ';';

  let tpl = read('src/template.html');
  if (!tpl.includes('/*__ASSETS__*/')) {
    throw new Error('src/template.html is missing the /*__ASSETS__*/ marker');
  }
  // Use a function replacement so `$` sequences in the code (e.g. fflate's `$e$`)
  // are inserted literally, not treated as special replacement patterns.
  let body = tpl.replace('/*__ASSETS__*/', () => assets);

  // Hoist <title> from the body fragment into a proper <head>.
  const m = body.match(/<title>([\s\S]*?)<\/title>/i);
  const title = m ? m[1].trim() : 'Court IQ';
  body = body.replace(/<title>[\s\S]*?<\/title>\s*/i, '');

  const html =
    '<!doctype html>\n<html lang="en">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="description" content="Self-hosted tennis analytics from SwingVision exports.">\n' +
    '<title>' + title + '</title>\n' +
    '</head>\n<body>\n' + body + '\n</body>\n</html>\n';

  const outDir = path.join(ROOT, 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  // GitHub Pages: disable Jekyll so files aren't reprocessed.
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
  console.log('Built dist/index.html — ' + Math.round(html.length / 1024) + ' KB (self-contained)');
}

build();
