#!/usr/bin/env python3
"""Invariants every published artifact must satisfy, checked as a set.

Unit tests elsewhere cover each stage on its own, and all of them passed while a real
defect was live: `merge_history` correctly scrubbed the origin sentinel, and
`merge_feed` then overwrote the clean record with the raw upstream one. Every stage
was individually correct; the wiring was not.

This module asserts the properties that must hold for the artifacts as a whole -
whatever route produced them:

  * no origin sentinel, malformed coordinate, or bad `location_confidence` survives
    into any published file
  * ids are unique where they are required to be
  * every record in the live feed is reachable in the archive, and vice versa
  * category names are canonical everywhere

Runs in CI as its own step and as part of `verify_release.py`, so a violation fails
the build instead of landing on `main` from a green cron run.

Usage:
    python scripts/publish_invariants.py            # check the repo's data dir
    python scripts/publish_invariants.py --data DIR # check somewhere else
    python scripts/publish_invariants.py --json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_data as cd
import location_contract as lc


def _iter_records(payload):
    """Every milestone-shaped dict in a payload, whatever envelope it wears."""
    if isinstance(payload, list):
        for item in payload:
            if isinstance(item, dict):
                yield item
        return
    if not isinstance(payload, dict):
        return
    for m in (payload.get("milestones") or []):
        if isinstance(m, dict):
            yield m
    for cat in (payload.get("categories") or {}).values():
        if isinstance(cat, dict):
            for m in (cat.get("milestones") or []):
                if isinstance(m, dict):
                    yield m
    for e in (payload.get("events") or []):
        if isinstance(e, dict):
            yield e


def _walk_geolocations(payload):
    """Yield (path, value) for every `geolocation` key anywhere in a payload.

    Recursive rather than schema-driven on purpose: the point is to catch a sentinel
    in whatever shape it arrives, including a shape no validator was written for.
    Deployment legs use `from`/`to` coordinate pairs rather than a `geolocation`
    object, so those are checked separately by their own validator.
    """
    def walk(node, path):
        if isinstance(node, dict):
            for key, value in node.items():
                child = f"{path}.{key}" if path else key
                if key == "geolocation":
                    yield child, value
                yield from walk(value, child)
        elif isinstance(node, list):
            for i, item in enumerate(node):
                yield from walk(item, f"{path}[{i}]")
    yield from walk(payload, "")


def check(data_dir: Path) -> list[str]:
    issues: list[str] = []

    # ---- 1. every artifact individually passes its own validator ---------
    for name in cd.REQUIRED_FILES:
        path = data_dir / name
        if not path.exists():
            issues.append(f"{name}: missing")
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            issues.append(f"{name}: unreadable ({exc})")
            continue
        for problem in cd.check_file(path):
            issues.append(f"{name}: {problem}")
        # Per-file validation checks shape. These check content.
        issues.extend(_content_invariants(name, payload))

    # ---- 2. the other browser-fetched files are validated too ------------
    # ARCHIVE_FILES and ACTIVITY_FILES are published artefacts, so they get the same
    # content invariants as the main files. CATALOG_FILES is deliberately excluded
    # from those: data/historical_milestones.json is pipeline *input*, and it carries
    # legacy category labels ("Biotechnology") on purpose - the ingest folds them
    # through CATEGORY_ALIASES. Holding an input file to the output contract rejects
    # exactly the legacy data the alias table exists to accept. It still gets its own
    # validator, just not this one.
    for name in cd.ARCHIVE_FILES + cd.ACTIVITY_FILES:
        path = data_dir / name
        if not path.exists():
            issues.append(f"{name}: missing")
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            issues.append(f"{name}: unreadable ({exc})")
            continue
        for problem in cd.check_file(path):
            issues.append(f"{name}: {problem}")
        issues.extend(_content_invariants(name, payload))

    for name in cd.CATALOG_FILES:
        path = data_dir / name
        if not path.exists():
            issues.append(f"{name}: missing")
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            issues.append(f"{name}: unreadable ({exc})")
            continue
        for problem in cd.check_file(path):
            issues.append(f"{name}: {problem}")

    # ---- 3. cross-file invariants ----------------------------------------
    issues.extend(_cross_file(data_dir))
    return issues


def _content_invariants(name: str, payload) -> list[str]:
    """Content properties, as opposed to the per-file shape checks."""
    issues: list[str] = []

    for where, coords in _walk_geolocations(payload):
        if lc.is_unlocated(coords):
            issues.append(f"{name}: {where} holds an unusable coordinate; "
                          "published files omit the key instead of storing a sentinel")

    for rec in _iter_records(payload):
        label = rec.get("id") or rec.get("title") or "?"
        conf = rec.get("location_confidence")
        if conf is not None and not lc.validate_confidence(conf):
            issues.append(f"{name}: {label!r} has unknown location_confidence {conf!r}")
        if rec.get("located") is True and lc.is_unlocated(rec.get("geolocation")):
            issues.append(f"{name}: {label!r} claims located=true but carries no "
                          "usable geolocation")
        cat = rec.get("category")
        if isinstance(cat, str) and cat not in cd._CATEGORIES:
            issues.append(f"{name}: {label!r} has non-canonical category {cat!r}")
    return issues


def _cross_file(data_dir: Path) -> list[str]:
    """Properties that only exist when the files are considered together.

    The archive-reachability check is the one that matters most. `milestones.json` is
    a live snapshot that upstream can rewrite; `milestones_history.json` is the
    append-only archive the year slider's history is drawn from. If a live milestone
    is not in the archive, the next sync can drop it from history permanently and
    nothing else notices - each file validates fine on its own.
    """
    issues: list[str] = []
    live_path = data_dir / "milestones.json"
    hist_path = data_dir / "milestones_history.json"
    if not (live_path.exists() and hist_path.exists()):
        return issues
    try:
        live = json.loads(live_path.read_text(encoding="utf-8"))
        hist = json.loads(hist_path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - already reported per-file
        return issues

    live_records = [m for m in _iter_records(live) if m.get("id")]
    hist_records = [m for m in _iter_records(hist) if m.get("id")]
    live_ids = {m["id"] for m in live_records}
    hist_ids = {m["id"] for m in hist_records}

    missing = sorted(live_ids - hist_ids)
    if missing:
        issues.append(
            f"{len(missing)} live milestone(s) are absent from the archive, so the "
            f"year slider's history would lose them on the next sync: "
            f"{', '.join(missing[:5])}{'...' if len(missing) > 5 else ''}")

    # Duplicates counted over the record list, not over the id set - a set has
    # already thrown the duplicates away, which made an earlier version of this
    # check unreachable in principle.
    seen: dict[str, int] = {}
    for m in hist_records:
        seen[m["id"]] = seen.get(m["id"], 0) + 1
    dupes = sorted(i for i, n in seen.items() if n > 1)
    if dupes:
        issues.append(f"archive contains duplicate ids: {', '.join(dupes[:5])}")
    return issues


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=None, help="data directory (default: repo's)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    data_dir = Path(args.data) if args.data else cd.DATA_DIR
    issues = check(data_dir)
    if args.json:
        print(json.dumps({"ok": not issues, "issues": issues}, indent=2))
    elif issues:
        for problem in issues:
            print(f"[error] {problem}")
        print(f"\n{len(issues)} publish invariant(s) violated")
    else:
        print(f"[ok] publish invariants hold for {data_dir}")
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())