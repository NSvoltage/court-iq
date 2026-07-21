# Architecture

Court IQ is four plain-JS modules and one HTML template. There is no framework,
no bundler and no runtime dependency; `scripts/build.js` splices the modules and
the sample match into `src/template.html` at the `/*__ASSETS__*/` marker and
writes a single self-contained `dist/index.html`.

## Modules

Each module is an IIFE that attaches to `window` (or `globalThis` under Node),
which is why the same files run in the browser and in `npm test`. **Load order
matters** — each depends on the one above it:

| Order | File | Global | Responsibility |
|---|---|---|---|
| 1 | `vendor/fflate.js` | `fflate` | CSP-safe unzip |
| 2 | `vendor/xlsxlite.js` | `XLSXLite` | `.xlsx` → `{Settings, Shots, Rallies}` |
| 3 | `engine/base.js` | `SVEngine` | parse, dedupe, measured metrics, `buildBrief` |
| 4 | `engine/integrity.js` | `SVIntegrity` | point-outcome rules, repair, audit, evaluation |
| 5 | `engine/augment.js` | `SVEngine3` | shot quality, targeting, patterns — calls 3 then 4 |
| 6 | `engine/career.js` | `Career` | fingerprints, trend math, insights, persistence |

## The shape of it

```
.xlsx ─► XLSXLite.parse ─► rawSheets
                              │
                              ▼
              SVEngine.build          measured metrics
                              │
                              ▼
              SVIntegrity.process     outcome decisions + recompute
                              │
                              ▼
              SVEngine3.build   ────► M          one plain object
                              │
        Career.fingerprint(M) ─┴────► record ──► localStorage
                                                     │
                              every view renders from M / the history
```

Two properties are worth preserving:

**The engine is pure.** `rawSheets → M` touches no DOM, no network and no
storage. It's a function. That's what makes it testable under `node:test`, and
it means the same code could run anywhere a file can be read.

**`M` is the only contract.** Every view is a pure render of `M`; no view
computes a statistic of its own. When a number needs to change, it changes in the
engine and every view follows. `SVIntegrity` is the **single owner of point
outcomes** — nothing else decides who won a point, which is what keeps the
scoreboard, the statline, the brief and the career record from drifting apart.

## Where the browser is actually assumed

Surprisingly little. The coupling is concentrated in two places:

- **`career.js` persistence** — `read()` / `write()` wrap `localStorage` behind
  a two-function seam, with an in-memory fallback and a `SCHEMA` constant that
  discards records written by an older version.
- **`template.html`** — all rendering, `FileReader`, and the theme toggle.

`base.js`, `integrity.js` and the analytic half of `augment.js` assume nothing
about the environment.

## Storage model

`Career` deliberately keeps two tiers, because they have very different sizes:

- **records** — `Career.fingerprint(M)`, a compact rate-based summary (~1 KB).
  Every match keeps one forever; trends and insights read only these.
- **full models** — the entire `M` (~1 MB), kept for the most recent matches
  under an LRU budget so a match can be reopened without the original file.

Record `id` is a content hash of `start_time | opponent | total_shots`, so
loading the same export twice updates in place instead of duplicating.

## If this becomes a hosted, multi-user app

Noted here so the seams don't get paved over. Nothing below is built.

The current split already lines up with what a server version needs:

- **The engine moves unchanged.** Because `rawSheets → M` is pure and already
  runs under Node, parsing and analysis can run server-side on upload with no
  rewrite — or stay in the browser, with only the result uploaded.
- **Persistence is the one thing to swap.** `read()`/`write()` in `career.js` is
  the seam; a hosted version replaces those two functions with API calls and
  leaves the trend and insight math alone.
- **The two tiers map onto ordinary infrastructure.** Records are a row per
  match in a relational table (indexed by user and date — they're small and
  queryable); full models are blobs in object storage; the raw `.xlsx` is a blob
  too, if it's kept at all.
- **The content hash is the idempotency key.** Re-uploading the same export
  should update the row, not create a second one.
- **Identity has to move.** Today the tracked player is inferred from the
  sheet's `Host Team` name. With accounts, the account owns the match and that
  field becomes a hint for *which side of the net is me* — a per-upload
  question, since the name in the export won't reliably match the account.
- **The privacy claim changes, and the README has to change with it.** "No
  server, no account, no upload — your data never leaves your machine" is a
  headline feature right now. The moment uploads exist, match data and video
  timestamps are personal data at rest, with retention, deletion and export
  obligations. That's a product decision before it's an engineering one; a
  reasonable path is keeping local-only mode as the default and making sync
  opt-in.
