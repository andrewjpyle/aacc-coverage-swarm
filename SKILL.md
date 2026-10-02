---
name: aacc-coverage-swarm
description: |
  Use this skill when the user invokes `/aacc-coverage-swarm` (or asks to "raise test coverage",
  "improve the pass rate", "get module X covered", "run the coverage swarm", or wants a codebase
  driven up to a coverage target). Runs a Claude Code Workflow that measures a FRESH local baseline,
  ranks modules by uncovered lines, gives each claimed module its own git worktree and agent (pass
  rate first, then a coverage ratchet, stopping after 2 no-progress rounds), and gates every new test
  with BOTH an adversarial reviewer AND a real mutation check (perturb the covered source; the test
  must fail, or it is deleted).

  It writes tests on local branches and can fix product bugs the tests expose, but it NEVER merges,
  pushes or opens a PR. A human reviews each branch.

  Skip this skill for: a single file (just write the tests); a red gate that is structural rather
  than coverage; or a coverage number you only want to READ.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Workflow
---

# aacc-coverage-swarm: drive coverage and pass rate up, without Goodharting

## The one idea

Coverage is a Goodhart magnet. An unguarded agent loop writes assertion-free tests that lift the
percentage and catch nothing. Every new test therefore faces two gates, both required:

1. an **adversarial reviewer**: would this catch a real regression, or is it a bare call?
2. a **mutation check**: perturb the covered source line; the test must fail. A test that still
   passes is vacuous, and the gate deletes it before re-measuring coverage.

A run that rejects zero vacuous tests is flagged as suspicious, not excellent.

## How to run

1. **Pass the repo path; do not guess it.** `repo_path` must be the absolute path to a git working
   copy. Commit first: module worktrees start from `HEAD`, so uncommitted changes are invisible to
   them.

2. **Run the workflow:**
   ```
   Workflow({
     scriptPath: "<path>/aacc-coverage-swarm/coverage_swarm_workflow.js",
     args: {
       repo_path: "<abs path to your working copy>",
       test_cmd: "<how your suite runs with coverage>",
       max_modules: 3
     }
   })
   ```
   | arg | meaning |
   |---|---|
   | `repo_path` | **required**, absolute path to a git working copy |
   | `test_cmd` | the command that runs your suite WITH a coverage report. Optional, but more reliable than letting the measure agent guess |
   | `label` | plain label for the report (defaults to the repo folder name) |
   | `max_modules` | modules this run claims, 1 to 50 (default 3) |
   | `max_rounds` | cover rounds per module, 1 to 10 (default 3) |
   | `target` | per-module coverage target, overriding the kind-based defaults |
   | `worktree_root` | where module worktrees go (default `<repo>.coverage-swarm/` next to the repo) |
   | `dry_run` | `true` = measure and rank only, one agent, nothing written |

   Start with `dry_run: true` on an unfamiliar repo.

3. **Write the report.** The workflow returns `report_markdown`. Save it verbatim to
   `./coverage-swarms/<label>_<YYYY-MM-DD>.md` (get the date with `date +%F`). The tests live on
   local branches, so without this file the run is hard to trace later.

4. **Relay it.** Lead with `product_bugs` if any, then `verdict`, the per-module table
   (`verified_percent` is the gate's re-measure; `claimed_percent` is the cover agent's own claim),
   `modules_hard`, and `admin_asks`.

5. **Review each branch yourself.** Every module's tests are on `coverage-swarm/<module>` in its
   worktree. `git -C <worktree> diff <baseline sha>..HEAD` shows exactly what was written. Merge what
   is good; remove the worktree with `git worktree remove` when done. A second run refuses to
   overwrite an existing module worktree.

## Verdicts

| verdict | meaning |
|---|---|
| `blocked` | no usable baseline: the suite did not run, the report listed no modules, or the repo is not git |
| `nothing_to_do` | no module of 20+ statements is below target |
| `dry_run` | measured and ranked only |
| `moved` | every claimed module gained coverage with a gate that actually ran |
| `partial` | some did, some failed, stalled or are unverified |
| `no_verified_gain` | no module has a gate-verified gain |

A module whose cover agent died is `failed`. A module whose gate died, skipped the mutation check,
attempted zero mutations or left a mutation in the source is `unverified`. Neither counts as moved.

## Per module

Pass rate first, then coverage. When a genuine failure means the product is broken, the fix goes to
the product and the test asserts the corrected behaviour; a test that codifies the bug is never
acceptable. Environment failures (no DB, missing service, live network) are reported, not tested
around.

The script runs the rounds: each asks for `current + 10`, capped at the module target. It stops at
the target, after 2 consecutive rounds with no measured gain (and names the module as hard), or at
`max_rounds`.

## Cost

1 measure agent, then per module up to `max_rounds` cover agents plus 1 gate, then 1 report agent.
Defaults (3 modules, 3 rounds) cap a run at 14 agents.
