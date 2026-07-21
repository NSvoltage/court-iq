/* ============================================================
   Court IQ — Career / longitudinal layer.
   window.Career: fingerprint(M) -> compact per-match record,
   localStorage persistence (records + LRU full models),
   trendOf(series,goodDir), insights(records), demoSeed(base).
   Pure of any single match's DOM.
   ============================================================ */
(function (root) {
  "use strict";
  const KEY = "courtiq_career_v1";       // { records:[...], full:{id:M}, order:[id...] }
  const FULL_BUDGET = 4.0e6;             // ~4MB of full-model JSON

  const num = x => (typeof x === "number" && isFinite(x)) ? x : null;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rnd = (x, d = 0) => { if (x == null) return null; const p = Math.pow(10, d); return Math.round(x * p) / p; };

  // ---- metric specification (single source of truth for fingerprint + views) ----
  // goodDir: +1 higher-is-better, -1 lower-is-better, 0 neutral. modeled: relies on inference.
  const METRICS = [
    { key: "serve_avg_mph", label: "Serve speed", group: "Serve", goodDir: 1, modeled: false, unit: "mph", get: M => num(M.serve.you.avg_speed) },
    { key: "serve_top_mph", label: "Serve top speed", group: "Serve", goodDir: 1, modeled: false, unit: "mph", get: M => num(M.serve.you.max_speed) },
    { key: "serve_in_pct", label: "Serve in %", group: "Serve", goodDir: 1, modeled: false, unit: "%", get: M => num(M.serve.you.in_rate) },
    { key: "serve_q", label: "Serve quality", group: "Serve", goodDir: 1, modeled: true, unit: "/100", get: M => num(M.quality.you.serve_q) },
    { key: "in_play_pct", label: "In-play rate", group: "Consistency", goodDir: 1, modeled: false, unit: "%", get: M => num(M.player.reliability.you.in_play_pct) },
    { key: "shots_per_miss", label: "Shots per miss", group: "Consistency", goodDir: 1, modeled: false, unit: "", get: M => num(M.player.reliability.you.shots_per_miss) },
    { key: "fh_in_pct", label: "Forehand in %", group: "Consistency", goodDir: 1, modeled: false, unit: "%", get: M => num((M.player.reliability.you.by_stroke.Forehand || {}).in_pct) },
    { key: "bh_in_pct", label: "Backhand in %", group: "Consistency", goodDir: 1, modeled: false, unit: "%", get: M => num((M.player.reliability.you.by_stroke.Backhand || {}).in_pct) },
    { key: "miss_long_share", label: "Miss-long share", group: "Consistency", goodDir: -1, modeled: false, unit: "%", get: M => { const r = M.player.reliability.you, t = r.miss_net + r.miss_out; return t ? rnd(100 * r.miss_out / t, 1) : null; } },
    { key: "deep_pct", label: "Deep-ball rate", group: "Depth & position", goodDir: 1, modeled: false, unit: "%", get: M => num(M.player.positioning.you.deep_pct) },
    { key: "contact_vs_baseline", label: "Contact vs baseline", group: "Depth & position", goodDir: 1, modeled: false, unit: "m", get: M => num(M.player.positioning.you.median_contact_m) },
    { key: "bh_contact", label: "Backhand contact", group: "Depth & position", goodDir: 1, modeled: false, unit: "m", get: M => num((M.player.positioning.you.by_stroke.Backhand || {}).median) },
    { key: "dist_per_point_m", label: "Distance / point", group: "Movement", goodDir: 0, modeled: true, unit: "m", get: M => num(M.player.movement.you.per_point_est_m) },
    { key: "pct_pulled_wide", label: "Pulled wide", group: "Movement", goodDir: -1, modeled: true, unit: "%", get: M => num(M.player.movement.you.pct_pulled_wide) },
    { key: "shot_quality", label: "Shot quality", group: "Quality", goodDir: 1, modeled: true, unit: "/100", get: M => num(M.quality.you.groundstroke_q) },
    { key: "elite_share", label: "Elite-shot rate", group: "Quality", goodDir: 1, modeled: true, unit: "%", get: M => { const q = M.quality.you; return q.n ? rnd(100 * q.elite_shots / q.n, 1) : null; } },
    { key: "xw_per100", label: "Expected winners /100", group: "Quality", goodDir: 1, modeled: true, unit: "", get: M => { const q = M.quality.you; return M.match.total_shots ? rnd(100 * q.expected_winners / M.match.total_shots, 2) : null; } },
    { key: "avg_rally", label: "Avg rally length", group: "Rally", goodDir: 0, modeled: false, unit: "", get: M => num(M.match.avg_rally_shots) },
    { key: "mid_rally_win_pct", label: "Mid-rally win %", group: "Rally", goodDir: 1, modeled: true, unit: "%", get: M => num((M.rally.buckets["5-8 (mid)"] || {}).you_win_pct) },
    { key: "bh_unpredictability", label: "Backhand unpredictability", group: "Behavior", goodDir: 1, modeled: false, unit: "%", get: M => unpredictability((M.patterns2.you.tendency || {}).Backhand) },
    { key: "fh_unpredictability", label: "Forehand unpredictability", group: "Behavior", goodDir: 1, modeled: false, unit: "%", get: M => unpredictability((M.patterns2.you.tendency || {}).Forehand) }
  ];
  const HEADLINE = ["serve_avg_mph", "serve_in_pct", "in_play_pct", "shot_quality", "deep_pct", "contact_vs_baseline", "bh_in_pct", "bh_unpredictability"];
  const METRIC = {}; METRICS.forEach(m => METRIC[m.key] = m);

  function unpredictability(tend) {
    if (!tend || !tend.length) return null;
    const tot = tend.reduce((s, t) => s + t.n, 0); if (!tot) return null;
    let H = 0; tend.forEach(t => { const p = t.n / tot; if (p > 0) H -= p * Math.log2(p); });
    return rnd(100 * H / Math.log2(5), 1); // normalized to max 5 directions
  }
  function hashId(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return "m" + (h >>> 0).toString(36); }
  function fmt(key, v) {
    if (v == null) return "—"; const m = METRIC[key], u = m ? m.unit : "";
    if (u === "%") return rnd(v, 1) + "%";
    if (u === "m") return (v > 0 ? "+" : "") + rnd(v, 2) + "m";
    if (u === "mph") return rnd(v, 0) + "";
    if (u === "/100") return rnd(v, 0) + "";
    return rnd(v, 1) + "";
  }

  // ---- fingerprint one match ----
  function fingerprint(M, opts) {
    opts = opts || {};
    const rec = M.reconstruction.reconstructed_score;
    const metrics = {}; METRICS.forEach(m => metrics[m.key] = m.get(M));
    const dateMs = opts.date != null ? opts.date : Date.now();
    return {
      id: hashId((M.meta.start_time || "") + "|" + (M.meta.opp_name || "") + "|" + M.match.total_shots),
      date: dateMs, date_str: opts.date_str || new Date(dateMs).toISOString().slice(0, 10),
      opponent: M.meta.opp, tracked: M.meta.tracked,
      points: M.match.total_points, shots: M.match.total_shots,
      score: { you: rec.you, opp: rec.opp }, win: rec.you > rec.opp,
      win_pct: rec.you + rec.opp ? rnd(100 * rec.you / (rec.you + rec.opp), 1) : null,
      pct_estimated: M.reconstruction.pct_estimated,
      weight: rnd(clamp(M.match.total_shots / 300, 0, 1) * (1 - 0.5 * (M.reconstruction.pct_estimated || 0) / 100), 3),
      metrics, demo: !!opts.demo
    };
  }

  // ---- persistence ----
  // localStorage is the source of truth; `mem` is an in-memory fallback so the
  // app still works in sandboxed iframes / private modes where storage throws.
  let mem = null;
  function blank() { return { records: [], full: {}, order: [] }; }
  function read() {
    try { const s = JSON.parse(root.localStorage.getItem(KEY)); if (s) return s; } catch (e) {}
    return mem || blank();
  }
  function write(store) {
    mem = store; // in-memory keeps the COMPLETE store (records + full models)
    try { root.localStorage.setItem(KEY, JSON.stringify(store)); return true; }
    catch (e) { // quota (or blocked): shrink a CLONE for storage; never touch `mem`
      const t = { records: store.records, full: Object.assign({}, store.full), order: store.order.slice() };
      while (t.order.length) { const id = t.order.shift(); delete t.full[id]; try { root.localStorage.setItem(KEY, JSON.stringify(t)); return true; } catch (e2) { } }
      try { root.localStorage.setItem(KEY, JSON.stringify({ records: store.records, full: {}, order: [] })); } catch (e3) { }
      return false;
    }
  }
  const Career = {
    metrics: METRICS, headline: HEADLINE, metric: k => METRIC[k], fmt, fingerprint,
    load() { const s = read(); return s.records.slice().sort((a, b) => a.date - b.date); },
    fullModel(id) { const s = read(); return s.full[id] || null; },
    fullIds() { return Object.keys(read().full); },
    add(record, fullModel) {
      const s = read();
      const i = s.records.findIndex(r => r.id === record.id);
      if (i >= 0) s.records[i] = record; else s.records.push(record);
      if (fullModel) {
        s.full[record.id] = fullModel;
        s.order = s.order.filter(x => x !== record.id); s.order.push(record.id);
        let bytes = JSON.stringify(s.full).length;
        while (bytes > FULL_BUDGET && s.order.length > 1) { const old = s.order.shift(); delete s.full[old]; bytes = JSON.stringify(s.full).length; }
      }
      write(s); return this.load();
    },
    remove(id) { const s = read(); s.records = s.records.filter(r => r.id !== id); delete s.full[id]; s.order = s.order.filter(x => x !== id); write(s); return this.load(); },
    clearDemo() { const s = read(); const demoIds = s.records.filter(r => r.demo).map(r => r.id); s.records = s.records.filter(r => !r.demo); demoIds.forEach(id => { delete s.full[id]; }); s.order = s.order.filter(x => !demoIds.includes(x)); write(s); return this.load(); },
    clearAll() { write(blank()); return []; },
    hasAny() { return read().records.length > 0; },
    exportText() { const s = read(); return JSON.stringify({ schema: "courtiq-career-1", exported: new Date().toISOString(), records: s.records }, null, 1); },
    importText(text) { const data = JSON.parse(text); const incoming = (data.records || []); const s = read(); incoming.forEach(r => { if (!s.records.find(x => x.id === r.id)) s.records.push(r); }); write(s); return this.load(); },

    // ---- trend of a series [{value,weight}] honoring goodDir ----
    trendOf(series, goodDir) {
      const pts = series.map((p, i) => ({ x: i, y: num(p.value), w: p.weight == null ? 1 : p.weight })).filter(p => p.y != null);
      if (pts.length < 3) return { dir: "flat", improving: null, significant: false, n: pts.length, label: "need ≥3" };
      const use = pts.slice(-8).map((p, i) => ({ x: i, y: p.y, w: p.w }));
      const W = use.reduce((s, p) => s + p.w, 0) || 1;
      const mx = use.reduce((s, p) => s + p.w * p.x, 0) / W, my = use.reduce((s, p) => s + p.w * p.y, 0) / W;
      let sxx = 0, sxy = 0; use.forEach(p => { sxx += p.w * (p.x - mx) * (p.x - mx); sxy += p.w * (p.x - mx) * (p.y - my); });
      const slope = sxx ? sxy / sxx : 0;
      let ss = 0; use.forEach(p => { const pred = my + slope * (p.x - mx); ss += p.w * (p.y - pred) * (p.y - pred); });
      const resStd = Math.sqrt(ss / W);
      const vals = use.map(p => p.y), range = Math.max.apply(null, vals) - Math.min.apply(null, vals);
      const change = slope * (use.length - 1);
      // significant = beats residual noise AND is a real fraction of the series' own spread
      const significant = Math.abs(change) > 0.6 * resStd && Math.abs(change) > 0.3 * range && range > 1e-9 && range > 0.02 * Math.abs(my);
      // dir = raw movement (drives the arrow); improving = whether that's good (drives the colour)
      const dir = significant ? (slope > 0 ? "up" : "down") : "flat";
      const improving = (significant && goodDir !== 0) ? ((slope * goodDir) > 0) : null;
      return { slope: rnd(slope, 3), change: rnd(change, 2), resStd: rnd(resStd, 2), range: rnd(range, 2), significant, dir, improving, n: pts.length };
    },

    // ---- insights over the full record series ----
    insights(records) {
      const out = []; if (records.length < 2) return out;
      const rs = records.slice().sort((a, b) => a.date - b.date);
      const last = rs[rs.length - 1], prev = rs[rs.length - 2];
      const std = key => { const v = rs.map(r => r.metrics[key]).filter(x => x != null); if (v.length < 2) return 0; const m = v.reduce((s, x) => s + x, 0) / v.length; return Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / v.length); };
      const insightable = m => m.goodDir !== 0 && m.key !== "xw_per100"; // skip neutral + tiny-scale metrics (poor insight copy)
      // since last match
      METRICS.forEach(m => {
        if (!insightable(m)) return;
        const a = last.metrics[m.key], b = prev.metrics[m.key]; if (a == null || b == null) return;
        const d = a - b, s = std(m.key); if (s <= 0 || Math.abs(d) < 0.5 * s) return;
        const good = m.goodDir === 0 ? null : (d * m.goodDir > 0);
        out.push({ scope: "Since last match", title: `${m.label} ${d > 0 ? "+" : ""}${rnd(d, m.unit === "m" ? 2 : 1)}${m.unit === "%" ? "%" : ""}`, detail: `${fmt(m.key, b)} → ${fmt(m.key, a)}`, tone: good == null ? "neutral" : good ? "good" : "bad", mag: Math.abs(d) / s, conf: m.modeled ? 0.7 : 1 });
      });
      // trends over last N
      METRICS.forEach(m => {
        if (!insightable(m)) return;
        const t = this.trendOf(rs.map(r => ({ value: r.metrics[m.key], weight: r.weight })), m.goodDir);
        if (!t.significant) return; const good = t.improving;
        const word = good === null ? (t.dir === "up" ? "rising" : "falling") : good ? "improving" : "slipping";
        out.push({ scope: `Over last ${Math.min(rs.length, 8)} matches`, title: `${m.label} is ${word}`, detail: `${t.dir === "up" ? "↑" : "↓"} ${m.label} ${t.change > 0 ? "+" : ""}${rnd(t.change, m.unit === "m" ? 2 : 1)}${m.unit === "%" ? "%" : ""} over the window`, tone: good == null ? "neutral" : good ? "good" : "bad", mag: Math.abs(t.change) / (t.resStd || 1), conf: m.modeled ? 0.7 : 1 });
      });
      // recurring behavior: miss-long dominant
      const window = rs.slice(-Math.min(rs.length, 7));
      const longK = window.filter(r => r.metrics.miss_long_share != null && r.metrics.miss_long_share > 50).length;
      if (longK >= Math.ceil(window.length * 0.6) && window.length >= 3) out.push({ scope: "Recurring behaviour", title: `Chronic over-hitting: miss long > net in ${longK} of last ${window.length}`, detail: `Consistent margin issue — aim inside the lines, add net clearance.`, tone: "bad", mag: longK, conf: 1 });
      // best/worst by composite of good-direction measured metrics
      const composite = r => { let s = 0, n = 0; METRICS.forEach(m => { if (m.goodDir === 0 || m.modeled) return; const v = r.metrics[m.key], sd = std(m.key); if (v == null || sd <= 0) return; const mean = rs.map(x => x.metrics[m.key]).filter(x => x != null); const mu = mean.reduce((a, b) => a + b, 0) / mean.length; s += m.goodDir * (v - mu) / sd; n++; }); return n ? s / n : 0; };
      const scored = rs.map(r => ({ r, c: composite(r) })).sort((a, b) => b.c - a.c);
      if (scored.length >= 3) { out.push({ scope: "Highlight", title: `Best match: ${scored[0].r.date_str} vs ${scored[0].r.opponent}`, detail: `Your strongest all-round performance by measured skills.`, tone: "good", mag: 0.4, conf: 1 }); }
      return out.sort((a, b) => (b.mag * b.conf) - (a.mag * a.conf)).slice(0, 12);
    },

    // ---- deterministic demo history from a base fingerprint ----
    demoSeed(base) {
      // 4 earlier matches; deltas trend upward toward `base` (recent), with realistic noise
      const plan = [
        { days: 63, mul: { serve_avg_mph: -7, serve_in_pct: -8, in_play_pct: -3.5, shot_quality: -6, deep_pct: -6, contact_vs_baseline: -0.35, bh_in_pct: -4, bh_unpredictability: -9, miss_long_share: 9 }, opp: "Rahul", win: true },
        { days: 45, mul: { serve_avg_mph: -4, serve_in_pct: -3, in_play_pct: -1.5, shot_quality: -3, deep_pct: 2, contact_vs_baseline: -0.2, bh_in_pct: -1, bh_unpredictability: -4, miss_long_share: 4 }, opp: "Opp", win: false },
        { days: 28, mul: { serve_avg_mph: -6, serve_in_pct: -1, in_play_pct: -2.5, shot_quality: -1, deep_pct: -2, contact_vs_baseline: -0.28, bh_in_pct: -6, bh_unpredictability: 3, miss_long_share: 6 }, opp: "Marcus", win: true },
        { days: 12, mul: { serve_avg_mph: -2, serve_in_pct: 2, in_play_pct: -0.5, shot_quality: -2, deep_pct: 3, contact_vs_baseline: -0.1, bh_in_pct: -2, bh_unpredictability: -2, miss_long_share: 2 }, opp: "Opp", win: false }
      ];
      return plan.map((p, i) => {
        const metrics = {}; METRICS.forEach(m => { const v = base.metrics[m.key]; metrics[m.key] = v == null ? null : rnd(v + (p.mul[m.key] || 0), m.unit === "m" ? 2 : 1); });
        const dateMs = base.date - p.days * 864e5;
        const yo = p.win ? 78 + i : 70 + i, op = p.win ? 70 : 82 - i;
        return { id: "demo" + i, date: dateMs, date_str: new Date(dateMs).toISOString().slice(0, 10), opponent: p.opp, tracked: base.tracked, points: 150 + i * 4, shots: 900 + i * 40, score: { you: yo, opp: op }, win: yo > op, win_pct: rnd(100 * yo / (yo + op), 1), pct_estimated: 34 + i, weight: 0.8, metrics, demo: true };
      });
    }
  };
  root.Career = Career;
})(typeof window !== "undefined" ? window : globalThis);
