export const meta = {
  name: 'aacc-coverage-swarm',
  description: 'Drive a codebase\'s test coverage and pass rate up: measure a fresh local baseline, rank modules by leverage, run one agent per module in its own git worktree (pass rate first, then a coverage ratchet, stopping after 2 no-progress rounds), gate every new test with an adversarial reviewer AND a mutation check, and report. Writes tests on local branches; NEVER merges or opens a PR.',
  phases: [
    { title: 'Measure', detail: 'clean LOCAL coverage run; never a stored, CI or pasted number' },
    { title: 'Rank', detail: 'score modules by uncovered lines to target; take the top N' },
    { title: 'Cover', detail: 'one worktree per module: fix genuine reds, then ratchet coverage round by round' },
    { title: 'Gate', detail: 'adversarial review + mutation check; vacuous tests are deleted; coverage re-measured' },
    { title: 'Report', detail: 'what moved (verified), what is hard, what is an admin ask' },
  ],
}

// ── constants ──────────────────────────────────────────────────────────────

// Per-module coverage targets by module kind. The kinds are Django-flavoured; any
// kind not listed (every module of a JS or plain Python library, say) gets
// MODULE_DEFAULT_TARGET, and the `target` arg overrides them all. An unreachable
// target makes the swarm grind on the wrong thing, so the default is 70, not 90.
const MODULE_TARGETS = {
  models: 90, api: 85, views: 80, services: 80, commands: 60,
  serializers: 80, tasks: 70,
}
const MODULE_DEFAULT_TARGET = 70

// Each round asks for current + RATCHET_STEP, capped at the module target.
const RATCHET_STEP = 10

// The script stops a module after this many consecutive rounds with no measured
// gain, and names it as hard. Without this the loop grinds forever on one file.
const NO_PROGRESS_ROUNDS = 2

// Hard ceiling on rounds per module, whatever the progress.
const DEFAULT_MAX_ROUNDS = 3

// Modules smaller than this are skipped as noise (and the skip is logged).
const MIN_MODULE_LINES = 20

// ── schemas ────────────────────────────────────────────────────────────────

const MEASURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ran_ok: { type: 'boolean', description: 'true ONLY if the coverage run actually produced a report' },
    command: { type: 'string', description: 'the exact command run, so the number is reproducible' },
    exit_code: { type: 'integer' },
    head_sha: { type: 'string', description: 'output of `git -C <repo> rev-parse HEAD`; empty if the repo is not a git repository' },
    working_tree_dirty: { type: 'boolean', description: 'true if `git status --porcelain` printed anything' },
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
          path: { type: 'string', description: 'path relative to the repo root' },
          kind: { type: 'string', description: 'models|api|views|services|commands|serializers|tasks|other' },
          percent: { type: 'number' },
          lines_total: { type: 'integer', description: 'statements the coverage tool counts for this file' },
          lines_missed: { type: 'integer' },
        },
        required: ['name', 'path', 'kind', 'percent', 'lines_total', 'lines_missed'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['ran_ok', 'command', 'exit_code', 'head_sha', 'overall_percent', 'tests_passed', 'tests_failed', 'modules'],
}

const ROUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    module: { type: 'string' },
    worktree_path: { type: 'string', description: 'the absolute worktree path you worked in' },
    started_percent: { type: 'number', description: 'module coverage you measured at the start of this round' },
    ended_percent: { type: 'number', description: 'module coverage you MEASURED at the end of this round, from a real coverage run' },
    stopped_reason: { type: 'string', enum: ['round_target_met', 'no_gain', 'blocked'] },
    tests_added: { type: 'integer' },
    test_files: { type: 'array', items: { type: 'string' } },
    committed: { type: 'boolean', description: 'true if this round\'s work is committed on the module branch' },
    reds_fixed: {
      type: 'array',
      description: 'Genuinely failing tests repaired. If the PRODUCT was broken, the fix is to the product, never a test asserting the bug.',
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
    llm_model_used: { type: 'string', description: 'The model that did this work, as you know it. A self-report.' },
    notes: { type: 'string' },
  },
  required: ['module', 'worktree_path', 'started_percent', 'ended_percent', 'stopped_reason', 'tests_added', 'committed', 'llm_model_used'],
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
      description: 'Tests that assert nothing real, or that SURVIVED a mutation of the code they claim to cover. Each one listed here must be DELETED from the worktree.',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          test: { type: 'string' },
          why: { type: 'string' },
          survived_mutation: { type: 'boolean' },
          removed: { type: 'boolean', description: 'true once the test is deleted from the worktree and the deletion committed' },
        },
        required: ['test', 'why', 'survived_mutation', 'removed'],
      },
    },
    mutation_check_ran: { type: 'boolean', description: 'false means the gate did NOT actually run; report it, never assume it passed' },
    mutations_attempted: { type: 'integer' },
    mutations_caught: { type: 'integer' },
    source_restored: { type: 'boolean', description: 'true if `git status` shows no leftover mutation in the source after the check' },
    measured_percent: { type: 'number', description: 'module coverage you re-measured in the worktree AFTER removing vacuous tests' },
    verdict: { type: 'string', enum: ['pass', 'pass_with_removals', 'fail'] },
    notes: { type: 'string' },
  },
  required: ['module', 'reviewed', 'meaningful', 'vacuous', 'mutation_check_ran', 'mutations_attempted', 'mutations_caught', 'source_restored', 'measured_percent', 'verdict'],
}

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    admin_asks: {
      type: 'array',
      description: 'Things the swarm CANNOT do: infra/permissions, quality-gate settings, merges. Named precisely, never worked around.',
      items: {
        type: 'object', additionalProperties: false,
        properties: { ask: { type: 'string' }, why_blocked: { type: 'string' } },
        required: ['ask', 'why_blocked'],
      },
    },
    next_actions: { type: 'array', items: { type: 'string' } },
    report_markdown: {
      type: 'string',
      description:
        'The whole report as human-readable markdown, ready to be written to a file verbatim. ' +
        'Workflow scripts have no filesystem access, so this string is how a run leaves a durable artifact.',
    },
  },
  required: ['summary', 'admin_asks', 'next_actions', 'report_markdown'],
}

// ── inputs ─────────────────────────────────────────────────────────────────

// The Workflow runtime can hand a JSON-encoded STRING through rather than an object.
// Without this guard every field silently defaults and a passed repo_path reads as absent.
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { A = {} } }
A = A || {}

const repoPath = String(A.repo_path || '').trim().replace(/\/+$/, '')
const testCmd = String(A.test_cmd || '').trim()

if (!repoPath) {
  throw new Error('repo_path is required: the swarm runs a real local test suite, so it needs the absolute path to your working copy.')
}
if (!repoPath.startsWith('/')) {
  throw new Error(`repo_path must be absolute, got "${repoPath}". Agents run in their own directories, so a relative path points somewhere else.`)
}

// A typo here must fail loudly. Number('three') is NaN, and slice(0, NaN) claims
// nothing, which used to produce a confident report over zero modules.
const intArg = (name, dflt, min, max) => {
  if (A[name] == null || A[name] === '') return dflt
  const n = Number(A[name])
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got ${JSON.stringify(A[name])}`)
  }
  return n
}
const maxModules = intArg('max_modules', 3, 1, 50)
const maxRounds = intArg('max_rounds', DEFAULT_MAX_ROUNDS, 1, 10)
let explicitTarget = null
if (A.target != null && A.target !== '') {
  explicitTarget = Number(A.target)
  if (!Number.isFinite(explicitTarget) || explicitTarget <= 0 || explicitTarget > 100) {
    throw new Error(`target must be a number in (0, 100], got ${JSON.stringify(A.target)}`)
  }
}
const dryRun = A.dry_run === true || A.dry_run === 'true'

const repoBase = repoPath.split('/').pop()
const parentDir = repoPath.slice(0, repoPath.length - repoBase.length - 1)
// Worktrees live NEXT TO the repo, never inside it: a test runner that recurses the
// repo would otherwise collect every module's worktree as part of the suite.
const worktreeRoot = String(A.worktree_root || `${parentDir}/${repoBase}.coverage-swarm`).trim().replace(/\/+$/, '')
const label = String(A.label || repoBase || 'coverage-swarm').trim()

log(`Coverage swarm: label=${label} repo=${repoPath} modules<=${maxModules} rounds<=${maxRounds}${dryRun ? ' (DRY RUN, no tests written)' : ''}`)

// ── Phase 1: MEASURE (fresh, local, never a pasted number) ─────────────────

phase('Measure')
const measured = await agent(
  `You are establishing the BASELINE for a test-coverage push on "${label}".

Repo: ${repoPath}
${testCmd ? `Test command (with coverage): ${testCmd}` : 'No test command was given. Work it out from the repo.'}

Run the project's test suite WITH COVERAGE, locally, right now. Do not read a stored
number, a dashboard, or a previous report. Measure it yourself.

Steps:
1. Record \`git -C ${repoPath} rev-parse HEAD\` as head_sha (empty string if this is not
   a git repository) and whether \`git -C ${repoPath} status --porcelain\` prints anything.
2. Work out how this repo runs tests (pytest.ini / pyproject / package.json / CI
   config). If a command was given above, use it.
3. Run it with a machine-readable coverage report and coverage gating disabled (you
   are measuring, not gating). Do NOT modify any source or test file in this phase.
4. Read the RAW per-file numbers out of the coverage report. Report only source
   modules, not test files.
5. Triage failures into GENUINE vs ENVIRONMENT. Environment failures are things like:
   no database, a missing service, a live network call. They must never be "fixed" by
   writing a test around them. Where a failure means the PRODUCT is broken, mark
   is_product_bug.
6. Classify each module by kind (models/api/views/services/commands/serializers/
   tasks/other) from its path.

If the suite cannot run at all, set ran_ok=false and explain. An unmeasurable suite
is a REPORTED FAILURE, never a zero.`,
  { schema: MEASURE_SCHEMA, label: 'measure:baseline', phase: 'Measure' }
)

const blocked = (why, ask) => {
  log(`Baseline FAILED for ${label}: ${why}. Refusing to invent a number.`)
  return {
    verdict: 'blocked',
    label,
    summary: `Could not establish a usable local coverage baseline for ${label}: ${why}. An unmeasurable suite is a reported failure, not 0%.`,
    measure: measured || null,
    admin_asks: [{ ask, why_blocked: why }],
    report_markdown: `# Coverage swarm: ${label}\n\n**Verdict: blocked.** ${why}.\n\nNothing was written.\n`,
  }
}

if (!measured) return blocked('the measure agent returned nothing', `Re-run the swarm on ${label}`)
if (!measured.ran_ok) return blocked(measured.notes || 'the suite did not produce a coverage report', `Make the test suite runnable locally for ${label}`)
if (!Number.isFinite(measured.overall_percent)) return blocked('the coverage report had no overall percentage', `Check the coverage command for ${label}`)
if (!Array.isArray(measured.modules) || measured.modules.length === 0) {
  return blocked('the coverage report listed zero source modules', `Point the coverage command at the source package for ${label}`)
}
const headSha = String(measured.head_sha || '').trim()
if (!dryRun && !/^[0-9a-f]{7,40}$/.test(headSha)) {
  return blocked('repo_path is not a git repository (no HEAD sha); the swarm writes tests into per-module git worktrees', `Run the swarm on a git working copy of ${label}`)
}

log(`Baseline: ${measured.overall_percent}% overall, ${measured.tests_passed}P/${measured.tests_failed}F/${measured.tests_skipped || 0}S across ${measured.modules.length} modules at ${headSha || '(no sha)'}`)
if (measured.tests_skipped) log(`NOTE ${measured.tests_skipped} skipped. Pass rate EXCLUDES these, so a high pass rate can hide them.`)
if (measured.working_tree_dirty) log('NOTE the working copy has uncommitted changes. Worktrees start from HEAD, so the module agents will NOT see them.')

// ── Phase 2: RANK ──────────────────────────────────────────────────────────

phase('Rank')

const targetFor = (m) => explicitTarget ?? (MODULE_TARGETS[m.kind] ?? MODULE_DEFAULT_TARGET)

// Leverage = uncovered lines still needed to reach target. Ranking by percentage
// alone sends the swarm at a 30-line file while a 2,000-line service sits at 10%.
const scored = measured.modules.map((m) => {
  const target = targetFor(m)
  const gap = Math.max(target - m.percent, 0)
  return { ...m, target, gap, leverage: Math.round((gap / 100) * m.lines_total) }
})
const tooSmall = scored.filter((m) => m.gap > 0 && m.lines_total < MIN_MODULE_LINES)
const ranked = scored
  .filter((m) => m.gap > 0 && m.lines_total >= MIN_MODULE_LINES)
  .sort((a, b) => b.leverage - a.leverage)

// Unique, filesystem-safe slug per module: it names the worktree and the branch.
const usedSlugs = new Set()
const slugFor = (m) => {
  const base = (m.path || m.name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'module'
  let s = base, i = 2
  while (usedSlugs.has(s)) s = `${base}-${i++}`
  usedSlugs.add(s)
  return s
}
const claimed = ranked.slice(0, maxModules).map((m) => {
  const slug = slugFor(m)
  return { ...m, slug, worktree: `${worktreeRoot}/${slug}`, branch: `coverage-swarm/${slug}` }
})

// There is no lock: the claimed list is echoed in the report so a parallel run can avoid it.
log(`Ranked ${ranked.length} modules below target; taking the top ${claimed.length}:`)
for (const m of claimed) log(`  ${m.name} (${m.kind}) ${m.percent}% -> ${m.target}%  ~${m.leverage} lines`)
if (ranked.length > claimed.length) log(`NOT taken this run: ${ranked.length - claimed.length} more modules below target.`)
if (tooSmall.length) log(`Skipped as too small (<${MIN_MODULE_LINES} statements): ${tooSmall.map((m) => m.name).join(', ')}`)

const baseline = {
  overall_percent: measured.overall_percent,
  command: measured.command,
  head_sha: headSha,
  tests_passed: measured.tests_passed,
  tests_failed: measured.tests_failed,
  tests_skipped: measured.tests_skipped || 0,
  environment_failures: measured.environment_failures || 0,
}

const rankTable = (rows) => [
  '| module | now | target | uncovered lines to target |',
  '|---|---|---|---|',
  ...rows.map((m) => `| \`${m.name}\` | ${m.percent}% | ${m.target}% | ${m.leverage} |`),
]

if (claimed.length === 0) {
  log('Nothing to do: no module is below target. No agents spawned past the baseline.')
  return {
    verdict: 'nothing_to_do',
    label,
    summary: `Measured ${measured.overall_percent}%. No module of ${MIN_MODULE_LINES}+ statements is below its target, so nothing was claimed.`,
    baseline,
    claimed_modules: [],
    skipped_too_small: tooSmall.map((m) => m.name),
    report_markdown: [
      `# Coverage swarm: ${label}`, '',
      `**Verdict: nothing to do.** Baseline (measured locally): **${measured.overall_percent}%** with \`${measured.command}\`.`,
      `No module of ${MIN_MODULE_LINES}+ statements is below its target. Nothing was written.`,
    ].join('\n'),
  }
}

if (dryRun) {
  return {
    verdict: 'dry_run',
    label,
    summary: `DRY RUN: measured ${measured.overall_percent}% and ranked ${ranked.length} modules below target. No tests written.`,
    baseline,
    claimed_modules: claimed.map((m) => m.name),
    ranked: ranked.slice(0, 20).map((m) => ({ name: m.name, path: m.path, percent: m.percent, target: m.target, leverage: m.leverage })),
    report_markdown: [
      `# Coverage swarm: DRY RUN: ${label}`, '',
      `Baseline (measured locally, not read from a dashboard): **${measured.overall_percent}%**`,
      `Command: \`${measured.command}\``,
      `Tests: ${measured.tests_passed}P / ${measured.tests_failed}F / ${measured.tests_skipped || 0}S`, '',
      `${ranked.length} modules below target. Would take ${claimed.length}:`, '',
      ...rankTable(claimed), '',
      'No tests were written.',
    ].join('\n'),
  }
}

// ── Phase 3+4: COVER (rounds) then GATE, pipelined per module ──────────────
// Each module gets a deterministic worktree OUTSIDE the repo, created from the
// measured HEAD. The runtime's own isolation:'worktree' is not used: it isolates the
// session's checkout, not repo_path, and its path is not known to the gate agent
// that has to review the tests afterwards.

const roundTarget = (current, m) => Math.min(Math.round(current + RATCHET_STEP), m.target)

const genuine = (measured.genuine_failures || [])

const coverPrompt = (m, round, current) => `Raise test coverage for module "${m.name}" (${m.path}).

Repo: ${repoPath}  (measured at ${headSha})
Your worktree: ${m.worktree}  on branch ${m.branch}
Round ${round} of at most ${maxRounds}.  Current: ${current}%   Target this round: ${roundTarget(current, m)}%   Module target: ${m.target}%
${testCmd ? `Test command (with coverage): ${testCmd}` : ''}

WORKTREE. Work ONLY inside ${m.worktree}. Never edit files under ${repoPath} itself.
${round === 1
    ? `This is round 1: create it with
  git -C ${repoPath} worktree add -b ${m.branch} ${m.worktree} ${headSha}
If that path or branch already exists, a previous run's tests live there: do NOT
overwrite or delete them. Stop and report stopped_reason=blocked with the reason.`
    : `It already exists from round ${round - 1}, with that round's work committed. Continue there.`}

ORDER OF WORK: pass rate first, then coverage.

1. PASS RATE. Genuine failures from the baseline: ${genuine.length ? JSON.stringify(genuine) : 'none'}.
   If any belong to this module, fix them first. If the failure means the PRODUCT is
   broken, FIX THE PRODUCT and make the test assert the corrected behaviour. NEVER
   write a test that codifies the bug (no \`assert response.status_code == 500\`).

2. COVERAGE. Run this module's tests with a term-missing coverage report inside the
   worktree; it names the exact uncovered lines. Go after real behaviour: error
   paths, filters, edge values, exception handlers, branch conditions.

MATCH THE EXISTING HARNESS. Read the neighbouring tests first and copy their style.
Put new tests where THIS project's test runner actually collects them; confirm the
layout from the test config. A test the runner never executes is decoration.

EVERY TEST ASSERTS BEHAVIOUR, never "it ran". A separate gate will mutate the source
and delete every test that still passes.

Stop when the round target is met (stopped_reason=round_target_met), or when you
cannot raise coverage this round (stopped_reason=no_gain, and say in notes what makes
this module hard). Report ended_percent from a REAL coverage run in the worktree,
never an estimate. Commit your work on ${m.branch} (a local commit only: never push,
never open a PR, never merge).`

const gatePrompt = (m, rounds) => {
  const files = [...new Set(rounds.flatMap((r) => r.test_files || []))]
  return `Adversarially review the tests written for module "${m.name}" (${m.path}).

Worktree: ${m.worktree}  (branch ${m.branch}, created from ${headSha})
The new tests are exactly the diff: git -C ${m.worktree} diff ${headSha}..HEAD
Files reported by the cover agent: ${files.join(', ') || '(none reported)'}
${testCmd ? `Test command (with coverage): ${testCmd}` : ''}

Work ONLY in that worktree. Coverage is a Goodhart magnet: an unguarded loop writes
assertion-free tests that lift the number and catch nothing. Find them and remove
them. Both checks are required:

1. ADVERSARIAL REVIEW. For each new test: would it catch a real regression? Are the
   assertions on real behaviour (values, shape, a computed output, a specific branch)
   or is it a bare call, or an assertion on a mock's own return value?

2. MUTATION CHECK. This one cannot be skipped. For each new test, PERTURB the source
   line it claims to cover (invert a condition, change a returned value, drop a
   filter, change a constant). Re-run that test. It MUST fail. If it still passes, it
   is vacuous: record survived_mutation=true. RESTORE the source every time
   (\`git -C ${m.worktree} checkout -- <file>\`) and confirm with git status.

3. REMOVE every vacuous test from the worktree, re-run the module's tests to confirm
   they pass, and commit the removal on ${m.branch}. Set removed=true for each.

4. RE-MEASURE this module's coverage in the worktree after the removals and report it
   as measured_percent. That is the number the report trusts.

If you could not actually run the mutation check, set mutation_check_ran=false and
say why. Never report a gate you did not run as passed. Finding ZERO vacuous tests is
possible but suspicious: say so in notes and describe what you did to break them.`
}

const runModule = async (m) => {
  const rounds = []
  let current = m.percent
  let noProgress = 0
  let stop = null
  for (let r = 1; r <= maxRounds; r++) {
    const res = await agent(coverPrompt(m, r, current), { schema: ROUND_SCHEMA, label: `cover:${m.name}:r${r}`, phase: 'Cover' })
    if (!res) { stop = 'agent_failed'; log(`${m.name}: cover agent for round ${r} returned nothing.`); break }
    rounds.push({ round: r, ...res })
    if (res.stopped_reason === 'blocked') { stop = 'blocked'; break }
    const ended = Number(res.ended_percent)
    if (Number.isFinite(ended) && ended > current) { current = ended; noProgress = 0 } else { noProgress++ }
    log(`${m.name}: round ${r} ${res.started_percent}% -> ${res.ended_percent}% (+${res.tests_added} tests)${noProgress ? `, no gain x${noProgress}` : ''}`)
    if (current >= m.target) { stop = 'target_met'; break }
    if (noProgress > NO_PROGRESS_ROUNDS) { stop = 'no_progress'; break }
  }
  if (!stop) stop = 'max_rounds'
  const testsAdded = rounds.reduce((n, r) => n + (r.tests_added || 0), 0)
  // Nothing written means nothing to gate. A failed round-1 agent never made the worktree.
  const gate = testsAdded > 0
    ? await agent(gatePrompt(m, rounds), { schema: GATE_SCHEMA, label: `gate:${m.name}`, phase: 'Gate' })
    : null
  return { module: m, rounds, stop, tests_added: testsAdded, gate, gate_spawned: testsAdded > 0 }
}

const perModule = await pipeline(claimed, runModule)

// ── Phase 5: REPORT ────────────────────────────────────────────────────────
// Every count and verdict below is computed HERE from what the agents returned, not
// taken from the synthesis agent, so a cheerful summary cannot overwrite a failure.

phase('Report')

const outcomes = claimed.map((m, i) => {
  const r = perModule[i]
  if (!r) return { module: m.name, status: 'failed', why: 'module chain threw', worktree: m.worktree, branch: m.branch }
  const g = r.gate
  const vacuous = g ? (g.vacuous || []) : []
  const gateVerified = !!g && g.mutation_check_ran === true && g.source_restored === true &&
    (g.reviewed === 0 || (g.mutations_attempted || 0) >= 1) && Number.isFinite(g.measured_percent)
  let status
  if (r.rounds.length === 0) status = 'failed'
  else if (r.tests_added === 0) status = r.stop === 'blocked' ? 'blocked' : 'no_tests'
  else if (!g) status = 'unverified'
  else if (!gateVerified) status = 'unverified'
  else if (g.measured_percent > m.percent) status = 'moved'
  else status = 'no_gain'
  return {
    module: m.name,
    path: m.path,
    status,
    stop: r.stop,
    started_percent: m.percent,
    claimed_percent: r.rounds.length ? r.rounds[r.rounds.length - 1].ended_percent : m.percent,
    verified_percent: gateVerified ? g.measured_percent : null,
    target: m.target,
    rounds: r.rounds.length,
    tests_added: r.tests_added,
    vacuous_rejected: vacuous.length,
    vacuous_not_removed: vacuous.filter((v) => !v.removed).map((v) => v.test),
    mutations_attempted: g ? g.mutations_attempted : 0,
    mutations_caught: g ? g.mutations_caught : 0,
    gate_ran: gateVerified,
    worktree: m.worktree,
    branch: m.branch,
    product_bugs: r.rounds.flatMap((x) => x.product_bugs_found || []),
    reds_fixed: r.rounds.flatMap((x) => x.reds_fixed || []),
    models: [...new Set(r.rounds.map((x) => x.llm_model_used).filter(Boolean))],
  }
})

const moved = outcomes.filter((o) => o.status === 'moved')
const failed = outcomes.filter((o) => o.status === 'failed')
const unverified = outcomes.filter((o) => o.status === 'unverified')
const hard = outcomes.filter((o) => o.stop === 'no_progress')
const vacuousTotal = outcomes.reduce((n, o) => n + o.vacuous_rejected, 0)
const gated = outcomes.filter((o) => o.gate_ran)
const zeroVacuousSuspicious = gated.length > 0 && vacuousTotal === 0
const productBugs = outcomes.flatMap((o) => o.product_bugs.map((b) => ({ ...b, module: o.module })))
const verdict = moved.length === 0 ? 'no_verified_gain' : (moved.length === outcomes.length ? 'moved' : 'partial')

if (failed.length) log(`WARNING ${failed.length} module(s) FAILED (agent died): ${failed.map((o) => o.module).join(', ')}. Not counted as moved.`)
if (unverified.length) log(`WARNING ${unverified.length} module(s) have UNVERIFIED gains (gate missing or did not run): ${unverified.map((o) => o.module).join(', ')}`)
log(`Quality gate rejected ${vacuousTotal} vacuous test(s) across ${gated.length} gated module(s).${zeroVacuousSuspicious ? ' Zero is SUSPICIOUS, not excellent.' : ''}`)

const facts = {
  label, verdict, baseline,
  overall_after: 'not re-measured: the new tests live on unmerged per-module branches; trust verified_percent per module',
  modules: outcomes,
  modules_hard: hard.map((o) => o.module),
  vacuous_rejected: vacuousTotal,
  zero_vacuous_suspicious: zeroVacuousSuspicious,
  unclaimed_below_target: ranked.length - claimed.length,
  skipped_too_small: tooSmall.map((m) => m.name),
}

const fallbackMarkdown = () => [
  `# Coverage swarm: ${label}`, '',
  `**Verdict: ${verdict}.** Baseline ${baseline.overall_percent}% at \`${headSha}\` with \`${baseline.command}\`.`, '',
  ...(productBugs.length ? ['## Product bugs found', '', ...productBugs.map((b) => `- \`${b.where}\`: ${b.what} (${b.fixed ? 'fixed' : 'NOT fixed'})`), ''] : []),
  '| module | status | start | verified | target | rounds | tests | vacuous rejected | branch |',
  '|---|---|---|---|---|---|---|---|---|',
  ...outcomes.map((o) => `| \`${o.module}\` | ${o.status} | ${o.started_percent}% | ${o.verified_percent == null ? 'unverified' : o.verified_percent + '%'} | ${o.target}% | ${o.rounds} | ${o.tests_added} | ${o.vacuous_rejected} | \`${o.branch}\` |`),
  '',
  `Vacuous tests rejected: ${vacuousTotal}${zeroVacuousSuspicious ? ' (zero is suspicious, not excellent)' : ''}.`,
  hard.length ? `Hard modules (stopped after ${NO_PROGRESS_ROUNDS} no-progress rounds): ${hard.map((o) => o.module).join(', ')}.` : '',
  'Nothing was merged and no PR was opened.',
].join('\n')

const report = await agent(
  `Write the report for a coverage swarm on "${label}". The FACTS below were computed by
the workflow script from the agents' structured results. Do not change any number,
status or verdict in them; explain them.

FACTS:
${JSON.stringify(facts, null, 2)}

Rules:
- Lead with product bugs if there are any; they are worth more than the percentage.
- Then the verdict, then a table of every claimed module (including the ones that
  did not move) with start, verified, target, status, rounds, tests added, vacuous
  rejected, and the branch/worktree where its tests live.
- A module with status unverified or failed is NOT a success. Say so.
- If zero_vacuous_suspicious is true, say that zero rejections is suspicious.
- Name every hard module and what made it hard (from the round notes if present).
- The overall percentage after the run was not re-measured; say so plainly.
- admin_asks: what the swarm cannot do itself (infra, permissions, merges). Next
  actions are for a human: review each branch's diff, merge what is good.
- Include the baseline command and sha so the number is reproducible.

Return report_markdown: the whole report as markdown, ready to write to a file verbatim.`,
  { schema: REPORT_SCHEMA, label: 'report:synthesis', phase: 'Report' }
)
if (!report) log('Report agent returned nothing; using the script-built report instead.')

return {
  ...facts,
  summary: report ? report.summary : `${verdict}: ${moved.length}/${outcomes.length} modules moved with a verified gate.`,
  admin_asks: report ? report.admin_asks : [],
  next_actions: report ? report.next_actions : [],
  product_bugs: productBugs,
  claimed_modules: claimed.map((m) => m.name),
  report_markdown: report && report.report_markdown ? report.report_markdown : fallbackMarkdown(),
}
