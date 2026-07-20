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
`y = 23.77`, singles sideline at `x = ±4.115`.

## Pipeline

```
xlsxlite.parse(file)  →  rawSheets {Settings, Shots, Rallies}
SVEngine.build(rawSheets)   →  measured + first-order inferred model
SVEngine3.build(rawSheets)  →  + shot quality, reconstructed outcomes, patterns  =  M
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

## Outcome reconstruction

To cover the whole match instead of discarding ambiguous points, `SVEngine3`
reconstructs outcomes:

- Rallies ending on a measured **out/net** → counted as an error (certain).
- Rallies ending **in**, not truncated → credited to the hitter, weighted by the
  last shot's quality (a clear putaway vs. a soft ball).
- **Truncated** rallies (duration ≫ tracked shots) → winner imputed from the
  in-rally shot-quality gap.
- **Untracked** rallies (no shots logged) → allocated proportionally to form.

Each match reports `M.reconstruction.pct_estimated` — the share of points that
were modelled rather than measured — and the UI surfaces it.

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
| `M.reconstruction` | reconstructed score, sources, `pct_estimated` (modelled) |
| `M.patterns2` | serve+1 combos, direction tendency, rally openings |
| `M.trajectories` | per-shot enriched table (coords, result, quality) |
| `M.brief` | generated coaching narrative |

See `src/engine/base.js` and `src/engine/augment.js` for exact field names.
