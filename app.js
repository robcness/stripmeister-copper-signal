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

  // ---- Primary signal -----------------------------------------------------
  const sig = data.signal || {};
  if (typeof sig.score === 'number') setText('signal-score', sig.score);
  if (typeof sig.score_max === 'number') setText('signal-score-max', sig.score_max);
  if (sig.label) setText('signal-label', sig.label);
  if (sig.headline) setText('signal-headline', sig.headline);
  if (sig.summary) renderSignalSummary(sig.summary);

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
