#!/usr/bin/env python3
"""One command that answers "is this releasable?".

Everything CI checks, run locally in the same order, plus the determinism gate. The
point is not the checking - CI already does that - it is that every check is reachable
in one step before a push.

This exists because two pushes this session passed locally and went red in CI, both
times because a check only one environment ran. Once the whole set is one command,
that surfaces in seconds rather than in a CI run.

The toolchain version is compared against CI's pin and reported loudly, because a
green run on the wrong Bun version is the exact failure mode this is meant to catch.

Usage:
    python scripts/verify_release.py
    python scripts/verify_release.py --skip-determinism       # faster inner loop
    python scripts/verify_release.py --bun /path/to/bun        # pin a toolchain
    python scripts/verify_release.py --also-bun /path/to/old   # cross-version check

Exit code is 0 only when every step passed.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# What .github/workflows/ci.yml pins. A mismatch is reported, not fatal, because the
# point is to make the difference visible rather than to block on it.
CI_BUN_VERSION = "1.2.14"

# Pinned regeneration date so the determinism gate compares like with like. Matches CI.
DETERMINISM_TODAY = "2026-10-01"


def _env() -> dict[str, str]:
    env = dict(os.environ)
    # Matches CI: suppress the stale-source failure that a scratch regen would trip.
    env["STALE_ERROR_DAYS"] = "99"
    return env


def _bun_version(bun: str) -> str:
    try:
        out = subprocess.run([bun, "--version"], capture_output=True,
                             text=True, timeout=60)
        return out.stdout.strip() or "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def _run(argv: list[str], env: dict[str, str], cwd: Path = ROOT
         ) -> tuple[bool, str]:
    """Run a step. Returns (ok, detail) where detail is tail output on failure."""
    try:
        proc = subprocess.run(argv, cwd=str(cwd), env=env,
                              capture_output=True, text=True, timeout=900)
    except FileNotFoundError:
        return False, "not installed: %s" % argv[0]
    except subprocess.TimeoutExpired:
        return False, "timed out after 900s"
    if proc.returncode != 0:
        combined = (proc.stdout or "") + (proc.stderr or "")
        tail = combined.strip().splitlines()[-12:]
        return False, "\n".join(tail) or "exit %d" % proc.returncode
    return True, ""


def _determinism(env: dict[str, str]) -> tuple[bool, str]:
    """Regenerate twice into separate trees, compare them, then re-check invariants."""
    with tempfile.TemporaryDirectory() as tmp:
        tmpd = Path(tmp)
        for name in ("gen-a", "gen-b"):
            ok, detail = _run(
                [sys.executable, "scripts/sync_milestones.py",
                 "--output-dir", str(tmpd / name),
                 "--upstream", "data/milestones.json",
                 "--today", DETERMINISM_TODAY], env)
            if not ok:
                return False, "%s regeneration failed\n%s" % (name, detail)

        ok, detail = _run(
            [sys.executable, "scripts/determinism_gate.py",
             str(tmpd / "gen-a"), str(tmpd / "gen-b")], env)
        if not ok:
            return False, detail

        return _run(
            [sys.executable, "scripts/check_data.py",
             str(tmpd / "gen-a" / "data" / "events.json"),
             str(tmpd / "gen-a" / "data" / "milestones.json")], env)


def _build_steps(bun: str, tmpdir: Path, skip_determinism: bool
                 ) -> list[tuple[str, list[str] | None]]:
    """(label, argv) pairs. argv of None means the in-process determinism check."""
    steps: list[tuple[str, list[str] | None]] = [
        ("Python unit tests", [sys.executable, "-m", "pytest", "scripts/", "-q"]),
        ("Data validation", [sys.executable, "scripts/check_data.py"]),
        ("JS unit tests", [bun, "test", "test/"]),
        ("JS static parse", [bun, "build", "assets/js/worldmap.js",
                             "--no-bundle", "--outdir", str(tmpdir / "parse-check")]),
    ]
    if not skip_determinism:
        steps.append(("Data regeneration is deterministic", None))
    return steps


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bun", help="path to the bun binary to use")
    ap.add_argument("--also-bun", action="append", default=[], metavar="PATH",
                    help="extra bun binary to cross-check the JS suite against")
    ap.add_argument("--skip-determinism", action="store_true",
                    help="omit the regenerate-and-compare gate (faster inner loop)")
    ap.add_argument("--quiet", action="store_true",
                    help="print only the summary and any failures")
    args = ap.parse_args()

    bun = args.bun or shutil.which("bun")
    if not bun:
        print("FAIL  bun not found on PATH; install it or pass --bun",
              file=sys.stderr)
        return 2

    env = _env()
    started = time.time()
    failures: list[tuple[str, str]] = []
    total_steps = 0

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        for label, argv in _build_steps(bun, tmpdir, args.skip_determinism):
            total_steps += 1
            t0 = time.time()
            ok, detail = _determinism(env) if argv is None else _run(argv, env)
            dt = time.time() - t0
            if ok:
                if not args.quiet:
                    print("  ok    %-42s %5.1fs" % (label, dt))
            else:
                failures.append((label, detail))
                print("  FAIL  %-42s %5.1fs" % (label, dt))

        for extra in args.also_bun:
            total_steps += 1
            label = "JS unit tests (%s)" % _bun_version(extra)
            ok, detail = _run([extra, "test", "test/"], env)
            if ok:
                if not args.quiet:
                    print("  ok    %-42s" % label)
            else:
                failures.append((label, detail))
                print("  FAIL  %-42s" % label)

    version = _bun_version(bun)
    total = time.time() - started
    print()
    if version == CI_BUN_VERSION:
        print("bun %s (matches CI)" % version)
    else:
        print("bun %s  <-- CI pins %s; a green run here does not guarantee CI"
              % (version, CI_BUN_VERSION))

    if failures:
        print("\n%d of %d steps FAILED in %.1fs" % (len(failures), total_steps, total))
        for label, detail in failures:
            print("\n--- %s ---\n%s" % (label, detail or "(no output)"))
        return 1

    print("all %d steps passed in %.1fs" % (total_steps, total))
    return 0


if __name__ == "__main__":
    sys.exit(main())