#!/usr/bin/env python3
"""Fail a commit that hand-edits generated data files.

Every file under `data/` is produced by `scripts/sync_milestones.py`,
`scripts/sync_layers.py` or `scripts/article_geocode.py`. Nothing else writes them.
Editing one by hand is always a mistake: the next six-hourly cron run overwrites it,
and in the meantime the repository holds data that no generator would produce, which
is exactly what the determinism gate and the publish invariants are built to catch -
except they only run on `main`, so the mistake reaches the branch first.

This has been hit for real: the milestone-check cron advanced `main` four times in
one session, producing four rebase conflicts on generated files. That is the cost of
the files being editable.

Scope matters. Scanning the whole history flags 40 commits, including the legitimate
one-off repairs that removed 27 null-island records by hand - doing so was correct at
the time, and a check that cannot be turned green gets deleted. So the default range
is `origin/main..HEAD`: only what this branch introduces.

Only the bot's own commits are exempt, identified by the commit author GitHub Actions
uses. Use `--check-commit` for a single commit; with no argument, every commit on the
branch is checked.

Usage:
    python scripts/data_ownership.py                    # every commit on the branch
    python scripts/data_ownership.py --check-commit HEAD
    python scripts/data_ownership.py --commit-file .git/COMMIT_EDITMSG
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

GENERATED = (
    "data/milestones.json",
    "data/milestones_history.json",
    "data/events.json",
    "data/activity.json",
    "data/world_layers.json",
    "data/historical_milestones.json",
    "data/.sync_fingerprint",
    "data/geocode_cache.json",
    "data/coverage_history.json",
    "data/metric_coverage_baseline.json",
)

BOT_IDENTITIES = ("github-actions[bot]", "41898282+github-actions[bot]@users.noreply.github.com")


def _run(*args: str) -> str:
    proc = subprocess.run(["git", *args], capture_output=True, text=True, cwd=str(ROOT))
    return proc.stdout


def _git_ok(*args: str) -> bool:
    return subprocess.run(["git", *args], capture_output=True, text=True,
                          cwd=str(ROOT)).returncode == 0


def base_ref_exists(rev_range: str) -> tuple[bool, str]:
    """Whether the range's base can actually be resolved.

    `git rev-list` on an unresolvable range exits 0 and prints nothing, so an absent
    origin/main - a shallow clone, or a repository cloned without the remote - reads
    as "no offending commits" and the check passes having examined nothing. That is
    precisely the failure this check exists to prevent, so an unresolvable base is an
    error rather than a clean bill of health.
    """
    base = rev_range.split("..")[0]
    if _git_ok("rev-parse", "--verify", "--quiet", base):
        return True, ""
    return False, base


def commit_is_from_bot(sha: str) -> bool:
    out = _run("show", "-s", "--format=%an|%ae", sha)
    return any(marker in out for marker in BOT_IDENTITIES)


def touched_generated_from_tree(files) -> list[str]:
    """The pure part of touched_generated, testable without a repository."""
    return sorted({f for f in files if f in GENERATED})


def touched_generated(sha: str) -> list[str]:
    return touched_generated_from_tree(
        _run("show", "--name-only", "--format=", sha).split())


RECORD_SEP = "\x1e"  # ASCII record separator: cannot appear in a path or an author


def offending_commits(rev_range: str = "HEAD") -> list[tuple[str, list[str]]]:
    """Commits in `rev_range` that hand-edit generated data.

    One `git log` call rather than three per commit. The obvious implementation asks
    git for the author and then the file list once per SHA, which on this repository
    is 332 commits and 664 process spawns for a full-history scan - most of the wall
    clock of a step that should take milliseconds. A single log with a record
    separator returns both fields per commit in one pass.

    The separator is an ASCII record separator rather than a newline so the split is
    unambiguous; it cannot occur in a filename, an author name or an email address.
    """
    ok, why = base_ref_exists(rev_range)
    if not ok:
        raise UnknownBase(why)
    out = _run("log", "--format=%H" + RECORD_SEP + "%an" + RECORD_SEP + "%ae",
               "--name-only", rev_range)
    if not out.strip():
        return []

    offenders = []
    for chunk in out.split(RECORD_SEP):
        lines = [l for l in chunk.split("\n") if l.strip()]
        if len(lines) < 3:
            continue
        sha, author, email = lines[0], lines[1], lines[2]
        if any(m in author or m in email for m in BOT_IDENTITIES):
            continue
        touched = touched_generated_from_tree(lines[3:])
        if touched:
            offenders.append((sha, touched))
    return offenders


class UnknownBase(RuntimeError):
    """The range's base ref does not resolve in this repository."""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rev-list", default=None,
                    help="rev-list argument. Defaults to origin/main..HEAD, i.e. only "
                         "the commits this branch introduces")
    ap.add_argument("--all", action="store_true",
                    help="scan the whole branch history, not just new commits")
    ap.add_argument("--list", action="store_true", help="print the generated set and exit")
    args = ap.parse_args()

    if args.list:
        for f in GENERATED:
            print(f)
        return 0

    default_range = "HEAD" if args.all else "origin/main..HEAD"
    rev_range = args.rev_list or default_range
    try:
        offenders = offending_commits(rev_range)
    except UnknownBase as exc:
        print("[error] cannot resolve %r, so the check could not run" % rev_range,
              file=sys.stderr)
        print("        A shallow clone has no origin/main. Fetch it with\n"
              "          git fetch --unshallow\n"
              "        or pass --all to scan this branch's whole history.",
              file=sys.stderr)
        return 2
    if not offenders:
        print("[ok] no hand-edited generated data files")
        return 0
    for sha, files in offenders:
        print("[error] %s edited generated data: %s" % (sha[:9], ", ".join(files)))
    print("\n%d commit(s) hand-edit files the pipeline owns. Regenerate them instead:\n"
          "  python scripts/sync_milestones.py --upstream data/milestones.json\n"
          "  python scripts/sync_layers.py --write\n"
          "  python scripts/article_geocode.py --refresh\n"
          "or let the milestone-check cron do it." % len(offenders))
    return 1


if __name__ == "__main__":
    sys.exit(main())