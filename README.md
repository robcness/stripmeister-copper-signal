# StripMeister Copper Recovery Signal

Private internal prototype for an embeddable StripMeister website widget. **Do not publish publicly.**

## Purpose

A single at-a-glance widget that connects current copper-market conditions to a practical
StripMeister next step — for copper recyclers, scrappers, electricians, and contractors deciding
whether the recovery math supports buying a wire stripping tool right now.

Common-sense indicator. Not a forecast, not financial advice, not a scrap-yard pricing guarantee,
not an ROI promise.

## Files

- `index.html` — single-page widget markup.
- `style.css` — design tokens, layout, dial, stoplight, theming (light + dark).
- `app.js` — theme toggle, responsive model-finder anchor swap, and live-data
  hydration from `data/copper-signal.json` (with graceful fallback).
- `data/copper-signal.json` — single source of truth for values shown in the
  widget (price, deltas, scrap references, score, sources).
- `scripts/update-copper-data.mjs` — Node script that reads/writes that JSON,
  recomputes deltas + spread, and is run by GitHub Actions.
- `.github/workflows/update-copper-data.yml` — scheduled / manual workflow
  that runs the updater and commits the refreshed JSON.
- `qa-*.png` — local QA screenshots (desktop + mobile, both themes).

## Design language (current iteration)

- **Palette:** charcoal + StripMeister red (logo-matched). Copper as the warm metal accent
  on the arched dial, hairline trim, and field gradients. Blue is reserved exclusively for the
  primary CTA button.
- **Today's buying signal:** arched copper gauge dial with a needle pointing into the buy zone.
  The stoplight readout is integrated directly under the arc as a single illuminated green light
  carrying the words “GOOD TIME TO BUY” and the score (`82/100`). No standalone stoplight section,
  no chart legend.
- **Plain-language interpretation:** three short, action-oriented bullets covering market posture,
  why recovered copper matters now, and how volume + labor cost decide urgency. The previous
  standalone "Recovery rationale" variable has been folded in here and into the methodology blurb.
- **CTAs:** two buttons in one grouped area — `Calculate your wire recovery` (blue primary) and
  `Find your StripMeister model` (outlined). No duplicate CTAs anywhere on the page.
- **Methodology + sources:** a single compact `<details>` accordion at the bottom.

## CTA destinations

- Calculate your wire recovery → `https://www.stripmeister.com/pages/scrap-calculator`
- Find your StripMeister model →
  - desktop: `https://www.stripmeister.com#shopify-section-template--18912940359751__sm_desktop_all_products_v2_QU9pWA`
  - mobile (auto-swapped by `app.js`): `https://www.stripmeister.com#shopify-section-template--18912940359751__sm_mobile_products_v3_Da6cGT`

## Prototype scoring model

- Price momentum: 35%
- Five-year value context: 25%
- Recycling demand relevance: 20%
- Short-term risk adjustment: 20%

## Local preview

```bash
cd stripmeister-copper-signal
python3 -m http.server 8765
# open http://localhost:8765/index.html
```

The widget fetches `./data/copper-signal.json` on load and hydrates the
visible values, chips, KPI, methodology table, and stacked calculation
block. If the fetch fails (file missing, served from `file://`, etc.) the
hardcoded HTML values remain, so the page always renders.

## Live data plan

### Architecture

- **Hosting:** GitHub Pages serves the static `index.html`, `style.css`,
  `app.js`, and `data/copper-signal.json` from the repo root. No backend.
- **Single source of truth:** `data/copper-signal.json` carries every value
  the widget shows — copper reference price, 30d / 12mo / 5yr deltas, bare
  bright + insulated references, strip value delta, 50 lb spread, score,
  labels, source URLs, and a positive/negative status flag per metric.
- **Hydration on load:** `app.js` runs `fetch('./data/copper-signal.json')`,
  walks `[data-field]` elements, and writes formatted values into the DOM.
  The chip color (`positive` / `negative`) is driven by the status flag, so
  a swing into negative territory automatically restyles the chip.
- **Graceful fallback:** every fetch step is wrapped in try/catch. If the
  JSON is missing or malformed, the static HTML values stay in place — the
  widget is never blank.

### Update cadence

- **GitHub Actions workflow:** `.github/workflows/update-copper-data.yml`
  runs on a daily schedule (`30 13 * * *`, ≈ 09:30 ET) and on manual
  `workflow_dispatch`. It runs `node scripts/update-copper-data.mjs`, which
  reads the JSON, optionally pulls fresh source values, recomputes deltas
  and spread, and writes the file back. The workflow commits the file only
  if something changed.
- **Conservative by default.** Without `FETCH_SOURCES=1` the script only
  refreshes `generated_at` / `last_checked` and leaves market values
  untouched. That keeps the page stable on a bad-network day and avoids
  accidentally publishing a wrong number on a partial fetch.

### Sources

- **Copper futures (live, automated):** [Yahoo Finance v8 chart — HG=F](https://query1.finance.yahoo.com/v8/finance/chart/HG=F?interval=1d&range=5y).
  Free, no API key, returns 5 years of daily closes plus the latest live quote
  in USD/lb (the same unit the widget displays). The updater computes 30d /
  12mo / 5yr deltas against the closest preceding trading day in this series
  and stamps the actual anchor dates into `data/copper-signal.json` under
  `copper.history.{latest,d30,y1,y5}`.

  Stooq HG.F (originally suggested) was tested and rejected: as of 2026-Q2
  the daily-CSV endpoint requires an account-bound API key, and the public
  quote page is JS-driven without a server-rendered price. The script header
  documents this in detail. If Yahoo ever degrades, the script preserves the
  existing JSON values — the dashboard never goes blank.

- **Scrap reference spread (manual / reference only):**
  - [Rockaway Recycling — #1 Bare Bright Wire](https://rockawayrecycling.com/metal/1-bare-bright-wire/)
  - [Rockaway Recycling — Insulated Copper Wire](https://rockawayrecycling.com/metal/insulated-copper-wire/)
  - [iScrap App — bare bright copper](https://iscrapapp.com/metals/bare-bright-copper/)
  - [ScrapMonster — copper scrap](https://www.scrapmonster.com/scrap-prices/category/Copper-Scrap/128/1/1)

  These are intentionally **not auto-fetched.** The pages are HTML-only,
  layouts change without notice, and headline rates are reference-only —
  local yards quote daily and apply their own grading. Auto-publishing a
  brittle scrape risks misleading users. Update via the workflow_dispatch
  inputs `bare_bright_override` / `insulated_override`, or by editing
  `data/copper-signal.json` directly. The widget already discloses these as
  reference rates and surfaces three independent sources.

### Caveats

- **No runtime fetching in the browser.** All source fetching happens inside
  GitHub Actions (or a manual run of the script) and writes a static JSON —
  CORS and rate limits would break a browser-side fetch.
- **Yahoo can degrade.** The fetcher uses a 15-second timeout and silently
  preserves the previous value on any failure (HTTP, parse, network).
- **Scrap reference values stay manual** until/unless a more reliable
  programmatic source (or a paid feed Rob is willing to pay for) is
  introduced.

### Workflow hardening

`.github/workflows/update-copper-data.yml` pins both third-party actions to
immutable commit SHAs (with the version in a trailing comment) per GitHub's
supply-chain hardening guidance:

- `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5  # v4.3.1`
- `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020  # v4.4.0`

Last verified 2026-04-30. Update both the SHA and the version comment when
bumping; resolve via `https://api.github.com/repos/<owner>/<repo>/commits/<tag>`.

### Manual update workflow

Run the script locally, then commit the JSON.

```bash
# Conservative: only refreshes timestamps.
node scripts/update-copper-data.mjs

# Live copper fetch (Yahoo Finance HG=F):
FETCH_SOURCES=1 node scripts/update-copper-data.mjs

# Manual price overrides (e.g. for scrap references, which are never
# auto-fetched):
COPPER_OVERRIDE=6.12 \
BARE_BRIGHT_OVERRIDE=5.10 \
INSULATED_OVERRIDE=1.80 \
node scripts/update-copper-data.mjs
```

The same overrides are exposed as `workflow_dispatch` inputs in the GitHub
Action, so you can refresh values from the GitHub UI without a local clone.
