// Copper Recovery Signal — widget script
//
// Responsibilities:
// 1. Theme toggle (dark/light)
// 2. Responsive model-finder anchor swap (desktop vs mobile Shopify section IDs)
// 3. Live-data hydration: fetch ./data/copper-signal.json and update visible
//    values, chips, KPI, methodology table, and calculation block. If the
//    fetch fails (file missing, offline preview, CORS via file://), the
//    hardcoded HTML values remain in place so the widget still renders.
// 4. Currency toggle: convert all USD/lb reference values into CAD/lb on
//    demand. Conversion is display-only and uses the rate stored in
//    data.fx.usd_to_cad (sourced from Bank of Canada Valet by the updater).
//    Percent deltas and the signal score are unit-agnostic and never change.

// ----- Theme toggle ---------------------------------------------------------
const root = document.documentElement;
const themeButton = document.querySelector('[data-theme-toggle]');
const themeIcon = document.querySelector('[data-theme-icon]');

function setTheme(nextTheme) {
  root.setAttribute('data-theme', nextTheme);
  if (themeIcon) themeIcon.textContent = 'Theme';
  if (themeButton)
    themeButton.setAttribute('aria-label', `Switch to ${nextTheme === 'dark' ? 'light' : 'dark'} theme`);
}

const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
setTheme(prefersDark ? 'dark' : 'light');

themeButton?.addEventListener('click', () => {
  const current = root.getAttribute('data-theme') || 'dark';
  setTheme(current === 'dark' ? 'light' : 'dark');
});

// ----- Responsive model-finder anchor --------------------------------------
const modelFinderLink = document.querySelector('[data-testid="link-model-finder"]');

function updateModelFinderAnchor() {
  if (!modelFinderLink) return;
  const desktopAnchor =
    'https://www.stripmeister.com#shopify-section-template--18912940359751__sm_desktop_all_products_v2_QU9pWA';
  const mobileAnchor =
    'https://www.stripmeister.com#shopify-section-template--18912940359751__sm_mobile_products_v3_Da6cGT';
  modelFinderLink.href = window.matchMedia('(max-width: 768px)').matches ? mobileAnchor : desktopAnchor;
}

updateModelFinderAnchor();
window.addEventListener('resize', updateModelFinderAnchor);

// ===========================================================================
// Currency + hydration
// ===========================================================================
//
// State:
//   currentData     — the parsed copper-signal.json (or null until loaded)
//   currentCurrency — 'USD' (default) or 'CAD'
//
// Whenever either changes we re-run render(). Render is idempotent: it always
// rewrites the same set of [data-field] elements from currentData, applying
// the FX conversion when currentCurrency === 'CAD'.

let currentData = null;
let currentCurrency = 'USD';

// ----- Formatting helpers --------------------------------------------------

function fmtMoney(n, dp = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return n.toFixed(dp);
}

function fmtSignedPct(n, dp = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const sign = n > 0 ? '+' : ''; // negative sign comes from toFixed naturally
  return `${sign}${n.toFixed(dp)}%`;
}

// Format the "Last updated" caption.
//
// Preference order:
//   1. `generated_at`   — ISO timestamp, formatted in Eastern time with the
//                         live EST/EDT abbreviation derived from the date.
//   2. `last_updated`   — date-only string (YYYY-MM-DD); formatted as a date
//                         with no clock time.
//   3. `last_checked`   — last-resort ISO timestamp fallback.
// Returns null when no usable value is present so callers can leave the
// existing static fallback in place rather than wiping it.
function fmtLastUpdated(data) {
  if (!data || typeof data !== 'object') return null;

  // 1) Prefer the precise generation timestamp.
  const isoTs = typeof data.generated_at === 'string' ? data.generated_at : null;
  const fallbackTs = typeof data.last_checked === 'string' ? data.last_checked : null;
  const ts = isoTs || fallbackTs;
  if (ts) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) {
      try {
        const dateTxt = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }).format(d);
        const timeTxt = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).format(d);
        // Derive EST vs EDT from the actual offset on that date so we never
        // mislabel the timezone across the DST boundary. Use a generic "ET"
        // fallback if the runtime cannot produce a timeZoneName part.
        let tz = 'ET';
        try {
          const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            timeZoneName: 'short',
          }).formatToParts(d);
          const tzPart = parts.find((p) => p.type === 'timeZoneName');
          if (tzPart && /^E[SD]T$/.test(tzPart.value)) tz = tzPart.value;
        } catch (_e) {
          /* keep generic ET */
        }
        return `Last updated: ${dateTxt}, ${timeTxt} ${tz}`;
      } catch (_e) {
        /* fall through to date-only path */
      }
    }
  }

  // 2) Fall back to the date-only `last_updated` field.
  const dateOnly = typeof data.last_updated === 'string' ? data.last_updated : null;
  if (dateOnly) {
    // Parse YYYY-MM-DD as a local-noon date to avoid timezone day shifts.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
      if (!Number.isNaN(d.getTime())) {
        try {
          const dateTxt = new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          }).format(d);
          return `Last updated: ${dateTxt}`;
        } catch (_e) {
          return `Last updated: ${dateOnly}`;
        }
      }
    }
    return `Last updated: ${dateOnly}`;
  }

  return null;
}

function setText(field, value) {
  if (value === null || value === undefined) return;
  document.querySelectorAll(`[data-field="${field}"]`).forEach((el) => {
    el.textContent = String(value);
  });
}

function setHTML(field, html) {
  if (html === null || html === undefined) return;
  document.querySelectorAll(`[data-field="${field}"]`).forEach((el) => {
    el.innerHTML = html;
  });
}

function setStatus(field, status) {
  // status: "positive" | "negative" | "flat"
  if (!status) return;
  document.querySelectorAll(`[data-field="${field}"]`).forEach((el) => {
    el.classList.remove('positive', 'negative', 'flat');
    if (status === 'positive') el.classList.add('positive');
    else if (status === 'negative') el.classList.add('negative');
    else el.classList.add('flat');
  });
}

function showField(field, shown) {
  document.querySelectorAll(`[data-field="${field}"]`).forEach((el) => {
    if (shown) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  });
}

// All band ids used anywhere on the dashboard. We carry the legacy 'hold'
// id alongside the new 'verify' and 'watch' ids so older cached JSON
// payloads that still emit band:'hold' continue to style correctly while
// the new score-engine settles in.
const BAND_IDS = ['verify', 'watch', 'hold', 'good', 'strong', 'exceptional'];

function setBandClass(field, band) {
  if (!band) return;
  document.querySelectorAll(`[data-field="${field}"]`).forEach((el) => {
    BAND_IDS.forEach((b) => el.classList.remove(`band-${b}`));
    el.classList.add(`band-${band}`);
  });
}

// Render the hero summary text with an inline “run the recovery math now”
// link to the StripMeister scrap calculator. We avoid blanket innerHTML on
// arbitrary JSON: only the literal phrase “run the recovery math now” (case-
// insensitive) is wrapped, and only when present. Surrounding text is set as
// plain text via DOM nodes, so JSON content is never interpreted as HTML.
function renderSignalSummary(summary) {
  const els = document.querySelectorAll('[data-field="signal-summary"]');
  if (!els.length) return;
  const phrase = 'run the recovery math now';
  const href = 'https://www.stripmeister.com/pages/scrap-calculator';
  els.forEach((el) => {
    el.textContent = '';
    const idx = summary.toLowerCase().indexOf(phrase);
    if (idx === -1) {
      el.textContent = summary;
      return;
    }
    const before = summary.slice(0, idx);
    const matched = summary.slice(idx, idx + phrase.length);
    const after = summary.slice(idx + phrase.length);
    if (before) el.appendChild(document.createTextNode(before));
    const a = document.createElement('a');
    a.className = 'signal-summary-link';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.setAttribute('data-testid', 'link-summary-calculator');
    a.appendChild(document.createTextNode(matched));
    const arrow = document.createElement('span');
    arrow.className = 'signal-summary-link-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '\u2192';
    a.appendChild(arrow);
    el.appendChild(a);
    if (after) el.appendChild(document.createTextNode(after));
  });
}

function deriveStatus(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  if (n > 0) return 'positive';
  if (n < 0) return 'negative';
  return 'flat';
}

// ----- Currency conversion --------------------------------------------------
//
// Conversion is a single multiply by `rate`. For per-pound values we keep two
// decimal places (the format the widget already uses for USD/lb). For the
// 50-lb spread we round to a whole dollar.
//
// Rounding rules:
//   - per-lb values:  round( usd * rate, 2 )    e.g. $5.05 → C$6.88
//   - 50 lb spread:   round( usd * rate, 0 )    e.g. $165  → C$225
//   - copper price:   round( usd * rate, 2 )
//   - history closes: round( usd * rate, 3 ) for the methodology calc text
//
// Percent deltas and the signal score are dimensionless; they are NEVER
// converted.

function convertPerLb(usdPerLb, rate) {
  if (typeof usdPerLb !== 'number' || !Number.isFinite(usdPerLb)) return null;
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return null;
  return Math.round(usdPerLb * rate * 100) / 100;
}

function convertSpread(usdSpread, rate) {
  if (typeof usdSpread !== 'number' || !Number.isFinite(usdSpread)) return null;
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return null;
  return Math.round(usdSpread * rate);
}

function convertHistoryClose(usdClose, rate) {
  if (typeof usdClose !== 'number' || !Number.isFinite(usdClose)) return null;
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return null;
  return Math.round(usdClose * rate * 1000) / 1000;
}

// ----- Currency-sensitive copy ---------------------------------------------
//
// A small localization layer keyed off the displayed currency. USD shows U.S.
// English copy (the default already in the HTML); CAD shows Canadian-spelled,
// Canada-aware variants. This is intentionally restrained — it covers a few
// places where the wording would read awkwardly to a Canadian audience and
// nothing else. Commodity terms, unit names (lb, gauge), and product names
// are NOT localized.
//
// Phrases live on elements marked with `data-copy="<key>"`. If a key is
// missing from the map for a given currency, the existing text is left in
// place (graceful fallback — never blanks the DOM).

const COPY = {
  USD: {
    'verify-local':
      'your local scrap yard before committing volume \u2014 copper pricing is regional and moves daily.',
    'manual-labor': 'current manual labor hours',
    'yards-grading':
      'Local scrap yards quote daily and apply their\n              own grading; confirm with the buyer before committing volume.',
  },
  CAD: {
    'verify-local':
      'your local scrap yard or recycler before committing volume \u2014 copper pricing is regional and moves daily.',
    'manual-labor': 'current manual labour hours',
    'yards-grading':
      'Local scrap yards and recyclers quote daily and apply their\n              own grading; confirm with the buyer before committing volume.',
  },
};

function applyCopyLocale(currency) {
  const locale = COPY[currency] || COPY.USD;
  document.querySelectorAll('[data-copy]').forEach((el) => {
    const key = el.getAttribute('data-copy');
    if (!key) return;
    const next = locale[key];
    // Fall back to USD if the requested locale is missing this key — never
    // wipe the existing DOM text.
    const fallback = COPY.USD[key];
    if (typeof next === 'string') {
      el.textContent = next;
    } else if (typeof fallback === 'string') {
      el.textContent = fallback;
    }
  });
}

// ----- Render ---------------------------------------------------------------
//
// Field map (data-field → JSON path, in displayed currency):
//   copper-price            → copper.reference_price_*_per_lb (2 dp)
//   delta-30d/12mo/5yr      → copper.delta_*_pct (unit-agnostic, never converted)
//   delta-*-chip            → toggle .positive / .negative class from status
//   strip-delta-sign        → "+" or "−" depending on sign
//   strip-delta-abs         → |scrap.strip_value_delta_*_per_lb| (2 dp)
//   strip-delta-wrap        → toggle .positive / .negative class
//   bare-bright-price       → scrap.bare_bright_*_per_lb (2 dp)
//   insulated-price         → scrap.insulated_wire_*_per_lb (2 dp)
//   spread-unit-lbs         → scrap.spread_unit_lbs (unit-agnostic)
//   spread-per-50lb         → scrap.spread_per_50lb_* (whole dollar)
//   signal-score / -max     → signal.score / score_max (unit-agnostic)
//   signal-label/-headline/-summary → signal.* (text-only)
//   unit-per-lb             → "USD/lb" or "CAD/lb"
//   unit-currency-code      → "USD" or "CAD"
//   fx-meta-text            → "Reference only · USD shown natively." (USD)
//                              or "1 USD ≈ X.XXXX CAD · Bank of Canada YYYY-MM-DD" (CAD)
//   last-updated-text       → "Last updated: <date> [, <time> ET]" derived from
//                              copper-signal.json `generated_at` (preferred) or
//                              `last_updated` (date-only fallback).
//   method-* / calc-*       → formatted strings written into the methodology
//                              table and stacked calculation block.

function render() {
  const data = currentData;
  if (!data || typeof data !== 'object') return;

  const currency = currentCurrency === 'CAD' ? 'CAD' : 'USD';
  const fx = data.fx || {};
  const rate = currency === 'CAD' ? Number(fx.usd_to_cad) : 1;
  const hasValidRate = currency === 'USD' || (Number.isFinite(rate) && rate > 0);

  // If user requested CAD but we have no valid rate, fall back silently to USD
  // for the actual numbers; the toggle UI will reflect the original choice.
  const effectiveCurrency = hasValidRate ? currency : 'USD';
  const effectiveRate = hasValidRate ? rate : 1;

  // ---- Currency labels ----------------------------------------------------
  const unitPerLb = `${effectiveCurrency}/lb`;
  setText('unit-per-lb', unitPerLb);
  setText('unit-currency-code', effectiveCurrency);

  // ---- Currency-sensitive copy -------------------------------------------
  applyCopyLocale(effectiveCurrency);

  // ---- FX meta (caption) --------------------------------------------------
  const fxAsOf = fx.as_of_date || '';
  const fxLabel = fx.source?.label || 'Bank of Canada';
  let fxMeta;
  if (effectiveCurrency === 'USD') {
    fxMeta = 'Reference only · USD shown natively. Not a yard quote.';
  } else if (Number.isFinite(rate) && rate > 0) {
    const asOfTxt = fxAsOf ? ` · ${fxAsOf}` : '';
    fxMeta = `1 USD ≈ ${rate.toFixed(4)} CAD · ${fxLabel}${asOfTxt}. Display only — not a yard quote.`;
  } else {
    fxMeta = 'CAD rate unavailable · showing USD reference values.';
  }
  setText('fx-meta-text', fxMeta);

  // ---- "Last updated" caption -------------------------------------------
  // Currency-independent: the timestamp reflects when the data file was
  // generated, not which display currency the user picked.
  const lastUpdatedTxt = fmtLastUpdated(data);
  if (lastUpdatedTxt) setText('last-updated-text', lastUpdatedTxt);

  // ---- Copper market card -------------------------------------------------
  const c = data.copper || {};
  const copperUsd = c.reference_price_usd_per_lb;
  const copperShown = effectiveCurrency === 'CAD' ? convertPerLb(copperUsd, effectiveRate) : copperUsd;
  setText('copper-price', fmtMoney(copperShown, 2));

  // Percent deltas — never converted.
  const delta30 = fmtSignedPct(c.delta_30d_pct, 2);
  const delta12 = fmtSignedPct(c.delta_12mo_pct, 1);
  const delta5 = fmtSignedPct(c.delta_5yr_pct, 1);
  setText('delta-30d', delta30);
  setText('delta-12mo', delta12);
  setText('delta-5yr', delta5);

  const statuses = c.deltas_status || {};
  setStatus('delta-30d-chip', statuses['30d'] || deriveStatus(c.delta_30d_pct));
  setStatus('delta-12mo-chip', statuses['12mo'] || deriveStatus(c.delta_12mo_pct));
  setStatus('delta-5yr-chip', statuses['5yr'] || deriveStatus(c.delta_5yr_pct));

  // ---- Strip value delta KPI ---------------------------------------------
  const s = data.scrap || {};
  const stripDeltaUsd = s.strip_value_delta_usd_per_lb;
  const bareBrightUsd = s.bare_bright_usd_per_lb;
  const insulatedUsd = s.insulated_wire_usd_per_lb;
  const spreadUsd = s.spread_per_50lb_usd;

  const stripDeltaShown =
    effectiveCurrency === 'CAD' ? convertPerLb(stripDeltaUsd, effectiveRate) : stripDeltaUsd;
  const bareBrightShown =
    effectiveCurrency === 'CAD' ? convertPerLb(bareBrightUsd, effectiveRate) : bareBrightUsd;
  const insulatedShown =
    effectiveCurrency === 'CAD' ? convertPerLb(insulatedUsd, effectiveRate) : insulatedUsd;
  const spreadShown =
    effectiveCurrency === 'CAD' ? convertSpread(spreadUsd, effectiveRate) : spreadUsd;

  if (typeof stripDeltaShown === 'number' && Number.isFinite(stripDeltaShown)) {
    const sign = stripDeltaShown >= 0 ? '+' : '−';
    setText('strip-delta-sign', sign);
    setText('strip-delta-abs', fmtMoney(Math.abs(stripDeltaShown), 2));
    setStatus('strip-delta-wrap', s.strip_value_delta_status || deriveStatus(stripDeltaShown));
  }
  setText('bare-bright-price', fmtMoney(bareBrightShown, 2));
  setText('insulated-price', fmtMoney(insulatedShown, 2));
  if (typeof s.spread_unit_lbs === 'number') setText('spread-unit-lbs', s.spread_unit_lbs);
  if (typeof spreadShown === 'number') setText('spread-per-50lb', spreadShown);

  // ---- 1-day / 5-day momentum chips --------------------------------------
  const delta1d = fmtSignedPct(c.delta_1d_pct, 2);
  const delta5d = fmtSignedPct(c.delta_5d_pct, 2);
  if (delta1d) {
    setText('delta-1d', delta1d);
    setStatus('delta-1d-chip', statuses['1d'] || deriveStatus(c.delta_1d_pct));
    showField('delta-1d-chip', true);
    setText('method-delta-1d', delta1d);
  } else {
    showField('delta-1d-chip', false);
  }
  if (delta5d) {
    setText('delta-5d', delta5d);
    setStatus('delta-5d-chip', statuses['5d'] || deriveStatus(c.delta_5d_pct));
    showField('delta-5d-chip', true);
    setText('method-delta-5d', delta5d);
  } else {
    showField('delta-5d-chip', false);
  }

  // ---- Since-last-refresh ribbon ------------------------------------------
  // Only render when the delta is meaningfully non-zero. A 0.00% / $0.00 ribbon
  // adds noise without information and feels like clutter.
  const slr = c.since_last_refresh && typeof c.since_last_refresh === 'object' ? c.since_last_refresh : null;
  const slrIsMeaningful =
    slr &&
    typeof slr.delta_pct === 'number' &&
    Number.isFinite(slr.delta_pct) &&
    Math.abs(slr.delta_pct) >= 0.01;
  if (slrIsMeaningful) {
    const pct = fmtSignedPct(slr.delta_pct, 2);
    const dUsdPerLb = typeof slr.delta_usd_per_lb === 'number' ? slr.delta_usd_per_lb : null;
    const dShown =
      dUsdPerLb === null
        ? null
        : effectiveCurrency === 'CAD'
        ? convertPerLb(dUsdPerLb, effectiveRate)
        : dUsdPerLb;
    const moneyPart =
      typeof dShown === 'number' && Number.isFinite(dShown)
        ? `${dShown >= 0 ? '+' : '\u2212'}$${fmtMoney(Math.abs(dShown), 2)} ${unitPerLb}`
        : null;
    const prevAt = slr.previous_generated_at ? new Date(slr.previous_generated_at) : null;
    const prevTxt = prevAt && !Number.isNaN(prevAt.getTime()) ? prevAt.toISOString().slice(0, 10) : null;
    const parts = [];
    if (moneyPart) parts.push(moneyPart);
    parts.push(`${pct} since last refresh`);
    if (prevTxt) parts.push(`(prior ${prevTxt})`);
    setText('refresh-meta', parts.join(' \u00b7 '));
    showField('refresh-meta-wrap', true);
  } else {
    showField('refresh-meta-wrap', false);
  }
  // The score-delta ribbon is suppressed when score_delta is exactly 0 to keep
  // the UI quiet during no-op refreshes.


  // ---- Primary signal -----------------------------------------------------
  const sig = data.signal || {};
  if (typeof sig.score === 'number') setText('signal-score', sig.score);
  if (typeof sig.score_max === 'number') setText('signal-score-max', sig.score_max);
  if (sig.label) setText('signal-label', sig.label);
  if (sig.headline) setText('signal-headline', sig.headline);
  if (sig.summary) renderSignalSummary(sig.summary);

  // Apply band class to the buy-light pill so hold renders amber, exceptional renders deeper green.
  if (sig.band) setBandClass('buy-light', sig.band);

  // Dynamic aria-label / desc so screen readers reflect the live score and band.
  if (typeof sig.score === 'number' && typeof sig.score_max === 'number') {
    const scoreMax = sig.score_max;
    const labelTxt = sig.label || 'Buying signal';
    document.querySelectorAll('[data-field="dial-wrap"]').forEach((el) => {
      el.setAttribute('aria-label', `${labelTxt}: ${sig.score} out of ${scoreMax}.`);
    });
    // Build a band-aware desc that screen-reader users hear in place of the
    // legend chips (which are aria-hidden to avoid duplication). The 'verify'
    // category (< 60) is named explicitly so screen-reader users know it
    // exists even though the published score is floored at 60.
    const bdesc = sig.bands || {};
    // If watch band isn't provided in the data payload (legacy data file),
    // synthesize its range from the min boundary up to good.min - 1 so the
    // screen-reader description never leaves a numeric gap between 60 and good.
    let watchRange = null;
    if (bdesc.watch && typeof bdesc.watch.min === 'number') {
      watchRange = `${bdesc.watch.min}\u2013${bdesc.watch.max}`;
    } else if (bdesc.good && typeof bdesc.good.min === 'number') {
      watchRange = `60\u2013${bdesc.good.min - 1}`;
    }
    const bandsLine = (bdesc.good && bdesc.strong && bdesc.exceptional)
      ? ` Score bands: under 60 verify conditions, ${watchRange ? `${watchRange} watch and review economics, ` : ''}${bdesc.good.min}\u2013${bdesc.good.max} good time to buy, ${bdesc.strong.min}\u2013${bdesc.strong.max} strong buying window, ${bdesc.exceptional.min} and above exceptional recovery window.`
      : '';
    setText('dial-desc', `An arched semicircular gauge filled with a continuous metallic copper-to-green gradient descending from optimal: vivid green for exceptional, warm olive-green for strong, amber copper for good, and burnished copper-brown for watch. Threshold ticks keep the segment edges scannable. Current score ${sig.score} of ${scoreMax} (${labelTxt}). A stylized triangular needle points to the score.${bandsLine}`);
    document.querySelectorAll('[data-field="buy-light"]').forEach((el) => {
      el.setAttribute('aria-label', `${labelTxt}. Score ${sig.score} of ${scoreMax}.`);
    });
  }

  // === Arched stoplight gauge: bands + needle + dividers + ticks + legend
  //
  // Geometry (must match index.html / style.css):
  //   - Upper half of a circle, cx=160 cy=170 r=120
  //   - Score range [min, max] maps linearly to parametric angle 180°..360°
  //   - Score 60 = left pole (a=180°); score 100 = right pole (a=360°)
  // For each threshold/score s with t = (s - min)/(max - min):
  //   a = 180° + t * 180°  (radians: pi + t*pi)
  //   pointOnArc(s) = (cx + r*cos(a), cy + r*sin(a))
  // For a circle the unit outward normal at angle a is simply (cos a, sin a).
  // We reuse that normal to (1) place ticks outside the stroke, (2) draw
  // divider overlays across the stroke, and (3) shape the triangular
  // needle from a hub at the bottom-center of the dial.
  if (typeof sig.score === 'number') {
    const min = (sig.score_min_published ?? 60);
    const max = (sig.score_max ?? 100);
    const span = Math.max(1, max - min);
    const clamped = Math.min(max, Math.max(min, sig.score));

    // Circle geometry constants (mirror index.html and style.css).
    const cx = 160;
    const cy = 170;
    const r = 120;
    const strokeHalf = 11; // half of dial-band stroke-width (22)

    // Convert a score value to its parametric angle on the upper-half circle.
    const scoreToAngle = (s) => {
      const tt = (s - min) / span;
      return Math.PI + tt * Math.PI; // radians, 180°..360°
    };

    // Point on the band arc for score s.
    const pointOnArc = (s) => {
      const a = scoreToAngle(s);
      return {
        x: cx + r * Math.cos(a),
        y: cy + r * Math.sin(a),
        a,
      };
    };

    // Unit outward normal at angle a. On a circle this is just (cos a, sin a).
    const outwardNormal = (a) => ({ nx: Math.cos(a), ny: Math.sin(a) });

    // --- 1a) Active-band emphasis overlay ---------------------------------
    // The new gauge is a CONTINUOUS metallic gradient rather than four
    // discrete dasharray segments, so per-band stroke-dasharrays are no
    // longer needed. Instead, we set ONE dasharray on the brighten overlay
    // (.dial-band-active) so only the segment under the needle gets a soft
    // highlight tint — the surrounding metallic gradient remains at full
    // intensity. This preserves the polished-metal continuity while still
    // drawing the eye to the active band.
    //
    // The overlay's slice runs from active.min up to the NEXT band's .min
    // (or score_max if there is no next band) so it lines up exactly with
    // the perceived band boundary on the gradient.
    const bandsCfg = sig.bands || {};
    const scoreToPct = (s) => ((s - min) / span) * 100;
    const activeBandKey = sig.band === 'verify' ? 'watch' : sig.band;
    const bandOrder = ['watch', 'good', 'strong', 'exceptional'];
    const setActiveDash = (startScore, endScore) => {
      const startPct = Math.max(0, Math.min(100, scoreToPct(startScore)));
      const endPct = Math.max(0, Math.min(100, scoreToPct(endScore)));
      const widthPct = Math.max(0, endPct - startPct);
      document.querySelectorAll('[data-field="band-active-arc"]').forEach((el) => {
        el.setAttribute('stroke-dasharray', `0 ${startPct} ${widthPct} 100`);
        el.classList.toggle('is-on', widthPct > 0);
      });
    };
    if (activeBandKey && bandsCfg[activeBandKey] && typeof bandsCfg[activeBandKey].min === 'number') {
      // End of the active band = start of the next band, or score_max if
      // we're already in the top band.
      const idx = bandOrder.indexOf(activeBandKey);
      let endScore = max;
      for (let i = idx + 1; i < bandOrder.length; i += 1) {
        const next = bandsCfg[bandOrder[i]];
        if (next && typeof next.min === 'number') { endScore = next.min; break; }
      }
      // Fall back to the band's own .max if the next band is missing.
      if (endScore === max && typeof bandsCfg[activeBandKey].max === 'number'
        && bandsCfg[activeBandKey].max < max) {
        endScore = bandsCfg[activeBandKey].max + 1;
      }
      setActiveDash(bandsCfg[activeBandKey].min, endScore);
    } else {
      // No active band identified — hide the highlight overlay entirely.
      document.querySelectorAll('[data-field="band-active-arc"]').forEach((el) => {
        el.setAttribute('stroke-dasharray', '0 0 0 100');
        el.classList.remove('is-on');
      });
    }

    // --- 1) Triangle needle ------------------------------------------------
    // Tip lands ON the band stroke at the current score (centerline of the
    // stroke band). Base sits on a hub at (160, 185) below the arc midline.
    // The triangle has a short notched back-edge so it reads as a stylized
    // arrow head rather than a generic gauge sliver.
    const tip = pointOnArc(clamped);
    const hubX = 160, hubY = 185;
    // Direction from hub to tip.
    const dx = tip.x - hubX;
    const dy = tip.y - hubY;
    const dLen = Math.hypot(dx, dy) || 1;
    const ux = dx / dLen;
    const uy = dy / dLen;
    // Perpendicular (rotated 90° CCW).
    const px = -uy;
    const py = ux;
    // Base half-width and back inset. The back inset gives the triangle a
    // small notched back so it doesn't look like a flat-bottomed sliver.
    const baseHalf = 6;
    const backInset = 4;
    // Base center sits ON the hub.
    const bcx = hubX;
    const bcy = hubY;
    // Two outer base corners (perpendicular to direction).
    const b1x = bcx + px * baseHalf;
    const b1y = bcy + py * baseHalf;
    const b2x = bcx - px * baseHalf;
    const b2y = bcy - py * baseHalf;
    // Back center: pulled slightly toward the tip so the back edge notches in.
    const bkx = bcx + ux * backInset;
    const bky = bcy + uy * backInset;
    // Polygon points: base-right → back-center → base-left → tip
    // (drawing as a kite for a more dynamic needle silhouette).
    const needlePts = [
      [b1x, b1y],
      [bkx, bky],
      [b2x, b2y],
      [tip.x, tip.y],
    ]
      .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
      .join(' ');
    document.querySelectorAll('[data-field="dial-needle-tri"]').forEach((el) => {
      el.setAttribute('points', needlePts);
    });

    // --- 2) Band divider overlay lines -------------------------------------
    // Draw a short radial line across the stroke at each *internal* band
    // threshold. The four discrete segments already supply the band color
    // cue; the divider lines reinforce the seams with a thin contrast tick
    // so the boundary reads even when the active band is dimmed. Endpoints
    // (min and max) are skipped because they sit at the arc's pole positions
    // and would otherwise look like truncation marks.
    const dividersGroup = document.querySelector('[data-field="dial-dividers"]');
    if (dividersGroup) {
      while (dividersGroup.firstChild) dividersGroup.removeChild(dividersGroup.firstChild);
      const SVG_NS = 'http://www.w3.org/2000/svg';
      const internalThresholds = [];
      ['watch', 'good', 'strong', 'exceptional'].forEach((k) => {
        if (bandsCfg[k] && typeof bandsCfg[k].min === 'number') {
          // Only include thresholds strictly inside the visible range.
          if (bandsCfg[k].min > min && bandsCfg[k].min < max) {
            internalThresholds.push(bandsCfg[k].min);
          }
        }
      });
      const uniqueDividers = Array.from(new Set(internalThresholds)).sort((a, b) => a - b);
      uniqueDividers.forEach((s) => {
        const p = pointOnArc(s);
        const n = outwardNormal(p.a);
        const innerX = p.x - strokeHalf * n.nx;
        const innerY = p.y - strokeHalf * n.ny;
        const outerX = p.x + strokeHalf * n.nx;
        const outerY = p.y + strokeHalf * n.ny;
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', innerX.toFixed(1));
        line.setAttribute('y1', innerY.toFixed(1));
        line.setAttribute('x2', outerX.toFixed(1));
        line.setAttribute('y2', outerY.toFixed(1));
        dividersGroup.appendChild(line);
      });
    }

    // --- 3) Threshold tick marks and numeric labels -----------------------
    // Ticks sit at score_min, each band.min, and score_max. Labels are
    // placed outside the stroke along the local outward normal.
    const ticksGroup = document.querySelector('[data-field="dial-ticks"]');
    const labelsGroup = document.querySelector('[data-field="dial-tick-labels"]');
    if (ticksGroup && labelsGroup) {
      const tickScores = [min];
      ['watch', 'good', 'strong', 'exceptional'].forEach((k) => {
        if (bandsCfg[k] && typeof bandsCfg[k].min === 'number') tickScores.push(bandsCfg[k].min);
      });
      tickScores.push(max);
      // De-duplicate and sort
      const uniqueTicks = Array.from(new Set(tickScores)).sort((a, b) => a - b);

      while (ticksGroup.firstChild) ticksGroup.removeChild(ticksGroup.firstChild);
      while (labelsGroup.firstChild) labelsGroup.removeChild(labelsGroup.firstChild);

      const SVG_NS = 'http://www.w3.org/2000/svg';
      const tickOuterOffset = strokeHalf + 3; // tip of tick sits just inside the stroke edge for fallback compat
      const tickInnerOffset = strokeHalf - 1; // start tick just inside the outer stroke edge
      const labelOffset = strokeHalf + 15;    // numeric label radius outside the stroke
      uniqueTicks.forEach((s) => {
        const p = pointOnArc(s);
        const n = outwardNormal(p.a);
        const x1 = p.x + tickInnerOffset * n.nx;
        const y1 = p.y + tickInnerOffset * n.ny;
        const x2 = p.x + tickOuterOffset * n.nx;
        const y2 = p.y + tickOuterOffset * n.ny;
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', x1.toFixed(1));
        line.setAttribute('y1', y1.toFixed(1));
        line.setAttribute('x2', x2.toFixed(1));
        line.setAttribute('y2', y2.toFixed(1));
        ticksGroup.appendChild(line);

        const lx = p.x + labelOffset * n.nx;
        const ly = p.y + labelOffset * n.ny;
        const text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('x', lx.toFixed(1));
        text.setAttribute('y', ly.toFixed(1));
        if (Math.abs(s - clamped) < 0.5) text.classList.add('is-active');
        text.textContent = String(s);
        labelsGroup.appendChild(text);
      });
    }

    // --- 4) Band legend chips (data-driven from signal.bands) -------------
    // The markup ships with FOUR legend keys in order: watch / good / strong
    // / exceptional — matching the four stoplight segments in the arc above.
    // We don't show a separate 'verify' chip in the legend because the
    // published score is always >= 60; the desc text names verify for
    // screen-reader users so the category isn't hidden, just not chip-listed.
    // This keeps the legend row uncluttered and professional.
    const legend = document.querySelector('[data-field="dial-band-legend"]');
    if (legend && bandsCfg.good && bandsCfg.strong && bandsCfg.exceptional) {
      const keys = legend.querySelectorAll('.dial-band-key');
      const setKeyRange = (key, rangeText) => {
        if (!key) return;
        const rangeEl = key.querySelector('.dial-band-chip-range');
        if (rangeEl) rangeEl.textContent = rangeText;
      };
      const fmtRange = (b) => `${b.min}\u2013${b.max}`;
      // Match DOM order: watch → good → strong → exceptional.
      // If the watch band is missing from older JSON, fall back to the
      // 60..(good.min - 1) range so the chip still reads sensibly.
      const watchCfg = bandsCfg.watch || { min, max: (bandsCfg.good.min - 1) };
      if (keys[0]) setKeyRange(keys[0], fmtRange(watchCfg));
      if (keys[1]) setKeyRange(keys[1], fmtRange(bandsCfg.good));
      if (keys[2]) setKeyRange(keys[2], fmtRange(bandsCfg.strong));
      // Exceptional caps the open-ended top band: "92+".
      if (keys[3]) setKeyRange(keys[3], `${bandsCfg.exceptional.min}+`);
      keys.forEach((k) => {
        const isActive = k.classList.contains(`band-${sig.band || ''}`);
        k.classList.toggle('is-active', isActive);
      });
    }
  }

  // Score delta since last refresh (small subtitle under the buy-light).
  if (typeof sig.score_delta === 'number' && Number.isFinite(sig.score_delta)) {
    const sd = sig.score_delta;
    const sign = sd > 0 ? '+' : sd < 0 ? '\u2212' : '\u00b1';
    setText('score-delta', `${sign}${Math.abs(sd)}`);
    setStatus('score-delta', sd > 0 ? 'positive' : sd < 0 ? 'negative' : 'flat');
    const prevScore = typeof sig.previous_score === 'number' ? sig.previous_score : null;
    setText('score-delta-meta', prevScore !== null ? `(prior ${prevScore}/${sig.score_max ?? 100})` : '');
    showField('score-delta-wrap', sd !== 0);
  } else {
    showField('score-delta-wrap', false);
  }

  // Top drivers (max 2) shown subtly under the readout. Skip if list is empty.
  if (Array.isArray(sig.drivers) && sig.drivers.length > 0) {
    const parts = sig.drivers.slice(0, 2).map((d) => {
      if (!d || typeof d !== 'object') return null;
      const label = d.label || d.id || '';
      const delta = typeof d.delta === 'number' ? d.delta : null;
      if (!label) return null;
      if (delta === null) return label;
      const sign = delta > 0 ? '+' : delta < 0 ? '\u2212' : '\u00b1';
      return `${label} (${sign}${Math.abs(delta)})`;
    }).filter(Boolean);
    if (parts.length > 0) {
      setText('score-drivers', parts.join(' \u00b7 '));
      showField('score-drivers-wrap', true);
    } else {
      showField('score-drivers-wrap', false);
    }
  } else {
    showField('score-drivers-wrap', false);
  }

  // Methodology formula line: prefer the canonical weights_note from JSON when present.
  if (typeof sig.weights_note === 'string' && sig.weights_note.length > 0) {
    const bands = sig.bands || {};
    const goodB = bands.good ? `${bands.good.min}\u2013${bands.good.max} ${bands.good.label}` : null;
    const strongB = bands.strong ? `${bands.strong.min}\u2013${bands.strong.max} ${bands.strong.label}` : null;
    const excB = bands.exceptional ? `${bands.exceptional.min}+ ${bands.exceptional.label}` : null;
    const bandLine = [goodB, strongB, excB].filter(Boolean).join(' \u00b7 ');
    const formula = bandLine ? `${sig.weights_note} Bands: ${bandLine}.` : sig.weights_note;
    setText('method-signal-formula', formula);
  }

  // ---- Methodology table -------------------------------------------------
  if (typeof copperShown === 'number') {
    setText('method-copper-price', `$${fmtMoney(copperShown, 2)} ${unitPerLb}`);
  }
  if (delta30) setText('method-delta-30d', delta30);
  if (delta12) setText('method-delta-12mo', delta12);
  if (delta5) setText('method-delta-5yr', delta5);
  if (typeof stripDeltaShown === 'number') {
    const sign = stripDeltaShown >= 0 ? '+' : '−';
    setText('method-strip-delta', `${sign}$${fmtMoney(Math.abs(stripDeltaShown), 2)} ${unitPerLb}`);
  }
  if (typeof sig.score === 'number' && typeof sig.score_max === 'number') {
    setText('method-signal-score', `${sig.score} / ${sig.score_max}`);
  }

  // 12mo / 5yr calculation strings — convert the historical anchor closes
  // alongside the latest close so the math reads in the displayed currency,
  // but the percent result remains identical (ratio is unit-free).
  const hist = c.history || {};
  const latestObj = hist.latest && typeof hist.latest === 'object' ? hist.latest : null;
  const y1Obj = hist.y1 && typeof hist.y1 === 'object' ? hist.y1 : null;
  const y5Obj = hist.y5 && typeof hist.y5 === 'object' ? hist.y5 : null;

  const curUsd = latestObj?.close ?? hist.close_2026_04_30;
  const curDate = latestObj?.date;
  const prev1yUsd = y1Obj?.close ?? hist.close_2025_04_30;
  const prev1yDate = y1Obj?.date;
  const prev5yUsd = y5Obj?.close ?? hist.close_2021_04_30;
  const prev5yDate = y5Obj?.date;

  const conv = (n) =>
    effectiveCurrency === 'CAD' ? convertHistoryClose(n, effectiveRate) : n;

  const cur = conv(curUsd);
  const prev1y = conv(prev1yUsd);
  const prev5y = conv(prev5yUsd);

  if ([cur, prev1y].every((n) => typeof n === 'number')) {
    const fromLabel = prev1yDate || '2025-04-30';
    const toLabel = curDate || '2026-04-30';
    setText(
      'method-delta-12mo-calc',
      `(${cur} − ${prev1y}) ÷ ${prev1y}. Close ${fromLabel} $${prev1y} → close ${toLabel} $${cur} (${effectiveCurrency}).`
    );
  }
  if ([cur, prev5y].every((n) => typeof n === 'number')) {
    const fromLabel = prev5yDate || '2021-04-30';
    const toLabel = curDate || '2026-04-30';
    setText(
      'method-delta-5yr-calc',
      `(${cur} − ${prev5y}) ÷ ${prev5y}. Close ${fromLabel} $${prev5y} → close ${toLabel} $${cur} (${effectiveCurrency}).`
    );
  }

  // ---- Stacked calc block ------------------------------------------------
  if (typeof bareBrightShown === 'number') {
    setText('calc-bare-bright', `$${fmtMoney(bareBrightShown, 2)} ${unitPerLb}`);
  }
  if (typeof insulatedShown === 'number') {
    setText('calc-insulated', `$${fmtMoney(insulatedShown, 2)} ${unitPerLb}`);
  }
  if (typeof stripDeltaShown === 'number') {
    const sign = stripDeltaShown >= 0 ? '+' : '−';
    setHTML(
      'calc-strip-delta',
      `<strong>${sign}$${fmtMoney(Math.abs(stripDeltaShown), 2)} ${unitPerLb}</strong>`
    );
  }
  if (typeof s.spread_unit_lbs === 'number') {
    setText('calc-spread-label', `${s.spread_unit_lbs} lb recovered`);
  }
  if (typeof spreadShown === 'number') {
    setText('calc-spread-value', `≈ $${spreadShown} ${effectiveCurrency} raw-material spread`);
  }
}

// ----- Currency toggle wiring -----------------------------------------------

function setCurrency(nextCurrency) {
  const next = nextCurrency === 'CAD' ? 'CAD' : 'USD';
  if (currentCurrency === next) return;
  currentCurrency = next;

  const buttons = document.querySelectorAll('[data-currency]');
  buttons.forEach((btn) => {
    const isActive = btn.getAttribute('data-currency') === next;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
  });

  // Always swap copy locale, even before / without live data — numbers stay
  // on whatever the static HTML provided, but spelling/phrasing still flips.
  applyCopyLocale(next);

  render();
}

function bindCurrencyToggle() {
  const buttons = document.querySelectorAll('[data-currency]');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-currency') || 'USD';
      // If user clicks CAD but we have no rate yet, still flip the visual
      // state — render() will gracefully fall back to USD numbers and
      // surface a "rate unavailable" message in the meta caption.
      setCurrency(target);
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const next = currentCurrency === 'USD' ? 'CAD' : 'USD';
        setCurrency(next);
        const targetBtn = document.querySelector(`[data-currency="${next}"]`);
        if (targetBtn) targetBtn.focus();
      }
    });
  });
}

bindCurrencyToggle();

// ----- Live data fetch ------------------------------------------------------

async function loadCopperSignal() {
  try {
    const res = await fetch('./data/copper-signal.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    currentData = data;
    render();
  } catch (err) {
    // Silent fallback — hardcoded HTML values remain visible.
    if (typeof console !== 'undefined' && console.info) {
      console.info('[copper-signal] Live data unavailable; using static fallback.', err && err.message);
    }
  }
}

// Kick off after DOM parse. The script tag is `defer`, so DOM is ready.
loadCopperSignal();
