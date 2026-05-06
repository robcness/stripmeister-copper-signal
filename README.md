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
- **Currency toggle (USD / CAD):** a compact pill toggle sits above the key metrics row.
  USD is the default (the underlying source data is USD). Selecting CAD re-renders the
  copper reference, bare bright, insulated, strip value delta, 50 lb spread, and the
  methodology / calculation values from USD/lb to CAD/lb using a single FX rate stored
  in `data.fx.usd_to_cad`. Percent deltas and the signal score are dimensionless and
  never change. Labels always show explicit `USD/lb` or `CAD/lb` to avoid implying a
  guaranteed yard price.

## CTA destinations

- Calculate your wire recovery → `https://www.stripmeister.com/pages/scrap-calculator`
- Find your StripMeister model →
  - desktop: `https://www.stripmeister.com#shopify-section-template--18912940359751__sm_desktop_all_products_v2_QU9pWA`
  - mobile (auto-swapped by `app.js`): `https://www.stripmeister.com#shopify-section-template--18912940359751__sm_mobile_products_v3_Da6cGT`

## Currency conversion (USD / CAD)

The widget supports a simple display-only currency toggle. The default and source
currency is **USD**; **CAD** is a reference conversion only.

### Source of the FX rate

- **Primary:** [Bank of Canada Valet API](https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1)
  (`FXUSDCAD`). Free, no API key, official daily reference rate.
- **Fallback:** the previous value in `data/copper-signal.json` is preserved when the
  fetch fails, with `fetch_status.fx_usd_cad` set to `bank-of-canada-failed` so the
  staleness is auditable.
- **Manual override:** set `FX_USD_CAD_OVERRIDE` (env or workflow_dispatch input) to
  pin the rate to a specific value. Wins over the fetched value.

The rate is stored in the JSON under `fx`:

```jsonc
"fx": {
  "base_currency": "USD",
  "quote_currency": "CAD",
  "usd_to_cad": 1.3624,
  "as_of_date": "2026-04-30",
  "source": {
    "label": "Bank of Canada Valet — FXUSDCAD",
    "url": "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1",
    "caveat": "Daily reference rate from Bank of Canada. Not a transactional rate; banks and yards apply their own spreads. Display-only conversion."
  },
  "fetch_status": "bank-of-canada",
  "manual_override": null
}
```

### What converts and what does not

| Field                        | Converts? | Rounding              |
| ---------------------------- | --------- | --------------------- |
| Copper reference price       | Yes       | 2 decimal places (× rate) |
| Bare bright reference        | Yes       | 2 decimal places          |
| Insulated wire reference     | Yes       | 2 decimal places          |
| Strip value delta            | Yes       | 2 decimal places          |
| 50 lb spread                 | Yes       | rounded to whole dollar    |
| History closes (calc text)   | Yes       | 3 decimal places (kept tight to preserve calc readability) |
| Methodology + calc block     | Yes (USD/lb → CAD/lb labels) | inherits per-row rule |
| 30d / 12mo / 5yr percent     | **No** — dimensionless   | n/a                       |
| Signal score (82 / 100)      | **No** — dimensionless   | n/a                       |

Conversion is a single multiplication: `cad_value = usd_value * fx.usd_to_cad`.
Rounding is applied **after** the multiplication, per the table above. The labels
(`USD/lb` vs. `CAD/lb`) are driven by the same toggle state so the displayed unit
always matches the displayed value.

### Caveats explicitly disclosed in-app

- The toggle's caption (`fx-meta-text`) shows the live rate, the source
  (“Bank of Canada Valet — FXUSDCAD”), and the rate's `as_of_date` whenever CAD is
  selected.
- The text “**Display only — not a yard quote.**” is rendered alongside the rate in
  CAD mode to make clear this is reference conversion, not a buyer’s price.
- If `data.fx.usd_to_cad` is missing or invalid (e.g. fallback HTML render with no
  live data), clicking the CAD button flips the visual toggle state but the numbers
  remain in their static USD form and the caption reads
  “CAD rate unavailable · showing USD reference values.” The widget never displays
  unconverted USD values under a CAD label.

### Currency-sensitive copy (USD vs. CAD wording)

Alongside the numeric conversion, a tiny localization layer in `app.js` swaps a
handful of phrases to read naturally in each market. This is intentionally
restrained — commodity terms, units (lb, gauge), grade names, and product names
are **not** localized.

Marked-up phrases live on `data-copy="<key>"` elements in the HTML; the `COPY`
map in `app.js` provides the USD and CAD strings. Missing keys silently fall
back to USD so the DOM is never blanked.

Current keys:

| Key             | USD                                                                                | CAD                                                                                                |
| --------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `verify-local`  | “your local scrap yard before committing volume …”                                 | “your local scrap yard or recycler before committing volume …”                                     |
| `manual-labor`  | “current manual labor hours”                                                       | “current manual labour hours”                                                                      |
| `yards-grading` | “Local scrap yards quote daily and apply their own grading; confirm with the buyer” | “Local scrap yards and recyclers quote daily and apply their own grading; confirm with the buyer” |

The locale is re-applied on every currency toggle, including the static-fallback
path where live JSON failed to load.

### Test IDs

For automated checks, every converted value carries a stable `data-testid`:

- `currency-toggle`, `currency-toggle-usd`, `currency-toggle-cad`
- `text-fx-meta` (caption with rate + source + date)
- `text-copper-price`, `unit-copper-price`
- `text-strip-delta`, `unit-strip-delta`
- `text-bare-bright-price`, `text-insulated-price`, `text-spread-per-50lb`
- `text-currency-code` (the small “(USD)” / “(CAD)” marker in the spread copy)
- `text-method-copper-price`, `text-method-strip-delta`
- `block-calc`, `text-calc-bare-bright`, `text-calc-insulated`, `text-calc-strip-delta`, `text-calc-spread-value`
- `copy-verify-local`, `copy-manual-labor`, `copy-yards-grading` (currency-sensitive copy hooks)

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
  runs every weekday at **09:30 America/New_York** (Eastern Time),
  excluding weekends and U.S. market holidays. Manual `workflow_dispatch`
  is also available and **always bypasses** the schedule guard, so a
  human-initiated rerun is never blocked. The job runs
  `node scripts/update-copper-data.mjs`, which reads the JSON, optionally
  pulls fresh source values, recomputes deltas and spread, and writes the
  file back. The workflow commits the file only if something changed.

  GitHub's `schedule:` cron is UTC-only with no DST or holiday awareness,
  so the workflow registers two cron entries — `30 13 * * 1-5` and
  `30 14 * * 1-5` — and `scripts/schedule-guard.mjs` gates the run on
  the actual local Eastern time + weekday + market-holiday calendar.
  Between EDT (UTC-4) and EST (UTC-5), exactly one of those two crons
  hits 09:30 ET on any given weekday; the other is skipped by the guard.

  The guard's holiday calendar is a transparent **U.S. equity / CME-style
  market-holiday list** (defined in `scripts/schedule-guard.mjs` as
  `HOLIDAYS_2026` / `HOLIDAYS_2027`): New Year's Day observed, MLK Day,
  Presidents' Day, Good Friday, Memorial Day, Juneteenth observed,
  Independence Day observed, Labor Day, Thanksgiving, and Christmas
  observed. We chose U.S. market holidays because the live copper source
  is COMEX High Grade Copper futures (`HG=F`) on CME, which follows the
  U.S. holiday calendar. To switch to Canadian statutory holidays later,
  edit those tables in `schedule-guard.mjs` and update this paragraph.

  Guard logic is unit-tested in `scripts/test-schedule-guard.mjs` —
  scenarios cover EDT vs EST, weekend skips, holiday skips, drift
  tolerance, and an `America/Toronto` cross-check. Run with:

  ```bash
  node scripts/test-schedule-guard.mjs
  ```
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
  layouts change without notice, and headline rates are reference-only.

- **USD/CAD foreign exchange (Bank of Canada Valet — official, free, no key):**
  - [Valet observations — FXUSDCAD](https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1)

  Daily reference rate, not a transactional / dealing rate. The updater
  fetches the most recent observation, sanity-bounds it to a plausible range
  (0.5 – 3.0 USD/CAD), and writes it into `data.fx.usd_to_cad` along with the
  observation date. On any failure it preserves the previous value and stamps
  `fetch_status.fx_usd_cad = 'bank-of-canada-failed'`. A `FX_USD_CAD_OVERRIDE`
  manual override is supported for emergencies.

  These reference-rate caveats also apply elsewhere in this section:
  Local yards quote daily and apply their own grading. Auto-publishing a
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

# Live copper fetch (Yahoo Finance HG=F) AND USD/CAD (Bank of Canada Valet):
FETCH_SOURCES=1 node scripts/update-copper-data.mjs

# Manual price overrides (e.g. for scrap references, which are never
# auto-fetched). FX_USD_CAD_OVERRIDE pins the FX rate when set.
COPPER_OVERRIDE=6.12 \
BARE_BRIGHT_OVERRIDE=5.10 \
INSULATED_OVERRIDE=1.80 \
FX_USD_CAD_OVERRIDE=1.37 \
node scripts/update-copper-data.mjs
```

The same overrides are exposed as `workflow_dispatch` inputs in the GitHub
Action, so you can refresh values from the GitHub UI without a local clone.
