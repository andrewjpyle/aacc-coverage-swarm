#!/usr/bin/env python3
"""Bounded test / mutation runner for the aacc-coverage-swarm (stdlib only).

Origin: 2026-10-15 Studio OOM panic. A hand-written mutation runner called
``subprocess.run(["uv", "run", "pytest", ...], timeout=180)``. Mutant M24 removed
``not recs or`` from a pagination exit, so the test looped forever and a fixture
appended to a list on every pass. On timeout, Python SIGKILLed only ``uv``. The
python3.13 grandchild was orphaned, kept running, and grew to ~100 GB. Three of
them panicked the 64 GB Mac Studio.

A timeout around a wrapper (uv, npx, doppler, a shell) is NOT enough. This helper
starts the command in its OWN process group (``start_new_session=True``) and, on
timeout, SIGKILLs the WHOLE group, so no grandchild survives. It also kills any
leftover group members after a normal exit, and streams output to a temp file
instead of memory.

Use it for every test run inside a swarm agent. Never hand-roll subprocess.run.

CLI, plain bounded run (exit code = the command's, 124 on timeout)::

    python3 bounded_run.py --timeout 180 --cwd <worktree> -- \
        .venv/bin/python -m pytest tests/test_x.py --timeout=60 -x -q

CLI, one mutant (apply, run, ALWAYS restore; prints one JSON line)::

    python3 bounded_run.py --timeout 180 --cwd <worktree> \
        --mutate apps/x/service.py --old "not recs or " --new "" -- \
        .venv/bin/python -m pytest tests/test_x.py --timeout=60 -x -q

The JSON ``outcome`` is ``killed`` (tests failed), ``killed_timeout`` (timed out:
counts as KILLED, the standard mutation-testing rule), ``survived`` (tests passed:
the test is vacuous) or ``error`` (the mutation could not be applied).
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass

DEFAULT_TIMEOUT_S = 180
TIMEOUT_EXIT_CODE = 124
OUTPUT_TAIL_CHARS = 4000


@dataclass
class RunResult:
    returncode: int
    timed_out: bool
    duration_s: float
    output_tail: str


def _kill_group(pgid: int) -> None:
    """SIGKILL every process in the group; ignore an already-empty group."""
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def run_bounded(cmd: list[str], timeout: float = DEFAULT_TIMEOUT_S, cwd: str | None = None) -> RunResult:
    """Run ``cmd`` in its own process group; on timeout kill the whole group."""
    start = time.monotonic()
    with tempfile.TemporaryFile(mode="w+b") as out:
        proc = subprocess.Popen(
            cmd, cwd=cwd, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
        pgid = proc.pid  # start_new_session: the child leads a new group with pgid == pid
        timed_out = False
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
        finally:
            # Always: on timeout this is the fix; after a normal exit it reaps any
            # background grandchild the command left running.
            _kill_group(pgid)
            if proc.poll() is None:
                proc.wait()
        out.seek(0, os.SEEK_END)
        size = out.tell()
        out.seek(max(0, size - OUTPUT_TAIL_CHARS))
        tail = out.read().decode("utf-8", errors="replace")
    rc = TIMEOUT_EXIT_CODE if timed_out else proc.returncode
    return RunResult(returncode=rc, timed_out=timed_out, duration_s=round(time.monotonic() - start, 2), output_tail=tail)


@contextmanager
def mutated(path: str, old: str, new: str):
    """Apply one mutation (first occurrence of ``old`` -> ``new``); restore the original bytes in finally."""
    with open(path, "rb") as fh:
        original = fh.read()
    text = original.decode("utf-8")
    if old not in text:
        raise ValueError(f"mutation target not found in {path}: {old!r}")
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text.replace(old, new, 1))
        yield
    finally:
        with open(path, "wb") as fh:
            fh.write(original)


def run_mutant(path: str, old: str, new: str, cmd: list[str], timeout: float = DEFAULT_TIMEOUT_S,
               cwd: str | None = None) -> dict:
    """Apply a mutant, run the bounded command, restore the source. Timeout counts as KILLED."""
    target = os.path.join(cwd, path) if cwd and not os.path.isabs(path) else path
    try:
        with mutated(target, old, new):
            res = run_bounded(cmd, timeout=timeout, cwd=cwd)
    except ValueError as exc:
        return {"outcome": "error", "error": str(exc), "file": path}
    if res.timed_out:
        outcome = "killed_timeout"
    elif res.returncode == 0:
        outcome = "survived"
    else:
        outcome = "killed"
    return {"outcome": outcome, "file": path, "old": old, "new": new, **asdict(res)}


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--" not in argv:
        print("usage: bounded_run.py [--timeout S] [--cwd DIR] [--mutate FILE --old S --new S] -- CMD...", file=sys.stderr)
        return 2
    split = argv.index("--")
    opts, cmd = argv[:split], argv[split + 1:]
    p = argparse.ArgumentParser(prog="bounded_run.py")
    p.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S)
    p.add_argument("--cwd", default=None)
    p.add_argument("--mutate", default=None)
    p.add_argument("--old", default=None)
    p.add_argument("--new", default="")
    a = p.parse_args(opts)
    if not cmd:
        print("bounded_run.py: no command after --", file=sys.stderr)
        return 2
    if a.mutate:
        if a.old is None:
            print("bounded_run.py: --mutate needs --old", file=sys.stderr)
            return 2
        print(json.dumps(run_mutant(a.mutate, a.old, a.new, cmd, timeout=a.timeout, cwd=a.cwd)))
        return 0
    res = run_bounded(cmd, timeout=a.timeout, cwd=a.cwd)
    sys.stdout.write(res.output_tail)
    if res.timed_out:
        print(f"\nBOUNDED_RUN: TIMEOUT after {a.timeout}s; process group killed", file=sys.stderr)
    return res.returncode


if __name__ == "__main__":
    sys.exit(main())
