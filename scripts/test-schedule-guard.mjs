#!/usr/bin/env node
/**
 * test-schedule-guard.mjs
 *
 * Unit tests for scripts/schedule-guard.mjs `decide()`. Covers:
 *   - Exact 09:30 ET (EDT and EST) → RUN
 *   - Before 09:30 ET → SKIP
 *   - After 16:30 ET cutoff → SKIP
 *   - Weekend (Saturday + Sunday) → SKIP
 *   - U.S. market holiday → SKIP
 *   - Custom holiday list honored
 *   - America/Toronto cross-check
 *   - Delayed scheduled run at 11:42 ET with previous-day generated_at
 *     → RUN  (regression: parent reported the May 7 GitHub-delayed run
 *     that the old +/- 15m guard skipped)
 *   - Second delayed scheduled run same ET day after data was generated
 *     at 11:42 ET → SKIP (already-refreshed-today dedupe)
 *   - Same ET day with a pre-09:30 generated_at (e.g. midnight manual
 *     refresh) → RUN (the scheduled job is still eligible)
 *   - Two cron entries: 13:30 UTC EDT + 14:30 UTC EDT same day, with
 *     the first refresh stamped by the first run → second run SKIPs
 *
 * No npm dependencies. Pure Node + Intl.
 */
/* eslint-disable no-console */

import { decide } from "./schedule-guard.mjs";

let passed = 0;
let failed = 0;

function check(label, got, expected) {
  const ok = got === expected;
  if (ok) {
    passed++;
    console.log(`  PASS ${label} -> ${JSON.stringify(got)}`);
  } else {
    failed++;
    console.log(
      `  FAIL ${label} -> got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

function header(name) {
  console.log(`\n${name}`);
}

// ---------- Scenario 1: Exact 09:30 EDT (RUN) ---------------------------
// 2026-06-09 is a Tuesday in EDT (UTC-4). 13:30 UTC == 09:30 EDT.
header("Scenario 1: 13:30 UTC Tue (EDT) → 09:30 EDT (RUN)");
{
  const d = decide({ now: new Date("2026-06-09T13:30:00Z") });
  check("run", d.run, true);
  check("local.hour", d.local.hour, 9);
  check("local.minute", d.local.minute, 30);
  check("local.weekday Tue", d.local.weekday, 2);
}

// ---------- Scenario 2: Exact 09:30 EST (RUN) ---------------------------
// 2026-12-08 is a Tuesday in EST (UTC-5). 14:30 UTC == 09:30 EST.
header("Scenario 2: 14:30 UTC Tue (EST) → 09:30 EST (RUN)");
{
  const d = decide({ now: new Date("2026-12-08T14:30:00Z") });
  check("run", d.run, true);
  check("local.hour", d.local.hour, 9);
  check("local.minute", d.local.minute, 30);
}

// ---------- Scenario 3: Before 09:30 ET → SKIP --------------------------
// 13:29 UTC EDT == 09:29 EDT. One minute before window.
header("Scenario 3: 13:29 UTC Tue (EDT) → 09:29 EDT (SKIP, before window)");
{
  const d = decide({ now: new Date("2026-06-09T13:29:00Z") });
  check("run", d.run, false);
  check("local.hour", d.local.hour, 9);
  check("local.minute", d.local.minute, 29);
  check("reason mentions before", /before/.test(d.reason), true);
}

// ---------- Scenario 4: After 16:30 ET cutoff → SKIP --------------------
// 2026-06-09 20:30 UTC EDT == 16:30 EDT. cutoff is half-open at 16:30 →
// SKIP at 16:30 itself, and SKIP after.
header("Scenario 4: 20:30 UTC Tue EDT → 16:30 EDT (SKIP, at cutoff)");
{
  const d = decide({ now: new Date("2026-06-09T20:30:00Z") });
  check("run", d.run, false);
  check("local.hour", d.local.hour, 16);
  check("local.minute", d.local.minute, 30);
  check("reason mentions cutoff", /cutoff/.test(d.reason), true);
}

header("Scenario 4b: 21:00 UTC Tue EDT → 17:00 EDT (SKIP, past cutoff)");
{
  const d = decide({ now: new Date("2026-06-09T21:00:00Z") });
  check("run", d.run, false);
  check("local.hour", d.local.hour, 17);
  check("reason mentions cutoff", /cutoff/.test(d.reason), true);
}

// ---------- Scenario 5: Saturday → SKIP weekend -------------------------
// 2026-06-13 is a Saturday.
header("Scenario 5: Saturday 13:30 UTC EDT (SKIP weekend)");
{
  const d = decide({ now: new Date("2026-06-13T13:30:00Z") });
  check("run", d.run, false);
  check("weekday Sat", d.local.weekday, 6);
  check("reason mentions weekend", /weekend/.test(d.reason), true);
}

// ---------- Scenario 6: Sunday → SKIP weekend ---------------------------
// 2026-12-13 is a Sunday.
header("Scenario 6: Sunday 14:30 UTC EST (SKIP weekend)");
{
  const d = decide({ now: new Date("2026-12-13T14:30:00Z") });
  check("run", d.run, false);
  check("weekday Sun", d.local.weekday, 0);
  check("reason mentions weekend", /weekend/.test(d.reason), true);
}

// ---------- Scenario 7: U.S. holiday — Independence Day observed --------
// 2026-07-03 (Friday) is the observed Independence Day (4th = Sat). EDT.
header("Scenario 7: 2026-07-03 13:30 UTC (SKIP holiday)");
{
  const d = decide({ now: new Date("2026-07-03T13:30:00Z") });
  check("run", d.run, false);
  check("reason mentions holiday", /holiday/.test(d.reason), true);
  check("local.date", d.local.date, "2026-07-03");
}

// ---------- Scenario 8: Christmas + 09:30 EST → SKIP holiday ------------
// 2026-12-25 is Christmas (Friday). 14:30 UTC == 09:30 EST.
header("Scenario 8: Christmas 09:30 EST (SKIP holiday, not weekend)");
{
  const d = decide({ now: new Date("2026-12-25T14:30:00Z") });
  check("run", d.run, false);
  check("reason mentions holiday", /holiday/.test(d.reason), true);
  check("local.date", d.local.date, "2026-12-25");
}

// ---------- Scenario 9: Custom holidays argument honored ----------------
header("Scenario 9: Custom holiday list (RUN when not in list)");
{
  // Override: empty holiday list means 2026-07-03 is just a weekday.
  const d = decide({
    now: new Date("2026-07-03T13:30:00Z"),
    holidays: [],
  });
  check("run", d.run, true);
  check("local.date", d.local.date, "2026-07-03");
}

// ---------- Scenario 10: America/Toronto matches America/New_York -------
header("Scenario 10: America/Toronto 13:30 UTC EDT (RUN)");
{
  const d = decide({
    now: new Date("2026-06-09T13:30:00Z"),
    tz: "America/Toronto",
  });
  check("run", d.run, true);
  check("local.hour", d.local.hour, 9);
  check("local.minute", d.local.minute, 30);
}

// ---------- Scenario 11: Delayed run — 11:42 ET, previous-day data → RUN
// Regression test for the parent-reported May 7 incident: GitHub delayed
// the 13:30 UTC cron until 15:42 UTC == 11:42 ET. Old guard skipped with
// "outside 09:30 window, drift 132m". New guard must RUN, because:
//   - it is a weekday (Thursday 2026-05-07)
//   - it is not on the holiday list
//   - 11:42 ET is at/after 09:30 and before the 16:30 cutoff
//   - the previous data refresh was the prior business day
header("Scenario 11: Delayed 11:42 ET with previous-day generated_at (RUN)");
{
  const d = decide({
    now: new Date("2026-05-07T15:42:00Z"),
    lastGeneratedAt: "2026-05-06T13:30:00Z", // previous business day, 09:30 EDT
  });
  check("run", d.run, true);
  check("local.date", d.local.date, "2026-05-07");
  check("local.hour", d.local.hour, 11);
  check("local.minute", d.local.minute, 42);
  check("reason mentions eligible", /eligible/.test(d.reason), true);
}

// ---------- Scenario 12: Second delayed run same ET day → SKIP ---------
// After the first delayed run lands at 11:42 ET and stamps the file,
// the second cron's delayed firing later that same ET day must SKIP
// to avoid a duplicate commit.
header("Scenario 12: Second delayed run same ET day (SKIP, already refreshed)");
{
  const d = decide({
    now: new Date("2026-05-07T16:35:00Z"), // 12:35 ET, still within cutoff
    lastGeneratedAt: "2026-05-07T15:42:30Z", // earlier today at 11:42 ET
  });
  check("run", d.run, false);
  check("local.date", d.local.date, "2026-05-07");
  check("reason mentions already refreshed", /already refreshed/.test(d.reason), true);
}

// ---------- Scenario 13: Pre-09:30 same-day generated_at does NOT block
// A manual midnight refresh on the same ET date should not suppress the
// real 09:30 scheduled run. The data is "stale-of-the-day" until a
// post-09:30 refresh lands.
header("Scenario 13: Same ET date but pre-09:30 generated_at (RUN)");
{
  const d = decide({
    now: new Date("2026-06-09T13:30:00Z"), // 09:30 EDT Tuesday
    lastGeneratedAt: "2026-06-09T05:00:00Z", // 01:00 EDT same day
  });
  check("run", d.run, true);
  check("local.hour", d.local.hour, 9);
}

// ---------- Scenario 14: Two-cron dedupe — second cron same ET day -----
// 13:30 UTC and 14:30 UTC both fire on a Tuesday in EDT. The first one
// (09:30 EDT) refreshes the data, then the second one (10:30 EDT) sees
// today's already-refreshed timestamp and SKIPs. This is the steady-
// state dedupe that lets us keep both UTC cron entries.
header("Scenario 14: 14:30 UTC EDT after 13:30 UTC EDT refresh (SKIP)");
{
  const d = decide({
    now: new Date("2026-06-09T14:30:00Z"), // 10:30 EDT
    lastGeneratedAt: "2026-06-09T13:30:30Z", // 09:30 EDT same day
  });
  check("run", d.run, false);
  check("local.hour", d.local.hour, 10);
  check("reason mentions already refreshed", /already refreshed/.test(d.reason), true);
}

// ---------- Scenario 15: Two-cron dedupe in EST ------------------------
// In EST (winter) the 14:30 UTC cron is the 09:30 ET hit. The 13:30 UTC
// cron is 08:30 ET (before window). If for some reason 14:30 UTC ran
// first and refreshed, a delayed re-fire later the same ET day SKIPs.
header("Scenario 15: 15:30 UTC EST after 14:30 UTC EST refresh (SKIP)");
{
  const d = decide({
    now: new Date("2026-12-08T15:30:00Z"), // 10:30 EST
    lastGeneratedAt: "2026-12-08T14:30:30Z", // 09:30 EST same day
  });
  check("run", d.run, false);
  check("local.hour", d.local.hour, 10);
  check("reason mentions already refreshed", /already refreshed/.test(d.reason), true);
}

// ---------- Scenario 16: Null lastGeneratedAt is fine ------------------
// Cold start / missing data file: behave as if there has been no prior
// refresh.
header("Scenario 16: Null lastGeneratedAt (RUN at 09:30 EDT)");
{
  const d = decide({
    now: new Date("2026-06-09T13:30:00Z"),
    lastGeneratedAt: null,
  });
  check("run", d.run, true);
}

// ---------- Scenario 17: Garbage lastGeneratedAt is fine ---------------
// Unparseable strings should be treated as "no prior refresh" and not
// crash the guard.
header("Scenario 17: Garbage lastGeneratedAt is treated as none (RUN)");
{
  const d = decide({
    now: new Date("2026-06-09T13:30:00Z"),
    lastGeneratedAt: "not-an-iso-string",
  });
  check("run", d.run, true);
}

// ---------- Scenario 18: Standard time pre-09:30 → SKIP -----------------
// 2026-12-08 13:30 UTC == 08:30 EST. Old guard would also skip this; new
// guard skips for "before window" rather than "drift" reason.
header("Scenario 18: 13:30 UTC Tue (EST) → 08:30 EST (SKIP, before window)");
{
  const d = decide({ now: new Date("2026-12-08T13:30:00Z") });
  check("run", d.run, false);
  check("local.hour", d.local.hour, 8);
  check("local.minute", d.local.minute, 30);
  check("reason mentions before", /before/.test(d.reason), true);
}

// ---------- Summary -----------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
console.log("All assertions passed.");
