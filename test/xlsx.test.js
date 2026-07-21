'use strict';
// End-to-end cover for the path a real user takes: a SwingVision .xlsx off the
// phone, through the unzip + XML parse, into the engine. The bundled
// sample-match.json is a dump of this same export, so the two must agree -
// if they ever diverge, the JSON has been edited without regenerating it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// in the browser fflate is a global; under Node its UMD wrapper exports instead,
// so put it back on the global that xlsxlite reaches for
globalThis.fflate = require('../src/vendor/fflate.js');
require('../src/vendor/xlsxlite.js');
require('../src/engine/base.js');
require('../src/engine/integrity.js');
require('../src/engine/augment.js');

const XLSX = path.join(__dirname, '..', 'examples', 'sample-match.xlsx');
const raw = globalThis.xlsxlite.parse(new Uint8Array(fs.readFileSync(XLSX)));

test('reads a real SwingVision .xlsx off disk', () => {
  assert.deepEqual(Object.keys(raw).sort(), ['Rallies', 'Settings', 'Shots']);
  assert.ok(raw.Shots.length > 1000, 'has shot rows');
  assert.ok(raw.Rallies.length > 100, 'has rally rows');
  // header row then data, as the engine expects
  assert.ok(raw.Shots[0].includes('Result'));
});

test('the demo export carries no identifying name', () => {
  // this file ships in a public repo - it must not name a real person
  const blob = JSON.stringify(raw);
  assert.ok(!/Panging/.test(blob), 'surname present in the export');
});

test('the .xlsx and the bundled JSON sample describe the same match', () => {
  const fromXlsx = globalThis.SVEngine3.build(raw);
  const fromJson = globalThis.SVEngine3.build(
    JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'sample-match.json'), 'utf8'))
  );
  assert.equal(fromXlsx.match.total_shots, fromJson.match.total_shots);
  assert.equal(fromXlsx.match.total_points, fromJson.match.total_points);
  assert.equal(fromXlsx.meta.tracked, fromJson.meta.tracked);
  assert.deepEqual(fromXlsx.match.points_won, fromJson.match.points_won);
});
