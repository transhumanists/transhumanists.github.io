#!/usr/bin/env python3
"""Validate the worldmap's data files against the shapes the front end consumes.

Mirrors the runtime predicates in assets/js/worldmap.js (isPlottable,
isZonePlottable, isFleetPlottable) so malformed data fails in CI instead of
rendering silently-garbled layers (NaN dots/arrows) in production.

Usage:
    python scripts/check_data.py             # checks the repo's data/ directory
    python scripts/check_data.py DIR...      # checks given dirs (each must hold
                                             # events.json + world_layers.json)
Exit code is 1 if any problem is found.
"""
from __future__ import annotations

import json
import math
import re
import sys
from datetime import date as _date
from datetime import datetime as _datetime
from datetime import timedelta as _timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
REQUIRED_FILES = ("events.json", "world_layers.json")

# Single source of truth for the data contract (schema/worldmap-data.schema.json).
# The defaults below keep this module runnable if the schema is ever removed,
# but the parity tests in test_check_data.py fail loudly in CI on any drift.
_SCHEMA_FILE = ROOT / "schema" / "worldmap-data.schema.json"
_SCHEMA = json.loads(_SCHEMA_FILE.read_text(encoding="utf-8")) if _SCHEMA_FILE.exists() else {}

_COORD_CTRL = _SCHEMA.get("controls", {}).get("coordinate", {})
_LAT_MIN = float(_COORD_CTRL.get("lat_min", -90.0))
_LAT_MAX = float(_COORD_CTRL.get("lat_max", 90.0))
_LON_MIN = float(_COORD_CTRL.get("lon_min", -180.0))
_LON_MAX = float(_COORD_CTRL.get("lon_max", 180.0))

_LIFECYCLE_CTRL = _SCHEMA.get("controls", {}).get("layer_lifecycle", {})
_STATUS_VALUES = set(
    _LIFECYCLE_CTRL.get("status_values", ["active", "ongoing", "concluded", "inactive", "ended", "resolved"])
)
_DATE_RE = re.compile(_LIFECYCLE_CTRL.get("date_pattern", r"^\d{4}(-\d{2}){0,2}$"))


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
        _is_number(lat) and _LAT_MIN <= float(lat) <= _LAT_MAX
        and _is_number(lon) and _LON_MIN <= float(lon) <= _LON_MAX
    )


def _coord_located(lat: object, lon: object) -> bool:
    # Layers are never geocoded at load time, so "(0, 0)" — the "no location"
    # marker used by worldmap.js normalizeEvent — must not be accepted: it would
    # plot a glowing halo over Null Island (Gulf of Guinea) and mislead readers.
    return _coord_ok(lat, lon) and not (float(lat) == 0.0 and float(lon) == 0.0)


# Layer lifecycle schema (drives the fluo/dim rendering + duration tooltips in
# the worldmap): status must be one of the known values and the date fields must
# be sane. Empty/absent fields are allowed (active layers may have no end date).
# The status list and date regex are loaded from schema/worldmap-data.schema.json
# (see the constants computed above).


def _valid_date(value: object) -> bool:
    if value is None or value == "":
        return True
    if not isinstance(value, str):
        return False
    s = value.strip()
    if not _DATE_RE.fullmatch(s):
        return False
    parts = s.split("-")
    if len(parts) >= 2 and not 1 <= int(parts[1]) <= 12:
        return False
    if len(parts) == 3:
        try:
            _date.fromisoformat(s)
        except ValueError:
            return False
    return True


def _month_end(ym: str) -> str:
    year, month = ym.split("-")
    if month == "12":
        return f"{year}-12-31"
    next_month = _date.fromisoformat(f"{year}-{int(month) + 1:02d}-01")
    return (next_month - _timedelta(days=1)).isoformat()


def _date_bounds(value: str) -> tuple[str, str]:
    """Earliest and latest ISO dates a partial date (YYYY or YYYY-MM) could
    represent; full dates bound to themselves. Caller guarantees a valid date."""
    s = value.strip()
    if len(s) == 4:
        return f"{s}-01-01", f"{s}-12-31"
    if len(s) == 7:
        return f"{s}-01", _month_end(s)
    return s, s


def _check_lifecycle(kind: str, i: int, item: dict) -> list[str]:
    issues: list[str] = []
    status = item.get("status")
    if status is not None and (
        not isinstance(status, str) or status.strip().lower() not in _STATUS_VALUES
    ):
        issues.append(f"{kind}[{i}]: status must be one of {sorted(_STATUS_VALUES)}")
    for field in ("start_date", "end_date"):
        if not _valid_date(item.get(field)):
            issues.append(f"{kind}[{i}]: {field} must be YYYY-MM-DD, YYYY-MM or YYYY")
    start = item.get("start_date")
    end = item.get("end_date")
    # Ordering semantics (same-length ISO partial dates order lexicographically):
    #   * equal precision -> start > end is an unambiguous inversion.
    #   * mixed precision -> flag only a PROVABLE inversion: the earliest instant
    #     the start could be is after the latest instant the end could be
    #     (e.g. start "2025" vs end "2024-12" is an empty window whatever the
    #     real day; start "2024" vs end "2024-06-30" stays valid/unflagged).
    if (
        isinstance(start, str) and isinstance(end, str)
        and _valid_date(start) and _valid_date(end)
        and start.strip() and end.strip()
    ):
        s, e = start.strip(), end.strip()
        if len(s) == len(e):
            if s > e:
                issues.append(f"{kind}[{i}]: start_date must not be after end_date")
        else:
            start_min, _ = _date_bounds(s)
            _, end_max = _date_bounds(e)
            if start_min > end_max:
                issues.append(f"{kind}[{i}]: start_date is after end_date (empty window)")
    return issues


def _check_unique_ids(kind: str, items: list) -> list[str]:
    issues: list[str] = []
    seen: dict[str, int] = {}
    for i, item in enumerate(items):
        if isinstance(item, dict):
            ident = item.get("id")
            if isinstance(ident, str) and ident:
                if ident in seen:
                    issues.append(
                        f"{kind}: duplicate id {ident!r} (entries {seen[ident]} and {i})"
                    )
                else:
                    seen[ident] = i
    return issues


def _valid_event_date(value: object) -> bool:
    # Mirrors the shapes worldmap.js parseDateToISO accepts (YYYY-MM-DD,
    # D-M-YYYY / D/M/YYYY, plus a Date-constructor fallback covering partial
    # YYYY / YYYY-MM), but enforces calendar validity so fake dates such as
    # "2026-02-30" fail CI instead of rendering non-dates on the map.
    if not isinstance(value, str):
        return False
    s = value.strip()
    ym = re.fullmatch(r"(\d{4})-(\d{2})", s)
    if ym:
        year, month = int(ym[1]), int(ym[2])
        return 1 <= year <= 9999 and 1 <= month <= 12
    if re.fullmatch(r"\d{4}", s):
        return True
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        try:
            _date(int(m[1]), int(m[2]), int(m[3]))
            return True
        except ValueError:
            return False
    m = re.fullmatch(r"(\d{1,2})[-/](\d{1,2})[-/](\d{4})", s)
    if m:
        try:
            _date(int(m[3]), int(m[2]), int(m[1]))
            return True
        except ValueError:
            return False
    try:
        _datetime.fromisoformat(s)
        return True
    except ValueError:
        return False


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
        if not _valid_event_date(ev.get("date")):
            issues.append(f"events[{i}]: date must be a parseable date string")
        geo = ev.get("geolocation")
        if not isinstance(geo, dict) or not _coord_ok(geo.get("lat"), geo.get("lon")):
            issues.append(f"events[{i}]: geolocation must be a finite lat/lon pair in range")
    return issues


def check_zones(zones: object, kind: str = "conflict_zones") -> list[str]:
    issues: list[str] = []
    if not isinstance(zones, list):
        return [f"{kind} must be a list"]
    for i, z in enumerate(zones):
        if not isinstance(z, dict):
            issues.append(f"{kind}[{i}]: entry must be an object")
            continue
        if not isinstance(z.get("name"), str):
            issues.append(f"{kind}[{i}]: name must be a string")
        if not _coord_located(z.get("lat"), z.get("lon")):
            issues.append(f"{kind}[{i}]: lat/lon must be located (finite, in range, not 0,0)")
        issues.extend(_check_lifecycle(kind, i, z))
    issues.extend(_check_unique_ids(kind, zones if isinstance(zones, list) else []))
    return issues


def check_crisis_zones(zones: object) -> list[str]:
    # Crisis zones share the conflict-zone contract consumed by the front end
    # (normalizeZone/isLayerActive), so they must satisfy the same checks.
    return check_zones(zones, kind="crisis_zones")


def check_fleets(fleets: object, kind: str = "deployments") -> list[str]:
    issues: list[str] = []
    if not isinstance(fleets, list):
        return [f"{kind} must be a list"]
    for i, f in enumerate(fleets):
        if not isinstance(f, dict):
            issues.append(f"{kind}[{i}]: entry must be an object")
            continue
        if not _coord_located(f.get("from", {}).get("lat") if isinstance(f.get("from"), dict) else None,
                              f.get("from", {}).get("lon") if isinstance(f.get("from"), dict) else None):
            issues.append(f"{kind}[{i}]: from must be a located lat/lon pair (finite, in range, not 0,0)")
        if not _coord_located(f.get("to", {}).get("lat") if isinstance(f.get("to"), dict) else None,
                              f.get("to", {}).get("lon") if isinstance(f.get("to"), dict) else None):
            issues.append(f"{kind}[{i}]: to must be a located lat/lon pair (finite, in range, not 0,0)")
        issues.extend(_check_lifecycle(kind, i, f))
    issues.extend(_check_unique_ids(kind, fleets if isinstance(fleets, list) else []))
    return issues


def check_data(data: dict, filename: str) -> list[str]:
    if not isinstance(data, dict):
        return ["top-level JSON must be an object"]
    if filename == "events.json":
        return check_events(data.get("events"))
    if filename == "world_layers.json":
        # Accept both "deployments" (new) and "fleet_movements" (legacy)
        deployments = data.get("deployments")
        kind = "deployments"
        if deployments is None:
            deployments = data.get("fleet_movements")
            kind = "fleet_movements"
        return (
            check_zones(data.get("conflict_zones"))
            + check_crisis_zones(data.get("crisis_zones"))
            + check_fleets(deployments, kind=kind)
        )
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