# Contributing to Court IQ

Thanks for your interest! Court IQ is intentionally small, dependency-free, and
inspectable. This guide covers the workflow and the few conventions that keep it
that way.

## Setup

```bash
git clone https://github.com/NSvoltage/court-iq.git
cd court-iq
npm run dev     # build + serve at http://localhost:5173
npm test        # run the unit tests
```

No `npm install` is required — there are no runtime or build dependencies.

## Project layout

- `src/template.html` — the UI. All views and rendering live here (plain SVG/Canvas, no framework). Contains the `/*__ASSETS__*/` marker the build fills in.
- `src/engine/base.js` — `window.SVEngine.build(rawSheets)`: parse + dedupe + measured metrics.
- `src/engine/integrity.js` — `window.SVIntegrity`: the single owner of point-outcome decisions — the rule table, repair, audit trail, and hold-out evaluation.
- `src/engine/augment.js` — `window.SVEngine3.build`: runs the base engine and the integrity pass, then adds shot quality, targeting, and patterns.
- `src/engine/career.js` — `window.Career`: per-match fingerprints, trend math, insights, and `localStorage` persistence.
- `src/vendor/` — vendored `fflate` + the `xlsxlite` reader.
- `scripts/build.js` — concatenates the above into `dist/index.html`.
- `test/` — `node:test` unit tests.

Each engine module is a plain IIFE that attaches to `window` (or `globalThis` in
Node), which is why the same files run both in the browser and in the tests.
They load in dependency order — `fflate` → `xlsxlite` → `base` → `integrity` →
`augment` → `career` — set in `scripts/build.js`. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the boundaries, and
[`AGENTS.md`](AGENTS.md) for a one-page operational summary (build, invariants,
gotchas) that a coding agent or a new contributor can start from.

## Conventions

- **Keep it dependency-free.** No runtime `npm` packages, no CDN links (the app
  targets strict CSPs). Vendor anything new under `src/vendor/` and record it in
  `THIRD_PARTY.md`.
- **Measured vs. modelled.** If you add a metric, be clear about whether it is
  measured from coordinates/speed/result or inferred. Modelled numbers are
  labelled as such in the UI.
- **One owner per number.** Views render `M`; they don't compute statistics of
  their own, and nothing outside `integrity.js` decides who won a point. Two
  places deriving the same number is how a scoreboard ends up disagreeing with
  the point count beside it.
- **Never invent data.** If the export can't support a stat, report it as
  unavailable rather than filling the gap with a plausible-looking guess.
- **Test engine changes.** If you touch the engines, add/adjust a case in
  `test/` and keep `npm test` green.

## Adding a tracked metric (career trends/insights)

The metric system is table-driven. To add one:

1. Add an entry to the `METRICS` array in `src/engine/career.js` with a `key`,
   `label`, `group`, `goodDir` (`+1` higher-is-better, `-1` lower-is-better,
   `0` neutral), `modeled` flag, `unit`, and a `get: M => …` accessor.
2. (Optional) add its `key` to `HEADLINE` to show it on the Trends grid by default.

It will automatically flow into fingerprints, the trend badges, and the insights
feed — no other wiring needed.

## Pull requests

- Keep changes focused and describe the "why".
- Run `npm run build` and open `dist/index.html` to sanity-check the UI.
- Be honest in copy: prefer "estimated"/"modelled" over implying certainty.
