"""Build the README graphics for aacc-coverage-swarm.

    python docs/assets/src/build.py
    uv run --with playwright==1.56.0 --with pillow python docs/assets/src/render.py docs/assets/src docs/assets

hero and architecture are structural: the phase names and the round constants are read from
coverage_swarm_workflow.js, so they cannot drift from the code. anatomy and run render ONLY from
captures/demo_report.json and captures/demo_result.json, a real run of this workflow against the
fictional Acme Shop demo in examples/acme-shop (sample code, nothing real).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
import readme_kit as k  # noqa: E402

REPO = "AACC-COVERAGE-SWARM"
SRC = (ROOT / "coverage_swarm_workflow.js").read_text(encoding="utf-8")


def const(name: str) -> int:
    return int(re.search(rf"const {name} = (\d+)", SRC).group(1))


def run_date(c: dict) -> str:
    """The run's date as the report file names it (Central time), not the UTC capture stamp."""
    return re.search(r"_(\d{4}-\d{2}-\d{2})\.", " ".join(c["command"])).group(1)


def phases() -> list[str]:
    meta = SRC.split("phases: [", 1)[1].split("]", 1)[0]
    out = re.findall(r"title: '([A-Za-z]+)'", meta)
    assert len(out) == 5, f"expected 5 phases in meta, found {out}"
    return out


def hero() -> str:
    return k.hero(
        "AACC-COVERAGE-SWARM · CLAUDE CODE SKILL · MIT",
        "Test coverage", "you cannot fake.",
        "A Claude Code workflow that raises coverage and pass rate one module at a time, and "
        "<b style='color:var(--ivory);font-weight:600'>mutates your source to delete every test that cannot fail</b>.",
        [("Measured, never pasted", "A fresh local coverage run is the baseline. No suite, no number."),
         ("A mutation gate per module", "Break the covered line. A test that still passes is deleted."),
         ("Branches, never merges", "Each module's tests land on a local branch for a human to review.")],
        f"{const('RATCHET_STEP')}% PER ROUND · STOP AFTER {const('NO_PROGRESS_ROUNDS')} FLAT ROUNDS · 0 MERGES",
        k.wheel(phases(), "EVERY TEST", "Must fail", size=560, node_r=50),
        f"{REPO} · HOW IT WORKS")


def architecture() -> str:
    step, flat, rounds = const("RATCHET_STEP"), const("NO_PROGRESS_ROUNDS"), const("DEFAULT_MAX_ROUNDS")
    boxes = (k.box(56, 240, 230, 160, "MEASURE", ["your test command", "with coverage, run", "locally, right now", "no number = blocked"])
             + k.box(56, 435, 230, 155, "RANK", ["uncovered lines", "to target, not %", "take the top N", "skip < 20 stmts"])
             + k.box(366, 240, 290, 350, "PER MODULE · WORKTREE", ["<repo>.coverage-swarm/<mod>", "branch coverage-swarm/<mod>", "", "round 1..n:", f"  ask current + {step}%", "  fix genuine reds first", "  commit locally", "", f"stop: target met,", f"  {flat} flat rounds in a row,", f"  or {rounds} rounds"], True)
             + k.box(736, 240, 290, 350, "GATE · SAME WORKTREE", ["adversarial review", "", "mutate each covered line", "re-run: test must FAIL", "restore the source", "", "delete vacuous tests", "re-measure coverage", "", "no mutation run =", "gain unverified"], True)
             + k.box(1106, 240, 238, 160, "REPORT", ["verdict computed", "by the script", "product bugs first", "hard modules named"])
             + k.box(1106, 435, 238, 155, "YOU", ["review each branch", "merge what is good", "the swarm never", "merges or pushes"]))
    arrows = [(171, 400, 171, 427), (286, 512, 356, 415), (656, 415, 726, 415), (1026, 320, 1096, 320), (1225, 400, 1225, 427)]
    return k.flow("HOW IT WORKS", f"Measure, cover, {k.em('try to break it')}.",
                  "a dead agent is a failed module · a gate that did not run is an unverified gain · the report agent cannot change the verdict",
                  boxes, arrows, f"{REPO} · HOW IT WORKS")


def anatomy() -> str:
    c = k.load_capture(HERE / "captures" / "demo_report.json")
    md = c["output"]
    title = re.search(r"^# (.+)$", md, re.M).group(1)
    bug_h = re.search(r"^## (.+bug.*)$", md, re.M | re.I).group(1)
    bug_row = re.search(r"^\| `([^`]+)` \(`[^`]+`\) \| \*\*([^*]+)\*\*", md, re.M)
    verdict = re.search(r"^## Verdict: \*\*([a-z_]+)\*\*", md, re.M).group(1)
    rows = re.findall(r"^\| `(acme_shop\.\w+)` \([^)]*\) \| ([\d.]+) \| ([\d.]+) \| (\d+) \| (\w+) \| \w+ \| (\d+) \| (\d+) \| (\d+) \| (\d+) / (\d+) \|", md, re.M)
    assert len(rows) == 2, rows
    overall = re.search(r"^## (Overall coverage after the run: .+)$", md, re.M).group(1)
    lines = [("h1", k.esc(title)),
             ("h2", k.esc(bug_h)),
             ("li", f"<span class='mono' style='font-size:14px'>{k.esc(bug_row.group(1))}</span>: {k.esc(bug_row.group(2))}"),
             ("b", f"Verdict: {k.esc(verdict)}"),
             ("h2", "Modules: start, verified by the gate, target")]
    for name, start, verified, target, status, rounds, tests, vac, caught, tried in rows:
        lines.append(("li", f"<span class='mono' style='font-size:14px'>{k.esc(name)}</span> {float(start):.0f}% to {float(verified):.0f}% (target {target}%) · {status}"))
        lines.append(("li2", f"{tests} tests · {vac} vacuous rejected · mutations caught {caught} / {tried} · {rounds} round"))
    asks = re.findall(r"^\d+\. \*\*([^*]+)\*\*", md.split("(admin asks)", 1)[1].split("## Next", 1)[0], re.M)
    lines.append(("h2", "What the swarm cannot do (admin asks)"))
    for a in asks:
        lines.append(("li", k.esc(a.rstrip("."))))
    lines.append(("h2", k.esc(overall)))
    lines.append(("i", "The new tests live on two unmerged branches, so no single tree holds them all."))
    lines.append(("m", f"examples/acme-shop · fictional sample code · captured {run_date(c)}"))
    notes = [(178, "It found the bug planted in the demo and fixed the product, not the test."),
             (228, "The verdict is computed by the script from the agents' results, not written by the report agent."),
             (290, "Verified = the gate's own re-measure after it deleted vacuous tests."),
             (352, "Surviving mutations are reported, not hidden behind 100% line coverage."),
             (440, "Merging and approving a price change stay with a human."),
             (560, "No invented overall number: it says it was not re-measured.")]
    return k.anatomy("ANATOMY OF A REAL RUN", lines, notes, f"{REPO} · REAL RUN {run_date(c)} · SAMPLE DATA: ACME SHOP", doc_width=840)


def run_timeline() -> str:
    c = k.load_capture(HERE / "captures" / "demo_result.json")
    r = json.loads(c["output"])
    b = r["baseline"]
    mods = {m["module"].split(".")[-1]: m for m in r["modules"]}
    p, i = mods["pricing"], mods["inventory"]
    tried = sum(m["mutations_attempted"] for m in r["modules"])
    caught = sum(m["mutations_caught"] for m in r["modules"])
    bug = r["product_bugs"][0]
    steps = [
        ("MEASURE", f"{b['overall_percent']:.0f}% baseline", f"{b['tests_passed']} tests passing, measured locally at {b['head_sha'][:7]}", False),
        ("COVER · PRICING", f"{p['started_percent']:.0f}% to {p['claimed_percent']:.0f}%", f"{p['tests_added']} tests, and a fix in {bug['where'].split(' ')[0].strip('`')}", False),
        ("COVER · INVENTORY", f"{i['started_percent']:.0f}% to {i['claimed_percent']:.0f}%", f"{i['tests_added']} tests in {i['rounds']} round", False),
        ("GATE", f"{r['vacuous_rejected']} vacuous test deleted", f"{caught} of {tried} mutations caught; coverage re-measured after the deletion", True),
        ("REPORT", f"verdict: {r['verdict']}", "overall after the run: not re-measured, and it says so", False),
    ]
    what = bug["what"].replace("**", "").replace("`", "").split(". The swarm")[0].rstrip(".")
    survived = [(m["module"].split(".")[-1], m["mutations_attempted"] - m["mutations_caught"], m["mutations_attempted"]) for m in r["modules"] if m["mutations_attempted"] > m["mutations_caught"]]
    extra = ("<div style='position:absolute;left:56px;right:56px;top:515px;display:grid;grid-template-columns:3fr 2fr;gap:14px'>"
             f"<div class='card' style='padding:18px 22px'><div class='k' style='font-size:12px'>PRODUCT BUG FOUND · {k.esc(bug['where'].split(' ')[0].strip('`'))}</div>"
             f"<div style='font-size:16px;line-height:1.45;margin-top:10px'>{k.esc(what)}.</div></div>"
             "<div class='card' style='padding:18px 22px'><div class='k' style='font-size:12px'>STILL REPORTED</div>"
             + "".join(f"<div style='font-size:16px;line-height:1.45;margin-top:10px'>{n} of {t} mutations survived on <span class='mono'>{k.esc(mod)}</span>, so 100% line coverage is not called clean.</div>" for mod, n, t in survived)
             + "</div></div>")
    html = k.timeline("A REAL RUN, START TO FINISH", f"Two modules, one planted bug, {k.em('one test deleted')}.",
                      "The fictional Acme Shop demo: two small Python modules with one weak test each.",
                      steps, f"{REPO} · REAL RUN {run_date(c)} · SAMPLE DATA: ACME SHOP")
    marker = "<div style='position:absolute;left:70px;right:70px;top:330px"
    assert marker in html
    return html.replace(marker, extra + marker, 1)


if __name__ == "__main__":
    k.write_pages(HERE, {"hero": hero(), "architecture": architecture(), "anatomy": anatomy(), "run": run_timeline()})
