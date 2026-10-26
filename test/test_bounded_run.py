"""bounded_run.py kills the WHOLE process group on timeout.

A mutation runner wrapped ``uv run pytest`` in ``subprocess.run(..., timeout=180)``.
On timeout only ``uv`` died; the orphaned python grandchild looped forever and grew to
~100 GB. These tests spawn a wrapper that spawns a grandchild and assert the
grandchild is GONE after the helper times out. The control test shows plain
``subprocess.run`` leaves it alive, so the main test can tell the two apart.

Run: python3 -m pytest test/test_bounded_run.py --timeout=60
"""
from __future__ import annotations

import importlib.util
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

HELPER = Path(__file__).resolve().parents[1] / 'bounded_run.py'


def _load_helper():
    spec = importlib.util.spec_from_file_location('bounded_run', HELPER)
    mod = importlib.util.module_from_spec(spec)
    sys.modules['bounded_run'] = mod  # @dataclass resolves its module through sys.modules
    spec.loader.exec_module(mod)
    return mod


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _wait_gone(pid: int, seconds: float = 5.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not _alive(pid):
            return True
        time.sleep(0.05)
    return not _alive(pid)


def _wrapper_cmd(pidfile: Path) -> list[str]:
    """A 'uv'-like wrapper: spawns a long-lived grandchild, records its pid, then waits on it."""
    grandchild = 'import time\nwhile True: time.sleep(0.1)'
    code = (
        'import subprocess, sys\n'
        f'p = subprocess.Popen([sys.executable, "-c", {grandchild!r}])\n'
        f'open({str(pidfile)!r}, "w").write(str(p.pid))\n'
        'p.wait()\n'
    )
    return [sys.executable, '-c', code]


def _read_pid(pidfile: Path) -> int:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if pidfile.exists() and pidfile.read_text().strip():
            return int(pidfile.read_text())
        time.sleep(0.05)
    raise AssertionError('wrapper never recorded the grandchild pid')


def test_timeout_kills_the_grandchild_not_just_the_wrapper(tmp_path):
    br = _load_helper()
    pidfile = tmp_path / 'gc.pid'
    res = br.run_bounded(_wrapper_cmd(pidfile), timeout=1.5)
    gc_pid = _read_pid(pidfile)
    try:
        assert res.timed_out is True
        assert res.returncode == br.TIMEOUT_EXIT_CODE
        assert _wait_gone(gc_pid), f'grandchild {gc_pid} survived the bounded runner timeout'
    finally:
        if _alive(gc_pid):
            os.kill(gc_pid, signal.SIGKILL)


def test_control_plain_subprocess_timeout_orphans_the_grandchild(tmp_path):
    """The failure mode the helper exists for: proves the main test can detect a survivor."""
    pidfile = tmp_path / 'gc.pid'
    with pytest.raises(subprocess.TimeoutExpired):
        subprocess.run(_wrapper_cmd(pidfile), timeout=1.5)
    gc_pid = _read_pid(pidfile)
    try:
        assert _alive(gc_pid), 'expected plain subprocess.run to leave the grandchild running'
    finally:
        os.kill(gc_pid, signal.SIGKILL)


def test_normal_exit_returns_code_and_output(tmp_path):
    br = _load_helper()
    res = br.run_bounded([sys.executable, '-c', 'print("hello"); raise SystemExit(3)'], timeout=30)
    assert res.timed_out is False
    assert res.returncode == 3
    assert 'hello' in res.output_tail


def test_timed_out_mutant_counts_as_killed_and_source_is_restored(tmp_path):
    br = _load_helper()
    src = tmp_path / 'paginate.py'
    original = 'def done(recs, more):\n    return not recs or not more\n'
    src.write_text(original)
    # The "test" reads the mutated source and loops forever if the exit is gone.
    check = (
        'import time\n'
        f'src = open({str(src)!r}).read()\n'
        'while "not recs or" not in src: time.sleep(0.1)\n'
    )
    out = br.run_mutant(str(src), 'not recs or ', '', [sys.executable, '-c', check], timeout=1.5)
    assert out['outcome'] == 'killed_timeout'
    assert src.read_text() == original


def test_mutant_outcomes_survived_and_killed(tmp_path):
    br = _load_helper()
    src = tmp_path / 'm.py'
    src.write_text('X = 1\n')
    passes = [sys.executable, '-c', 'raise SystemExit(0)']
    fails = [sys.executable, '-c', f'raise SystemExit(0 if open({str(src)!r}).read() == "X = 1\\n" else 1)']
    assert br.run_mutant(str(src), 'X = 1', 'X = 2', passes, timeout=30)['outcome'] == 'survived'
    assert br.run_mutant(str(src), 'X = 1', 'X = 2', fails, timeout=30)['outcome'] == 'killed'
    assert br.run_mutant(str(src), 'NOT THERE', 'y', passes, timeout=30)['outcome'] == 'error'
    assert src.read_text() == 'X = 1\n'


def test_source_restored_even_when_the_run_raises(tmp_path, monkeypatch):
    br = _load_helper()
    src = tmp_path / 'm.py'
    src.write_text('X = 1\n')

    def boom(*a, **k):
        raise RuntimeError('runner crashed')

    monkeypatch.setattr(br, 'run_bounded', boom)
    with pytest.raises(RuntimeError):
        br.run_mutant(str(src), 'X = 1', 'X = 2', ['true'], timeout=5)
    assert src.read_text() == 'X = 1\n'
