# Data model & methodology

This document describes what Court IQ reads from a SwingVision export, the model
object it builds, and — importantly — which numbers are **measured** vs.
**modelled**.

## Input

A SwingVision spreadsheet export (`.xlsx`) with three sheets:

- **Settings** — start/end time, host & guest player names.
- **Shots** — one row per tracked shot: player, stroke, spin, speed (mph),
  result (In/Out/Net), direction, and coordinates for the contact point
  (`Hit x/y/z`) and the bounce (`Bounce x/y`). Rally-mode exports have `Game`
  and `Set` columns set to `0` (no scoreboard).
- **Rallies** — one row per rally with a `Duration`.

Coordinates are in metres. Court constants: net at `y = 11.885`, baseline at
`y = 23.77`, singles sideline at `x = ±4.115`, doubles sideline at `x = ±5.485`.

**Singles is assumed.** The export carries no singles/doubles flag, so the
placement maps draw a singles court and treat the doubles alleys as out. On the
sample match this agrees with the tracking — every alley bounce is already
labelled `Result = Out` — but a doubles export would be read wrongly.

## Pipeline

```
xlsxlite.parse(file)        →  rawSheets {Settings, Shots, Rallies}
SVEngine.build(rawSheets)   →  measured + first-order inferred model
SVIntegrity.process(M)      →  point outcomes decided, repaired, audited, verified
SVEngine3.build(rawSheets)  →  + shot quality, targeting, patterns              =  M
Career.fingerprint(M)       →  compact per-match record for history/trends
```

### Cleaning / correction

- **De-duplication.** Some exports contain duplicated rows (occasionally with a
  flipped player label). Rows are de-duplicated by `(Point, Shot)`, keeping the
  first occurrence. The count removed is reported (`M.meta.corrupt_dupes_removed`).
- **Outlier flags.** Bounces well outside the court and physically implausible
  speeds are flagged (`M.corrections`).

## Measured vs. modelled

The pipeline separates ground truth from inference. This is the single most
important thing to understand about the numbers.

### Measured (trust directly)
Everything read straight from the tracking:

- Bounce coordinates and contact coordinates.
- Ball speed.
- Per-shot result (In / Out / Net).
- Anything aggregated purely from the above: placement maps, shot depth,
  contact-position-vs-baseline, in-play rates, serve speed & landing, rally
  lengths, direction tendencies.

### Modelled / inferred (treat as estimates)
Anything that depends on *who won a point*, which the export does not record:

- **Point outcomes & the scoreline.** Only ~half of points in a typical
  rally-mode export end on a measured miss (out/net). "In"-ending rallies are
  ambiguous — a winner, or just where tracking stopped.
- **Winners vs. errors**, momentum, service-points-won.
- **Shot quality (`xQuality`, 0–100)** — a heuristic from speed, depth and angle.
- **Distance covered** — estimated from contact positions between shots (a load
  index, not a GPS track).
- **First vs. second serve** — not distinguishable; only one serve is logged per
  point.

## Outcome reconstruction — the integrity engine

`src/engine/integrity.js` (`window.SVIntegrity`) is the **single owner of every
point-outcome decision**. Nothing else in the codebase decides who won a point,
which is what keeps the scoreboard, the statline, the coaching brief and the
career record from drifting apart. It is a separate module so it can be audited
and evaluated independently of the UI.

```
CLASSIFY → LEARN prior → IMPUTE → REWRITE → RECOMPUTE → VERIFY
```

### 1. Classify

An ordered rule table decides how each point ended. Order matters — the first
matching rule wins:

| Rule | Fires when | Class |
|---|---|---|
| `serve_fault_unresolved` | one shot, a serve, not `In` | reconstructed |
| `measured_miss` | last shot not `In` | measured |
| `long_rally_end` | ≥ 9 shots tracked | winner |
| `clean_putaway` | last-shot quality clears a shot-count threshold | winner |

`serve_fault_unresolved` encodes a rule of tennis that the export can't express:
**a missed first serve doesn't end the point.** Only one serve is logged per
point, so a lone faulted serve is ambiguous — the second serve simply wasn't
recorded. Scoring it as the server losing the point is what drove both players
below 50 % of service points won.

### 2. Learn, impute, rewrite

A prior is learned from **measured-only** points, then truncated points are
ranked by a `dominance()` score and imputed to match that prior. Each point
receives `outcome_class`, `outcome_conf` and a plain-English `reason`.

### 3. Recompute

Everything downstream of an outcome is rebuilt from the repaired points: points
won, winners/errors, serve stats, rally buckets, momentum and trajectory tags.
The coaching brief is regenerated afterwards so its narrative can't quote
pre-repair counts.

### 4. Verify

Impossible states are checked against the rules of tennis — e.g. both players
winning under half their service points, which cannot happen because someone has
to be holding serve.

### What it will not do

**Rallies with no shots logged are counted but never scored.** Splitting them by
the tracked win-rate would invent an outcome for a point there is zero evidence
about, and it put the scoreboard out of step with the point count shown
everywhere else. `M.reconstruction.rallies_seen` reports them; only
`total_points` is ever scored.

Stat families the export cannot support — break points, games, sets — are
reported as unavailable rather than fabricated (`M.integrity.verification`).

### Auditing and evaluation

- `M.integrity.repair.audit` — one entry per change: point, before → after, the
  rule that fired, why, and a confidence.
- `SVIntegrity.evaluate()` — a hold-out **stratified by server**, reporting
  `calibration_error_pts` as the primary metric and `accuracy` as secondary.
  Calibration leads because per-point accuracy on a genuinely ambiguous point is
  close to a coin flip; what matters is that the *totals* come out right.

`M.reconstruction.pct_estimated` reports the share of scored points that were
modelled rather than measured, and the UI marks modelled figures with an
asterisk.

## Longitudinal fingerprint

`Career.fingerprint(M)` reduces a match to a compact, **rate-based** record
(percentages / per-point / per-100) so matches of different lengths compare
fairly. Every metric carries:

- a **`goodDir`** (`+1` higher-is-better, `-1` lower-is-better, `0` neutral) so
  trend arrows mean *improvement*, not just up/down;
- a **`modeled`** flag so estimated metrics are marked;
- a **`weight`** (`shots / 300`, discounted by `pct_estimated`) so short or
  heavily-modelled matches count less in trends and insights.

Trends use a weighted linear slope with noise/spread guards so genuinely flat or
steady-but-noisy series read as *flat* rather than trending. Raw direction (the
arrow) and improvement (the colour) are computed separately.

## The `M` object (top level)

| Key | Contents |
|---|---|
| `M.meta` | player names, timestamps, row counts |
| `M.match` | totals, points won (inferred), rally stats |
| `M.serve` / `M.shots` | per-player serve & stroke aggregates (measured) |
| `M.winners_errors` | winners/errors by stroke & direction (inferred) |
| `M.rally` / `M.momentum` | rally-length splits; running point diff (inferred) |
| `M.player.movement` | distance estimate, coverage, work-rate (modelled) |
| `M.player.positioning` | contact-vs-baseline, depth mix (measured) |
| `M.player.reliability` | per-shot in/out by stroke & direction (measured) |
| `M.quality` | shot-quality index, expected winners (modelled) |
| `M.points` | one row per point: winner, `outcome_class`, `outcome_conf`, `reason` |
| `M.integrity` | repair report + `audit`, `verification`, hold-out `evaluation` |
| `M.reconstruction` | score, sources, `pct_estimated`, `rallies_seen` (modelled) |
| `M.targeting` | placement in the receiver's frame: lateral, depth, grid, directions |
| `M.patterns2` | serve+1 combos, direction tendency, rally openings |
| `M.trajectories` | per-shot enriched table (coords, result, quality) |
| `M.brief` | generated coaching narrative |

See `src/engine/base.js` and `src/engine/augment.js` for exact field names.
