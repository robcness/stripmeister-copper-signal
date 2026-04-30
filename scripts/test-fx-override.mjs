#!/usr/bin/env node
/**
 * test-fx-override.mjs
 *
 * Local test harness for the manual_override metadata fix in
 * scripts/update-copper-data.mjs. Exercises three scenarios:
 *
 *   1. No override + FETCH_SOURCES=1 + Bank of Canada fetch SUCCEEDS
 *      -> fx.manual_override === null
 *      -> fx.fetch_status === 'bank-of-canada'
 *
 *   2. FX_USD_CAD_OVERRIDE=1.42 + FETCH_SOURCES=1
 *      -> fx.manual_override === 1.42
 *      -> fx.fetch_status === 'manual-override'
 *
 *   3. No override + no FETCH_SOURCES (conservative no-fetch run)
 *      -> fx.manual_override === null
 *      -> fx.fetch_status preserves prior status (NOT a fresh manual-override)
 *
 * The harness:
 *   - Snapshots the live data/copper-signal.json
 *   - Patches the file to known starting metadata before each scenario,
 *     INCLUDING the misleading manual_override: 1.39 the parent agent saw,
 *     so we prove the fix actively clears stale metadata.
 *   - Stubs fetch() so we don't hit the live Bank of Canada / Yahoo APIs.
 *   - Imports the updater as a child process to keep the test isolated.
 *   - Restores the original JSON when finished.
 *
 * Run: node scripts/test-fx-override.mjs
 * Exits non-zero on any assertion failure.
 */

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_PATH = resolve(__dirname, '..', 'data', 'copper-signal.json');
const UPDATER = resolve(__dirname, 'update-copper-data.mjs');

// ---------------------------------------------------------------------------
// fetch stub
//
// The real updater calls `fetch(BOC_FX_URL)` and `fetch(YAHOO_CHART_URL)`.
// We inject a Node `--import` ESM loader that intercepts global fetch and
// returns canned JSON. This avoids any network dependency while letting the
// real script run unmodified.
// ---------------------------------------------------------------------------

// Write the stub loader into a fresh OS temp dir so it never lands in the
// repo even if the test crashes mid-run.
const TMP_DIR = await mkdtemp(join(tmpdir(), 'fx-override-test-'));
const STUB_LOADER = join(TMP_DIR, 'fetch-stub.mjs');

const stubSource = `
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('bankofcanada.ca')) {
    if (process.env.STUB_BOC === 'fail') {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        observations: [{ d: '2026-04-30', FXUSDCAD: { v: '1.3624' } }],
      }),
    };
  }
  if (u.includes('finance.yahoo.com')) {
    // Minimal valid Yahoo shape so the copper branch doesn't NaN out.
    const today = Math.floor(Date.now() / 1000);
    const day = 86400;
    const ts = [];
    const closes = [];
    for (let i = 365 * 5 + 30; i >= 0; i -= 1) {
      ts.push(today - i * day);
      closes.push(4.5 + Math.random() * 0.01);
    }
    closes[closes.length - 1] = 6.0265;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        chart: {
          result: [
            {
              meta: { regularMarketPrice: 6.0265 },
              timestamp: ts,
              indicators: { quote: [{ close: closes }] },
            },
          ],
        },
      }),
    };
  }
  return realFetch(url);
};
`;
await writeFile(STUB_LOADER, stubSource, 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const original = await readFile(DATA_PATH, 'utf8');

async function setStartingState(patch) {
  const data = JSON.parse(original);
  // Seed with the misleading state the parent agent observed: a stale
  // manual_override that should NOT survive a fresh run. We patch BOTH
  // the nested fx.* block and the top-level fetch_status.fx_usd_cad,
  // because the updater treats the top-level as the source of truth
  // when nothing fresh has been fetched or overridden.
  data.fx = {
    ...data.fx,
    fetch_status: 'manual-override',
    manual_override: 1.39,
    usd_to_cad: 1.39,
    as_of_date: '2026-04-15',
    ...(patch?.fx || {}),
  };
  data.fetch_status = {
    ...(data.fetch_status || {}),
    fx_usd_cad: 'manual-override',
    ...(patch?.fetch_status || {}),
  };
  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function runUpdater(env) {
  const r = spawnSync(
    process.execPath,
    ['--import', STUB_LOADER, UPDATER],
    {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    },
  );
  if (r.status !== 0) {
    console.error('updater stderr:', r.stderr);
    console.error('updater stdout:', r.stdout);
    throw new Error('updater exited with code ' + r.status);
  }
  return r;
}

async function loadResult() {
  return JSON.parse(await readFile(DATA_PATH, 'utf8'));
}

let failed = 0;
function assertEq(actual, expected, label) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  if (!ok) failed += 1;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

try {
  // -------------------------------------------------------------------------
  console.log('\nScenario 1: FETCH_SOURCES=1, no override, BoC fetch SUCCEEDS');
  // -------------------------------------------------------------------------
  await setStartingState({});
  runUpdater({ FETCH_SOURCES: '1' });
  let r = await loadResult();
  assertEq(r.fx.manual_override, null, 'fx.manual_override is null');
  assertEq(r.fx.fetch_status, 'bank-of-canada', 'fx.fetch_status is bank-of-canada');
  assertEq(r.fx.usd_to_cad, 1.3624, 'fx.usd_to_cad reflects fetched rate');
  assertEq(r.fetch_status.fx_usd_cad, 'bank-of-canada', 'top-level fetch_status.fx_usd_cad');

  // -------------------------------------------------------------------------
  console.log('\nScenario 2: FETCH_SOURCES=1 + FX_USD_CAD_OVERRIDE=1.42');
  // -------------------------------------------------------------------------
  await setStartingState({});
  runUpdater({ FETCH_SOURCES: '1', FX_USD_CAD_OVERRIDE: '1.42' });
  r = await loadResult();
  assertEq(r.fx.manual_override, 1.42, 'fx.manual_override is 1.42');
  assertEq(r.fx.fetch_status, 'manual-override', 'fx.fetch_status is manual-override');
  assertEq(r.fx.usd_to_cad, 1.42, 'fx.usd_to_cad reflects override');

  // -------------------------------------------------------------------------
  console.log('\nScenario 3: no FETCH_SOURCES, no override (conservative run)');
  // -------------------------------------------------------------------------
  // Seed with the stale misleading override so we can prove the no-fetch
  // path also clears it (the bug must not survive a timestamp-only run).
  await setStartingState({});
  runUpdater({});
  r = await loadResult();
  assertEq(r.fx.manual_override, null, 'fx.manual_override is null on no-fetch run');
  // fxStatus should reflect prior status (manual-override seed) since we
  // didn't fetch and didn't supply a new override. The KEY guarantee is
  // that we don't fabricate a fresh manual-override flag in metadata.
  assertEq(
    r.fx.fetch_status,
    'manual-override',
    'fx.fetch_status preserves prior status (no fresh override applied)',
  );

  // -------------------------------------------------------------------------
  console.log('\nScenario 4 (bonus): BoC fetch FAILS, no override');
  // -------------------------------------------------------------------------
  await setStartingState({});
  runUpdater({ FETCH_SOURCES: '1', STUB_BOC: 'fail' });
  r = await loadResult();
  assertEq(r.fx.manual_override, null, 'fx.manual_override is null on BoC failure');
  assertEq(r.fx.fetch_status, 'bank-of-canada-failed', 'fx.fetch_status is bank-of-canada-failed');
} finally {
  // Restore original JSON so the test never leaves the working tree dirty.
  await writeFile(DATA_PATH, original, 'utf8');
  // And remove the temp dir holding the stub loader.
  await rm(TMP_DIR, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll assertions passed.');
