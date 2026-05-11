#!/usr/bin/env node
/**
 * score-engine.mjs
 *
 * Pure, dependency-free scoring + banding for the Copper Recovery Signal.
 *
 * Design intent
 * -------------
 * The user asked for a "more sensitive but still conservative" scoring rule
 * that *responds to daily copper moves* without crossing into hype or
 * implying guaranteed ROI. Earlier versions of the data pipeline emitted a
 * static score of 82 regardless of input — by design easy to read, but it
 * did not move when the underlying copper market did.
 *
 * The new rule is:
 *
 *   score = clamp( BASE + d1_adj + d5_adj + d30_adj + ctx_5y + strip_adj , 60, 99 )
 *
 *   where:
 *     BASE     = 80          (calm, "good time to buy" baseline)
 *     d1_adj   in [-4, +4]   (responds to today's % move vs. last close)
 *     d5_adj   in [-5, +5]   (responds to 5-day momentum)
 *     d30_adj  in [-5, +5]   (responds to 30-day momentum)
 *     ctx_5y   in [-2, +3]   (5-year value context)
 *     strip_adj in [-2, +2]  (scrap spread health)
 *
 * Conservative caps:
 *   - Per-component caps prevent any one input from dominating the score.
 *   - Hard floor 60 and hard ceiling 99 — we never publish 100/100 or 0/100.
 *
 * Sensitivity calibration:
 *   - A +0.5% daily move = +1 point
 *   - A +1.5% five-day move = +1 point
 *   - A +3.0% thirty-day move = +1 point
 *
 *   On a +$0.19/lb day against a $6.00 base (≈ +3.17% daily) with otherwise
 *   neutral context, this produces a +3 point delta from the prior score —
 *   a modest, market-aware response (not a swing).
 *
 * Score bands (per product owner specification)
 * --------------------------------------------
 *   78–84  →  "Good time to buy"           headline: "Recovery window open"
 *   85–91  →  "Strong buying window"       headline: "Strong recovery window"
 *   92+    →  "Exceptional recovery window" headline: "Exceptional recovery window"
 *   <78    →  "Hold / monitor"             headline: "Hold and monitor"
 *
 * Wording rules — no hype, no guarantees:
 *   - Summary text refers to "the recovery math" and references conditions,
 *     not future prices.
 *   - We never say "buy now to make money" or "guaranteed return" anywhere.
 *
 * Drivers
 * -------
 * scoreDrivers() returns the top 2 contributions by absolute magnitude,
 * each as { id, label, delta }. These are surfaced in data.signal.drivers
 * for the dashboard to render if a clean spot is available, and to make
 * the day-over-day "why did the score move" question answerable from JSON
 * even though we are not sending email.
 */

export const SCORE_BASE = 80;
export const SCORE_MIN = 60;
export const SCORE_MAX = 99;

/**
 * Compute the 1d adjustment: +1 per +0.5% daily move, capped at ±4.
 */
function adjDaily(d1Pct) {
  if (typeof d1Pct !== 'number' || !Number.isFinite(d1Pct)) return 0;
  const raw = Math.round(d1Pct / 0.5);
  return Math.max(-4, Math.min(4, raw));
}

/**
 * Compute the 5d adjustment: +1 per +1.5% 5-day move, capped at ±5.
 */
function adj5d(d5Pct) {
  if (typeof d5Pct !== 'number' || !Number.isFinite(d5Pct)) return 0;
  const raw = Math.round(d5Pct / 1.5);
  return Math.max(-5, Math.min(5, raw));
}

/**
 * Compute the 30d adjustment: +1 per +3% 30-day move, capped at ±5.
 */
function adj30d(d30Pct) {
  if (typeof d30Pct !== 'number' || !Number.isFinite(d30Pct)) return 0;
  const raw = Math.round(d30Pct / 3.0);
  return Math.max(-5, Math.min(5, raw));
}

/**
 * 5-year context: a long-horizon sanity check. Bigger reward at deeper
 * positive context, mild penalty if copper is below where it was 5 years
 * ago (signals weak demand/oversupply).
 */
function adj5yr(d5yPct) {
  if (typeof d5yPct !== 'number' || !Number.isFinite(d5yPct)) return 0;
  if (d5yPct >= 50) return 3;
  if (d5yPct >= 25) return 2;
  if (d5yPct >= 10) return 1;
  if (d5yPct < 0) return -2;
  return 0;
}

/**
 * Strip-spread adjustment: the recovery math is only attractive if the
 * spread between bare-bright and insulated is meaningful. Modest weight.
 */
function adjStrip(stripDeltaUsdPerLb) {
  if (typeof stripDeltaUsdPerLb !== 'number' || !Number.isFinite(stripDeltaUsdPerLb)) return 0;
  if (stripDeltaUsdPerLb >= 4) return 2;
  if (stripDeltaUsdPerLb >= 2) return 1;
  if (stripDeltaUsdPerLb <= 0) return -2;
  return 0;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Return the band metadata for a numeric score.
 * Bands are exclusive between tiers per product owner spec:
 *   <60    Verify conditions          (rarely seen — published score is floored at 60)
 *   60–77  Watch & review economics   (conservative, non-buying)
 *   78–84  Good time to buy
 *   85–91  Strong buying window
 *   92+    Exceptional recovery window
 *
 * Language note: the product owner asked us to AVOID 'Wait' / 'Hold'-style
 * language. 'Verify conditions' replaces the legacy 'Hold / monitor' label
 * at the very bottom; 'Watch & review economics' covers the 60–77 band as
 * an intermediate conservative, non-buying state.
 */
export function bandForScore(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return {
      id: 'unknown',
      label: 'Signal unavailable',
      headline: 'Signal unavailable',
      summary:
        'Live copper data is missing. The widget falls back to its last known reference values.',
    };
  }
  if (score >= 92) {
    return {
      id: 'exceptional',
      label: 'Exceptional recovery window',
      headline: 'Exceptional recovery window',
      summary:
        'Copper momentum is unusually strong across short and long horizons. ' +
        'If you have wire on hand, run the recovery math now. Reference signal — not financial advice.',
    };
  }
  if (score >= 85) {
    return {
      id: 'strong',
      label: 'Strong buying window',
      headline: 'Strong recovery window',
      summary:
        'Copper is firm and trending up across multiple horizons. ' +
        'If you have wire on hand, run the recovery math now. Reference signal — not financial advice.',
    };
  }
  if (score >= 78) {
    return {
      id: 'good',
      label: 'Good time to buy',
      headline: 'Recovery window open',
      summary:
        'Copper is supportive of the recovery math at current reference rates. ' +
        'If you have wire on hand, run the recovery math now. Reference signal — not financial advice.',
    };
  }
  if (score >= 60) {
    return {
      id: 'watch',
      label: 'Watch & review economics',
      headline: 'Watch and review economics',
      summary:
        'Copper momentum is soft. The recovery math is less compelling at current reference rates — ' +
        'review your inventory economics and check your local yard before committing volume. ' +
        'Reference signal — not financial advice.',
    };
  }
  return {
    id: 'verify',
    label: 'Verify conditions',
    headline: 'Verify conditions',
    summary:
      'Copper momentum is unusually weak. Verify the current reference price and your local yard quote ' +
      'before committing volume. Reference signal — not financial advice.',
  };
}

/**
 * Compute the score (raw + capped) and per-component adjustments.
 *
 * Inputs: an object with optional numeric fields:
 *   d1_pct        daily % move (latest vs. previous close)
 *   d5_pct        5-day % move
 *   d30_pct       30-day % move
 *   d5y_pct       5-year % move
 *   strip_usd_lb  strip value delta in USD/lb
 *
 * Returns { score, raw, components: {...}, band: {...} }.
 */
export function computeScore({
  d1_pct = null,
  d5_pct = null,
  d30_pct = null,
  d5y_pct = null,
  strip_usd_lb = null,
} = {}) {
  const components = {
    base: SCORE_BASE,
    daily: adjDaily(d1_pct),
    five_day: adj5d(d5_pct),
    thirty_day: adj30d(d30_pct),
    five_year_context: adj5yr(d5y_pct),
    strip_spread: adjStrip(strip_usd_lb),
  };
  const raw =
    components.base +
    components.daily +
    components.five_day +
    components.thirty_day +
    components.five_year_context +
    components.strip_spread;
  const score = clamp(Math.round(raw), SCORE_MIN, SCORE_MAX);
  return {
    score,
    raw,
    components,
    band: bandForScore(score),
  };
}

/**
 * Return the top N drivers (by absolute contribution) for a components map,
 * skipping the constant base. Each driver has:
 *   { id, label, delta }
 * Ties are broken in a stable order: daily > 5-day > 30-day > 5yr > strip.
 */
export function scoreDrivers(components, n = 2) {
  const order = [
    { id: 'daily', label: '1-day copper move' },
    { id: 'five_day', label: '5-day copper momentum' },
    { id: 'thirty_day', label: '30-day copper momentum' },
    { id: 'five_year_context', label: '5-year context' },
    { id: 'strip_spread', label: 'Strip-value spread' },
  ];
  const rows = order
    .map((row) => ({
      id: row.id,
      label: row.label,
      delta: components?.[row.id] ?? 0,
    }))
    .filter((row) => row.delta !== 0);
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return rows.slice(0, n);
}
