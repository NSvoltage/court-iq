# AGENTS.md

Orientation for an agent (or a new contributor) working in this repo. Operational
rules and the shape of the build live here; the deeper "why" lives in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
[`docs/DATA_MODEL.md`](docs/DATA_MODEL.md).

## What this is

Court IQ turns a SwingVision ball-tracking `.xlsx` export into a tennis analytics
dashboard. It is **one static HTML file** — parsing, every analytic, and the
match history all run in the browser. No server, no build step at runtime, no
dependencies.

## Commands

```bash
npm run dev      # build + serve at http://localhost:5173
npm run build    # writes the self-contained dist/index.html
npm test         # node:test — engine, career, and .xlsx suites (23 tests)
```

There is no `npm install` — no runtime or build dependencies. Node ≥ 18.

## How the build works (the modular part)

The app is authored as separate plain-JS modules and **spliced into one file at
build time**. `scripts/build.js` reads the modules in a fixed order, concatenates
them, and drops the result into `src/template.html` at the marker
`/*__ASSETS__*/` (inside a `<script>` tag on line ~423). It then embeds the
sample match as `window.SAMPLE_RAW` and emits `dist/index.html`.

Nothing is minified or transpiled — the output is inspectable, and what you edit
in `src/` is what ships.

**Module load order is a hard constraint** — each layer depends on the one above,
and the order is set in `scripts/build.js`:

| Order | File | Global | Responsibility |
|---|---|---|---|
| 1 | `src/vendor/fflate.js` | `fflate` | CSP-safe unzip (vendored, MIT) |
| 2 | `src/vendor/xlsxlite.js` | `xlsxlite` | `.xlsx` → `{Settings, Shots, Rallies}` |
| 3 | `src/engine/base.js` | `SVEngine` | parse, dedupe, measured metrics, `buildBrief` |
| 4 | `src/engine/integrity.js` | `SVIntegrity` | point-outcome rules, repair, audit, evaluation |
| 5 | `src/engine/augment.js` | `SVEngine3` | shot quality, targeting, patterns — calls 3 then 4 |
| 6 | `src/engine/career.js` | `Career` | fingerprints, trends, insights, `localStorage` |

Each module is an IIFE that attaches to `window` (or `globalThis` under Node),
which is why the **same files run in the browser and in `npm test`** with no
shim. `src/template.html` is the UI shell and every view (hand-rolled SVG/Canvas,
no framework).

```
.xlsx ─► xlsxlite ─► SVEngine.build ─► SVIntegrity.process ─► SVEngine3.build ─► M
                                                                                 │
                                       Career.fingerprint(M) ─► localStorage ────┘
                                                                                 ▼
                                             every view renders from M / the history
```

## The rules that keep the numbers honest

These are not style preferences — violating them is how the app starts showing
figures that contradict each other.

- **`M` is the only contract.** The engine builds one plain object `M`; every
  view is a *pure render* of it. No view computes a statistic of its own. When a
  number is wrong, fix it in the engine and every view follows.
- **One owner per number.** `SVIntegrity` is the single owner of who won each
  point. Nothing else decides outcomes. Two code paths deriving the same number
  is exactly how a scoreboard ends up disagreeing with the point count beside it
  (this has happened — see the "one scoreboard" test in `test/engine.test.js`).
- **Never invent data.** If the export can't support a stat (break points, games,
  sets — the scoreboard isn't in a rally-mode export), report it as unavailable.
  Modelled figures are marked; they never masquerade as measured. Rallies with no
  shots logged are counted but never scored.
- **Measured vs. modelled is load-bearing.** Coordinates, speed, and per-shot
  in/out are measured — trust them. Anything depending on who won a point is
  modelled. Keep new metrics on the correct side of that line and label them.

## Working conventions

- **Verify from the console, not a screenshot.** The app is one big inline
  script, so a syntax error blanks the whole page silently. Regressions are
  caught by rendering under headless Chrome and reading the console across views
  and both themes — a clean screenshot is not proof the console is clean.
- **Watch the cascade.** All CSS is in `template.html`; class names are global.
  A later rule with the same class name silently wins (a scoreboard `.prow` once
  collided with the points-log `.prow`). Grep for a class before reusing it.
- **`height="auto"` is valid CSS but not a valid SVG attribute** — set it via
  `svg.style.height`, or it throws on every render.
- **Test engine changes.** Touch an engine, add/adjust a case in `test/` and keep
  `npm test` green. `test/xlsx.test.js` parses `examples/sample-match.xlsx` end
  to end and checks it builds the same match as the bundled JSON, so the two
  can't silently diverge.

## Adding a tracked (career) metric

The metric system is table-driven. Add one entry to the `METRICS` array in
`src/engine/career.js` (`key`, `label`, `group`, `goodDir`, `modeled`, `unit`,
`get: M => …`) and it flows into fingerprints, trend badges, and insights
automatically — no other wiring.

## Data & privacy

- The bundled sample and `examples/sample-match.xlsx` are a real match with the
  player anonymised to a first name. **This repo is public** — anything committed
  is world-readable. Re-verify any new data file before committing it.
- `.gitignore` blocks `*.xlsx` everywhere except `examples/`, so a real export
  can't be committed by accident.

## Layout

```
src/template.html      UI shell + every view; contains the /*__ASSETS__*/ marker
src/engine/*.js        the six-stage pipeline above
src/vendor/*.js        fflate + xlsxlite (see THIRD_PARTY.md)
src/data/              anonymised demo match (built in as window.SAMPLE_RAW)
examples/              the same match as a loadable .xlsx
scripts/build.js       the splice
test/                  node:test suites
docs/                  ARCHITECTURE.md, DATA_MODEL.md
```
