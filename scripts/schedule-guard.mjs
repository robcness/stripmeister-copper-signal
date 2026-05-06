#!/usr/bin/env node
/**
 * schedule-guard.mjs
 *
 * Decides whether a GitHub Actions *scheduled* run of the copper-data
 * updater should actually execute today.
 *
 * Why this exists
 * ---------------
 * The user requested: "run every weekday at 09:30 Eastern, excluding
 * weekends and holidays."
 *
 * GitHub's `schedule:` cron is UTC-only and has no concept of daylight
 * saving time or holiday calendars. So we cron *more often than we need*
 * — twice a day at 13:30 UTC and 14:30 UTC, which between them cover
 * 09:30 America/New_York during EDT (UTC-4) and EST (UTC-5) — and then
 * gate the actual work behind this guard. The guard only allows the run
 * when:
 *
 *   1. local America/New_York time is exactly 09 hours 30 minutes
 *      (within a small +/- minute tolerance for cron drift), AND
 *   2. it is Monday–Friday in that timezone, AND
 *   3. the date is not on the configured market-holiday list.
 *
 * Manual `workflow_dispatch` runs always bypass this guard — see the
 * workflow YAML. This script is only invoked on `schedule` events.
 *
 * The holiday calendar is a transparent "U.S. equity / CME-style market
 * holiday" list — see HOLIDAYS_2026 / HOLIDAYS_2027 below. The user did
 * not specify Canadian vs U.S. holidays; we picked U.S. market holidays
 * because the underlying live source (Yahoo Finance HG=F = COMEX High
 * Grade Copper futures) is a U.S. CME-traded instrument, and CME copper
 * follows the U.S. market-holiday calendar. Easy to swap to Canadian
 * statutory holidays later by editing the HOLIDAYS_* tables.
 *
 * Output
 * ------
 * Writes a single line `RUN=true` or `RUN=false` to stdout.
 * If running inside GitHub Actions (`GITHUB_OUTPUT` is set), it ALSO
 * appends `run=true|false` to the step output so subsequent steps can
 * gate on `steps.<id>.outputs.run`. Always exits 0 — the guard never
 * fails the workflow; it just signals skip-or-run.
 *
 * Test mode
 * ---------
 * For unit testing, this module also exports `decide({ now, tz, holidays })`
 * which takes an explicit Date and returns a structured decision object
 * with `run`, `reason`, and the local-time fields it inspected. See
 * scripts/test-schedule-guard.mjs.
 */
/* eslint-disable no-console */

import { writeFileSync, appendFileSync, existsSync } from "node:fs";

// ---- Holiday calendars --------------------------------------------------
// U.S. equity / CME-style market holidays. ISO date strings (YYYY-MM-DD)
// in America/New_York local date. These are the days the COMEX High Grade
// Copper futures market is *closed* (full closure, not the early-close
// half-days — early closes still allow a 09:30 ET refresh).
//
// Sources: NYSE holiday calendar + CME Group equity/metals holiday calendar.
// Adjust freely. To switch to Canadian statutory holidays, replace these
// tables (and update the comment in update-copper-data.yml).
//
// Observed-day rules already applied (e.g. Independence Day 2026 falls on
// Saturday → observed Friday 2026-07-03).

export const HOLIDAYS_2026 = Object.freeze([
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Jr. Day
  "2026-02-16", // Presidents' Day (Washington's Birthday)
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth (Friday — observed in place)
  "2026-07-03", // Independence Day observed (July 4 = Saturday)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
]);

export const HOLIDAYS_2027 = Object.freeze([
  "2027-01-01", // New Year's Day
  "2027-01-18", // MLK Jr. Day
  "2027-02-15", // Presidents' Day
  "2027-03-26", // Good Friday
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth observed (June 19 = Saturday)
  "2027-07-05", // Independence Day observed (July 4 = Sunday)
  "2027-09-06", // Labor Day
  "2027-11-25", // Thanksgiving
  "2027-12-24", // Christmas observed (Dec 25 = Saturday)
]);

export const DEFAULT_HOLIDAYS = Object.freeze([
  ...HOLIDAYS_2026,
  ...HOLIDAYS_2027,
]);

// ---- Pure decision function (testable) ---------------------------------

/**
 * Return the local YYYY-MM-DD / hour / minute / weekday for `now` as
 * observed in `tz`, using Intl.DateTimeFormat. weekday is 0..6 with
 * 0 = Sunday, 6 = Saturday (matches JS `Date#getDay`). This avoids any
 * dependency on a timezone library and is DST-correct because Intl
 * understands DST.
 */
export function localFields(now, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value]),
  );
  // Intl can return "24" for hour at midnight in some locales — normalize.
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const minute = Number(parts.minute);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[parts.weekday];
  return { date, hour, minute, weekday };
}

/**
 * Pure decision: should the scheduled run proceed?
 * Returns `{ run: boolean, reason: string, local: {...} }`.
 *
 * Options:
 *   now         Date — the moment to evaluate (defaults to new Date()).
 *   tz          IANA timezone — defaults to "America/New_York".
 *   holidays    Array<string> of YYYY-MM-DD — defaults to DEFAULT_HOLIDAYS.
 *   targetHour  number — defaults to 9.
 *   targetMin   number — defaults to 30.
 *   toleranceMin number — defaults to 15. GitHub Actions schedules can
 *               drift by 5–20+ minutes under load, so we accept any run
 *               whose local time is within +/- toleranceMin of 09:30.
 */
export function decide({
  now = new Date(),
  tz = "America/New_York",
  holidays = DEFAULT_HOLIDAYS,
  targetHour = 9,
  targetMin = 30,
  toleranceMin = 15,
} = {}) {
  const local = localFields(now, tz);

  // 1. Weekend?
  if (local.weekday === 0 || local.weekday === 6) {
    return { run: false, reason: `weekend (${local.date})`, local };
  }

  // 2. Holiday?
  if (holidays.includes(local.date)) {
    return { run: false, reason: `market holiday (${local.date})`, local };
  }

  // 3. Time window?
  const localMinutes = local.hour * 60 + local.minute;
  const targetMinutes = targetHour * 60 + targetMin;
  const drift = Math.abs(localMinutes - targetMinutes);
  if (drift > toleranceMin) {
    return {
      run: false,
      reason: `outside 09:30 ${tz} window (local ${pad(local.hour)}:${pad(local.minute)}, drift ${drift}m)`,
      local,
    };
  }

  return {
    run: true,
    reason: `within 09:30 ${tz} window (local ${pad(local.hour)}:${pad(local.minute)})`,
    local,
  };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// ---- CLI entry point ----------------------------------------------------

function isMain() {
  // Resolve whether this file was invoked directly. Compare the resolved
  // file URL of argv[1] against this module's import.meta.url so that
  // importing this module from a sibling script does NOT trigger the CLI.
  if (!process.argv[1]) return false;
  try {
    const argvUrl = new URL(`file://${process.argv[1]}`).href;
    return argvUrl === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  const tz = process.env.SCHEDULE_TZ || "America/New_York";
  const decision = decide({ tz });

  console.log(`Schedule guard: ${decision.run ? "RUN" : "SKIP"} — ${decision.reason}`);
  console.log(
    `  local: ${decision.local.date} ${pad(decision.local.hour)}:${pad(decision.local.minute)} (weekday=${decision.local.weekday}, tz=${tz})`,
  );
  console.log(`RUN=${decision.run ? "true" : "false"}`);

  // GitHub Actions step output.
  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut) {
    const line = `run=${decision.run ? "true" : "false"}\n`;
    if (existsSync(ghOut)) appendFileSync(ghOut, line);
    else writeFileSync(ghOut, line);
  }

  // Always exit 0 — workflow gating happens on the step output.
  process.exit(0);
}
