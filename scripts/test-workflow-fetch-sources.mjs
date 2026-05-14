#!/usr/bin/env node
/**
 * Validates the FETCH_SOURCES expression in
 * `.github/workflows/update-copper-data.yml`.
 *
 * Background: on the May 14 scheduled run the workflow log showed
 *   Run updater env FETCH_SOURCES: 0
 * meaning the scheduled refresh was a timestamp-only no-op even though
 * the guard had let the job through. The previous expression was:
 *
 *   FETCH_SOURCES: ${{ github.event.inputs.fetch_sources == 'true'
 *                      && '1' || '0' }}
 *
 * which evaluates to '0' on a `schedule` trigger because schedule
 * events have no `inputs.fetch_sources` -> the equality is false.
 *
 * The fixed expression must satisfy:
 *
 *   schedule                                        -> '1'
 *   workflow_dispatch (no input / default 'true')   -> '1'
 *   workflow_dispatch with fetch_sources='true'     -> '1'
 *   workflow_dispatch with fetch_sources='false'    -> '0'
 *
 * This test parses the YAML, extracts the FETCH_SOURCES expression
 * for the "Run updater" step, evaluates it against each scenario
 * using a minimal interpreter of the GitHub Actions expression
 * subset we use (`==`, `!=`, `&&`, `||`, string and event-name
 * references), and asserts the expected resolved value.
 *
 * Run with:
 *   node scripts/test-workflow-fetch-sources.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const wfPath = path.join(repoRoot, '.github/workflows/update-copper-data.yml');

const yml = fs.readFileSync(wfPath, 'utf8');

// Pull out the FETCH_SOURCES line. We deliberately use a regex rather
// than a YAML parser so the test stays light (no dependencies) and
// also catches whitespace/quote drift in the expression itself.
const m = yml.match(/FETCH_SOURCES:\s*\$\{\{\s*(.+?)\s*\}\}/);
if (!m) {
  console.error('FAIL: could not locate FETCH_SOURCES ${{ ... }} expression in workflow.');
  process.exit(1);
}
const expr = m[1];
console.log(`FETCH_SOURCES expression: ${expr}`);

/**
 * Minimal evaluator for the GitHub Actions expression subset we use.
 * Supports: string literals, `github.event_name`, `github.event.inputs.<name>`,
 * `==`, `!=`, parentheses, `&&`, `||`. Operator precedence: `==`/`!=`
 * tighter than `&&` tighter than `||`. Treats unset inputs as ''
 * (matches Actions' coercion of missing inputs on non-dispatch events).
 */
function evaluate(expression, ctx) {
  let i = 0;
  const s = expression;

  function skip() { while (i < s.length && /\s/.test(s[i])) i++; }

  function parsePrimary() {
    skip();
    if (s[i] === '(') {
      i++;
      const v = parseOr();
      skip();
      if (s[i] !== ')') throw new Error(`expected ) at ${i}`);
      i++;
      return v;
    }
    if (s[i] === "'") {
      i++;
      let out = '';
      while (i < s.length && s[i] !== "'") { out += s[i++]; }
      if (s[i] !== "'") throw new Error('unterminated string');
      i++;
      return out;
    }
    // identifier path like github.event_name or github.event.inputs.fetch_sources
    let id = '';
    while (i < s.length && /[A-Za-z0-9_.]/.test(s[i])) id += s[i++];
    if (!id) throw new Error(`unexpected char '${s[i]}' at ${i}`);
    if (id === 'github.event_name') return ctx.event_name;
    if (id.startsWith('github.event.inputs.')) {
      const key = id.slice('github.event.inputs.'.length);
      // GitHub Actions: missing inputs evaluate to '' (empty string)
      // on non-workflow_dispatch events.
      return (ctx.inputs && key in ctx.inputs) ? ctx.inputs[key] : '';
    }
    if (id === 'true') return true;
    if (id === 'false') return false;
    throw new Error(`unknown identifier: ${id}`);
  }

  function parseEquality() {
    let left = parsePrimary();
    while (true) {
      skip();
      if (s.startsWith('==', i)) {
        i += 2;
        const right = parsePrimary();
        left = (left === right);
      } else if (s.startsWith('!=', i)) {
        i += 2;
        const right = parsePrimary();
        left = (left !== right);
      } else {
        break;
      }
    }
    return left;
  }

  function parseAnd() {
    let left = parseEquality();
    while (true) {
      skip();
      if (s.startsWith('&&', i)) {
        i += 2;
        const right = parseEquality();
        // GitHub Actions `&&` short-circuits and returns the second
        // operand when the first is truthy, otherwise the first.
        left = truthy(left) ? right : left;
      } else {
        break;
      }
    }
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (true) {
      skip();
      if (s.startsWith('||', i)) {
        i += 2;
        const right = parseAnd();
        // `||` returns the first truthy operand, else the last.
        left = truthy(left) ? left : right;
      } else {
        break;
      }
    }
    return left;
  }

  function truthy(v) {
    if (v === true) return true;
    if (v === false) return false;
    if (v === '' || v === 0 || v === null || v === undefined) return false;
    return true;
  }

  const out = parseOr();
  skip();
  if (i !== s.length) throw new Error(`trailing input at ${i}: ${s.slice(i)}`);
  return out;
}

const scenarios = [
  {
    name: 'schedule trigger (no inputs at all)',
    ctx: { event_name: 'schedule', inputs: {} },
    expected: '1',
  },
  {
    name: 'workflow_dispatch with default fetch_sources=true',
    ctx: { event_name: 'workflow_dispatch', inputs: { fetch_sources: 'true' } },
    expected: '1',
  },
  {
    name: 'workflow_dispatch with explicit fetch_sources=false',
    ctx: { event_name: 'workflow_dispatch', inputs: { fetch_sources: 'false' } },
    expected: '0',
  },
  {
    name: 'workflow_dispatch with fetch_sources omitted (Actions injects default)',
    // The dispatch default is "true" (set in the workflow). When a user
    // invokes via the API without providing the input, Actions still
    // injects that default. Modelled here.
    ctx: { event_name: 'workflow_dispatch', inputs: { fetch_sources: 'true' } },
    expected: '1',
  },
];

let failed = 0;
for (const sc of scenarios) {
  let got;
  try {
    // Reset interpreter state per-scenario.
    got = evaluate(expr, sc.ctx);
  } catch (e) {
    console.error(`FAIL [${sc.name}]: evaluation error: ${e.message}`);
    failed++;
    continue;
  }
  const ok = got === sc.expected;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.name}: got=${JSON.stringify(got)} expected=${JSON.stringify(sc.expected)}`);
  if (!ok) failed++;
}

// Sanity: the validation step in the workflow must still be present.
if (!/Refusing to run a timestamp-only refresh on a schedule trigger/.test(yml)) {
  console.error('FAIL: schedule-trigger validation guard missing from workflow.');
  failed++;
} else {
  console.log('ok   schedule-trigger validation guard present in workflow');
}

// Sanity: action SHA pins are intact.
const pinChecks = [
  /actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5/,
  /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/,
];
for (const re of pinChecks) {
  if (!re.test(yml)) {
    console.error(`FAIL: action SHA pin missing: ${re}`);
    failed++;
  } else {
    console.log(`ok   action SHA pin present: ${re}`);
  }
}

// Sanity: schedule guard still wired in.
if (!/scripts\/schedule-guard\.mjs/.test(yml) || !/github\.event_name == 'schedule'/.test(yml)) {
  console.error('FAIL: schedule guard step appears to be missing.');
  failed++;
} else {
  console.log('ok   schedule guard step still wired in');
}

// Sanity: push-race handling block still present (rebase + retry once).
if (!/Rebasing onto origin\/main and retrying push once/.test(yml)) {
  console.error('FAIL: push-race rebase/retry block missing.');
  failed++;
} else {
  console.log('ok   push-race rebase/retry block still present');
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll workflow assertions passed.');
