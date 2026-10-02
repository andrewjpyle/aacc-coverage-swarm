import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from './harness.mjs';

const REPO = '/srv/shop';
const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

const MEASURE = {
  ran_ok: true, command: 'pytest --cov=shop --cov-report=json', exit_code: 0, head_sha: SHA,
  working_tree_dirty: false, overall_percent: 40, tests_passed: 4, tests_failed: 0, tests_skipped: 0,
  genuine_failures: [], environment_failures: 0,
  modules: [
    { name: 'shop/pricing.py', path: 'shop/pricing.py', kind: 'other', percent: 30, lines_total: 60, lines_missed: 42 },
    { name: 'shop/stock.py', path: 'shop/stock.py', kind: 'other', percent: 50, lines_total: 40, lines_missed: 20 },
    { name: 'shop/tiny.py', path: 'shop/tiny.py', kind: 'other', percent: 0, lines_total: 5, lines_missed: 5 },
  ],
};
const round = (over = {}) => ({
  module: 'm', worktree_path: '/srv/x', started_percent: 30, ended_percent: 75, stopped_reason: 'round_target_met',
  tests_added: 3, test_files: ['tests/test_m.py'], committed: true, llm_model_used: 'test-model', ...over,
});
const gate = (over = {}) => ({
  module: 'm', reviewed: 3, meaningful: 3, vacuous: [], mutation_check_ran: true, mutations_attempted: 3,
  mutations_caught: 3, source_restored: true, measured_percent: 74, verdict: 'pass', ...over,
});
const REPORT = { summary: 's', admin_asks: [], next_actions: ['review the branches'], report_markdown: '# report' };

// respond(label) with per-label overrides; a function override receives the call history.
const respond = (over = {}) => (label, prompt, opts, calls) => {
  if (label in over) return typeof over[label] === 'function' ? over[label](prompt, calls) : over[label];
  if (label === 'measure:baseline') return MEASURE;
  if (label.startsWith('cover:')) return round();
  if (label.startsWith('gate:')) return gate();
  if (label === 'report:synthesis') return REPORT;
  throw new Error(`unexpected agent ${label}`);
};
const run = (args, over) => runWorkflow({ repo_path: REPO, ...args }, respond(over));
const labels = (calls) => calls.map((c) => c.opts.label);

// ── inputs ──

test('refuses a missing repo_path', async () => {
  await assert.rejects(runWorkflow({}, respond()), /repo_path is required/);
});

test('refuses a relative repo_path', async () => {
  await assert.rejects(run({ repo_path: 'shop' }), /repo_path must be absolute/);
});

test('refuses a non-numeric max_modules instead of claiming nothing', async () => {
  await assert.rejects(run({ max_modules: 'three' }), /max_modules must be an integer/);
});

test('refuses an out-of-range target', async () => {
  await assert.rejects(run({ target: 150 }), /target must be a number/);
});

test('accepts args that arrive as a JSON string', async () => {
  const { result } = await runWorkflow(JSON.stringify({ repo_path: REPO, max_modules: 1 }), respond());
  assert.deepEqual(result.claimed_modules, ['shop/pricing.py']);
});

// ── measure ──

test('a measure agent that returns nothing is blocked, not a 0% baseline', async () => {
  const { result, calls } = await run({}, { 'measure:baseline': null });
  assert.equal(result.verdict, 'blocked');
  assert.equal(calls.length, 1);
});

test('a suite that could not run is blocked and spawns nothing else', async () => {
  const { result, calls } = await run({}, { 'measure:baseline': { ...MEASURE, ran_ok: false, notes: 'no pytest' } });
  assert.equal(result.verdict, 'blocked');
  assert.match(result.summary, /no pytest/);
  assert.equal(calls.length, 1);
});

test('a coverage report with zero modules is blocked, not a confident run over nothing', async () => {
  const { result, calls } = await run({}, { 'measure:baseline': { ...MEASURE, modules: [] } });
  assert.equal(result.verdict, 'blocked');
  assert.match(result.summary, /zero source modules/);
  assert.equal(calls.length, 1);
});

test('a non-git repo is blocked before any tests are written', async () => {
  const { result, calls } = await run({}, { 'measure:baseline': { ...MEASURE, head_sha: '' } });
  assert.equal(result.verdict, 'blocked');
  assert.match(result.summary, /not a git repository/);
  assert.equal(calls.length, 1);
});

test('the baseline is measured fresh: the measure prompt forbids stored numbers and source edits', async () => {
  const { calls } = await run({ dry_run: true });
  const p = calls[0].prompt;
  assert.match(p, /Do not read a stored\s+number, a dashboard, or a previous report/);
  assert.match(p, /Do NOT modify any source or test file/);
  assert.match(p, /never a zero/);
});

// ── rank ──

test('ranks by uncovered lines to target, skips tiny modules, and logs the skip', async () => {
  const { result, logs } = await run({ dry_run: true });
  // pricing: (70-30)% of 60 = 24 lines; stock: (70-50)% of 40 = 8 lines; tiny skipped (<20 statements)
  assert.deepEqual(result.ranked.map((m) => [m.name, m.leverage]), [['shop/pricing.py', 24], ['shop/stock.py', 8]]);
  assert.ok(logs.some((m) => /Skipped as too small.*shop\/tiny\.py/.test(m)));
});

test('dry run spends exactly one agent and writes nothing', async () => {
  const { result, calls } = await run({ dry_run: true });
  assert.equal(calls.length, 1);
  assert.equal(result.verdict, 'dry_run');
  assert.match(result.report_markdown, /No tests were written/);
});

test('nothing below target returns nothing_to_do without spawning module or report agents', async () => {
  const at = { ...MEASURE, modules: MEASURE.modules.map((m) => ({ ...m, percent: 95 })) };
  const { result, calls } = await run({}, { 'measure:baseline': at });
  assert.equal(result.verdict, 'nothing_to_do');
  assert.deepEqual(labels(calls), ['measure:baseline']);
});

// ── worktrees ──

test('each module gets a deterministic worktree OUTSIDE the repo, and the gate reviews that same worktree', async () => {
  const { calls } = await run({ max_modules: 1, max_rounds: 1 });
  const cover = calls.find((c) => c.opts.label === 'cover:shop/pricing.py:r1');
  const g = calls.find((c) => c.opts.label === 'gate:shop/pricing.py');
  const wt = '/srv/shop.coverage-swarm/shop-pricing-py';
  assert.ok(cover.prompt.includes(`git -C ${REPO} worktree add -b coverage-swarm/shop-pricing-py ${wt} ${SHA}`));
  assert.ok(g.prompt.includes(`Worktree: ${wt}`));
  assert.ok(g.prompt.includes(`git -C ${wt} diff ${SHA}..HEAD`));
  assert.ok(!wt.startsWith(`${REPO}/`), 'worktree must not live inside the repo the runner collects');
  assert.equal(cover.opts.isolation, undefined, 'runtime isolation worktrees the session checkout, not repo_path');
});

test('round 2 continues in the existing worktree instead of creating it again', async () => {
  const { calls } = await run({ max_modules: 1, max_rounds: 2 }, { 'cover:shop/pricing.py:r1': round({ ended_percent: 40 }) });
  const r2 = calls.find((c) => c.opts.label === 'cover:shop/pricing.py:r2');
  assert.doesNotMatch(r2.prompt, /worktree add/);
  assert.match(r2.prompt, /already exists from round 1/);
  assert.match(r2.prompt, /Current: 40%\s+Target this round: 50%/);
});

// ── rounds: ratchet and no-progress stop ──

test('ratchets round by round and stops at the module target', async () => {
  let n = 0;
  const climb = () => round({ ended_percent: [40, 50, 60, 70][n++] });
  const { result, calls } = await run({ max_modules: 1, max_rounds: 10 }, { 'cover:shop/pricing.py:r1': climb, 'cover:shop/pricing.py:r2': climb, 'cover:shop/pricing.py:r3': climb, 'cover:shop/pricing.py:r4': climb });
  assert.equal(calls.filter((c) => c.opts.label.startsWith('cover:')).length, 4);
  assert.equal(result.modules[0].stop, 'target_met');
  assert.match(calls.find((c) => c.opts.label === 'cover:shop/pricing.py:r1').prompt, /Target this round: 40%/);
});

test('stops after exactly 2 consecutive no-progress rounds and names the module as hard', async () => {
  const flat = () => round({ ended_percent: 30, stopped_reason: 'no_gain', tests_added: 1 });
  const { result, calls } = await run({ max_modules: 1, max_rounds: 10 }, {
    'cover:shop/pricing.py:r1': flat, 'cover:shop/pricing.py:r2': flat, 'cover:shop/pricing.py:r3': flat,
  });
  assert.equal(calls.filter((c) => c.opts.label.startsWith('cover:')).length, 2);
  assert.equal(result.modules[0].stop, 'no_progress');
  assert.deepEqual(result.modules_hard, ['shop/pricing.py']);
});

test('a gain resets the no-progress counter', async () => {
  const seq = [30, 45, 45, 45];
  const over = Object.fromEntries([1, 2, 3, 4, 5].map((r) => [`cover:shop/pricing.py:r${r}`, () => round({ ended_percent: seq[r - 1] ?? 45 })]));
  const { result, calls } = await run({ max_modules: 1, max_rounds: 10 }, over);
  // r1 no gain (1), r2 gain (reset), r3 no gain (1), r4 no gain (2) -> stop
  assert.equal(calls.filter((c) => c.opts.label.startsWith('cover:')).length, 4);
  assert.equal(result.modules[0].stop, 'no_progress');
});

test('a blocked round stops the module and is not counted as moved', async () => {
  const { result, calls } = await run({ max_modules: 1 }, { 'cover:shop/pricing.py:r1': round({ stopped_reason: 'blocked', tests_added: 0, ended_percent: 30 }) });
  assert.equal(result.modules[0].status, 'blocked');
  assert.ok(!labels(calls).includes('gate:shop/pricing.py'));
});

// ── failed agents are failures ──

test('a cover agent that dies is a failed module: no gate spawned, not counted as moved', async () => {
  const { result, calls, logs } = await run({ max_modules: 2, max_rounds: 1 }, { 'cover:shop/pricing.py:r1': null });
  assert.ok(!labels(calls).includes('gate:shop/pricing.py'));
  const o = result.modules.find((m) => m.module === 'shop/pricing.py');
  assert.equal(o.status, 'failed');
  assert.equal(result.verdict, 'partial');
  assert.ok(logs.some((m) => /1 module\(s\) FAILED/.test(m)));
});

test('a gate agent that dies leaves the gain UNVERIFIED, never moved', async () => {
  const { result } = await run({ max_modules: 1, max_rounds: 1 }, { 'gate:shop/pricing.py': null });
  assert.equal(result.modules[0].status, 'unverified');
  assert.equal(result.verdict, 'no_verified_gain');
});

test('a gate that did not run the mutation check leaves the gain unverified', async () => {
  const { result } = await run({ max_modules: 1, max_rounds: 1 }, { 'gate:shop/pricing.py': gate({ mutation_check_ran: false }) });
  assert.equal(result.modules[0].status, 'unverified');
  assert.equal(result.modules[0].verified_percent, null);
});

test('a gate that left a mutation in the source is unverified', async () => {
  const { result } = await run({ max_modules: 1, max_rounds: 1 }, { 'gate:shop/pricing.py': gate({ source_restored: false }) });
  assert.equal(result.modules[0].status, 'unverified');
});

test('a gate claiming a pass with zero mutations attempted is unverified', async () => {
  const { result } = await run({ max_modules: 1, max_rounds: 1 }, { 'gate:shop/pricing.py': gate({ mutations_attempted: 0 }) });
  assert.equal(result.modules[0].status, 'unverified');
});

// ── the mutation gate ──

test('the gate prompt requires a real mutation, a restore, deletion of vacuous tests, and a re-measure', async () => {
  const { calls } = await run({ max_modules: 1, max_rounds: 1 });
  const p = calls.find((c) => c.opts.label === 'gate:shop/pricing.py').prompt;
  assert.match(p, /PERTURB the source/);
  assert.match(p, /It MUST fail/);
  assert.match(p, /RESTORE the source every time/);
  assert.match(p, /REMOVE every vacuous test/);
  assert.match(p, /RE-MEASURE/);
});

test('vacuous tests are counted by the script, and the verified number is the gate re-measure, not the cover claim', async () => {
  const { result } = await run({ max_modules: 1, max_rounds: 1 }, {
    'cover:shop/pricing.py:r1': round({ ended_percent: 80, tests_added: 4 }),
    'gate:shop/pricing.py': gate({ reviewed: 4, meaningful: 2, verdict: 'pass_with_removals', measured_percent: 55,
      vacuous: [{ test: 'test_a', why: 'no assert', survived_mutation: true, removed: true },
                { test: 'test_b', why: 'asserts the mock', survived_mutation: true, removed: false }] }),
  }, );
  const o = result.modules[0];
  assert.equal(result.vacuous_rejected, 2);
  assert.equal(o.claimed_percent, 80);
  assert.equal(o.verified_percent, 55);
  assert.deepEqual(o.vacuous_not_removed, ['test_b']);
  assert.equal(o.status, 'moved');
});

test('a gate that deletes every new test leaves no verified gain', async () => {
  const { result } = await run({ max_modules: 1, max_rounds: 1 }, {
    'gate:shop/pricing.py': gate({ meaningful: 0, measured_percent: 30, verdict: 'fail',
      vacuous: [{ test: 't', why: 'survived', survived_mutation: true, removed: true }] }),
  });
  assert.equal(result.modules[0].status, 'no_gain');
  assert.equal(result.verdict, 'no_verified_gain');
});

test('zero vacuous rejections across a gated run is flagged as suspicious', async () => {
  const { result, logs } = await run({ max_modules: 1, max_rounds: 1 });
  assert.equal(result.zero_vacuous_suspicious, true);
  assert.ok(logs.some((m) => /SUSPICIOUS/.test(m)));
});

// ── report ──

test('the report agent cannot overwrite the computed verdict or counts', async () => {
  const lying = { ...REPORT, verdict: 'moved', vacuous_rejected: 99, overall_after: 100 };
  const { result } = await run({ max_modules: 1, max_rounds: 1 }, { 'gate:shop/pricing.py': null, 'report:synthesis': lying });
  assert.equal(result.verdict, 'no_verified_gain');
  assert.equal(result.vacuous_rejected, 0);
  assert.match(result.overall_after, /not re-measured/);
});

test('a report agent that returns nothing falls back to a script-built report, not an empty result', async () => {
  const { result, logs } = await run({ max_modules: 2, max_rounds: 1 }, { 'report:synthesis': null });
  assert.match(result.report_markdown, /\| `shop\/pricing\.py` \| moved \|/);
  assert.match(result.report_markdown, /\| `shop\/stock\.py` \|/);
  assert.ok(logs.some((m) => /script-built report/.test(m)));
});

test('the full run: measure, per-module rounds and gate, then one report; all modules moved', async () => {
  const { result, calls } = await run({ max_modules: 2, max_rounds: 1 });
  assert.equal(labels(calls)[0], 'measure:baseline');
  assert.equal(labels(calls).at(-1), 'report:synthesis');
  assert.equal(calls.filter((c) => c.opts.label.startsWith('gate:')).length, 2);
  assert.equal(result.verdict, 'moved');
  assert.deepEqual(result.claimed_modules, ['shop/pricing.py', 'shop/stock.py']);
});
