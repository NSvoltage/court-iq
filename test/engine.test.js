'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The engine modules attach to globalThis (they run in the browser too).
require('../src/engine/base.js');
require('../src/engine/augment.js');

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'sample-match.json'), 'utf8'));
const M = globalThis.SVEngine3.build(sample);

test('parses, dedupes, and identifies players', () => {
  assert.ok(M.meta.clean_shot_rows > 1000, 'has clean shots');
  assert.ok(M.meta.corrupt_dupes_removed > 0, 'removed duplicate rows');
  assert.equal(typeof M.meta.tracked, 'string');
  assert.equal(M.meta.opp, 'Opp');
});

test('measured serve metrics are plausible', () => {
  assert.ok(M.serve.you.avg_speed > 60 && M.serve.you.avg_speed < 130);
  assert.ok(M.serve.you.in_rate >= 0 && M.serve.you.in_rate <= 100);
});

test('measured per-shot reliability', () => {
  assert.ok(M.player.reliability.you.in_play_pct > 50);
  assert.ok(M.player.reliability.you.miss_net + M.player.reliability.you.miss_out > 0);
});

test('measured positioning (contact vs baseline)', () => {
  assert.equal(typeof M.player.positioning.you.median_contact_m, 'number');
  assert.ok(M.player.positioning.you.deep_pct >= 0 && M.player.positioning.you.deep_pct <= 100);
});

test('modelled shot quality in range', () => {
  assert.ok(M.quality.you.groundstroke_q >= 0 && M.quality.you.groundstroke_q <= 100);
  assert.equal(typeof M.quality.you.expected_winners, 'number');
});

test('outcome reconstruction covers every point', () => {
  const r = M.reconstruction;
  assert.equal(r.reconstructed_score.you + r.reconstructed_score.opp, r.total_points);
  assert.ok(r.pct_estimated >= 0 && r.pct_estimated <= 100);
  assert.ok(r.sources.measured > 0);
});

test('patterns are produced', () => {
  assert.ok(Array.isArray(M.patterns2.you.serve_plus_one));
  assert.ok(M.patterns2.you.tendency.Forehand.length > 0);
  assert.ok(Array.isArray(M.patterns2.top_openings));
});

test('targeting: placement distribution + segments', () => {
  const tg = M.targeting.you;
  assert.ok(tg.n > 100, 'has groundstrokes');
  const s = tg.lateral.left_pct + tg.lateral.middle_pct + tg.lateral.right_pct;
  assert.ok(s >= 98 && s <= 102, 'lateral split sums to ~100');
  assert.equal(tg.grid.length, 3);
  assert.equal(tg.segments.length, 3);
  assert.equal(M.targeting.segment_labels.length, 3);
  assert.ok(M.targeting.segment_labels[2].to >= M.targeting.segment_labels[0].to);
});

test('per-shot trajectories carry coords + quality', () => {
  assert.ok(M.trajectories.length > 500);
  const t = M.trajectories.find((x) => x.result === 'In' && (x.stroke === 'Forehand' || x.stroke === 'Backhand'));
  assert.equal(typeof t.bx, 'number');
  assert.ok(t.q === null || (t.q >= 0 && t.q <= 100));
});
