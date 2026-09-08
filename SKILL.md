---
name: aacc-coverage-swarm
description: |
  Use this skill when the user invokes `/aacc-coverage-swarm` (or asks to "raise test coverage",
  "improve the pass rate", "get module X covered", "run the coverage swarm", or wants a codebase or
  a bucket of it driven up to a coverage/pass-rate target). Runs a Claude Code Workflow that measures
  a FRESH local baseline, ranks modules by leverage, fans out one focused agent per module — pass
  rate first, then a coverage ratchet — and gates every new test against Goodhart with BOTH an
  adversarial reviewer AND a real mutation check (perturb the covered source; the test must fail).

  It writes tests and can fix product bugs the tests expose, but it NEVER merges and never opens a
  PR on its own. A human dispatches.

  Skip this skill for: a single file (just write the tests); making a red gate green when the red is
  structural rather than coverage (see "Not this skill" below); or a coverage number you only want
  to READ (the number here comes only from the local baseline this skill measures).
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Workflow
---

# aacc-coverage-swarm — drive coverage and pass rate up, without Goodharting

A Claude Code Workflow that moves a codebase's test coverage and pass rate up — and refuses to move
them the fake way. It measures the number, it does not read it from a dashboard.

## The one idea

Coverage is a Goodhart magnet. An unguarded agent loop writes assertion-free tests
that lift the percentage and catch nothing, and it will do this cheerfully and
forever. **Every new test therefore faces two gates, both required:**

1. an **adversarial reviewer** — would this catch a real regression, or is it a bare
   call?
2. a **mutation check** — perturb the covered source; the test *must* fail. If it
   still passes, the test is vacuous and is thrown away.

A run that rejects zero vacuous tests is reported as **suspicious, not excellent**.

## When to invoke

**Invoke** when the user wants coverage or pass rate moved on your project, a bucket
of it, or a named module.

**Not this skill** when:
- the target is one file — just write the tests;
- a quality gate is red for *structural* reasons (e.g. a New Code window counting the
  whole codebase as new). No amount of testing fixes an admin setting; the workflow
  will name it as an `admin_ask` rather than grind at it;
- the suite cannot run locally at all. The workflow reports that as **blocked** and
  refuses to invent a number.

## How to run

1. **You pass the repo path — do not guess it.** The workflow needs a real working
   copy because it runs a real test suite. Give it the absolute path to your working
   copy as `repo_path`. Simple and explicit.

2. **Run the workflow:**
   ```
   Workflow({
     scriptPath: "<path>/aacc-coverage-swarm/coverage_swarm_workflow.js",
     args: {
       repo_path: "<abs path to your working copy>",
       test_cmd: "<how your suite runs with coverage>",
       label: "<optional label for the report>",
       max_modules: 3
     }
   })
   ```
   `args`:
   | arg | meaning |
   |---|---|
   | `repo_path` | **required** — absolute path to the working copy |
   | `test_cmd` | the command that runs your suite WITH a coverage report. If omitted, the measure agent works it out from the repo, but passing it is more reliable |
   | `label` | optional plain label for the report file and heading (defaults to the repo folder name) |
   | `max_modules` | how many modules this run claims (default 3) |
   | `target` | override the per-module target; omit to use the kind-based defaults |
   | `dry_run` | measure + rank only, write nothing |

   Start with `dry_run: true` on an unfamiliar repo. It costs one agent and tells you
   whether the suite even runs and where the leverage is.

3. **Write the report.** The workflow returns `report_markdown` ready to write
   verbatim. Get today's date (`date +%F`) and save it to:
   ```
   ./coverage-swarms/<label>_<YYYY-MM-DD>.md
   ```
   Create `coverage-swarms/` if missing.

   This step exists because a swarm run is expensive and, without it, hard to trace:
   the tests land in per-module worktrees, no PR is opened, and the reasoning lives
   only in a chat transcript that scrolls away. A run nobody can find later did not
   happen.

4. **Relay the report.** Lead with `product_bugs` if there are any — those are worth
   more than the percentage. Then the verdict, what moved, `modules_hard`, and
   `admin_asks`.

5. **Review the diff yourself before anything is merged.** The workflow does not open
   PRs and does not merge.

## What it does, per module

Pass rate **first**, then coverage. A coverage number measured over a
failing suite is a lie.

When a genuine failure means the **product** is broken, the fix goes to the product
and the test asserts the *corrected* behaviour. A test that codifies the bug
(`assert status_code == 500`) is never acceptable — it cements the defect and hands
back a false green.

Environment failures (no DB, missing service, live network) are **triaged out, not
fixed** — they are not this swarm's work and writing a test around them is how a
suite fills with lies.

## Hard-won details worth not re-learning

- **Put tests where your test runner actually collects them.** A test the runner
  never executes is decoration from birth. Tell each module agent your project's test
  layout so new tests land in the tree your suite runs — this workflow does not assume
  one specific layout.
- **Baseline LOCALLY, every time.** Never a stored number, a dashboard, or a pasted
  one. A CI figure measured over code CI does not execute reads low, and coverage
  drifts fast under an active campaign.
- **Rank by uncovered LINES, not percentage.** Percentage alone sends the swarm at a
  30-line file while a 2,000-line service sits at 10%.
- **Ratchet, don't target** — `current + 10` per round, capped at the module target.
- **Stop after 2 no-progress rounds** and flag the module. Grinding is not a virtue,
  and a silently skipped module reads as "covered everything".
- **Worktree per module agent**, so parallel agents never race in a shared checkout.
- **`llm_model_used` is asserted per agent** — the model that actually did the work,
  not the configured provider name. A swarm that exits 0 having produced nothing is
  the failure mode to fear most.

## Read-only-ish contract

It writes tests and may fix a product bug it uncovers. It does **not** merge, open
PRs, or transition anything. Acting on the report is a separate step a human drives.

## Cost / cadence

Measure = 1 agent, one per claimed module for cover + one for gate, plus a synthesis
agent. With the default `max_modules: 3` that is ~8 agents — a panel, not a swarm.
Raise `max_modules` deliberately; each one is a full test-writing agent.
