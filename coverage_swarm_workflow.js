export const meta = {
  name: 'aacc-coverage-swarm',
  description: 'Drive a codebase\'s test coverage and pass rate up to target: measure fresh locally, rank modules by leverage, fan out one focused agent per module (pass-rate first, then a coverage ratchet), gate every new test against Goodhart with an adversarial reviewer AND a mutation check, and emit a ranked plan. Proposes and writes tests; NEVER merges.',
  phases: [
    { title: 'Measure', detail: 'clean LOCAL coverage run — never trust the CI number or a pasted one' },
    { title: 'Rank', detail: 'score modules by uncovered lines x target priority; claim-gate each' },
    { title: 'Cover', detail: 'one agent per module: fix genuine reds, then ratchet coverage' },
    { title: 'Gate', detail: 'adversarial review + mutation check — a test that survives a mutation is vacuous' },
    { title: 'Report', detail: 'synthesise what moved, what is hard, and what is an admin ask' },
  ],
}

// ── constants ──────────────────────────────────────────────────────────────

// Per-module coverage targets by module kind. A module type nobody listed defaults
// to MODULE_DEFAULT_TARGET rather than 90 — an unreachable target makes the swarm
// grind on the wrong thing.
const MODULE_TARGETS = {
  models: 90, api: 85, views: 80, services: 80, commands: 60,
  serializers: 80, tasks: 70, beats: 60,
}
const MODULE_DEFAULT_TARGET = 70

// Start at current + 10, climb. Chasing an absolute number on a genuinely hard
// module burns the budget for no coverage.
const RATCHET_STEP = 10

// Stop after this many rounds with no measurable gain, flag the module and move on.
// Without this the loop grinds forever on the hardest file.
const NO_PROGRESS_ROUNDS = 2

// ── schemas ────────────────────────────────────────────────────────────────

const MEASURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ran_ok: { type: 'boolean', description: 'true ONLY if the coverage run actually produced a report' },
    command: { type: 'string', description: 'the exact command run, so the number is reproducible' },
    exit_code: { type: 'integer' },
    overall_percent: { type: 'number' },
    tests_passed: { type: 'integer' },
    tests_failed: { type: 'integer' },
    tests_skipped: { type: 'integer' },
    genuine_failures: {
      type: 'array',
      description: 'Failures that are REAL, after excluding environment noise (no DB, missing service, network).',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          nodeid: { type: 'string' },
          reason: { type: 'string' },
          is_product_bug: { type: 'boolean', description: 'true if the PRODUCT is broken, not the test' },
        },
        required: ['nodeid', 'reason', 'is_product_bug'],
      },
    },
    environment_failures: {
      type: 'integer',
      description: 'Count of failures judged to be environment-only. Reported, never fixed by writing a test around them.',
    },
    modules: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          kind: { type: 'string', description: 'models|api|views|services|commands|serializers|tasks|beats|other' },
          percent: { type: 'number' },
          lines_total: { type: 'integer' },
          lines_missed: { type: 'integer' },
        },
        required: ['name', 'path', 'kind', 'percent', 'lines_total', 'lines_missed'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['ran_ok', 'command', 'exit_code', 'overall_percent', 'tests_passed', 'tests_failed', 'modules'],
}

const MODULE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    module: { type: 'string' },
    started_percent: { type: 'number' },
    ended_percent: { type: 'number' },
    target_percent: { type: 'number' },
    target_met: { type: 'boolean' },
    stopped_reason: { type: 'string', description: 'target_met | no_progress | blocked | budget' },
    tests_added: { type: 'integer' },
    test_files: { type: 'array', items: { type: 'string' } },
    reds_fixed: {
      type: 'array',
      description: 'Genuinely failing tests repaired. If the PRODUCT was broken, the fix is to the product — never a test asserting the bug.',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          nodeid: { type: 'string' },
          fix: { type: 'string' },
          was_product_bug: { type: 'boolean' },
        },
        required: ['nodeid', 'fix', 'was_product_bug'],
      },
    },
    product_bugs_found: {
      type: 'array',
      description: 'Real defects the new tests exposed. This is where the push pays for itself beyond the number.',
      items: {
        type: 'object', additionalProperties: false,
        properties: { where: { type: 'string' }, what: { type: 'string' }, fixed: { type: 'boolean' } },
        required: ['where', 'what', 'fixed'],
      },
    },
    llm_model_used: { type: 'string', description: 'The model that ACTUALLY produced this work — not the configured provider name.' },
    notes: { type: 'string' },
  },
  required: ['module', 'started_percent', 'ended_percent', 'target_met', 'stopped_reason', 'tests_added', 'llm_model_used'],
}

const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    module: { type: 'string' },
    reviewed: { type: 'integer', description: 'number of new tests examined' },
    meaningful: { type: 'integer', description: 'tests asserting real behaviour (status AND shape/values, computed output, a specific branch)' },
    vacuous: {
      type: 'array',
      description: 'Tests that assert nothing real, or that SURVIVED a mutation of the code they claim to cover. These must be rejected, not kept for the number.',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          test: { type: 'string' },
          why: { type: 'string' },
          survived_mutation: { type: 'boolean' },
        },
        required: ['test', 'why', 'survived_mutation'],
      },
    },
    mutation_check_ran: { type: 'boolean', description: 'false means the gate did NOT actually run — report it, never assume it passed' },
    mutations_attempted: { type: 'integer' },
    mutations_caught: { type: 'integer' },
    verdict: { type: 'string', description: 'pass | pass_with_removals | fail' },
    notes: { type: 'string' },
  },
  required: ['module', 'reviewed', 'meaningful', 'vacuous', 'mutation_check_ran', 'verdict'],
}

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    overall_before: { type: 'number' },
    overall_after: { type: 'number' },
    modules_moved: { type: 'integer' },
    modules_hard: {
      type: 'array',
      description: 'Modules that stopped on no_progress. Naming them is the point — a silent skip reads as "covered everything".',
      items: {
        type: 'object', additionalProperties: false,
        properties: { module: { type: 'string' }, why: { type: 'string' }, suggestion: { type: 'string' } },
        required: ['module', 'why'],
      },
    },
    product_bugs: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { where: { type: 'string' }, what: { type: 'string' }, fixed: { type: 'boolean' }, severity: { type: 'string' } },
        required: ['where', 'what', 'fixed'],
      },
    },
    admin_asks: {
      type: 'array',
      description: 'Things the swarm CANNOT do: infra/permissions, quality-gate settings, merges. Named precisely, never worked around.',
      items: {
        type: 'object', additionalProperties: false,
        properties: { ask: { type: 'string' }, why_blocked: { type: 'string' } },
        required: ['ask', 'why_blocked'],
      },
    },
    vacuous_rejected: { type: 'integer', description: 'Total tests rejected by the quality gate. Zero across a whole run is SUSPICIOUS, not excellent.' },
    next_actions: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', description: 'moved | partial | blocked' },
    report_markdown: {
      type: 'string',
      description:
        'The whole report as human-readable markdown, ready to be written to a file verbatim. ' +
        'Workflow scripts have no filesystem access, so this string is the ONLY way a run leaves ' +
        'a durable artifact — without it the most expensive operation here is also the least ' +
        'traceable. Lead with product bugs if any, then verdict, what moved, hard modules, and ' +
        'admin asks.',
    },
  },
  required: ['summary', 'overall_before', 'overall_after', 'modules_moved', 'modules_hard', 'admin_asks', 'vacuous_rejected', 'verdict', 'report_markdown'],
}

// ── inputs ─────────────────────────────────────────────────────────────────

// Normalize args: the Workflow runtime can hand a JSON-encoded STRING through
// rather than an object. Guard against it — without this, a stringified payload
// makes every field silently default, and a passed repo_path reads as absent.
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { A = {} } }
A = A || {}
const repoPath = (A.repo_path || '').trim()
const testCmd = (A.test_cmd || '').trim()
const explicitTarget = A.target != null ? Number(A.target) : null
const maxModules = A.max_modules != null ? Number(A.max_modules) : 3
const dryRun = A.dry_run !== false && A.dry_run !== 'false' ? !!A.dry_run : false

if (!repoPath) {
  throw new Error(
    'repo_path is required — the swarm runs a real local test suite, so it needs the working copy. ' +
    'Pass the absolute path to your working copy.'
  )
}

// Plain label for the report only — falls back to the repo folder name.
const label = (A.label || repoPath.split('/').filter(Boolean).pop() || 'coverage-swarm').trim()

log(`Coverage swarm: label=${label} repo=${repoPath} modules<=${maxModules}${dryRun ? ' (DRY RUN — no tests written)' : ''}`)

// ── Phase 1: MEASURE (fresh, local, never a pasted number) ─────────────────

phase('Measure')
const measured = await agent(
  `You are establishing the BASELINE for a test-coverage push on "${label}".

Repo: ${repoPath}
${testCmd ? `Suggested test command (with coverage): ${testCmd}` : 'No test command was given — work it out from the repo.'}

Run the project's test suite WITH COVERAGE, locally, right now. Do not read a stored
number, a dashboard, or a previous report — coverage drifts fast under an active
campaign and a day-old hotspot list is routinely wrong. Measure it yourself.

Steps:
1. Work out how this repo runs tests (pytest.ini / pyproject / package.json / CI
   config). Prefer the command CI uses, plus coverage flags. If a command was given
   above, prefer it.
2. Run it with a machine-readable coverage report and coverage gating disabled (you
   are measuring, not gating). Do NOT modify any source or test file in this phase.
3. Read the RAW per-module numbers out of the coverage report — not a
   quality-gate's filtered number.
4. Triage failures into GENUINE vs ENVIRONMENT. Environment failures are things like:
   no database, a missing service, a live network call, an unseeded throwaway DB. They
   are NOT this swarm's work and must never be "fixed" by writing a test around them.
   Where a failure means the PRODUCT is broken, mark is_product_bug — that gets fixed
   properly later, never papered over with a test that asserts the bug.
5. Classify each module by kind (models/api/views/services/commands/serializers/
   tasks/beats/other) from its path.

If the suite cannot run at all, set ran_ok=false and explain — an unmeasurable suite
is a REPORTED FAILURE, never a zero. Recording absence as 0% defeats the whole point.`,
  { schema: MEASURE_SCHEMA, label: 'measure:baseline' }
)

if (!measured || !measured.ran_ok) {
  log(`Baseline FAILED — cannot measure ${label}. Refusing to invent a number.`)
  return {
    verdict: 'blocked',
    summary: `Could not establish a local coverage baseline for ${label}. ` +
             `An unmeasurable suite is a reported failure, not 0%.`,
    measure: measured || null,
    admin_asks: [{ ask: `Make the test suite runnable locally for ${label}`, why_blocked: measured?.notes || 'no report produced' }],
  }
}

log(`Baseline: ${measured.overall_percent}% overall, ${measured.tests_passed}P/${measured.tests_failed}F/${measured.tests_skipped || 0}S across ${measured.modules.length} modules`)
if (measured.tests_skipped) {
  log(`NOTE ${measured.tests_skipped} skipped — pass rate EXCLUDES these, so a high pass rate can hide them.`)
}

// ── Phase 2: RANK ──────────────────────────────────────────────────────────

phase('Rank')

const targetFor = (m) => explicitTarget ?? (MODULE_TARGETS[m.kind] ?? MODULE_DEFAULT_TARGET)

// Leverage = uncovered lines still needed to reach target. Ranking by percentage
// alone sends the swarm at a 30-line file while a 2,000-line service sits at 10%.
const ranked = measured.modules
  .map((m) => {
    const target = targetFor(m)
    const gap = Math.max(target - m.percent, 0)
    const linesToTarget = Math.round((gap / 100) * m.lines_total)
    return { ...m, target, gap, leverage: linesToTarget }
  })
  .filter((m) => m.gap > 0 && m.lines_total >= 20)   // sub-20-line modules are noise
  .sort((a, b) => b.leverage - a.leverage)

const claimed = ranked.slice(0, maxModules)

// Claim gate. Concurrent runs must not both take the same module — that is wasted
// work AND a merge collision. The claim is the module list this run owns; it is
// echoed in the report so a parallel run can avoid it.
log(`Ranked ${ranked.length} modules below target; claiming top ${claimed.length}:`)
for (const m of claimed) {
  log(`  ${m.name} (${m.kind}) ${m.percent}% -> ${m.target}%  ~${m.leverage} lines`)
}
if (ranked.length > claimed.length) {
  log(`NOT claimed this run: ${ranked.length - claimed.length} more modules remain below target.`)
}

if (dryRun) {
  return {
    verdict: 'partial',
    summary: `DRY RUN — measured ${measured.overall_percent}% and ranked ${ranked.length} modules. No tests written.`,
    overall_before: measured.overall_percent,
    overall_after: measured.overall_percent,
    modules_moved: 0,
    modules_hard: [],
    admin_asks: [],
    vacuous_rejected: 0,
    claimed: claimed.map((m) => m.name),
    ranked: ranked.slice(0, 20),
    report_markdown: [
      `# Coverage swarm — DRY RUN — ${label}`,
      '',
      `Baseline (measured locally, not read from a dashboard): **${measured.overall_percent}%**`,
      `Command: \`${measured.command}\``,
      `Tests: ${measured.tests_passed}P / ${measured.tests_failed}F / ${measured.tests_skipped || 0}S`,
      '',
      `${ranked.length} modules below target. Would claim ${claimed.length}:`,
      '',
      '| module | now | target | uncovered-to-target |',
      '|---|---|---|---|',
      ...claimed.map((m) => `| \`${m.name}\` | ${m.percent}% | ${m.target}% | ${m.leverage} |`),
      '',
      'No tests were written.',
    ].join('\n'),
  }
}

// ── Phase 3+4: COVER then GATE, pipelined per module ───────────────────────
// pipeline(), not parallel() + barrier: a module's quality gate should start the
// moment THAT module's tests are written, not after the slowest module finishes.

// Ratchet, not target: ask for current + RATCHET_STEP this round, capped at the
// module target. Demanding the full jump in one pass is how a hard module eats the
// whole budget and moves nothing.
const roundTarget = (m) => Math.min(Math.round(m.percent + RATCHET_STEP), m.target)

const coverPrompt = (m) => `Raise test coverage for module "${m.name}" in ${repoPath}.

Current: ${m.percent}%   Target this round: ${roundTarget(m)}%   Module target: ${m.target}%

ORDER OF WORK — pass rate first, then coverage:

1. PASS RATE. If this module has genuinely failing tests, fix them first. A coverage
   number measured over a failing suite is a lie. If the failure means the PRODUCT is
   broken, FIX THE PRODUCT and make the test assert the corrected behaviour. NEVER
   write a test that codifies the bug (no \`assert response.status_code == 500\`) —
   that cements the defect and hands back a false green.

2. COVERAGE. Run the module's tests with a term-missing coverage report; it names the
   exact uncovered lines. Go after real behaviour: error paths, filters, pagination
   edges, exception handlers, branch conditions.

MATCH THE EXISTING HARNESS. Read the neighbouring tests first and copy their style —
mocked-DB vs real-DB, dependency-injection override vs model-object mock. Do not
invent a new pattern.

WHERE TESTS GO: put new tests where THIS project's test runner actually collects them.
A test the runner never executes is decoration from birth. If you are unsure of the
layout, confirm it from the repo's test config before writing — do not assume a
directory.

EVERY TEST ASSERTS BEHAVIOUR, never "it ran". An assertion-free test that lifts the
number and catches nothing will be found by the quality gate and thrown away, and
your work with it.

STOP when the round target is met, or after ${NO_PROGRESS_ROUNDS} consecutive rounds with
no measurable gain — then say so via stopped_reason=no_progress and describe what
makes this module hard. Grinding is not a virtue.

Report llm_model_used with the model that ACTUALLY did this work.`

const gatePrompt = (m, cover) => `Adversarially review the tests just written for "${m.name}" in ${repoPath}.

Tests added: ${cover?.tests_added ?? 0}
Files: ${(cover?.test_files || []).join(', ') || '(none reported)'}

Coverage is a Goodhart magnet. An unguarded loop writes assertion-free tests that
lift the number and catch nothing. Your job is to find those and reject them. Two
checks, BOTH required:

1. ADVERSARIAL REVIEW. For each new test: would it catch a real regression? Are the
   assertions on real behaviour — status AND shape/values, a computed output, a
   specific branch — or is it a bare call with no assertion, or an assertion on a
   mock's own return value?

2. MUTATION CHECK — this is the one that cannot be skipped. For each new test, go
   and PERTURB the source it claims to cover (invert a condition, change a returned
   value, drop a filter). Re-run that test. It MUST fail. If it still passes, the
   test is vacuous: record it with survived_mutation=true. RESTORE the source
   afterwards, every time, and verify the restore.

If you could not actually run the mutation check, set mutation_check_ran=false and
say why. Never report a gate as passed that you did not run — a quality gate nobody
executed is exactly the failure this whole approach exists to prevent.

Finding ZERO vacuous tests across a whole module is possible but suspicious. Say so
in notes if that is your result, and describe what you did to try to break them.`

const perModule = await pipeline(
  claimed,
  (m) => agent(coverPrompt(m), { schema: MODULE_RESULT_SCHEMA, label: `cover:${m.name}`, phase: 'Cover', isolation: 'worktree' })
    .then((cover) => ({ m, cover })),
  ({ m, cover }) => agent(gatePrompt(m, cover), { schema: GATE_SCHEMA, label: `gate:${m.name}`, phase: 'Gate' })
    .then((gate) => ({ module: m, cover, gate })),
)

const results = perModule.filter(Boolean)

// ── Phase 5: REPORT ────────────────────────────────────────────────────────

phase('Report')

const gateFailures = results.filter((r) => r.gate && r.gate.mutation_check_ran === false)
if (gateFailures.length) {
  log(`WARNING ${gateFailures.length} module(s) reported the mutation check DID NOT RUN — their coverage gain is unverified.`)
}
const totalVacuous = results.reduce((n, r) => n + ((r.gate?.vacuous || []).length), 0)
log(`Quality gate rejected ${totalVacuous} vacuous test(s) across ${results.length} module(s).`)

const report = await agent(
  `Synthesise the result of a coverage swarm on "${label}".

BASELINE (measured locally at the start of this run):
${JSON.stringify({
    overall: measured.overall_percent,
    passed: measured.tests_passed,
    failed: measured.tests_failed,
    skipped: measured.tests_skipped,
    genuine_failures: measured.genuine_failures,
    environment_failures: measured.environment_failures,
  }, null, 2)}

PER-MODULE (cover result + quality-gate verdict):
${JSON.stringify(results.map((r) => ({ module: r.module.name, target: r.module.target, cover: r.cover, gate: r.gate })), null, 2)}

Write the report an operator will act on. Be strict about these:

- overall_after must be a MEASURED number if one was taken, not a sum of per-module
  claims. Per-file percentages do not add up to an overall percentage. If nobody
  re-measured the whole suite, say the overall is unverified rather than inventing it.
- List every module that stopped on no_progress under modules_hard. A silent skip
  reads as "covered everything" — name what was left.
- Any module whose gate reported mutation_check_ran=false has an UNVERIFIED gain.
  Say so explicitly; do not fold it into the success count.
- vacuous_rejected of 0 across a whole run is suspicious, not excellent. Flag it.
- Product bugs the tests exposed are the most valuable output here — this is where
  the push pays for itself beyond the number. Lead with them if there are any.
- admin_asks: anything the swarm cannot do (infra/permissions, quality-gate settings,
  merges needing approval). Name each precisely. Do not describe a workaround for a
  small one-time ask.
- The swarm PROPOSES. It does not merge. Next actions should be phrased for a human.

Also produce report_markdown: the entire report as human-readable markdown, ready
to be written to a file verbatim. A workflow script cannot touch the filesystem, so
this string is the only durable record a run leaves behind. Include the baseline
command so the number is reproducible, and name every module that was claimed —
including the ones that did not move.`,
  { schema: REPORT_SCHEMA, label: 'report:synthesis' }
)

return {
  ...(report || {}),
  label,
  claimed_modules: claimed.map((m) => m.name),
  unclaimed_below_target: Math.max(ranked.length - claimed.length, 0),
  baseline: {
    overall_percent: measured.overall_percent,
    command: measured.command,
    tests_passed: measured.tests_passed,
    tests_failed: measured.tests_failed,
    tests_skipped: measured.tests_skipped,
    environment_failures: measured.environment_failures,
  },
  modules: results.map((r) => ({ module: r.module.name, cover: r.cover, gate: r.gate })),
  gate_not_run: gateFailures.map((r) => r.module.name),
}
