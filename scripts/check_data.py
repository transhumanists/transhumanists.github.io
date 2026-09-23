#!/usr/bin/env python3
"""Validate the worldmap's data files against the shapes the front end consumes.

Mirrors the runtime predicates in assets/js/worldmap.js (isPlottable,
isZonePlottable, isFleetPlottable) so malformed data fails in CI instead of
rendering silently-garbled layers (NaN dots/arrows) in production.

Usage:
    python scripts/check_data.py             # checks the reenv data/ directory
    python scripts/check_data.py DIR...      # checks given dirs (each must hold
                                             # events.json + world_layers.json)
Exit code is 1 if any problem is found.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
REQUIRED_FILES = ("events.json", "world_layers.json")


def _is_number(v: object) -> bool:
    # JSON has no NaN/Infinity literal, but "1e400" parses to float('inf');
    # reject that *and* bool, exactly like Number.isFinite on the JS side.
    return (
        isinstance(v, (int, float))
        and not isinstance(v, bool)
        and math.isfinite(float(v))
    )


def _coord_ok(lat: object, lon: object) -> bool:
    return (
        _is_number(lat) and -90.0 <= float(lat) <= 90.0
        and _is_number(lon) and -180.0 <= float(lon) <= 180.0
    )


def check_events(events: object) -> list[str]:
    issues: list[str] = []
    if not isinstance(events, list):
        return ["events must be a list"]
    for i, ev in enumerate(events):
        if not isinstance(ev, dict):
            issues.append(f"events[{i}]: entry must be an object")
            continue
        if not isinstance(ev.get("title"), str):
            issues.append(f"events[{i}]: title must be a string")
        if not isinstance(ev.get("category"), str):
            issues.append(f"events[{i}]: category must be a string")
        geo = ev.get("geolocation")
        if not isinstance(geo, dict) or not _coord_ok(geo.get("lat"), geo.get("lon")):
            issues.append(f"events[{i}]: geolocation must be a finite lat/lon pair in range")
    return issues


def check_zones(zones: object) -> list[str]:
    issues: list[str] = []
    if not isinstance(zones, list):
        return ["conflict_zones must be a list"]
    for i, z in enumerate(zones):
        if not isinstance(z, dict):
            issues.append(f"conflict_zones[{i}]: entry must be an object")
            continue
        if not isinstance(z.get("name"), str):
            issues.append(f"conflict_zones[{i}]: name must be a string")
        if not _coord_ok(z.get("lat"), z.get("lon")):
            issues.append(f"conflict_zones[{i}]: lat/lon must be finite and in range")
    return issues


def check_fleets(fleets: object) -> list[str]:
    issues: list[str] = []
    if not isinstance(fleets, list):
        return ["fleet_movements must be a list"]
    for i, f in enumerate(fleets):
        if not isinstance(f, dict):
            issues.append(f"fleet_movements[{i}]: entry must be an object")
            continue
        if not _coord_ok(f.get("from", {}).get("lat") if isinstance(f.get("from"), dict) else None,
                         f.get("from", {}).get("lon") if isinstance(f.get("from"), dict) else None):
            issues.append(f"fleet_movements[{i}]: from must be a finite lat/lon pair in range")
        if not _coord_ok(f.get("to", {}).get("lat") if isinstance(f.get("to"), dict) else None,
                         f.get("to", {}).get("lon") if isinstance(f.get("to"), dict) else None):
            issues.append(f"fleet_movements[{i}]: to must be a finite lat/lon pair in range")
    return issues


def check_data(data: dict, filename: str) -> list[str]:
    if not isinstance(data, dict):
        return ["top-level JSON must be an object"]
    if filename == "events.json":
        return check_events(data.get("events"))
    if filename == "world_layers.json":
        # Accept both "deployments" (new) and "fleet_movements" (legacy)
        deployments = data.get("deployments")
        if deployments is None:
            deployments = data.get("fleet_movements")
        return check_zones(data.get("conflict_zones")) + check_fleets(deployments)
    return [f"unsupported data file: {filename}"]


def check_file(path: Path) -> list[str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - surface any read/parse failure
        return [f"unreadable/unparseable JSON: {exc}"]
    return check_data(data, path.name)


def main(argv: list[str]) -> int:
    roots = [Path(a) for a in argv] or [DATA_DIR]
    targets: list[Path] = []
    for root in roots:
        if root.is_dir():
            targets.extend(root / f for f in REQUIRED_FILES)
        else:
            targets.append(root)

    problems = 0
    for path in targets:
        if not path.exists():
            print(f"[error] {path}: file missing")
            problems += 1
            continue
        issues = check_file(path)
        if issues:
            for issue in issues:
                print(f"[error] {path}: {issue}")
            problems += len(issues)
        else:
            print(f"[ok] {path}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))