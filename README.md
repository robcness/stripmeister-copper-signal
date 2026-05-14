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

## Scoring model — momentum-sensitive, conservative

The buying signal lives in `scripts/score-engine.mjs` and is a transparent,
additive function of recent copper momentum. It is intentionally:

- **Sensitive** — a single notable session (e.g. **+$0.19/lb** on a $6 base ≈
  +3.2%) shifts the score by a few points, so the dashboard does not feel
  stuck on the same number for weeks.
- **Conservative** — every horizon is capped, the published range is
  floored at **60** and ceilinged at **99**, and no band carries a hype or
  ROI-guarantee message. The summary in every band ends with
  *"Reference signal — not financial advice."*

### Formula

```
score = clamp(
  80                        // baseline
  + adj_1d                  // capped ±4:  1 pt per 0.5% (sign matches direction)
  + adj_5d                  // capped ±5:  1 pt per 1.5%
  + adj_30d                 // capped ±5:  1 pt per 3.0%
  + adj_5y_context          // {<0%: −2, 0–10%: 0, ≥10%: +1, ≥25%: +2, ≥50%: +3}
  + adj_strip               // {≤$0: −2, 0–$2: 0, ≥$2: +1, ≥$4: +2}
, 60, 99)
```

The maximum theoretical swing from the 80 baseline is about −16 / +19 once
all five adjusters are saturated. In practice, components rarely all align,
so the published score sits in a narrower band.

### Bands and labels

| Score    | Band         | Label                          | Tone                                                                                  |
| -------- | ------------ | ------------------------------ | ------------------------------------------------------------------------------------- |
| < 78     | `hold`       | Hold and verify locally        | Wait/verify; not a sell signal. Amber readout.                                        |
| 78–84    | `good`       | Good time to buy               | Conditions support recovery work. Green readout.                                      |
| 85–91    | `strong`     | Strong buying window           | Momentum and context line up. Green readout.                                          |
| 92–99    | `exceptional`| Exceptional recovery window    | All inputs aligned positive; still capped at 99. Deeper-green readout.                |

Every summary explicitly disclaims financial advice. No band is described as
guaranteed return or a forecast.

### Drivers

The dashboard surfaces the **top two contributors by absolute magnitude**
(zero-delta components are skipped). The driver list answers “why is the
score where it is right now?” in plain language — e.g.
*"30-day copper momentum (+4) · 5-year context (+2)"*.

### Since-last-refresh

`copper.since_last_refresh` compares the live copper price against the
previous snapshot in `data/copper-signal.json`. When the change is
negligible (`|Δ| < 0.01%`), the UI suppresses the ribbon to avoid clutter.
The score delta (`signal.score_delta = score − previous_score`) renders
below the dial only when non-zero.

### Tests

`node scripts/test-score-engine.mjs` exercises 13 scenarios covering
the baseline, daily-only moves, 5-day moves, 30-day moves, strip-spread
dampening, clamping, band lookup, driver ranking, and summary-tone
guardrails (no “guaranteed,” “ROI,” “winning,” etc.).

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
  runs once per eligible business day, targeting **09:30 America/New_York**
  (Eastern Time), excluding weekends and U.S. market holidays. Manual
  `workflow_dispatch` is also available and **always bypasses** the
  schedule guard, so a human-initiated rerun is never blocked. The job
  runs `node scripts/update-copper-data.mjs`, which reads the JSON,
  pulls fresh source values, recomputes deltas and spread, and writes
  the file back. The workflow commits the file only if something
  changed.

  **Scheduled runs always fetch live sources** (`FETCH_SOURCES=1`) —
  the workflow hard-codes this for `schedule` events and includes a
  guard step that fails the run if the resolved value is anything else.
  This is a regression fence against a May 14 incident where the
  scheduled workflow shipped a successful-looking but timestamp-only
  refresh because `FETCH_SOURCES` resolved to `'0'`. Manual
  `workflow_dispatch` still respects the `fetch_sources` input (default
  `true`); set it to `false` from the GitHub UI when you specifically
  want a timestamp-only manual run.

  GitHub's `schedule:` cron is UTC-only with no DST or holiday awareness,
  **and scheduled workflows are best-effort: GitHub explicitly warns they
  may be delayed during periods of high load** (we have observed delays
  of 30+ minutes; e.g. May 7 fired at 15:42 UTC ≈ 11:42 ET instead of
  the requested 13:30 UTC). The previous `+/- 15 minutes of 09:30 ET`
  guard silently dropped those delayed runs and the data did not refresh
  for the day.

  The current `scripts/schedule-guard.mjs` interprets user intent as
  *"run at or after 09:30 ET, whenever GitHub actually starts the
  workflow on an eligible business day, but only once per day."* The
  workflow registers two cron entries — `30 13 * * 1-5` and
  `30 14 * * 1-5` — so that one of them lands close to 09:30 ET in EDT
  and the other in EST, and the guard then chooses the **first eligible
  run** on each ET business day:

  1. local ET date is Mon–Fri
  2. local ET date is not on the market-holiday list
  3. local time is at or after 09:30 ET and strictly before the 16:30
     ET cutoff (≈ 30 min after the U.S. equity close — past which a
     "today's open" refresh no longer makes sense)
  4. `data/copper-signal.json` `generated_at` is NOT already on the same
     ET date at/after 09:30 ET

  Rule (4) is what dedupes the second cron entry and any GitHub-delayed
  duplicate firing: the first eligible run of the day refreshes the
  file, subsequent scheduled invocations the same ET day SKIP with
  reason `already refreshed YYYY-MM-DD at HH:MM`. A pre-09:30 same-day
  timestamp (e.g. a manual midnight refresh) does **not** count as
  "already refreshed" and the scheduled job is allowed to proceed.

  The guard's holiday calendar covers **both U.S. equity / CME-style market
  holidays AND Canadian federal statutory holidays** for 2026 and 2027. The
  structured tables live in `scripts/schedule-guard.mjs` as
  `HOLIDAY_DETAILS_2026` / `HOLIDAY_DETAILS_2027`, each entry tagged with an
  `origin` of `us`, `ca`, or `both`:

  - **U.S. / CME**: New Year's Day observed, MLK Day, Presidents' Day,
    Good Friday, Memorial Day, Juneteenth observed, Independence Day
    observed, Labor Day, Thanksgiving, Christmas observed.
  - **Canadian federal**: Victoria Day, Canada Day, Civic Holiday (first
    Monday of August), National Day for Truth and Reconciliation (Sep 30,
    observed where needed), Canadian Thanksgiving (second Monday of
    October), Remembrance Day (Nov 11, observed where needed), Boxing Day
    (observed).
  - **Shared / overlap** (counted once): New Year's Day, Good Friday,
    Labor/Labour Day, Christmas Day.

  Skip messages include the holiday name and origin tag for transparency,
  e.g. `Skip: 2026-07-01 is a market holiday — Canada Day [ca]`. Both
  calendars matter: the live copper source is COMEX `HG=F` on CME (U.S.),
  but StripMeister and a meaningful share of the audience are Canadian, so
  refreshing the dashboard on Canada Day or Boxing Day would be off-tone
  even if CME were trading.

  Guard logic is unit-tested in `scripts/test-schedule-guard.mjs` — 89
  assertions covering exact 09:30 in EDT and EST, before-09:30 SKIP,
  after-16:30 cutoff SKIP, weekend skips, U.S.-only / Canadian-only /
  shared holiday skips, the overlap dedupe rule, the `holidayDetail()`
  lookup, custom holiday override, the May-7 delayed-firing regression
  (11:42 ET delayed run with previous-day `generated_at` → RUN), the
  same-day duplicate dedupe (already refreshed at 11:42 ET → second
  delayed run SKIPs), the steady-state two-cron dedupe in both EDT and
  EST, the pre-09:30 same-day timestamp pass-through, null/garbage
  `generated_at` cold starts, and an `America/Toronto` cross-check.
  Run with:

  ```bash
  node scripts/test-schedule-guard.mjs
  ```
- **Conservative by default *locally*.** Without `FETCH_SOURCES=1` the
  script only refreshes `generated_at` / `last_checked` and leaves market
  values untouched. That keeps the page stable on a bad-network day and
  avoids accidentally publishing a wrong number on a partial fetch.
  Scheduled GitHub Actions runs override this default and always fetch
  live sources — the workflow sets `FETCH_SOURCES=1` for `schedule`
  events (see the cadence section above).

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
