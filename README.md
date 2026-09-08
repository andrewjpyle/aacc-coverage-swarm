# aacc-coverage-swarm

A Claude Code skill that drives a codebase's **test coverage and pass rate up** — and
refuses to move them the fake way.

## The one idea

Coverage is a Goodhart magnet. Point an unguarded agent loop at a coverage number and
it will happily write assertion-free tests that lift the percentage and catch nothing
— forever. This skill exists to stop that.

**Every new test faces two gates, both required:**

1. **An adversarial reviewer** — would this test catch a real regression, or is it a
   bare call with no meaningful assertion?
2. **A mutation gate** — the reviewer *perturbs the covered source* (inverts a
   condition, changes a returned value, drops a filter) and re-runs the test. The test
   **must** fail. If it still passes, it is vacuous and is thrown away.

A run that rejects **zero** vacuous tests is reported as **suspicious, not excellent**.

## What it does

It runs as a Claude Code Workflow with five phases:

1. **Measure** — a fresh, LOCAL coverage run. Never a stored number, a dashboard, or a
   pasted one. If the suite cannot run locally, the run is reported **blocked** — it
   refuses to invent a number.
2. **Rank** — modules are scored by *uncovered lines to target* (leverage), not by
   percentage, so a 2,000-line service at 10% outranks a 30-line file. It claims the
   top N.
3. **Cover** — one focused agent per claimed module, in its own git worktree.
   **Pass rate first, then coverage** (a coverage number over a failing suite is a
   lie). Coverage climbs by a ratchet: `current + 10` per round, capped at the
   module's target. A module that makes no progress for two rounds is flagged, not
   ground on.
4. **Gate** — the two-gate anti-Goodhart check above, per module.
5. **Report** — a synthesis that leads with any product bugs found, names every hard
   module, flags unverified gains, and lists the admin asks the swarm cannot do
   itself.

### It writes tests, but never merges

The skill writes tests and may fix a product bug a new test exposes. It does **not**
open a PR, merge, or transition anything. Acting on the report is a separate step a
human drives.

## Install

Copy the skill folder into your Claude Code skills directory:

```
.claude/skills/aacc-coverage-swarm/
  SKILL.md
  coverage_swarm_workflow.js
```

It needs Claude Code's **Workflow** tool (the workflow fans out sub-agents). The
`allowed-tools` in `SKILL.md` include `Edit` because the skill writes test files.

## Run

Invoke the skill (`/aacc-coverage-swarm`) or run the workflow directly. Start with a
dry run on an unfamiliar repo — it costs one agent and tells you whether the suite
runs and where the leverage is:

```
Workflow({
  scriptPath: ".claude/skills/aacc-coverage-swarm/coverage_swarm_workflow.js",
  args: {
    repo_path: "/abs/path/to/your/working-copy",
    test_cmd: "<how your suite runs WITH a coverage report>",
    dry_run: true
  }
})
```

Then run for real by dropping `dry_run` (or setting it `false`).

### Args

| arg | required | meaning |
|---|---|---|
| `repo_path` | **yes** | absolute path to your working copy — the swarm runs a real local suite, so it needs the real files |
| `test_cmd` | no | the command that runs your suite WITH a coverage report; if omitted, the measure agent works it out from the repo, but passing it is more reliable |
| `label` | no | plain label for the report file and heading (defaults to the repo folder name) |
| `max_modules` | no | how many modules this run claims (default `3`) |
| `target` | no | override the per-module target; omit to use the kind-based defaults |
| `dry_run` | no | measure + rank only, write nothing |

The run returns `report_markdown` ready to save to `./coverage-swarms/<label>_<YYYY-MM-DD>.md`.

## The anti-Goodhart contract

- **Baseline is measured locally, every time** — never read from CI or a dashboard.
- **Pass rate before coverage** — reds are fixed first; a coverage number over a
  failing suite is a lie.
- **Never codify a bug.** When a genuine failure means the *product* is broken, the
  fix goes to the product and the test asserts the *corrected* behaviour. A test that
  asserts the bug (`assert status_code == 500`) is never acceptable.
- **Environment failures are triaged out, not fixed** — no DB, missing service, live
  network. Writing a test around them is how a suite fills with lies.
- **Rank by uncovered lines**, ratchet by `current + 10`, **stop after 2 no-progress
  rounds** and name the hard module. A silent skip reads as "covered everything".
- **Every module agent asserts the model that actually did the work** — a swarm that
  exits clean having produced nothing is the failure mode to fear most.
- **Put tests where your runner actually collects them.** A test the runner never
  executes is decoration. Tell each module agent your project's test layout — the
  workflow does not assume one.

## License

MIT. See [LICENSE](./LICENSE).
