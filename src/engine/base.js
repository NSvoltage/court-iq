/* ============================================================
   SwingVision match engine — composable, file-agnostic.
   Input: rawSheets = { Settings:[[...]], Shots:[[...]], Rallies:[[...]] }
   Output: one unified data model M consumed by every view.
   Keyed by "you" (host / tracked player) and "opp" (guest).
   ============================================================ */
(function (root) {
  "use strict";
  const NET = 11.885, BASE = 23.77, SGL = 4.115, DBL = 5.485;

  // ---------- small stats helpers ----------
  const isNum = x => typeof x === "number" && isFinite(x);
  const rnd = (x, d = 0) => { const p = Math.pow(10, d); return Math.round(x * p) / p; };
  const sum = a => a.reduce((s, x) => s + x, 0);
  const mean = a => { a = a.filter(isNum); return a.length ? rnd(sum(a) / a.length, 1) : null; };
  const median = a => { a = a.filter(isNum).slice().sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : rnd((a[m - 1] + a[m]) / 2, 2); };
  const pstd = a => { a = a.filter(isNum); if (!a.length) return 0; const m = sum(a) / a.length; return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / a.length); };
  const pct = (a, b) => b ? rnd(100 * a / b, 1) : 0;
  const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function Counter(arr) { const c = {}; arr.forEach(k => { if (k == null) return; c[k] = (c[k] || 0) + 1; }); return c; }

  // ---------- parse sheets ----------
  function toNum(v) { if (v == null || v === "") return v; const n = Number(v); return isFinite(n) && String(v).trim() !== "" ? n : v; }
  function parseTable(rows) {
    const header = rows[0].map(h => (h == null ? "" : String(h)));
    const idx = {}; header.forEach((h, i) => idx[h] = i);
    const data = rows.slice(1).filter(r => r && r.some(c => c != null && c !== ""));
    return { header, idx, data };
  }

  function build(rawSheets) {
    const S = parseTable(rawSheets.Shots);
    const idx = S.idx;
    const G = (r, c) => r[idx[c]];
    // Settings
    let host = "You", guest = "Opponent", startT = "", endT = "";
    try {
      const st = parseTable(rawSheets.Settings);
      const v = st.data[0] || [];
      host = v[st.idx["Host Team"]] || host;
      guest = v[st.idx["Guest Team"]] || guest;
      startT = v[st.idx["Start Time"]] || ""; endT = v[st.idx["End Time"]] || "";
    } catch (e) {}
    // coerce numeric columns
    const numCols = ["Speed (MPH)", "Point", "Game", "Set", "Bounce (x)", "Bounce (y)", "Hit (x)", "Hit (y)", "Hit (z)", "Video Time", "Shot"];
    S.data.forEach(r => numCols.forEach(c => { if (idx[c] != null) r[idx[c]] = toNum(r[idx[c]]); }));

    // identify players
    const pv = Object.keys(Counter(S.data.map(r => G(r, "Player"))));
    const YOU = pv.includes(host) ? host : pv[0];
    const OPP = pv.find(p => p !== YOU) || guest;
    const key = p => (p === YOU ? "you" : "opp");
    const shortName = f => (!f ? "" : String(f) === "Opponent" ? "Opp" : String(f).split(" ")[0]);
    const NAME = { you: shortName(YOU), opp: shortName(OPP) };
    const other = k => (k === "you" ? "opp" : "you");

    // ---------- dedup by (Point,Shot) keep first ----------
    const seen = new Set(), D = [];
    for (const r of S.data) {
      const k = G(r, "Point") + "|" + G(r, "Shot");
      if (seen.has(k)) continue; seen.add(k); D.push(r);
    }
    // group into points, sort by Shot
    const pts = new Map();
    for (const r of D) { const p = G(r, "Point"); if (!pts.has(p)) pts.set(p, []); pts.get(p).push(r); }
    for (const arr of pts.values()) arr.sort((a, b) => G(a, "Shot") - G(b, "Shot"));

    const pointOutcome = sh => {
      const last = sh[sh.length - 1], res = G(last, "Result"), h = key(G(last, "Player"));
      return res === "In" ? { winner: h, reason: "winner", last } : { winner: other(h), reason: "error", last };
    };

    // ---------- POINTS table ----------
    const POINTS = [];
    for (const [p, sh] of pts) {
      const o = pointOutcome(sh);
      const serve = G(sh[0], "Stroke") === "Serve" ? sh[0] : null;
      const ret = sh[1] || null;
      POINTS.push({
        point: p, n_shots: sh.length,
        server: serve ? key(G(serve, "Player")) : null,
        winner: o.winner, reason: o.reason, loser: other(o.winner),
        last_stroke: G(o.last, "Stroke"), last_result: G(o.last, "Result"),
        last_player: key(G(o.last, "Player")), last_dir: G(o.last, "Direction"),
        serve_speed: serve ? G(serve, "Speed (MPH)") : null,
        serve_spin: serve ? G(serve, "Spin") : null,
        serve_dir: serve ? G(serve, "Direction") : null,
        serve_result: serve ? G(serve, "Result") : null,
        serve_bx: serve ? G(serve, "Bounce (x)") : null,
        serve_by: serve ? G(serve, "Bounce (y)") : null,
        return_result: ret ? G(ret, "Result") : null
      });
    }

    const players = ["you", "opp"];
    const M = { meta: {}, match: {}, serve: {}, winners_errors: {}, rally: {}, shots: {}, patterns: {}, momentum: {}, points: POINTS, trajectories: [], player: {} };

    // ---------- META ----------
    M.meta = {
      tracked_name: YOU, opp_name: OPP, tracked: NAME.you, opp: NAME.opp,
      start_time: startT, end_time: endT,
      raw_shot_rows: S.data.length, clean_shot_rows: D.length, corrupt_dupes_removed: S.data.length - D.length,
      note: "Game/Set columns are 0 in rally-mode exports; point outcomes are inferred from the last tracked shot of each rally."
    };

    // ---------- MATCH ----------
    const wins = Counter(POINTS.map(p => p.winner));
    M.match = {
      total_points: POINTS.length, total_shots: D.length,
      points_won: { you: wins.you || 0, opp: wins.opp || 0 },
      point_win_pct: { you: pct(wins.you || 0, POINTS.length), opp: pct(wins.opp || 0, POINTS.length) },
      avg_rally_shots: rnd(mean(POINTS.map(p => p.n_shots)), 2),
      median_rally_shots: median(POINTS.map(p => p.n_shots)),
      longest_rally: Math.max(...POINTS.map(p => p.n_shots))
    };

    // ---------- SERVE ----------
    for (const k of players) {
      const full = k === "you" ? YOU : OPP;
      const serves = D.filter(r => G(r, "Stroke") === "Serve" && G(r, "Player") === full);
      const sin = serves.filter(r => G(r, "Result") === "In");
      const fault = serves.filter(r => G(r, "Result") !== "In");
      const spdIn = sin.map(r => G(r, "Speed (MPH)")).filter(isNum);
      const sp = POINTS.filter(p => p.server === k);
      const spWon = sp.filter(p => p.winner === k);
      const aces = sp.filter(p => p.n_shots === 1 && p.serve_result === "In");
      const svcWin = sp.filter(p => p.n_shots === 2 && p.serve_result === "In" && (p.return_result === "Out" || p.return_result === "Net"));
      const faultPts = sp.filter(p => p.serve_result !== "In" && p.n_shots === 1);
      const rp = POINTS.filter(p => p.server === other(k));
      const rw = rp.filter(p => p.winner === k);
      spdIn.sort((a, b) => a - b);
      M.serve[k] = {
        serves: serves.length, in_play: sin.length, in_rate: pct(sin.length, serves.length),
        faults: fault.length,
        fault_net: fault.filter(r => G(r, "Result") === "Net").length,
        fault_out: fault.filter(r => G(r, "Result") === "Out").length,
        avg_speed: mean(spdIn), max_speed: spdIn.length ? rnd(spdIn[spdIn.length - 1], 1) : null,
        speed_p90: spdIn.length ? rnd(spdIn[Math.floor(spdIn.length * 0.9)], 1) : null,
        spin: Counter(sin.map(r => G(r, "Spin"))),
        placement: Counter(sin.map(r => G(r, "Direction"))),
        service_points: sp.length, service_points_won: spWon.length,
        service_points_won_pct: pct(spWon.length, sp.length),
        aces_untouched: aces.length, service_winners_ret_error: svcWin.length,
        serve_fault_points: faultPts.length,
        serve_fault_net: faultPts.filter(p => p.serve_result === "Net").length,
        serve_fault_out: faultPts.filter(p => p.serve_result === "Out").length,
        svc_pts_won_excl_faults_pct: pct(spWon.length, sp.length - faultPts.length),
        return_points: rp.length, return_points_won: rw.length,
        return_points_won_pct: pct(rw.length, rp.length)
      };
    }

    // ---------- RALLY ----------
    const bucket = n => n <= 1 ? "1 (serve/ret)" : n <= 4 ? "2-4 (short)" : n <= 8 ? "5-8 (mid)" : "9+ (long)";
    const BUK = ["1 (serve/ret)", "2-4 (short)", "5-8 (mid)", "9+ (long)"];
    const rb = {}; BUK.forEach(b => rb[b] = { points: 0, you: 0, opp: 0 });
    POINTS.forEach(p => { const b = bucket(p.n_shots); rb[b].points++; rb[b][p.winner]++; });
    BUK.forEach(b => rb[b].you_win_pct = pct(rb[b].you, rb[b].points));
    M.rally = { buckets: rb, distribution: Counter(POINTS.map(p => p.n_shots)) };

    // ---------- SHOTS ----------
    for (const k of players) {
      const full = k === "you" ? YOU : OPP;
      const mine = D.filter(r => G(r, "Player") === full);
      M.shots[k] = {
        total: mine.length,
        strokes: Counter(mine.map(r => G(r, "Stroke"))),
        spin: Counter(mine.map(r => G(r, "Spin"))),
        direction: Counter(mine.filter(r => G(r, "Direction") !== "---").map(r => G(r, "Direction"))),
        fh_count: mine.filter(r => G(r, "Stroke") === "Forehand").length,
        bh_count: mine.filter(r => G(r, "Stroke") === "Backhand").length,
        avg_speed_fh: mean(mine.filter(r => G(r, "Stroke") === "Forehand").map(r => G(r, "Speed (MPH)"))),
        avg_speed_bh: mean(mine.filter(r => G(r, "Stroke") === "Backhand").map(r => G(r, "Speed (MPH)")))
      };
    }

    // ---------- WINNERS & ERRORS ----------
    for (const k of players) {
      const W = POINTS.filter(p => p.reason === "winner" && p.winner === k);
      const E = POINTS.filter(p => p.reason === "error" && p.loser === k);
      M.winners_errors[k] = {
        winners: W.length, errors: E.length,
        winner_error_ratio: E.length ? rnd(W.length / E.length, 2) : null,
        winners_by_stroke: Counter(W.map(p => p.last_stroke)),
        errors_by_stroke: Counter(E.map(p => p.last_stroke)),
        errors_net: E.filter(p => p.last_result === "Net").length,
        errors_out: E.filter(p => p.last_result === "Out").length,
        winners_by_dir: Counter(W.filter(p => p.last_dir !== "---").map(p => p.last_dir)),
        errors_by_dir: Counter(E.filter(p => p.last_dir !== "---").map(p => p.last_dir))
      };
    }

    // ---------- MOMENTUM ----------
    let diff = 0; const series = [];
    POINTS.forEach(p => { diff += p.winner === "you" ? 1 : -1; series.push(diff); });
    const longestRun = who => { let best = 0, cur = 0; POINTS.forEach(p => { if (p.winner === who) { cur++; best = Math.max(best, cur); } else cur = 0; }); return best; };
    let leadChanges = 0; for (let i = 1; i < series.length; i++) if ((series[i - 1] <= 0) !== (series[i] <= 0)) leadChanges++;
    M.momentum = { point_diff_series: series, final_diff: diff, longest_run_you: longestRun("you"), longest_run_opp: longestRun("opp"), lead_changes: leadChanges };

    // ---------- TRAJECTORIES ----------
    const valid = v => isNum(v);
    for (const [p, sh] of pts) {
      const o = pointOutcome(sh);
      sh.forEach((r, i) => {
        const hx = G(r, "Hit (x)"), hy = G(r, "Hit (y)"), hz = G(r, "Hit (z)"), bx = G(r, "Bounce (x)"), by = G(r, "Bounce (y)");
        if (![hx, hy, hz, bx, by].every(valid)) return;
        const isLast = r === o.last;
        M.trajectories.push({
          pt: p, i: i, player: key(G(r, "Player")),
          hx: rnd(hx, 3), hy: rnd(hy, 3), hz: rnd(hz, 3), bx: rnd(bx, 3), by: rnd(by, 3),
          stroke: G(r, "Stroke"), type: G(r, "Type"), spin: G(r, "Spin"),
          spd: rnd(G(r, "Speed (MPH)"), 1), result: G(r, "Result"), dir: G(r, "Direction"),
          outcome: isLast && o.reason === "winner" ? "winner" : isLast && o.reason === "error" ? "error" : "rally"
        });
      });
    }

    // ---------- PATTERNS: serve by placement ----------
    M.patterns.serve_by_placement = {};
    for (const k of players) {
      const sp = POINTS.filter(p => p.server === k && p.serve_result === "In");
      const byd = {};
      sp.forEach(p => { const d = p.serve_dir; (byd[d] = byd[d] || { n: 0, won: 0, spd: [] }); byd[d].n++; if (p.winner === k) byd[d].won++; byd[d].spd.push(p.serve_speed); });
      const out = {};
      for (const d in byd) out[d] = { serves: byd[d].n, points_won: byd[d].won, win_pct: pct(byd[d].won, byd[d].n), avg_speed: mean(byd[d].spd) };
      M.patterns.serve_by_placement[k] = out;
    }

    // ================= PLAYER LAB (movement / positioning / reliability) =================
    const fold = (x, y) => y > NET ? [-x, BASE - y] : [x, y];
    const ownContacts = (sh, full) => {
      const c = [];
      for (const r of sh) { if (G(r, "Player") !== full) continue; const hx = G(r, "Hit (x)"), hy = G(r, "Hit (y)"), t = G(r, "Video Time"); if (isNum(hx) && isNum(hy) && isNum(t)) c.push([hx, hy, t]); }
      return c;
    };
    const movement = k => {
      const full = k === "you" ? YOU : OPP;
      let floor = 0, full_ = 0, npoints = 0, ncontacts = 0, wide = 0, totpos = 0;
      const speeds = [], folded = [];
      for (const sh of pts.values()) {
        const c = ownContacts(sh, full); ncontacts += c.length;
        c.forEach(([x, y]) => { const f = fold(x, y); folded.push([rnd(f[0], 2), rnd(f[1], 2)]); totpos++; if (Math.abs(f[0]) > SGL * 0.7) wide++; });
        if (c.length >= 2) {
          npoints++;
          const baseY = c[0][1] < NET ? 0 : BASE, R = [0, baseY];
          for (let i = 0; i < c.length - 1; i++) {
            const p1 = [c[i][0], c[i][1]], p2 = [c[i + 1][0], c[i + 1][1]];
            const d = dist2(p1, p2); floor += d;
            full_ += dist2(p1, R) + dist2(R, p2);
            const dt = c[i + 1][2] - c[i][2]; if (dt > 0.2 && dt < 8) speeds.push(d / dt);
          }
        }
      }
      const est = floor + 0.55 * (full_ - floor);
      return {
        contacts: ncontacts, dist_floor_m: Math.round(floor), dist_full_m: Math.round(full_), dist_est_m: Math.round(est),
        per_point_est_m: rnd(est / Math.max(1, npoints), 1), per_shot_floor_m: rnd(floor / Math.max(1, ncontacts), 2),
        avg_leg_speed_ms: mean(speeds), peak_leg_speed_ms: speeds.length ? rnd(Math.max(...speeds), 2) : null,
        hard_moves: speeds.filter(s => s > 3).length, pct_pulled_wide: pct(wide, totpos), folded
      };
    };
    M.player.movement = { you: movement("you"), opp: movement("opp") };
    const mn = M.player.movement.you, mo = M.player.movement.opp;
    M.player.movement.comparison = { who_covered_more: mn.dist_est_m > mo.dist_est_m ? "you" : "opp", diff_m: Math.round(mn.dist_est_m - mo.dist_est_m) };

    const positioning = k => {
      const full = k === "you" ? YOU : OPP;
      const gs = D.filter(r => G(r, "Player") === full && (G(r, "Stroke") === "Forehand" || G(r, "Stroke") === "Backhand"));
      const crel = r => { const hy = G(r, "Hit (y)"); if (!isNum(hy)) return null; return hy < NET ? (0 - hy) : (hy - BASE); };
      const dnorm = r => { const hy = G(r, "Hit (y)"), by = G(r, "Bounce (y)"); if (!isNum(hy) || !isNum(by)) return null; const d = hy < NET ? (by - NET) : (NET - by); return d / NET; };
      const pos = gs.map(crel).filter(v => v != null);
      const dep = gs.map(dnorm).filter(d => d != null && d > -0.5 && d < 1.7);
      const byStroke = {};
      ["Forehand", "Backhand"].forEach(s => { const ss = gs.filter(r => G(r, "Stroke") === s).map(crel).filter(v => v != null); byStroke[s] = { median_contact_m: ss.length ? median(ss) : null, n: ss.length }; });
      return {
        n: pos.length, median_contact_m: median(pos),
        inside_pct: pct(pos.filter(p => p > 0).length, pos.length),
        behind_half_m_pct: pct(pos.filter(p => p < -0.5).length, pos.length),
        deep_pct: pct(dep.filter(d => d > 0.66).length, dep.length),
        mid_pct: pct(dep.filter(d => d > 0.33 && d <= 0.66).length, dep.length),
        short_pct: pct(dep.filter(d => d <= 0.33).length, dep.length),
        median_depth: median(dep), by_stroke: byStroke, depth_consistency_std: rnd(pstd(dep), 3)
      };
    };
    M.player.positioning = { you: positioning("you"), opp: positioning("opp") };

    const reliability = k => {
      const full = k === "you" ? YOU : OPP;
      const mine = D.filter(r => G(r, "Player") === full);
      const gs = mine.filter(r => G(r, "Stroke") === "Forehand" || G(r, "Stroke") === "Backhand");
      const inp = gs.filter(r => G(r, "Result") === "In").length;
      const net = gs.filter(r => G(r, "Result") === "Net").length, out_ = gs.filter(r => G(r, "Result") === "Out").length;
      const byStroke = {};
      ["Forehand", "Backhand", "Volley"].forEach(s => { const ss = mine.filter(r => G(r, "Stroke") === s); if (!ss.length) return; byStroke[s] = { n: ss.length, in_pct: pct(ss.filter(r => G(r, "Result") === "In").length, ss.length), net: ss.filter(r => G(r, "Result") === "Net").length, out: ss.filter(r => G(r, "Result") === "Out").length }; });
      const byDir = {};
      gs.forEach(r => { const dd = G(r, "Direction"); if (dd === "---") return; (byDir[dd] = byDir[dd] || { n: 0, miss: 0 }); byDir[dd].n++; if (G(r, "Result") !== "In") byDir[dd].miss++; });
      const bd = {}; for (const d in byDir) bd[d] = { n: byDir[d].n, miss_pct: pct(byDir[d].miss, byDir[d].n) };
      return { groundstrokes: gs.length, in_play_pct: pct(inp, gs.length), miss_net: net, miss_out: out_, net_vs_out_bias: net > out_ ? "net" : "long", shots_per_miss: rnd(inp / Math.max(1, net + out_), 1), by_stroke: byStroke, by_direction: bd };
    };
    M.player.reliability = { you: reliability("you"), opp: reliability("opp") };
    M.player.methodology = {
      movement: "Distance = sum of moves between a player's own successive contact points within each rally. 'Minimum' is straight contact-to-contact (a hard floor, ignores recovery). 'Estimated' adds a recovery model. We do not see continuous position, so treat as a load index, not a GPS reading.",
      positioning: "Contact position = the player's Hit(y) relative to their own baseline (positive = inside the court / taking the ball early; negative = struck from behind). Depth = where their shot bounced as a fraction of the opponent's half. Both directly measured; ends folded.",
      reliability: "Uses the per-shot Result field (In/Out/Net), directly measured for every shot — it does NOT rely on inferring who won the point."
    };

    // ---------- COACHING BRIEF ----------
    M.brief = buildBrief(M);
    return M;
  }

  // ---------- brief generator (port of brief.py) ----------
  function buildBrief(M) {
    const nm = M.meta, you = nm.tracked, opp = nm.opp;
    const m = M.match, sv = M.serve, we = M.winners_errors, rb = M.rally.buckets, sh = M.shots, sp = M.patterns.serve_by_placement;
    const P = (a, b) => b ? rnd2(100 * a / b) : 0;
    function rnd2(x) { return Math.round(x * 10) / 10; }
    const oppPts = m.points_won.opp, youPts = m.points_won.you;
    const errShare = P(we.you.errors, oppPts);
    const fhE = we.you.errors_by_stroke.Forehand || 0, fhW = we.you.winners_by_stroke.Forehand || 0;
    const oppBhW = we.opp.winners_by_stroke.Backhand || 0;
    const dv = k => (sp.you[k] || {}).win_pct;
    return {
      match_summary: {
        headline: `${opp} won ${oppPts}–${youPts} on points (${m.point_win_pct.opp}% of points). The margin was manufactured almost entirely by ${you}'s unforced errors, not by the opponent's offense.`,
        score_context: "Rally-mode export: no game/set score is available. Point outcomes are inferred from the last tracked shot of each rally (In=winner, Net/Out=error by hitter).",
        sample: `${m.total_points} points, ${m.total_shots} shots, avg rally ${m.avg_rally_shots} shots, longest ${m.longest_rally}.`,
        player_style: {
          you: `Aggressive first-strike ball-striker. Big serve (avg ${sv.you.avg_speed}, top ${sv.you.max_speed} mph) and heavy forehand, but high-variance: ${we.you.errors} errors vs ${we.you.winners} winners (W/E ${we.you.winner_error_ratio}).`,
          opp: `Consistent counter-puncher. Soft serve (avg ${sv.opp.avg_speed} mph) but ${sv.opp.in_rate}% in; wins with a reliable backhand (${oppBhW} BH winners) and by extending rallies until ${you} misses.`
        }
      },
      key_findings: [
        { rank: 1, theme: "Unforced errors are the whole story", severity: "critical",
          metric: `${you} ${we.you.errors} errors → ${errShare}% of the opponent's ${oppPts} points came from ${you}'s mistakes, not opponent winners.`,
          evidence: { you_WE: we.you.winner_error_ratio, opp_WE: we.opp.winner_error_ratio, errors_net: we.you.errors_net, errors_out: we.you.errors_out },
          interpretation: "Beating yourself. Errors split fairly evenly net/out, so it is decision-making and margin, not one broken mechanic.",
          recommendation: "Raise net clearance and target ~1 m inside the lines. Moving W/E from " + we.you.winner_error_ratio + " toward ~0.9 flips this match.",
          drill: "'11-in-a-row' cross-court rally target: reset the count on any error. Trains margin under fatigue." },
        { rank: 2, theme: "Forehand is both weapon and biggest leak", severity: "high",
          metric: `Forehand = ${fhE} errors (largest single error source) but only ${fhW} winners.`,
          evidence: { FH_errors: fhE, FH_winners: fhW, BH_errors: we.you.errors_by_stroke.Backhand || 0, avg_FH_speed: sh.you.avg_speed_fh },
          interpretation: "Over-pressing the forehand, especially trying to end points too early in the 5–8 ball window.",
          recommendation: "Split forehands into 'build' vs 'finish'. Pull the trigger only on a genuine short ball; otherwise heavy cross-court with clearance.",
          drill: "Green-light/red-light feed: coach calls whether each forehand is an attack or a rally ball." },
        { rank: 3, theme: "The serve produces nothing free", severity: "high",
          metric: `${sv.you.aces_untouched} aces, ${sv.you.in_rate}% first-serve-in, and only ${sv.you.service_points_won_pct}% of service points won (${sv.you.svc_pts_won_excl_faults_pct}% excluding pure serve faults) despite a ${sv.you.max_speed} mph top speed.`,
          evidence: { serve_faults: sv.you.faults, faults_net: sv.you.serve_fault_net, faults_long: sv.you.serve_fault_out, downT_win: dv("down the T"), wide_win: dv("out wide") },
          interpretation: "Pace without placement or a plan. Most serve faults are into the net (low trajectory / rushed toss).",
          recommendation: "Trade ~10 mph for a repeatable target and a serve+1 pattern (wide serve → forehand into the open court). Raise contact to kill the net faults.",
          drill: "Serve+1 patterns: 20 balls wide-then-forehand, 20 T-then-backhand. Score only if both land in target zones." },
        { rank: 4, theme: "Breaks down in the mid-rally (5–8 balls)", severity: "medium",
          metric: `Win rate by rally length — short 2-4: ${rb["2-4 (short)"].you_win_pct}%, mid 5-8: ${rb["5-8 (mid)"].you_win_pct}%, long 9+: ${rb["9+ (long)"].you_win_pct}%.`,
          evidence: rb,
          interpretation: "Wins the first-strike (2–4) exchanges but the win rate collapses in the 5–8 window — forcing the issue when patience pays.",
          recommendation: "Add one more neutral ball before attacking. Treat balls 5–8 as construction, not finishing.",
          drill: "'Third-shot rule': no winner attempt allowed until at least the 6th ball of the rally." },
        { rank: 5, theme: "Down-the-line over-use", severity: "medium",
          metric: `Down-the-line is ${you}'s most error-prone direction (${we.you.errors_by_dir["down the line"] || 0} errors) though also a top winner direction (${we.you.winners_by_dir["down the line"] || 0}).`,
          evidence: { errors_by_dir: we.you.errors_by_dir, winners_by_dir: we.you.winners_by_dir },
          interpretation: "High-risk change-of-direction attempted from neutral or defensive positions.",
          recommendation: "Earn the down-the-line: change direction only on a ball taken inside the baseline. Default to cross-court to reset.",
          drill: "Directional discipline: 2 cross-court minimum before any down-the-line in live points." }
      ],
      opponent_scouting: {
        how_they_win: `Opponent scores primarily off the backhand (${oppBhW} BH winners) and by absorbing pace until ${you} errs.`,
        exploit: `Soft serve (avg ${sv.opp.avg_speed} mph) invites a return-attack — step in and take time away. Their backhand is a weapon, so serve and rally to the FOREHAND and approach behind deep balls.`,
        avoid: "Do not get into cross-court backhand trades — that is their strength."
      },
      one_line_gameplan: `Cut the unforced errors first (aim ~1 m inside the lines, more net clearance), build with the forehand instead of forcing it, serve for placement + a wide→forehand pattern rather than raw pace, and attack the opponent's forehand while avoiding backhand-to-backhand trades.`
    };
  }

  root.SVEngine = { build };
})(typeof window !== "undefined" ? window : globalThis);
