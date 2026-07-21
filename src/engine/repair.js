/* ============================================================
   Court IQ — outcome REPAIR pass.

   SwingVision stops tracking mid-rally surprisingly often. The base engine
   credits whoever hit the last *tracked* shot, which silently invents winners:
   in the sample match 27 points were "won" by a return that simply happened to
   be the last ball the camera kept. That inflates winners, deflates service
   points won, and distorts every downstream stat.

   This pass runs on every parsed match:
     A CLASSIFY  each ending as measured-error / genuine-winner / truncated
     B LEARN     an unbiased server win-rate prior from the measured-only subset
     C IMPUTE    truncated points, ranked by who was dominating the rally and
                 calibrated so the aggregate matches that prior
     D REWRITE   point winners + confidence
     E RECOMPUTE every aggregate that depended on the old winners

   Philosophy: a slightly-off score is acceptable; a blatantly wrong number that
   distorts the analytics is not. Points we genuinely can't know are marked
   "imputed" and excluded from winner/error counts rather than guessed into them.
   ============================================================ */
(function (root) {
  "use strict";
  const other = k => (k === "you" ? "opp" : "you");
  const rnd = (x, d = 0) => { const p = Math.pow(10, d); return Math.round(x * p) / p; };
  const pct = (a, b) => (b ? rnd(100 * a / b, 1) : 0);
  function Counter(arr) { const c = {}; arr.forEach(k => { if (k == null) return; c[k] = (c[k] || 0) + 1; }); return c; }

  // ---- A: how did this point actually end? ----
  // Long rallies ending "in" are real endings (their last-hitter split is balanced).
  // Short ones are overwhelmingly dropped tracking (1-2 shot "in" endings were
  // returner-last 100% of the time), so they need evidence to count as winners.
  function classify(p, lastQ) {
    if (p.last_result !== "In") return "error";        // measured: the hitter missed
    const n = p.n_shots, q = lastQ;
    if (n >= 9) return "winner";
    if (n <= 2) return q != null && q >= 70 ? "winner" : "truncated";
    if (n <= 4) return q != null && q >= 60 ? "winner" : "truncated";
    return q != null && q >= 52 ? "winner" : "truncated";
  }

  function repair(M, byPoint) {
    const lastQ = p => { const s = byPoint[p.point] || []; const l = s[s.length - 1]; return l && l.q != null ? l.q : null; };
    const cls = {};
    M.points.forEach(p => { cls[p.point] = classify(p, lastQ(p)); });

    // ---- B: unbiased prior — only points whose winner is certain ----
    const prior = {};
    ["you", "opp"].forEach(k => {
      const s = M.points.filter(p => cls[p.point] === "error" && p.server === k);
      prior[k] = s.length ? s.filter(p => p.winner === k).length / s.length : 0.5;
    });

    // ---- C: impute truncated points ----
    const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 50);
    const dominance = p => { // >0 => the server was on top of the rally
      const s = byPoint[p.point] || [];
      return avg(s.filter(t => t.player === p.server && t.q != null).map(t => t.q))
        - avg(s.filter(t => t.player !== p.server && t.q != null).map(t => t.q));
    };
    const win = {}, conf = {};
    M.points.forEach(p => {
      const c = cls[p.point];
      if (c === "error") { win[p.point] = p.winner; conf[p.point] = 1; }
      else if (c === "winner") { win[p.point] = p.last_player; conf[p.point] = 0.75; }
    });
    ["you", "opp"].forEach(k => {
      const pool = M.points.filter(p => cls[p.point] === "truncated" && p.server === k)
        .sort((a, b) => dominance(b) - dominance(a));
      const toServer = Math.round(pool.length * prior[k]);
      pool.forEach((p, i) => { win[p.point] = i < toServer ? k : other(k); conf[p.point] = 0.45; });
    });
    M.points.forEach(p => { if (!win[p.point]) { win[p.point] = p.winner; conf[p.point] = 0.4; } });

    // ---- D: rewrite ----
    let changed = 0;
    M.points.forEach(p => {
      const w = win[p.point];
      if (w !== p.winner) changed++;
      p.winner = w; p.loser = other(w);
      p.outcome_class = cls[p.point];
      p.outcome_conf = conf[p.point];
      p.reason = cls[p.point] === "error" ? "error" : cls[p.point] === "winner" ? "winner" : "imputed";
    });

    recompute(M);

    const n = c => M.points.filter(p => p.outcome_class === c).length;
    return {
      endings: { measured_error: n("error"), genuine_winner: n("winner"), truncated_imputed: n("truncated") },
      server_prior: { you: rnd(prior.you * 100, 0), opp: rnd(prior.opp * 100, 0) },
      winners_changed: changed,
      note: "Winners/errors count only endings we can stand behind; imputed points are excluded from both."
    };
  }

  // ---- E: rebuild everything that depended on the old winners ----
  function recompute(M) {
    const P = M.points, players = ["you", "opp"];
    const wins = Counter(P.map(p => p.winner));
    M.match.points_won = { you: wins.you || 0, opp: wins.opp || 0 };
    M.match.point_win_pct = { you: pct(wins.you || 0, P.length), opp: pct(wins.opp || 0, P.length) };

    for (const k of players) {
      // only defensible endings feed winners/errors
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

    // rally buckets + momentum
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

    // trajectory outcome tags follow the repaired classes
    const byPt = {}; M.points.forEach(p => { byPt[p.point] = p; });
    M.trajectories.forEach(t => {
      const p = byPt[t.pt]; if (!p) return;
      const isLast = t.i === (p.n_shots - 1);
      t.outcome = !isLast ? "rally" : p.outcome_class === "winner" ? "winner" : p.outcome_class === "error" ? "error" : "unresolved";
    });
  }

  root.SVRepair = { repair, classify };
})(typeof window !== "undefined" ? window : globalThis);
