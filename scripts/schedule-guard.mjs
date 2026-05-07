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
 * saving time or holiday calendars, AND scheduled workflows are best-
 * effort: GitHub explicitly warns they may be delayed during periods of
 * high load — sometimes by 30+ minutes. We have observed the 13:30 UTC
 * cron firing at 15:42 UTC (~11:42 ET). Earlier versions of this guard
 * required local Eastern time to be within +/- 15 minutes of 09:30,
 * which silently dropped delayed runs and meant data did not refresh
 * for an entire day.
 *
 * New behavior — "first eligible run wins"
 * ----------------------------------------
 * Interpret the user's intent as "run at or after 09:30 Eastern,
 * whenever GitHub actually starts the workflow on an eligible business
 * day." Concretely the guard now allows a scheduled run when ALL of:
 *
 *   1. local America/New_York date is Mon–Fri
 *   2. local America/New_York date is not on the market-holiday list
 *   3. local time is at or after 09:30 ET and before a reasonable cutoff
 *      (16:30 ET by default — i.e. before the U.S. market close, after
 *      which a "today's open" data refresh no longer makes sense), AND
 *   4. data/copper-signal.json has NOT already been refreshed for the
 *      same local ET date at/after 09:30 ET.
 *
 * Rule (4) is what dedupes the two UTC cron entries (`30 13` and
 * `30 14`) and any GitHub-delayed duplicate firings: the first one
 * through on a given ET business day refreshes the file; subsequent
 * scheduled invocations the same ET day see a fresh `generated_at`
 * and skip with "already refreshed today". A `generated_at` from an
 * earlier ET date — or from the same ET date but BEFORE 09:30 (e.g.
 * a manual midnight refresh) — does not count as "already refreshed"
 * and the scheduled run is allowed to proceed.
 *
 * Manual `workflow_dispatch` runs always bypass this guard at the
 * workflow level — see the workflow YAML. This script is only invoked
 * on `schedule` events.
 *
 * Holiday calendar
 * ----------------
 * Transparent "U.S. equity / CME-style market holiday" list — see
 * HOLIDAYS_2026 / HOLIDAYS_2027 below. The user did not specify
 * Canadian vs U.S. holidays; we picked U.S. market holidays because
 * the underlying live source (Yahoo Finance HG=F = COMEX High Grade
 * Copper futures) is a U.S. CME-traded instrument, and CME copper
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
 * For unit testing, this module also exports
 * `decide({ now, tz, holidays, lastGeneratedAt, ... })` which takes
 * an explicit Date and an optional last-refresh ISO string and
 * returns a structured decision object with `run`, `reason`, and the
 * local-time fields it inspected. See scripts/test-schedule-guard.mjs.
 */
/* eslint-disable no-console */

import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
 *   now              Date — the moment to evaluate (defaults to new Date()).
 *   tz               IANA timezone — defaults to "America/New_York".
 *   holidays         Array<string> of YYYY-MM-DD — defaults to DEFAULT_HOLIDAYS.
 *   targetHour       number — defaults to 9. Earliest local hour eligible.
 *   targetMin        number — defaults to 30. Earliest local minute eligible.
 *   cutoffHour       number — defaults to 16. Latest local hour eligible (exclusive of cutoffMin).
 *   cutoffMin        number — defaults to 30. Latest local minute eligible.
 *                    Together (cutoffHour:cutoffMin) form the half-open
 *                    upper bound: local time must be strictly < cutoff.
 *                    Default 16:30 ET ≈ 30 min after U.S. equity close.
 *   lastGeneratedAt  string|null — ISO timestamp of the previous refresh.
 *                    If it falls on the same ET date AND at/after 09:30 ET,
 *                    the run is skipped as "already refreshed today" so the
 *                    second cron entry (and any delayed duplicate) is a
 *                    no-op. Pass null/undefined to indicate "no prior
 *                    refresh on file".
 */
export function decide({
  now = new Date(),
  tz = "America/New_York",
  holidays = DEFAULT_HOLIDAYS,
  targetHour = 9,
  targetMin = 30,
  cutoffHour = 16,
  cutoffMin = 30,
  lastGeneratedAt = null,
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

  // 3. Time window — must be at/after 09:30 ET and strictly before the
  //    cutoff (default 16:30 ET).
  const localMinutes = local.hour * 60 + local.minute;
  const targetMinutes = targetHour * 60 + targetMin;
  const cutoffMinutes = cutoffHour * 60 + cutoffMin;
  if (localMinutes < targetMinutes) {
    return {
      run: false,
      reason: `before ${pad(targetHour)}:${pad(targetMin)} ${tz} (local ${pad(local.hour)}:${pad(local.minute)})`,
      local,
    };
  }
  if (localMinutes >= cutoffMinutes) {
    return {
      run: false,
      reason: `after ${pad(cutoffHour)}:${pad(cutoffMin)} ${tz} cutoff (local ${pad(local.hour)}:${pad(local.minute)})`,
      local,
    };
  }

  // 4. Already-refreshed-today dedupe. If the data file already has a
  //    `generated_at` whose local ET date matches today's local ET date
  //    AND that timestamp's local time is >= 09:30 ET, skip — the first
  //    eligible run already landed. A pre-09:30 same-day timestamp does
  //    NOT block (e.g. a manual midnight refresh shouldn't suppress the
  //    real 09:30 scheduled run).
  if (lastGeneratedAt) {
    const lastDate = new Date(lastGeneratedAt);
    if (!Number.isNaN(lastDate.getTime())) {
      const lastLocal = localFields(lastDate, tz);
      const lastMinutes = lastLocal.hour * 60 + lastLocal.minute;
      if (lastLocal.date === local.date && lastMinutes >= targetMinutes) {
        return {
          run: false,
          reason: `already refreshed ${local.date} at ${pad(lastLocal.hour)}:${pad(lastLocal.minute)} ${tz}`,
          local,
        };
      }
    }
  }

  return {
    run: true,
    reason: `eligible run for ${local.date} (local ${pad(local.hour)}:${pad(local.minute)} ${tz})`,
    local,
  };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// ---- CLI helpers --------------------------------------------------------

/**
 * Read `data/copper-signal.json` (relative to the repo root) and return
 * its `generated_at` string, or null if missing/unreadable. Errors are
 * swallowed: the guard should never fail the workflow on a missing or
 * corrupt data file — it just falls back to "no prior refresh".
 */
export function readLastGeneratedAt(path) {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.generated_at === "string") {
      return parsed.generated_at;
    }
    return null;
  } catch {
    return null;
  }
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
  // Resolve `data/copper-signal.json` relative to the repo root (this
  // file lives in scripts/ so the repo root is one level up).
  const here = dirname(fileURLToPath(import.meta.url));
  const dataPath = process.env.SCHEDULE_GUARD_DATA_FILE
    || resolve(here, "..", "data", "copper-signal.json");
  const lastGeneratedAt = readLastGeneratedAt(dataPath);

  const decision = decide({ tz, lastGeneratedAt });

  console.log(`Schedule guard: ${decision.run ? "RUN" : "SKIP"} — ${decision.reason}`);
  console.log(
    `  local: ${decision.local.date} ${pad(decision.local.hour)}:${pad(decision.local.minute)} (weekday=${decision.local.weekday}, tz=${tz})`,
  );
  console.log(`  data file: ${dataPath}`);
  console.log(`  last generated_at: ${lastGeneratedAt ?? "(none)"}`);
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
