'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The engine modules attach to globalThis (they run in the browser too).
require('../src/engine/base.js');
require('../src/engine/integrity.js');
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

test('one scoreboard: the score agrees with the point count everywhere', () => {
  const r = M.reconstruction;
  // the headline point count, the scoreboard and the recomputed tally are one number
  assert.equal(r.reconstructed_score.you + r.reconstructed_score.opp, M.match.total_points);
  assert.equal(r.reconstructed_score.you, M.match.points_won.you);
  assert.equal(r.reconstructed_score.opp, M.match.points_won.opp);
  assert.equal(r.total_points, M.points.length);
  // rallies with no shots logged are counted, never scored - scoring them
  // would invent an outcome and inflate the board past the points played
  assert.ok(r.rallies_seen >= r.total_points);
  assert.equal(r.rallies_seen - r.total_points, r.untracked_rallies);
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

test('integrity: verification judges stat-family confidence', () => {
  const v = M.integrity.verification;
  assert.equal(typeof v.level, 'string');
  assert.ok(Array.isArray(v.flags));
  assert.equal(v.game_structure_recoverable, false); // no games in this export
  assert.equal(v.reliable.break_points, false);
  assert.equal(v.reliable.games_sets, false);
  assert.equal(v.reliable.measured_shots, true);
  assert.equal(v.reliable.errors, true);
  assert.ok(v.flags.some((f) => f.code === 'no_game_structure'));
  assert.ok(Array.isArray(v.annotate)); // which stat families need a UI footnote
});

test('integrity: repair corrects impossible tennis', () => {
  const r = M.integrity.repair;
  assert.ok(r.endings.measured > 0 && r.endings.reconstructed > 0);
  assert.ok(r.winners_changed > 0);
  // the defect: both players cannot lose the majority of their service points
  const sy = M.serve.you.service_points_won_pct, so = M.serve.opp.service_points_won_pct;
  assert.ok(!(sy < 50 && so < 50), 'both players below 50% service points won');
  // return% must stay the complement of the opponent's service%
  assert.ok(Math.abs(M.serve.you.return_points_won_pct - (100 - so)) < 0.2);
  // winners only counted for endings we can defend
  const defensible = M.points.filter((p) => p.outcome_class === 'winner').length;
  assert.equal(M.winners_errors.you.winners + M.winners_errors.opp.winners, defensible);
});

test('integrity: a missed first serve does not end the point', () => {
  // one serve is logged per point, so a lone faulted serve is ambiguous:
  // it must not be scored as the server losing the point
  const lone = M.points.filter((p) => p.n_shots <= 1 && p.last_stroke === 'Serve' && p.last_result !== 'In');
  assert.ok(lone.length > 0, 'sample has lone faulted serves');
  lone.forEach((p) => assert.equal(p.outcome_class, 'reconstructed'));
  // and with that corrected, servers win the majority of their service points
  assert.ok(M.serve.you.service_points_won_pct > 45);
  assert.ok(M.serve.opp.service_points_won_pct > 45);
});

test('integrity: every change is auditable', () => {
  const a = M.integrity.repair.audit;
  assert.ok(Array.isArray(a) && a.length === M.integrity.repair.winners_changed);
  const e = a[0];
  ['point', 'from', 'to', 'cls', 'rule', 'why', 'conf'].forEach((k) => assert.ok(k in e, 'audit entry has ' + k));
  assert.notEqual(e.from, e.to);
});

test('integrity: imputer is evaluated against held-out truth', () => {
  const ev = M.integrity.evaluation;
  assert.ok(ev && ev.n >= 10);
  assert.ok(ev.accuracy >= 0 && ev.accuracy <= 100);
  assert.ok(ev.baseline_majority_class >= 0);
  // sanity: hold-out accuracy should be in a believable band, not degenerate
  assert.ok(ev.accuracy > 20, 'imputer no better than noise');
});

test('per-shot trajectories carry coords + quality', () => {
  assert.ok(M.trajectories.length > 500);
  const t = M.trajectories.find((x) => x.result === 'In' && (x.stroke === 'Forehand' || x.stroke === 'Backhand'));
  assert.equal(typeof t.bx, 'number');
  assert.ok(t.q === null || (t.q >= 0 && t.q <= 100));
});
