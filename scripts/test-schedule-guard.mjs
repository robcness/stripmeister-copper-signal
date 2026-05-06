#!/usr/bin/env node
/**
 * test-schedule-guard.mjs
 *
 * Unit tests for scripts/schedule-guard.mjs `decide()`. Covers:
 *   - DST (March–November):  13:30 UTC on a Tuesday → 09:30 EDT → RUN
 *   - DST off-window:        14:30 UTC on a Tuesday → 10:30 EDT → SKIP
 *   - Standard time:         14:30 UTC on a Tuesday → 09:30 EST → RUN
 *   - Standard off-window:   13:30 UTC on a Tuesday → 08:30 EST → SKIP
 *   - Saturday weekend:      13:30 UTC Saturday → SKIP (weekend)
 *   - Sunday weekend:        14:30 UTC Sunday → SKIP (weekend)
 *   - U.S. holiday:          13:30 UTC on 2026-07-03 (Friday, Indep. Day
 *                            observed) → SKIP (holiday)
 *   - Drift tolerance:       13:38 UTC EDT (~09:38 ET) → RUN (within 15m)
 *   - Out of tolerance:      13:50 UTC EDT (~09:50 ET) → SKIP
 *   - America/Toronto check: 13:30 UTC EDT in Toronto → RUN (matches NY)
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

// ---------- Scenario 1: DST in effect, 13:30 UTC Tuesday → 09:30 EDT ----
// 2026-06-09 is a Tuesday in EDT (UTC-4). 13:30 UTC == 09:30 EDT.
header("Scenario 1: DST in effect, 13:30 UTC Tue → 09:30 EDT (RUN)");
{
  const d = decide({ now: new Date("2026-06-09T13:30:00Z") });
  check("run", d.run, true);
  check("local.hour", d.local.hour, 9);
  check("local.minute", d.local.minute, 30);
  check("local.weekday Tue", d.local.weekday, 2);
}

// ---------- Scenario 2: DST in effect, 14:30 UTC Tuesday → 10:30 EDT (SKIP) ----
header("Scenario 2: DST in effect, 14:30 UTC Tue → 10:30 EDT (SKIP)");
{
  const d = decide({ now: new Date("2026-06-09T14:30:00Z") });
  check("run", d.run, false);
  check("local.hour", d.local.hour, 10);
  check("reason mentions window", /window/.test(d.reason), true);
}

// ---------- Scenario 3: Standard time, 14:30 UTC Tuesday → 09:30 EST (RUN) ----
// 2026-12-08 is a Tuesday in EST (UTC-5). 14:30 UTC == 09:30 EST.
header("Scenario 3: Standard time, 14:30 UTC Tue → 09:30 EST (RUN)");
{
  const d = decide({ now: new Date("2026-12-08T14:30:00Z") });
  check("run", d.run, true);
  check("local.hour", d.local.hour, 9);
  check("local.minute", d.local.minute, 30);
}

// ---------- Scenario 4: Standard time, 13:30 UTC Tuesday → 08:30 EST (SKIP) ----
header("Scenario 4: Standard time, 13:30 UTC Tue → 08:30 EST (SKIP)");
{
  const d = decide({ now: new Date("2026-12-08T13:30:00Z") });
  check("run", d.run, false);
  check("local.hour", d.local.hour, 8);
  check("local.minute", d.local.minute, 30);
}

// ---------- Scenario 5: Saturday in DST, 13:30 UTC → SKIP (weekend) -----
// 2026-06-13 is a Saturday.
header("Scenario 5: Saturday 13:30 UTC EDT (SKIP weekend)");
{
  const d = decide({ now: new Date("2026-06-13T13:30:00Z") });
  check("run", d.run, false);
  check("weekday Sat", d.local.weekday, 6);
  check("reason mentions weekend", /weekend/.test(d.reason), true);
}

// ---------- Scenario 6: Sunday in EST, 14:30 UTC → SKIP (weekend) -------
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

// ---------- Scenario 8: Drift tolerance — within +/- 15 min OK ----------
// 2026-06-09 13:38 UTC == 09:38 EDT, drift = 8 min → RUN.
header("Scenario 8: Drift +8m within tolerance (RUN)");
{
  const d = decide({ now: new Date("2026-06-09T13:38:00Z") });
  check("run", d.run, true);
  check("local.minute", d.local.minute, 38);
}

// ---------- Scenario 9: Out of tolerance — drift 20m → SKIP -------------
header("Scenario 9: Drift +20m outside tolerance (SKIP)");
{
  const d = decide({ now: new Date("2026-06-09T13:50:00Z") });
  check("run", d.run, false);
  check("local.minute", d.local.minute, 50);
}

// ---------- Scenario 10: America/Toronto matches America/New_York -------
// Both observe Eastern Time with the same DST rules.
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

// ---------- Scenario 11: Holiday + correct time still SKIPs --------------
// 2026-12-25 is Christmas (Friday). 14:30 UTC == 09:30 EST. Should SKIP.
header("Scenario 11: Christmas 09:30 EST (SKIP holiday, not weekend)");
{
  const d = decide({ now: new Date("2026-12-25T14:30:00Z") });
  check("run", d.run, false);
  check("reason mentions holiday", /holiday/.test(d.reason), true);
  check("local.date", d.local.date, "2026-12-25");
}

// ---------- Scenario 12: Custom holidays argument honored ----------------
header("Scenario 12: Custom holiday list (RUN when not in list)");
{
  // Override: empty holiday list means 2026-07-03 is just a weekday.
  const d = decide({
    now: new Date("2026-07-03T13:30:00Z"),
    holidays: [],
  });
  check("run", d.run, true);
  check("local.date", d.local.date, "2026-07-03");
}

// ---------- Summary -----------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
console.log("All assertions passed.");
