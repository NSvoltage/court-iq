/* ============================================================
   Court IQ — DATA INTEGRITY ENGINE  (window.SVIntegrity)

   A self-contained, auditable pass that turns a raw parsed match into one we
   can publish. It owns every decision about what is measured, what is
   reconstructed, and what cannot be known — nothing else in the codebase
   should be guessing at outcomes.

     process(M, byPoint) -> M.integrity
       A CLASSIFY   each point ending: measured | reconstructed | unknowable
       B LEARN      an unbiased prior from the measured-only subset
       C IMPUTE     reconstructed endings, calibrated to that prior
       D REWRITE    winners + per-point confidence  (full audit trail kept)
       E RECOMPUTE  every aggregate that depended on the old winners
       F VERIFY     coherence checks; classify each stat family's confidence

     evaluate(M, byPoint) -> hold-out accuracy of the imputer vs baselines

   Why it exists: SwingVision stops tracking mid-rally often, and crediting
   whoever hit the last *tracked* shot invents winners (1-2 shot "in" endings
   were returner-last 100% of the time). Left alone that inflates winners and
   pushes both players below 50% of service points won — impossible tennis.

   AUDITABLE: every changed point is recorded in .audit with its before/after,
   class, confidence and the rule that fired.
   EVALUABLE: evaluate() hides known outcomes and scores the imputer against
   them, so the reconstruction can be measured rather than trusted.
   ============================================================ */
(function (root) {
  "use strict";
  const VERSION = "1.0.0";
  const other = k => (k === "you" ? "opp" : "you");
  const rnd = (x, d = 0) => { const p = Math.pow(10, d); return Math.round(x * p) / p; };
  const pct = (a, b) => (b ? rnd(100 * a / b, 1) : 0);
  const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 50);
  function Counter(arr) { const c = {}; arr.forEach(k => { if (k == null) return; c[k] = (c[k] || 0) + 1; }); return c; }

  // ---------- A. CLASSIFY ----------
  // Long rallies ending "in" are real endings (their last-hitter split is a
  // balanced 44%). Short ones are overwhelmingly dropped tracking (1-2 shot
  // "in" endings: returner-last 100%), so they need evidence to count.
  const RULES = [
    // TENNIS RULE: a missed first serve does not end the point — a second serve
    // follows. SwingVision logs only one serve per point, so a point whose only
    // tracked shot is a faulted serve is ambiguous: either a genuine double fault
    // or (far more often) a first-serve fault whose second serve and rally simply
    // weren't tracked. Awarding it to the returner would be wrong most of the time,
    // so it goes to the imputer instead of being scored as a measured miss.
    { id: "serve_fault_unresolved", when: p => p.n_shots <= 1 && p.last_stroke === "Serve" && p.last_result !== "In",
      cls: "reconstructed", why: "first serve missed and nothing further was tracked — the second serve and rally are unrecorded, so the point's winner is unknown" },
    { id: "measured_miss", when: p => p.last_result !== "In", cls: "measured", why: "ball landed out or in the net — the point demonstrably ended here" },
    { id: "long_rally_end", when: p => p.n_shots >= 9, cls: "winner", why: "9+ shot rally ending in play reads as a genuine finish" },
    { id: "clean_putaway", when: (p, q) => q != null && q >= (p.n_shots <= 2 ? 70 : p.n_shots <= 4 ? 60 : 52), cls: "winner", why: "final ball good enough to have ended the point" }
  ];
  function classify(p, q) {
    for (const r of RULES) if (r.when(p, q)) return { cls: r.cls, rule: r.id, why: r.why };
    return { cls: "reconstructed", rule: "tracking_cut", why: "tracking stopped mid-rally — the true winner is not in the data" };
  }

  const dominance = (p, byPoint) => { // >0 => the server was on top of the rally
    const s = byPoint[p.point] || [];
    return avg(s.filter(t => t.player === p.server && t.q != null).map(t => t.q))
      - avg(s.filter(t => t.player !== p.server && t.q != null).map(t => t.q));
  };

  function learnPrior(points) { // B. only points whose winner is certain
    const prior = {};
    ["you", "opp"].forEach(k => {
      const s = points.filter(p => p.server === k);
      prior[k] = s.length ? s.filter(p => p.winner === k).length / s.length : 0.5;
    });
    return prior;
  }

  function process(M, byPoint) {
    const lastQ = p => { const s = byPoint[p.point] || []; const l = s[s.length - 1]; return l && l.q != null ? l.q : null; };
    const decision = {};
    M.points.forEach(p => { decision[p.point] = classify(p, lastQ(p)); });

    const measured = M.points.filter(p => decision[p.point].cls === "measured" && p.server);
    const prior = learnPrior(measured);

    // C + D
    const win = {}, conf = {}, audit = [];
    M.points.forEach(p => {
      const d = decision[p.point];
      if (d.cls === "measured") { win[p.point] = p.winner; conf[p.point] = 1; }
      else if (d.cls === "winner") { win[p.point] = p.last_player; conf[p.point] = 0.75; }
    });
    ["you", "opp"].forEach(k => {
      const pool = M.points.filter(p => decision[p.point].cls === "reconstructed" && p.server === k)
        .sort((a, b) => dominance(b, byPoint) - dominance(a, byPoint));
      const toServer = Math.round(pool.length * prior[k]);
      pool.forEach((p, i) => { win[p.point] = i < toServer ? k : other(k); conf[p.point] = 0.45; });
    });
    M.points.forEach(p => { if (!win[p.point]) { win[p.point] = p.winner; conf[p.point] = 0.4; } });

    let changed = 0;
    M.points.forEach(p => {
      const d = decision[p.point], w = win[p.point], was = p.winner;
      if (w !== was) {
        changed++;
        audit.push({ point: p.point, from: was, to: w, cls: d.cls, rule: d.rule, why: d.why, conf: conf[p.point], n_shots: p.n_shots });
      }
      p.winner = w; p.loser = other(w);
      p.outcome_class = d.cls === "measured" ? "error" : d.cls === "winner" ? "winner" : "reconstructed";
      p.outcome_conf = conf[p.point];
      p.reason = p.outcome_class === "error" ? "error" : p.outcome_class === "winner" ? "winner" : "imputed";
    });

    recompute(M); // E

    const n = c => M.points.filter(p => p.outcome_class === c).length;
    const report = {
      version: VERSION,
      endings: { measured: n("error"), winner: n("winner"), reconstructed: n("reconstructed") },
      server_prior: { you: rnd(prior.you * 100, 0), opp: rnd(prior.opp * 100, 0) },
      winners_changed: changed,
      audit
    };
    M.integrity = { version: VERSION, repair: report, verification: verify(M, report), evaluation: evaluate(M, byPoint, decision) };
    return M.integrity;
  }

  // ---------- E. RECOMPUTE everything downstream ----------
  function recompute(M) {
    const P = M.points, players = ["you", "opp"];
    const wins = Counter(P.map(p => p.winner));
    M.match.points_won = { you: wins.you || 0, opp: wins.opp || 0 };
    M.match.point_win_pct = { you: pct(wins.you || 0, P.length), opp: pct(wins.opp || 0, P.length) };

    for (const k of players) {
      const W = P.filter(p => p.outcome_class === "winner" && p.winner === k);
      const E = P.filter(p => p.outcome_class === "error" && p.loser === k);
      const we = M.winners_errors[k];
      we.winners = W.length; we.errors = E.length;
      we.winner_error_ratio = E.length ? rnd(W.length / E.length, 2) : null;
      we.winners_by_stroke = Counter(W.map(p => p.last_stroke));
      we.errors_by_stroke = Counter(E.map(p => p.last_stroke));
      we.errors_net = E.filter(p => p.last_result === "Net").length;
      we.errors_out = E.filter(p => p.last_result === "Out").length;
      we.winners_by_dir = Counter(W.filter(p => p.last_dir !== "---").map(p => p.last_dir));
      we.errors_by_dir = Counter(E.filter(p => p.last_dir !== "---").map(p => p.last_dir));

      const sp = P.filter(p => p.server === k), spWon = sp.filter(p => p.winner === k);
      const rp = P.filter(p => p.server === other(k)), rw = rp.filter(p => p.winner === k);
      const sv = M.serve[k];
      sv.service_points = sp.length; sv.service_points_won = spWon.length;
      sv.service_points_won_pct = pct(spWon.length, sp.length);
      const faultPts = sp.filter(p => p.serve_result !== "In" && p.n_shots <= 1);
      sv.svc_pts_won_excl_faults_pct = pct(spWon.length, sp.length - faultPts.length);
      sv.return_points = rp.length; sv.return_points_won = rw.length;
      sv.return_points_won_pct = pct(rw.length, rp.length);
    }

    const bucket = n => (n <= 1 ? "1 (serve/ret)" : n <= 4 ? "2-4 (short)" : n <= 8 ? "5-8 (mid)" : "9+ (long)");
    const rb = M.rally.buckets;
    Object.keys(rb).forEach(b => { rb[b].points = 0; rb[b].you = 0; rb[b].opp = 0; });
    P.forEach(p => { const b = bucket(p.n_shots); if (rb[b]) { rb[b].points++; rb[b][p.winner]++; } });
    Object.keys(rb).forEach(b => { rb[b].you_win_pct = pct(rb[b].you, rb[b].points); });

    let diff = 0; const series = [];
    P.forEach(p => { diff += p.winner === "you" ? 1 : -1; series.push(diff); });
    const longestRun = who => { let best = 0, cur = 0; P.forEach(p => { if (p.winner === who) { cur++; best = Math.max(best, cur); } else cur = 0; }); return best; };
    let lead = 0; for (let i = 1; i < series.length; i++) if ((series[i - 1] <= 0) !== (series[i] <= 0)) lead++;
    M.momentum = { point_diff_series: series, final_diff: diff, longest_run_you: longestRun("you"), longest_run_opp: longestRun("opp"), lead_changes: lead };

    const byPt = {}; M.points.forEach(p => { byPt[p.point] = p; });
    M.trajectories.forEach(t => {
      const p = byPt[t.pt]; if (!p) return;
      const isLast = t.i === (p.n_shots - 1);
      t.outcome = !isLast ? "rally" : p.outcome_class === "winner" ? "winner" : p.outcome_class === "error" ? "error" : "unresolved";
    });
  }

  // ---------- F. VERIFY ----------
  function verify(M, report) {
    const P = M.points, flags = [];
    const svcY = M.serve.you.service_points_won_pct, svcO = M.serve.opp.service_points_won_pct;
    const retY = M.serve.you.return_points_won_pct, retO = M.serve.opp.return_points_won_pct;
    const seq = P.map(p => p.server).filter(Boolean);
    const runs = []; let cur = null, len = 0;
    seq.forEach(s => { if (s === cur) len++; else { if (cur != null) runs.push(len); cur = s; len = 1; } });
    if (cur != null) runs.push(len);
    const avgRun = runs.length ? seq.length / runs.length : 0, longest = runs.length ? Math.max.apply(null, runs) : 0;
    const gameStructured = runs.length >= 8 && avgRun <= 7 && longest <= 9;
    const bothBelow50 = svcY < 50 && svcO < 50;
    const dfY = M.serve.you.service_points ? M.serve.you.serve_fault_points / M.serve.you.service_points : 0;
    const dfO = M.serve.opp.service_points ? M.serve.opp.serve_fault_points / M.serve.opp.service_points : 0;
    const dfHigh = dfY > 0.12 || dfO > 0.12;
    const uncertainty = report.endings.reconstructed;

    if (!gameStructured) flags.push({ level: "warn", code: "no_game_structure", stat: "games",
      msg: `Serves arrive in turns of up to ${longest} points rather than 4–7-point games, so games, sets, holds, breaks and a 1st-vs-2nd-serve split can't be derived. Adding the final score unlocks them.` });
    if (uncertainty) flags.push({ level: "info", code: "outcomes_reconstructed", stat: "score",
      msg: `${uncertainty} points had tracking stop mid-rally. Their winners were reconstructed from the measured-only base rate rather than credited to the last tracked shot, correcting ${report.winners_changed} of them. The score carries about ±${uncertainty} points.` });
    if (bothBelow50) flags.push({ level: "warn", code: "serve_below_50", stat: "service",
      msg: `Both players win under half their service points (${svcY}% / ${svcO}%) — servers cannot both lose the majority of their service points.` });
    if (retY > 50 || retO > 50) flags.push({ level: "info", code: "breaks_implied", stat: "games",
      msg: `A returner wins over half their return points, so serve was broken repeatedly — break points certainly occurred, they just can't be located without a game structure.` });
    if (dfHigh) flags.push({ level: "info", code: "df_inflated", stat: "service",
      msg: `Double-fault rate looks inflated (${Math.round(dfY * 100)}% / ${Math.round(dfO * 100)}%): with one serve logged per point, most are single serve-faults.` });

    const reliable = {
      measured_shots: true, placement: true, shot_speed: true, movement: true, shot_quality: true,
      errors: true, serve_in_rate: true,
      point_outcomes: !bothBelow50, winners: true, score: !bothBelow50, service_stats: !bothBelow50,
      first_second_serve: false, double_faults: !dfHigh,
      break_points: false, games_sets: false, tiebreaks: false
    };
    // stat families that should carry a footnote marker in the UI
    const annotate = [];
    if (uncertainty) annotate.push("score", "winners", "service");
    if (!gameStructured) annotate.push("games");
    if (dfHigh) annotate.push("double_faults");

    return {
      level: flags.some(f => f.level === "warn") ? "caution" : "ok",
      game_structure_recoverable: gameStructured, score_uncertainty: uncertainty,
      both_serve_below_50: bothBelow50, needs_final_score: !gameStructured,
      serve_runs: runs.length, avg_serve_run: rnd(avgRun, 1), longest_serve_run: longest,
      reliable, annotate, flags
    };
  }

  // ---------- EVAL: hide known outcomes, score the imputer against them ----------
  function evaluate(M, byPoint, decision) {
    const known = M.points.filter(p => decision[p.point].cls === "measured" && p.server);
    if (known.length < 30) return null;
    // Deterministic hold-out, STRATIFIED by server: serve arrives in long blocks,
    // so naive every-3rd sampling yields a non-representative server mix.
    const holdSet = new Set();
    ["you", "opp"].forEach(k => {
      known.filter(p => p.server === k).forEach((p, i) => { if (i % 3 === 0) holdSet.add(p.point); });
    });
    const hold = known.filter(p => holdSet.has(p.point));
    const train = known.filter(p => !holdSet.has(p.point));
    const prior = learnPrior(train);                        // no leakage
    let correct = 0;
    ["you", "opp"].forEach(k => {
      const pool = hold.filter(p => p.server === k).sort((a, b) => dominance(b, byPoint) - dominance(a, byPoint));
      const toServer = Math.round(pool.length * prior[k]);
      pool.forEach((p, i) => { if ((i < toServer ? k : other(k)) === p.winner) correct++; });
    });
    const alwaysServer = hold.filter(p => p.winner === p.server).length;
    const majority = Math.max(alwaysServer, hold.length - alwaysServer);
    // PRIMARY metric: we impute to keep AGGREGATES honest, not to call individual
    // points. Calibration error = how far the imputed server-win share lands from
    // the truth on the same points. Per-point accuracy is reported as secondary.
    let predServer = 0;
    ["you", "opp"].forEach(k => {
      const pool = hold.filter(p => p.server === k);
      predServer += Math.round(pool.length * prior[k]);
    });
    const trueShare = pct(alwaysServer, hold.length), predShare = pct(predServer, hold.length);
    return {
      n: hold.length,
      calibration_error_pts: rnd(Math.abs(predShare - trueShare), 1), // primary
      predicted_server_share: predShare, actual_server_share: trueShare,
      accuracy: pct(correct, hold.length),                             // secondary
      baseline_always_server: pct(alwaysServer, hold.length),
      baseline_majority_class: pct(majority, hold.length),
      note: "Hold-out: a third of the definitively-known points are hidden, imputed from a prior learned on the rest, then scored. Calibration (aggregate) is the target; per-point accuracy is inherently limited because the true winner of a cut-off rally is not in the data."
    };
  }

  root.SVIntegrity = { process, evaluate, classify, verify, VERSION, RULES };
})(typeof window !== "undefined" ? window : globalThis);
