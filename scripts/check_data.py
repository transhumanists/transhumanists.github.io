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
from datetime import timezone as _timezone
from itertools import combinations
from pathlib import Path

# This module is executed both as `python scripts/check_data.py` and imported by the
# test suite as `check_data`. The sibling import only resolves in the first case, so
# make the script directory explicit rather than relying on sys.path[0].
sys.path.insert(0, str(Path(__file__).resolve().parent))

import milestone_identity

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
REQUIRED_FILES = ("events.json", "world_layers.json", "milestones.json")

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

# The only categories an event may carry. Deliberately no catch-all: an unknown
# category is a data bug, and quietly rendering it as "Other" hides it. Legacy
# upstream names are folded into these by CATEGORY_ALIASES in sync_milestones.py.
_CATEGORIES = _SCHEMA.get("controls", {}).get("events", {}).get("categories", [])
_CATEGORY_SET = set(_CATEGORIES)

# The schema version world_layers.json must carry (written by sync_layers.py /
# fetch_crisis_zones.py, declared once in schema/worldmap-data.schema.json).
_FILE_VERSION = _SCHEMA.get("files", {}).get("world_layers.json", {}).get("version", "1.1.0")


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


def _today_iso() -> str:
    # UTC so validation is identical on every machine/CI runner: a date that just
    # rolled over locally must not flip a "has already passed" verdict elsewhere.
    return _datetime.now(_timezone.utc).replace(microsecond=0).isoformat()[:10]


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
    # Semantic rules for ZONES (not fleets, which keep their own lifecycle):
    # a concluded/ended zone without an end_date would stay on the timeline
    # forever (violating the "drops off after its end year" contract), an
    # active zone whose end_date has already passed is a contradiction the
    # writers must resolve by flipping it to concluded instead, and a
    # concluded zone with a future end_date was concluded prematurely.
    if kind in ("conflict_zones", "crisis_zones"):
        status_norm = status.strip().lower() if isinstance(status, str) else ""
        concluded_family = status_norm in {"concluded", "inactive", "ended", "resolved"}
        if concluded_family and not (isinstance(end, str) and end.strip()):
            issues.append(f"{kind}[{i}]: {status_norm!r} zone must carry an end_date")
        if not concluded_family and status_norm in {"active", "ongoing", ""}:
            if (
                isinstance(end, str) and end.strip()
                and _valid_date(end) and _date_bounds(end)[1] < _today_iso()
            ):
                issues.append(f"{kind}[{i}]: status {status_norm!r} but end_date {end.strip()} has already passed")
        elif concluded_family:
            if (
                isinstance(end, str) and end.strip()
                and _valid_date(end) and _date_bounds(end)[0] > _today_iso()
            ):
                issues.append(f"{kind}[{i}]: concluded zone end_date {end.strip()} lies in the future")
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
        # JS `new Date()` rejects separator-less basic formats (e.g. "20260315",
        # "20260315T100000") that fromisoformat happily accepts; keep the
        # validator aligned with what the map can actually render.
        return "-" in s or ":" in s or "/" in s or " " in s
    except ValueError:
        return False


# The map, the dashboard and the widgets all gate their source links on
# /^https?:\/\//i before assigning href, so any other scheme renders as a
# silently missing "View source" link instead of a catchable error. Milestone
# URLs arrive from the upstream repo via sync_milestones.archive_record, which
# passes url straight through, so validate the scheme here where it fails CI
# rather than in the browser. Deliberately the renderers' own prefix test and not
# something stricter, so this gate can never reject data the front end accepts.
# An absent URL stays legal: the link is simply omitted.
_SOURCE_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def _valid_source_url(value: object) -> bool:
    if value is None or value == "":
        return True
    if not isinstance(value, str):
        return False
    return _SOURCE_URL_RE.match(value.strip()) is not None


_DEDUPE_STOPWORDS = milestone_identity.DEDUPE_STOPWORDS
_content_tokens = milestone_identity.content_tokens


# Ceiling on duplicate-report findings. If this fires the data is broken in bulk,
# and printing one line per colliding pair would produce a six-figure log and a
# multi-second validation step; the count is reported instead.
_MAX_DUP_ISSUES = 50

# Bucket size past which the whole collision is reported as one finding instead of
# comparing pairs. Pairwise corroboration is only meaningful while the candidates
# could plausibly be distinct results; beyond this the bucket is bulk-duplicate.
_MAX_DUP_BUCKET = 25


def check_duplicate_reports(events: list) -> list[str]:
    """No two events may report the same metric on the same date.

    Enforces exactly the rule sync_milestones.unify_duplicate_milestones applies,
    via the shared milestone_identity helpers: identical date + value + category is
    what makes two records the same reported result, and they must additionally
    corroborate each other (shared specific URL or shared content title token).
    Published events drop `unit`, so this keys without it - the one asymmetry
    between the two callers, declared at the call site in milestone_identity.

    A surviving group means the dashboard counts one breakthrough twice and the map
    stacks two dots on one location, so it is a data bug rather than a cosmetic
    one.
    """
    issues: list[str] = []
    if not isinstance(events, list):
        return []
    buckets: dict[tuple, list] = {}
    for ev in events:
        if not isinstance(ev, dict):
            continue
        key = milestone_identity.report_group_key(ev, include_unit=False)
        if key is None:
            continue
        buckets.setdefault(key, []).append(ev)

    for key, group in buckets.items():
        if len(group) < 2:
            continue
        if len(group) > _MAX_DUP_BUCKET:
            # A bucket this large is itself the finding: far more records claim the
            # identical metric on the identical date than could be distinct
            # results. Reporting the collision avoids a quadratic scan over data
            # that is already known-broken, and points at the upstream source
            # rather than at individual pairs.
            issues.append(
                f"{len(group)} records report the same metric on {key[0]} "
                f"(value={key[1]}, category={key[-1]}); every one is a suspected "
                "duplicate - fix the upstream source"
            )
            if len(issues) >= _MAX_DUP_ISSUES:
                break
            continue
        # Delegates to the same predicate the unifier applies, so the validator
        # cannot disagree with the merge about what counts as a duplicate.
        for a, b in combinations(group, 2):
            if milestone_identity.same_report(a, b):
                issues.append(
                    f"duplicate report for date={key[0]} value={key[1]} "
                    f"category={key[-1]}: {a.get('id')} and {b.get('id')} "
                    f"({a.get('title')!r} / {b.get('title')!r})"
                )
                if len(issues) >= _MAX_DUP_ISSUES:
                    break
        if len(issues) >= _MAX_DUP_ISSUES:
            break
    if len(issues) >= _MAX_DUP_ISSUES:
        issues.append(
            f"...duplicate-report findings capped at {_MAX_DUP_ISSUES}; "
            "the feed is broadly duplicated, fix the upstream source"
        )
    return issues


def check_event_ordering(events: list) -> list[str]:
    """The published event list must be newest-first.

    merge_feed() sorts by (date, category, title) descending and every consumer
    inherits that order: build_events() writes it straight into events.json, the
    dashboard's "recent highlights" carousel renders in list order, and the map
    picks a co-located stack's lead member from event order. A transform in the
    middle of the pipeline that regroups (rather than filters) therefore unsorts
    the feed without tripping any per-record check - which is exactly how a
    duplicate-unification step shipped once with the newest milestone buried at
    index 54. Validated here so it cannot ship again.
    """
    issues: list[str] = []
    if not isinstance(events, list):
        return []
    dates = [e.get("date") for e in events if isinstance(e, dict) and isinstance(e.get("date"), str)]
    for i in range(1, len(dates)):
        if dates[i] > dates[i - 1]:
            issues.append(
                f"events are not newest-first: position {i} ({dates[i]}) is later than "
                f"position {i - 1} ({dates[i - 1]})"
            )
            # One report is enough; a fully reversed list would emit hundreds.
            break
    return issues


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
        elif _CATEGORY_SET and ev["category"] not in _CATEGORY_SET:
            issues.append(
                f"events[{i}]: category {ev['category']!r} is not one of "
                f"{sorted(_CATEGORY_SET)}"
            )
        if not _valid_event_date(ev.get("date")):
            issues.append(f"events[{i}]: date must be a parseable date string")
        if not _valid_source_url(ev.get("url")):
            issues.append(
                f"events[{i}]: url must be absent or an http(s) URL, got {ev.get('url')!r}"
            )
        geo = ev.get("geolocation")
        if not isinstance(geo, dict) or not _coord_ok(geo.get("lat"), geo.get("lon")):
            issues.append(f"events[{i}]: geolocation must be a finite lat/lon pair in range")
    # List-level invariants. Checked after the per-record pass so a malformed
    # record cannot make the ordering comparison itself throw.
    if not issues:
        issues.extend(check_event_ordering(events))
        issues.extend(check_duplicate_reports(events))
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
        if not _valid_source_url(z.get("url")):
            issues.append(
                f"{kind}[{i}]: url must be absent or an http(s) URL, got {z.get('url')!r}"
            )
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
        dep_kind = f.get("kind", "")
        is_infantry = dep_kind in ("infantry", "mobilization", "deployment", "rotation")
        if is_infantry:
            # Infantry deployments use lat/lon instead of from/to
            if not _coord_located(f.get("lat"), f.get("lon")):
                issues.append(f"{kind}[{i}]: lat/lon must be a located coordinate (finite, in range, not 0,0)")
        else:
            # Fleet/ground movements use from/to
            if not _coord_located(f.get("from", {}).get("lat") if isinstance(f.get("from"), dict) else None,
                                  f.get("from", {}).get("lon") if isinstance(f.get("from"), dict) else None):
                issues.append(f"{kind}[{i}]: from must be a located lat/lon pair (finite, in range, not 0,0)")
            if not _coord_located(f.get("to", {}).get("lat") if isinstance(f.get("to"), dict) else None,
                                  f.get("to", {}).get("lon") if isinstance(f.get("to"), dict) else None):
                issues.append(f"{kind}[{i}]: to must be a located lat/lon pair (finite, in range, not 0,0)")
        issues.extend(_check_lifecycle(kind, i, f))
    issues.extend(_check_unique_ids(kind, fleets if isinstance(fleets, list) else []))
    return issues


def check_milestones(data: object) -> list[str]:
    """Validate the canonical milestones archive that feeds the dashboard,
    widgets, and the timeline slider's year clustering. Mirrors the shapes
    the front end expects in assets/js/neohiro-widgets.js and the timeline
    code in assets/js/worldmap.js."""
    issues: list[str] = []
    if not isinstance(data, dict):
        return ["top-level JSON must be an object"]
    # Header check: version (any semver), last_update (required ISO-8601 UTC)
    version = data.get("version")
    if not isinstance(version, str) or re.fullmatch(r"\d+\.\d+\.\d+", version) is None:
        issues.append(f"version must be a semver string, got {version!r}")
    last_update = data.get("last_update")
    if not isinstance(last_update, str) or not last_update:
        issues.append("last_update must be a non-empty UTC timestamp string")
    else:
        try:
            ts = _datetime.fromisoformat(last_update.replace("Z", "+00:00"))
        except ValueError:
            issues.append(f"last_update {last_update!r} is not parseable as an ISO-8601 timestamp")
        else:
            if ts.tzinfo is None or ts.tzinfo.utcoffset(ts) is None:
                issues.append("last_update must carry a UTC offset (e.g. +00:00 or Z)")
    cats = data.get("categories")
    if not isinstance(cats, dict):
        issues.append("categories must be an object")
    else:
        for cat_key, cat in cats.items():
            if not isinstance(cat, dict):
                issues.append(f"categories[{cat_key}]: must be an object")
                continue
            milestones = cat.get("milestones")
            if not isinstance(milestones, list):
                issues.append(f"categories[{cat_key}].milestones: must be a list")
                continue
            for i, m in enumerate(milestones):
                if not isinstance(m, dict):
                    issues.append(f"categories[{cat_key}].milestones[{i}]: entry must be an object")
                    continue
                if not isinstance(m.get("id"), str):
                    issues.append(f"categories[{cat_key}].milestones[{i}].id: must be a string")
                if not isinstance(m.get("title"), str):
                    issues.append(f"categories[{cat_key}].milestones[{i}].title: must be a string")
                if not isinstance(m.get("category"), str):
                    issues.append(f"categories[{cat_key}].milestones[{i}].category: must be a string")
                if not isinstance(m.get("subcategory"), str):
                    issues.append(f"categories[{cat_key}].milestones[{i}].subcategory: must be a string")
                if not _valid_event_date(m.get("date")):
                    issues.append(f"categories[{cat_key}].milestones[{i}].date: must be a parseable date string")
                geo = m.get("geolocation")
                if not isinstance(geo, dict) or not _coord_ok(geo.get("lat"), geo.get("lon")):
                    issues.append(f"categories[{cat_key}].milestones[{i}].geolocation: must be a finite lat/lon pair in range")
                if not _valid_source_url(m.get("url")):
                    issues.append(
                        f"categories[{cat_key}].milestones[{i}].url: must be absent or an http(s) URL, got {m.get('url')!r}"
                    )
                for flag in ("is_record", "is_breakthrough", "is_new"):
                    if flag in m and not isinstance(m[flag], bool):
                        issues.append(f"categories[{cat_key}].milestones[{i}].{flag}: must be a boolean if present")
                # Written by unify_duplicate_milestones() when one reported result
                # arrived from several sources. It must be a non-empty list of
                # non-empty strings, and it only appears on a merged record, so it
                # is validated rather than ignored.
                if "sources" in m:
                    srcs = m["sources"]
                    if not isinstance(srcs, list) or not srcs:
                        issues.append(
                            f"categories[{cat_key}].milestones[{i}].sources: must be a non-empty list when present"
                        )
                    elif any(not isinstance(s, str) or not s.strip() for s in srcs):
                        issues.append(
                            f"categories[{cat_key}].milestones[{i}].sources: entries must be non-empty strings"
                        )
                    elif len(set(srcs)) != len(srcs):
                        issues.append(
                            f"categories[{cat_key}].milestones[{i}].sources: contains duplicate source names"
                        )
            # Per-category newest-first, for the same reason as events.json: the
            # dashboard and the catalog render each bucket in list order.
            dates = [
                m.get("date")
                for m in milestones
                if isinstance(m, dict) and isinstance(m.get("date"), str)
            ]
            for i in range(1, len(dates)):
                if dates[i] > dates[i - 1]:
                    issues.append(
                        f"categories[{cat_key}].milestones: not newest-first at position {i} "
                        f"({dates[i]} after {dates[i - 1]})"
                    )
                    break
    return issues


def check_human_rights(items: object) -> list[str]:
    """Validate the Human Rights Violations layer.

    A toggleable operational layer, not a milestone category: it is absent from
    controls.events.categories, never appears in a category filter, and defaults
    to OFF on the map. Entries render as landmarks with milestone tooltips, so they
    are held to the same located-pair and lifecycle rules as the other layers.
    """
    issues: list[str] = []
    if items is None:
        # Optional until the first fetch writes the key.
        return issues
    if not isinstance(items, list):
        return ["human_rights_violations must be a list"]
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            issues.append(f"human_rights_violations[{i}]: entry must be an object")
            continue
        if not isinstance(item.get("id"), str) or not item["id"].strip():
            issues.append(f"human_rights_violations[{i}].id: must be a non-empty string")
        if not isinstance(item.get("name"), str) or not item["name"].strip():
            issues.append(f"human_rights_violations[{i}].name: must be a non-empty string")
        if not _coord_located(item.get("lat"), item.get("lon")):
            issues.append(
                f"human_rights_violations[{i}]: must carry a located lat/lon pair "
                f"(not null island), got ({item.get('lat')!r}, {item.get('lon')!r})"
            )
        issues.extend(
            _check_lifecycle("human_rights_violations", i, item)
        )
        if not _valid_source_url(item.get("url")):
            issues.append(
                f"human_rights_violations[{i}].url: must be absent or an http(s) URL, "
                f"got {item.get('url')!r}"
            )
    issues.extend(_check_unique_ids("human_rights_violations", items))
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
            _check_header(data)
            + check_zones(data.get("conflict_zones"))
            + check_crisis_zones(data.get("crisis_zones"))
            + check_fleets(deployments, kind=kind)
            + check_human_rights(data.get("human_rights_violations"))
        )
    if filename == "milestones.json":
        return check_milestones(data)
    return [f"unsupported data file: {filename}"]


def _check_header(data: dict) -> list[str]:
    """Top-level contract for world_layers.json: the schema version in force and
    a parseable UTC last_update timestamp (both writers always set these)."""
    issues: list[str] = []

    version = data.get("version")
    if not isinstance(version, str) or re.fullmatch(r"\d+\.\d+\.\d+", version) is None:
        issues.append(f"version must be a semver string, got {version!r}")
    elif version != _FILE_VERSION:
        issues.append(f"version {version!r} does not match the schema's expected {_FILE_VERSION!r}")

    last_update = data.get("last_update")
    if not isinstance(last_update, str) or not last_update:
        issues.append("last_update must be a non-empty UTC timestamp string")
        return issues
    try:
        ts = _datetime.fromisoformat(last_update.replace("Z", "+00:00"))
    except ValueError:
        issues.append(f"last_update {last_update!r} is not parseable as an ISO-8601 timestamp")
    else:
        if ts.tzinfo is None or ts.tzinfo.utcoffset(ts) is None:
            issues.append("last_update must carry a UTC offset (e.g. +00:00 or Z)")
    return issues


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