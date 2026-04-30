// Copper Recovery Signal — widget script
//
// Responsibilities:
// 1. Theme toggle (dark/light)
// 2. Responsive model-finder anchor swap (desktop vs mobile Shopify section IDs)
// 3. Live-data hydration: fetch ./data/copper-signal.json and update visible
//    values, chips, KPI, methodology table, and calculation block. If the
//    fetch fails (file missing, offline preview, CORS via file://), the
//    hardcoded HTML values remain in place so the widget still renders.

// ----- Theme toggle ---------------------------------------------------------
const root = document.documentElement;
const button = document.querySelector('[data-theme-toggle]');
const icon = document.querySelector('[data-theme-icon]');

function setTheme(nextTheme) {
  root.setAttribute('data-theme', nextTheme);
  if (icon) icon.textContent = 'Theme';
  if (button) button.setAttribute('aria-label', `Switch to ${nextTheme === 'dark' ? 'light' : 'dark'} theme`);
}

const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
setTheme(prefersDark ? 'dark' : 'light');

button?.addEventListener('click', () => {
  const current = root.getAttribute('data-theme') || 'dark';
  setTheme(current === 'dark' ? 'light' : 'dark');
});

// ----- Responsive model-finder anchor --------------------------------------
const modelFinderLink = document.querySelector('[data-testid="link-model-finder"]');

function updateModelFinderAnchor() {
  if (!modelFinderLink) return;
  const desktopAnchor = 'https://www.stripmeister.com#shopify-section-template--18912940359751__sm_desktop_all_products_v2_QU9pWA';
  const mobileAnchor = 'https://www.stripmeister.com#shopify-section-template--18912940359751__sm_mobile_products_v3_Da6cGT';
  modelFinderLink.href = window.matchMedia('(max-width: 768px)').matches ? mobileAnchor : desktopAnchor;
}

updateModelFinderAnchor();
window.addEventListener('resize', updateModelFinderAnchor);

// ----- Live-data hydration --------------------------------------------------
//
// Fetches data/copper-signal.json and writes values into elements tagged with
// `data-field="..."`. Every step is best-effort and silently falls back to
// the hardcoded HTML if anything is missing.
//
// Field map (data-field → JSON path):
//   copper-price            → copper.reference_price_usd_per_lb (number, 2 dp)
//   delta-30d               → copper.delta_30d_pct (signed %, 2 dp)
//   delta-12mo              → copper.delta_12mo_pct (signed %, 1 dp)
//   delta-5yr               → copper.delta_5yr_pct (signed %, 1 dp)
//   delta-30d-chip / delta-12mo-chip / delta-5yr-chip
//                           → toggle .positive / .negative class from status
//   strip-delta-sign        → "+" or "−" depending on sign
//   strip-delta-abs         → |scrap.strip_value_delta_usd_per_lb| (2 dp)
//   strip-delta-wrap        → toggle .positive / .negative class
//   bare-bright-price       → scrap.bare_bright_usd_per_lb (2 dp)
//   insulated-price         → scrap.insulated_wire_usd_per_lb (2 dp)
//   spread-unit-lbs         → scrap.spread_unit_lbs
//   spread-per-50lb         → scrap.spread_per_50lb_usd
//   signal-score            → signal.score
//   signal-score-max        → signal.score_max
//   signal-label            → signal.label
//   signal-headline         → signal.headline
//   signal-summary          → signal.summary
//   method-* / calc-*       → formatted strings written into the methodology
//                              table and stacked calculation block.

function fmtMoney(n, dp = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return n.toFixed(dp);
}

function fmtSignedPct(n, dp = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const sign = n > 0 ? '+' : (n < 0 ? '' : ''); // negative sign comes from toFixed naturally
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

function deriveStatus(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  if (n > 0) return 'positive';
  if (n < 0) return 'negative';
  return 'flat';
}

function hydrate(data) {
  if (!data || typeof data !== 'object') return;

  // ---- Copper market card -------------------------------------------------
  const c = data.copper || {};
  setText('copper-price', fmtMoney(c.reference_price_usd_per_lb, 2));

  const delta30 = fmtSignedPct(c.delta_30d_pct, 2);
  const delta12 = fmtSignedPct(c.delta_12mo_pct, 1);
  const delta5 = fmtSignedPct(c.delta_5yr_pct, 1);
  setText('delta-30d', delta30);
  setText('delta-12mo', delta12);
  setText('delta-5yr', delta5);

  const statuses = (c.deltas_status || {});
  setStatus('delta-30d-chip', statuses['30d'] || deriveStatus(c.delta_30d_pct));
  setStatus('delta-12mo-chip', statuses['12mo'] || deriveStatus(c.delta_12mo_pct));
  setStatus('delta-5yr-chip', statuses['5yr'] || deriveStatus(c.delta_5yr_pct));

  // ---- Strip value delta KPI ---------------------------------------------
  const s = data.scrap || {};
  const stripDelta = s.strip_value_delta_usd_per_lb;
  if (typeof stripDelta === 'number' && Number.isFinite(stripDelta)) {
    const sign = stripDelta >= 0 ? '+' : '−';
    setText('strip-delta-sign', sign);
    setText('strip-delta-abs', fmtMoney(Math.abs(stripDelta), 2));
    setStatus('strip-delta-wrap', s.strip_value_delta_status || deriveStatus(stripDelta));
  }
  setText('bare-bright-price', fmtMoney(s.bare_bright_usd_per_lb, 2));
  setText('insulated-price', fmtMoney(s.insulated_wire_usd_per_lb, 2));
  if (typeof s.spread_unit_lbs === 'number') setText('spread-unit-lbs', s.spread_unit_lbs);
  if (typeof s.spread_per_50lb_usd === 'number') setText('spread-per-50lb', s.spread_per_50lb_usd);

  // ---- Primary signal -----------------------------------------------------
  const sig = data.signal || {};
  if (typeof sig.score === 'number') setText('signal-score', sig.score);
  if (typeof sig.score_max === 'number') setText('signal-score-max', sig.score_max);
  if (sig.label) setText('signal-label', sig.label);
  if (sig.headline) setText('signal-headline', sig.headline);
  if (sig.summary) setText('signal-summary', sig.summary);

  // ---- Methodology table -------------------------------------------------
  if (typeof c.reference_price_usd_per_lb === 'number') {
    setText('method-copper-price', `$${fmtMoney(c.reference_price_usd_per_lb, 2)}/lb`);
  }
  if (delta30) setText('method-delta-30d', delta30);
  if (delta12) setText('method-delta-12mo', delta12);
  if (delta5) setText('method-delta-5yr', delta5);
  if (typeof stripDelta === 'number') {
    const sign = stripDelta >= 0 ? '+' : '−';
    setText('method-strip-delta', `${sign}$${fmtMoney(Math.abs(stripDelta), 2)}/lb`);
  }
  if (typeof sig.score === 'number' && typeof sig.score_max === 'number') {
    setText('method-signal-score', `${sig.score} / ${sig.score_max}`);
  }

  // 12mo / 5yr calculation strings.
  //
  // Two history shapes are supported:
  //   - New (live updater):  history.latest / history.y1 / history.y5 with
  //                          { date, close } objects, dates stamped at
  //                          fetch time so they always reflect the actual
  //                          anchor day.
  //   - Legacy (prototype):  history.close_<YYYY_MM_DD> as flat numbers.
  //
  // Prefer the new shape; fall back to the legacy keys.
  const hist = c.history || {};
  const latestObj = hist.latest && typeof hist.latest === 'object' ? hist.latest : null;
  const y1Obj = hist.y1 && typeof hist.y1 === 'object' ? hist.y1 : null;
  const y5Obj = hist.y5 && typeof hist.y5 === 'object' ? hist.y5 : null;

  const cur = latestObj?.close ?? hist.close_2026_04_30;
  const curDate = latestObj?.date;
  const prev1y = y1Obj?.close ?? hist.close_2025_04_30;
  const prev1yDate = y1Obj?.date;
  const prev5y = y5Obj?.close ?? hist.close_2021_04_30;
  const prev5yDate = y5Obj?.date;

  if ([cur, prev1y].every((n) => typeof n === 'number')) {
    const fromLabel = prev1yDate || '2025-04-30';
    const toLabel = curDate || '2026-04-30';
    setText(
      'method-delta-12mo-calc',
      `(${cur} − ${prev1y}) ÷ ${prev1y}. Close ${fromLabel} $${prev1y} → close ${toLabel} $${cur}.`
    );
  }
  if ([cur, prev5y].every((n) => typeof n === 'number')) {
    const fromLabel = prev5yDate || '2021-04-30';
    const toLabel = curDate || '2026-04-30';
    setText(
      'method-delta-5yr-calc',
      `(${cur} − ${prev5y}) ÷ ${prev5y}. Close ${fromLabel} $${prev5y} → close ${toLabel} $${cur}.`
    );
  }

  // ---- Stacked calc block ------------------------------------------------
  if (typeof s.bare_bright_usd_per_lb === 'number') {
    setText('calc-bare-bright', `$${fmtMoney(s.bare_bright_usd_per_lb, 2)}/lb`);
  }
  if (typeof s.insulated_wire_usd_per_lb === 'number') {
    setText('calc-insulated', `$${fmtMoney(s.insulated_wire_usd_per_lb, 2)}/lb`);
  }
  if (typeof stripDelta === 'number') {
    const sign = stripDelta >= 0 ? '+' : '−';
    setHTML('calc-strip-delta', `<strong>${sign}$${fmtMoney(Math.abs(stripDelta), 2)}/lb</strong>`);
  }
  if (typeof s.spread_unit_lbs === 'number') {
    setText('calc-spread-label', `${s.spread_unit_lbs} lb recovered`);
  }
  if (typeof s.spread_per_50lb_usd === 'number') {
    setText('calc-spread-value', `≈ $${s.spread_per_50lb_usd} raw-material spread`);
  }
}

async function loadCopperSignal() {
  try {
    const res = await fetch('./data/copper-signal.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    hydrate(data);
  } catch (err) {
    // Silent fallback — hardcoded HTML values remain visible.
    // Use console.info (not error) so this does not show as a red error
    // in the embed host's console when running from file:// or when the
    // JSON is intentionally absent.
    if (typeof console !== 'undefined' && console.info) {
      console.info('[copper-signal] Live data unavailable; using static fallback.', err && err.message);
    }
  }
}

// Kick off after DOM parse. The script tag is `defer`, so DOM is ready.
loadCopperSignal();
