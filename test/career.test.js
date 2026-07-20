'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Minimal localStorage shim so the browser Career module runs under Node.
const _store = {};
globalThis.localStorage = {
  getItem: (k) => (k in _store ? _store[k] : null),
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
};

require('../src/engine/base.js');
require('../src/engine/augment.js');
require('../src/engine/career.js');

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'sample-match.json'), 'utf8'));
const M = globalThis.SVEngine3.build(sample);
const Career = globalThis.Career;

test('fingerprint is complete and rate-based', () => {
  const fp = Career.fingerprint(M, { date: 1000, date_str: '2026-01-01' });
  assert.ok(fp.id);
  assert.equal(typeof fp.metrics.in_play_pct, 'number');
  assert.equal(typeof fp.metrics.shot_quality, 'number');
  assert.ok(fp.weight > 0 && fp.weight <= 1);
});

test('trendOf honours goodDir and rejects noise', () => {
  const up = [10, 11, 12, 13, 14].map((v) => ({ value: v, weight: 1 }));
  const down = [14, 13, 12, 11, 10].map((v) => ({ value: v, weight: 1 }));
  const flat = [12, 11.9, 12.1, 12, 12.05].map((v) => ({ value: v, weight: 1 }));
  assert.equal(Career.trendOf(up, 1).dir, 'up');
  assert.equal(Career.trendOf(up, 1).improving, true);
  assert.equal(Career.trendOf(up, -1).improving, false); // rising is bad when lower is better
  assert.equal(Career.trendOf(down, 1).dir, 'down');
  assert.equal(Career.trendOf(flat, 1).dir, 'flat');
  assert.equal(Career.trendOf([{ value: 1, weight: 1 }, { value: 2, weight: 1 }], 1).significant, false);
});

test('add / dedupe / export-import round-trip', () => {
  Career.clearAll();
  const base = Career.fingerprint(M, { date: 2000, date_str: '2026-02-01' });
  Career.demoSeed(base).forEach((r) => Career.add(r));
  let recs = Career.add(base, M);
  assert.equal(recs.length, 5, 'demo seed (4) + real match (1)');
  recs = Career.add(base, M); // same id again
  assert.equal(recs.length, 5, 'deduped by id');
  assert.ok(Career.fullModel(base.id), 'full model cached for the real match');

  const text = Career.exportText();
  Career.clearAll();
  assert.equal(Career.load().length, 0);
  assert.equal(Career.importText(text).length, 5, 'restored from export');
});

test('insights are generated from a history', () => {
  const ins = Career.insights(Career.load());
  assert.ok(ins.length > 0);
  ins.forEach((c) => {
    assert.ok(c.title && c.scope);
    assert.ok(['good', 'bad', 'neutral'].includes(c.tone));
  });
});

test('clearDemo removes only demo matches', () => {
  Career.clearAll();
  const base = Career.fingerprint(M, { date: 3000, date_str: '2026-03-01' });
  Career.demoSeed(base).forEach((r) => Career.add(r));
  Career.add(base, M);
  const after = Career.clearDemo();
  assert.equal(after.length, 1);
  assert.equal(after[0].demo, false);
});
