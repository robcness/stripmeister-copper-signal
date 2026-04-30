#!/usr/bin/env node
/**
 * update-copper-data.mjs
 *
 * Reads data/copper-signal.json, optionally fetches updated copper futures
 * data from a free public source, recomputes deltas + spread, and writes the
 * JSON back.
 *
 * Designed to be run by GitHub Actions on a schedule (or manually).
 *
 * --------------------------------------------------------------------------
 * Source choice — copper futures (HG=F)
 * --------------------------------------------------------------------------
 *
 * Primary source: Yahoo Finance v8 chart endpoint
 *   https://query1.finance.yahoo.com/v8/finance/chart/HG=F?interval=1d&range=5y
 *
 *   - Free, no API key required.
 *   - Returns JSON with `meta.regularMarketPrice` (latest quote, USD/lb) and
 *     a daily timestamp/close array suitable for computing 30d / 12mo / 5yr
 *     deltas without keeping fixed historical anchors.
 *   - HG=F is COMEX High Grade Copper futures, quoted in USD/lb — the unit the
 *     widget already uses.
 *
 * Why not Stooq HG.F CSV (the originally-suggested source)?
 *   As of 2026-Q2, Stooq's `https://stooq.com/q/d/l/?s=hg.f&i=d` endpoint no
 *   longer returns a CSV without an account-bound API key (it returns an
 *   `error.txt` attachment). The public quote page (`https://stooq.com/q/?s=hg.f`)
 *   is JS-driven and does not expose a server-rendered price. Yahoo's chart
 *   endpoint is the most reliable free, key-less, programmatic source we
 *   could find. If it ever degrades, the script is best-effort: on failure
 *   it preserves the existing values and only refreshes timestamps.
 *
 * --------------------------------------------------------------------------
 * Scrap reference values (bare bright + insulated)
 * --------------------------------------------------------------------------
 *
 * Scrap-yard reference rates (Rockaway Recycling, iScrap App, ScrapMonster)
 * are intentionally NOT auto-fetched. Reasons:
 *
 *   1. Scrap pricing pages are HTML-only with no public JSON API; their
 *      layouts change without notice and a regex parser is brittle.
 *   2. Scrap-yard "headline" rates are reference-only — local yards quote
 *      daily and apply their own grading. Auto-publishing a number that
 *      could be days stale risks misleading users.
 *   3. The widget already discloses these are "reference rates only; check
 *      your local yard," and surfaces three independent sources in the
 *      methodology table.
 *
 * Scrap values are therefore manual. Update them via the workflow_dispatch
 * inputs `bare_bright_override` / `insulated_override`, or by editing
 * `data/copper-signal.json` directly. The script reuses the existing values
 * if no override is supplied.
 *
 * --------------------------------------------------------------------------
 * USD/CAD foreign exchange (display-only conversion)
 * --------------------------------------------------------------------------
 *
 * Primary source: Bank of Canada Valet API
 *   https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1
 *
 *   - Free, no API key, official Bank of Canada published rate.
 *   - Daily reference rate (USD -> CAD), not a transactional / dealing rate.
 *   - Returned as JSON: observations[0].FXUSDCAD.v as a string.
 *
 * The widget uses this rate strictly to render the same USD/lb metrics in
 * CAD/lb when the user flips a toggle. It is a display conversion, never a
 * yard quote. If the fetch fails, the script preserves the previous rate
 * and stamps `fetch_status.fx_usd_cad = 'bank-of-canada-failed'` so the
 * front-end can disclose the staleness via the rate's `as_of_date`.
 *
 * --------------------------------------------------------------------------
 * Environment flags
 * --------------------------------------------------------------------------
 *
 *   FETCH_SOURCES=1     Attempt to fetch live copper price from Yahoo AND
 *                       USD/CAD from Bank of Canada.
 *                       Default: 0 (timestamps only, market values unchanged).
 *   COPPER_OVERRIDE     Manual override for copper reference price (USD/lb).
 *                       Wins over the fetched value.
 *   BARE_BRIGHT_OVERRIDE / INSULATED_OVERRIDE
 *                       Manual override for the two scrap reference values.
 *   FX_USD_CAD_OVERRIDE Manual override for USD→CAD rate. Wins over fetch.
 *
 * Usage:
 *
 *   node scripts/update-copper-data.mjs                   # safe: timestamps only
 *   FETCH_SOURCES=1 node scripts/update-copper-data.mjs   # fetch copper + fx
 *   COPPER_OVERRIDE=6.12 node scripts/update-copper-data.mjs
 *   FX_USD_CAD_OVERRIDE=1.37 node scripts/update-copper-data.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_PATH = resolve(__dirname, '..', 'data', 'copper-signal.json');

const YAHOO_CHART_URL =
  'https://query1.finance.yahoo.com/v8/finance/chart/HG=F?interval=1d&range=5y';

const BOC_FX_URL =
  'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1';

// Polite UA — many CDNs block default Node UA strings.
const FETCH_HEADERS = {
  'User-Agent':
    'copper-signal-bot/1.0 (+https://www.stripmeister.com; internal data refresh)',
  Accept: 'application/json,text/plain,*/*',
};

// Bound the fetch so a hung connection cannot block the whole job.
const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Yahoo Finance copper fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch HG=F daily candles from Yahoo Finance and return:
 *
 *   {
 *     latest:        number,           // USD/lb, most recent close (or live quote)
 *     latestDateIso: string,           // ISO-8601 date of `latest`
 *     closeForOffsetDays: (n) => num,  // helper: close ~n days back, or null
 *   }
 *
 * Returns null on any failure. Never throws.
 */
async function fetchYahooCopper() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(YAHOO_CHART_URL, {
      headers: FETCH_HEADERS,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[update-copper-data] Yahoo HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) {
      console.warn('[update-copper-data] Yahoo response missing chart.result');
      return null;
    }
    const meta = result.meta || {};
    const ts = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    if (!Array.isArray(ts) || !Array.isArray(closes) || ts.length === 0) {
      console.warn('[update-copper-data] Yahoo response missing timestamps/closes');
      return null;
    }

    // Build [{date: 'YYYY-MM-DD', close: number}, ...] in ascending order,
    // skipping any rows where close is null (Yahoo returns null on holidays).
    const rows = [];
    for (let i = 0; i < ts.length; i += 1) {
      const c = closes[i];
      if (typeof c !== 'number' || !Number.isFinite(c)) continue;
      const iso = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      rows.push({ date: iso, close: c });
    }
    if (rows.length === 0) {
      console.warn('[update-copper-data] Yahoo returned no usable closes');
      return null;
    }

    // Prefer the live regularMarketPrice if present and finite; otherwise
    // fall back to the most recent close in the history.
    const live = meta.regularMarketPrice;
    const lastRow = rows[rows.length - 1];
    const latest = typeof live === 'number' && Number.isFinite(live) ? live : lastRow.close;
    const latestDateIso = lastRow.date;

    return {
      latest,
      latestDateIso,
      rows,
      /**
       * Return the close price ~n trading days back from the most recent row.
       * If `n` is larger than the array, returns the first available row.
       * This is approximate — calendar offsets (30d, 12mo, 5yr) are mapped
       * to the nearest preceding trading day in the series.
       */
      closeForOffsetDays(n) {
        const idx = rows.length - 1 - n;
        if (idx < 0) return rows[0]?.close ?? null;
        return rows[idx]?.close ?? null;
      },
      /**
       * Return the close price on or just before a target ISO date.
       */
      closeOnOrBefore(targetIso) {
        let candidate = null;
        for (const r of rows) {
          if (r.date <= targetIso) candidate = r;
          else break;
        }
        return candidate ? candidate.close : null;
      },
    };
  } catch (err) {
    console.warn('[update-copper-data] Yahoo fetch failed:', err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Bank of Canada USD/CAD fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch the most recent USD/CAD reference rate from Bank of Canada Valet.
 *
 * Returns { rate: number, dateIso: string } on success, or null on any
 * failure. Never throws. Sanity-bounds the rate to a plausible range so a
 * malformed response cannot publish a wildly wrong number.
 */
async function fetchBankOfCanadaUsdCad() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(BOC_FX_URL, {
      headers: FETCH_HEADERS,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[update-copper-data] BoC FX HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const obs = Array.isArray(json?.observations) ? json.observations : [];
    if (obs.length === 0) {
      console.warn('[update-copper-data] BoC FX response missing observations');
      return null;
    }
    const last = obs[obs.length - 1];
    const rateRaw = last?.FXUSDCAD?.v;
    const dateIso = last?.d;
    const rate = typeof rateRaw === 'string' ? Number(rateRaw) : Number(rateRaw);
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 3.0) {
      // USD/CAD has historically lived in roughly 0.9–1.6. A rate outside
      // 0.5–3.0 is almost certainly a parsing or upstream error.
      console.warn('[update-copper-data] BoC FX implausible rate:', rateRaw);
      return null;
    }
    if (typeof dateIso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
      console.warn('[update-copper-data] BoC FX missing date');
      return null;
    }
    return { rate, dateIso };
  } catch (err) {
    console.warn('[update-copper-data] BoC FX fetch failed:', err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function deriveStatus(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'flat';
  if (n > 0) return 'positive';
  if (n < 0) return 'negative';
  return 'flat';
}

function pct(curr, prev) {
  if (typeof curr !== 'number' || typeof prev !== 'number' || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

function round(n, dp) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return n;
  const p = 10 ** dp;
  return Math.round(n * p) / p;
}

function readNumberEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function todayIso() {
  return new Date().toISOString();
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function isoYearsAgo(n) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const raw = await readFile(DATA_PATH, 'utf8');
  const data = JSON.parse(raw);
  const fetchSources = process.env.FETCH_SOURCES === '1';

  // --- Gather candidate inputs -------------------------------------------
  let copperPrice = data?.copper?.reference_price_usd_per_lb ?? null;
  let bareBright = data?.scrap?.bare_bright_usd_per_lb ?? null;
  let insulated = data?.scrap?.insulated_wire_usd_per_lb ?? null;

  const copperOverride = readNumberEnv('COPPER_OVERRIDE');
  const bareBrightOverride = readNumberEnv('BARE_BRIGHT_OVERRIDE');
  const insulatedOverride = readNumberEnv('INSULATED_OVERRIDE');
  const fxOverride = readNumberEnv('FX_USD_CAD_OVERRIDE');

  // FX (USD→CAD) defaults
  const existingFx = data?.fx || {};
  let fxRate = typeof existingFx.usd_to_cad === 'number' ? existingFx.usd_to_cad : null;
  let fxAsOf = existingFx.as_of_date || null;
  let fxStatus = data?.fetch_status?.fx_usd_cad || existingFx.fetch_status || 'manual';

  let copperFetchStatus = data?.fetch_status?.copper_reference || 'manual';
  // Scrap statuses: never auto-fetched, but they may be overridden manually.
  let bareBrightStatus = data?.fetch_status?.bare_bright || 'manual';
  let insulatedStatus = data?.fetch_status?.insulated_wire || 'manual';

  // History anchors — start from existing JSON, then overwrite with fresh
  // computed anchors when a Yahoo fetch succeeds.
  let history = { ...(data?.copper?.history || {}) };
  let asOfDate = data?.copper?.as_of_date || todayDate();

  // 30-day delta — only the live fetcher can refresh this. Default: keep the
  // existing value so a no-fetch run does not silently zero it out.
  let delta30 = data?.copper?.delta_30d_pct ?? null;
  let delta12 = null;
  let delta5 = null;

  if (fetchSources) {
    // FX fetch from Bank of Canada (independent of copper fetch).
    const fx = await fetchBankOfCanadaUsdCad();
    if (fx) {
      fxRate = round(fx.rate, 4);
      fxAsOf = fx.dateIso;
      fxStatus = 'bank-of-canada';
    } else {
      fxStatus = 'bank-of-canada-failed';
      // Preserve previous rate — better stale than wrong.
    }

    const y = await fetchYahooCopper();
    if (y && typeof y.latest === 'number' && Number.isFinite(y.latest)) {
      copperPrice = round(y.latest, 4);
      asOfDate = y.latestDateIso;
      copperFetchStatus = 'yahoo-finance';

      // Compute 30-day, 12-month, 5-year deltas against the closest
      // available historical close in the same series.
      const target30 = isoDaysAgo(30);
      const target1y = isoYearsAgo(1);
      const target5y = isoYearsAgo(5);

      const close30 = y.closeOnOrBefore(target30);
      const close1y = y.closeOnOrBefore(target1y);
      const close5y = y.closeOnOrBefore(target5y);

      delta30 = pct(copperPrice, close30);
      delta12 = pct(copperPrice, close1y);
      delta5 = pct(copperPrice, close5y);

      // Snapshot the anchor closes alongside the calculation so the front-end
      // methodology block can show the math. We use generic keys here so we
      // don't collide with the prototype's date-stamped keys in older JSON.
      history = {
        ...history,
        latest: { date: y.latestDateIso, close: round(copperPrice, 4) },
        d30: close30 != null ? { date: target30, close: round(close30, 4) } : null,
        y1: close1y != null ? { date: target1y, close: round(close1y, 4) } : null,
        y5: close5y != null ? { date: target5y, close: round(close5y, 4) } : null,
      };
    } else {
      copperFetchStatus = 'yahoo-finance-failed';
      // Preserve existing deltas — better stale than wrong.
      delta12 = data?.copper?.delta_12mo_pct ?? null;
      delta5 = data?.copper?.delta_5yr_pct ?? null;
    }
  } else {
    // No fetch attempt — keep existing deltas as-is.
    delta12 = data?.copper?.delta_12mo_pct ?? null;
    delta5 = data?.copper?.delta_5yr_pct ?? null;
  }

  // Manual overrides win over fetched values.
  if (copperOverride !== null) {
    copperPrice = round(copperOverride, 4);
    copperFetchStatus = 'manual-override';
    asOfDate = todayDate();
  }
  if (bareBrightOverride !== null) {
    bareBright = round(bareBrightOverride, 2);
    bareBrightStatus = 'manual-override';
  }
  if (insulatedOverride !== null) {
    insulated = round(insulatedOverride, 2);
    insulatedStatus = 'manual-override';
  }
  if (fxOverride !== null && fxOverride > 0.5 && fxOverride < 3.0) {
    fxRate = round(fxOverride, 4);
    fxAsOf = todayDate();
    fxStatus = 'manual-override';
  }

  // --- Recompute spread --------------------------------------------------
  const stripDelta =
    typeof bareBright === 'number' && typeof insulated === 'number'
      ? round(bareBright - insulated, 2)
      : (data?.scrap?.strip_value_delta_usd_per_lb ?? null);

  const unitLbs = data?.scrap?.spread_unit_lbs ?? 50;
  const spreadPerUnit =
    typeof stripDelta === 'number' && Number.isFinite(stripDelta)
      ? Math.round(stripDelta * unitLbs)
      : (data?.scrap?.spread_per_50lb_usd ?? null);

  // --- Write back --------------------------------------------------------
  const next = {
    ...data,
    generated_at: todayIso(),
    last_updated: todayDate(),
    last_checked: todayIso(),
    copper: {
      ...data.copper,
      reference_price_usd_per_lb: copperPrice,
      as_of_date: asOfDate,
      delta_30d_pct: delta30 !== null ? round(delta30, 2) : data?.copper?.delta_30d_pct,
      delta_12mo_pct: delta12 !== null ? round(delta12, 2) : data?.copper?.delta_12mo_pct,
      delta_5yr_pct: delta5 !== null ? round(delta5, 2) : data?.copper?.delta_5yr_pct,
      history,
      deltas_status: {
        '30d': deriveStatus(delta30),
        '12mo': deriveStatus(delta12),
        '5yr': deriveStatus(delta5),
      },
    },
    scrap: {
      ...data.scrap,
      bare_bright_usd_per_lb: bareBright,
      insulated_wire_usd_per_lb: insulated,
      strip_value_delta_usd_per_lb: stripDelta,
      strip_value_delta_status: deriveStatus(stripDelta),
      spread_per_50lb_usd: spreadPerUnit,
      spread_unit_lbs: unitLbs,
    },
    fx: {
      ...existingFx,
      base_currency: 'USD',
      quote_currency: 'CAD',
      usd_to_cad: fxRate,
      as_of_date: fxAsOf,
      source: existingFx.source || {
        label: 'Bank of Canada Valet — FXUSDCAD',
        url: 'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1',
        caveat:
          'Daily reference rate from Bank of Canada. Not a transactional rate; banks and yards apply their own spreads. Display-only conversion.',
      },
      fetch_status: fxStatus,
      // manual_override reflects ONLY this run: a numeric override when
      // FX_USD_CAD_OVERRIDE is actively supplied (and within the sane
      // 0.5–3.0 band), otherwise null. We deliberately do NOT carry
      // forward a prior override here — the previous run's flag should
      // not masquerade as the current run's source of truth.
      manual_override:
        fxOverride !== null && fxOverride > 0.5 && fxOverride < 3.0
          ? round(fxOverride, 4)
          : null,
    },
    fetch_status: {
      ...(data.fetch_status || {}),
      copper_reference: copperFetchStatus,
      bare_bright: bareBrightStatus,
      insulated_wire: insulatedStatus,
      fx_usd_cad: fxStatus,
      notes: fetchSources
        ? 'Live fetch attempted via Yahoo Finance HG=F and Bank of Canada Valet (FXUSDCAD). Scrap reference values are manual by design — see scripts/update-copper-data.mjs header for rationale.'
        : 'Timestamps only. Set FETCH_SOURCES=1 to attempt live copper + FX fetch. Scrap values stay manual.',
    },
  };

  await writeFile(DATA_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');

  // Brief stdout summary so the GitHub Actions log is readable.
  console.log('[update-copper-data] wrote', DATA_PATH);
  console.log('[update-copper-data] copper:', copperPrice, '/lb (', copperFetchStatus, ')');
  console.log('[update-copper-data] bare bright:', bareBright, '(', bareBrightStatus, ')');
  console.log('[update-copper-data] insulated:', insulated, '(', insulatedStatus, ')');
  console.log('[update-copper-data] strip delta:', stripDelta, '/lb');
  console.log('[update-copper-data] deltas: 30d', delta30, '12mo', delta12, '5yr', delta5);
  console.log('[update-copper-data] fx USD→CAD:', fxRate, '(', fxStatus, ')', 'as of', fxAsOf);
}

main().catch((err) => {
  console.error('[update-copper-data] failed:', err);
  process.exit(1);
});
