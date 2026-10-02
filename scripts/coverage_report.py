#!/usr/bin/env python3
"""Audit milestone geocoding and historical coverage.

Two questions this answers that the rest of the pipeline cannot:

1. *Where are the dots wrong or missing?* Counts records by geocoding outcome and
   lists the unlocated ones with whatever evidence exists, so a human (or a later
   pass) can fill them in rather than guess. It never invents a coordinate.

2. *What is the shape of the database?* Per-year and per-category counts for the
   year slider, including which years are empty. The milestone-check cron only
   reports on what changed; this reports on what is missing.

Read-only. Use --json for machine-readable output (CI, dashboards).

Usage:
    python scripts/coverage_report.py
    python scripts/coverage_report.py --json
    python scripts/coverage_report.py --min-year 1945 --max-year 2026
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_data as cd

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCES = ("data/milestones.json", "data/milestones_history.json",
                   "data/historical_milestones.json")


def load(rel: str) -> list[dict]:
    """Every milestone in one data file, whatever shape that file uses."""
    path = ROOT / rel
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        return [m for m in payload if isinstance(m, dict)]
    out: list[dict] = [m for m in (payload.get("milestones") or []) if isinstance(m, dict)]
    for cat in (payload.get("categories") or {}).values():
        if isinstance(cat, dict):
            out.extend(m for m in (cat.get("milestones") or []) if isinstance(m, dict))
    return out


def geocode_state(m: dict) -> str:
    """located / unlocated / null_island. Kept in sync with check_data's rule."""
    geo = m.get("geolocation")
    if geo is None:
        return "unlocated"
    if isinstance(geo, dict):
        lat, lon = geo.get("lat"), geo.get("lon")
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            return "null_island" if (lat == 0 and lon == 0) else "located"
    return "malformed"


def _by_category(records: list[dict]) -> dict:
    """Total per canonical vertical, including verticals with nothing yet.

    Rebuilt from the record list rather than reused from the per-year counter: the
    two have different shapes, and sharing a name between them is how a totals line
    ends up printing a Counter.
    """
    counts: collections.Counter = collections.Counter()
    for m in records:
        counts[m.get("category") or "(uncategorised)"] += 1
    out = {c: counts.get(c, 0) for c in cd._CATEGORIES}
    # Anything the schema does not know about must still be visible, not dropped.
    for name, n in counts.items():
        if name not in out:
            out[name] = n
    return out


def build(min_year: int, max_year: int, sources: tuple[str, ...]) -> dict:
    records = []
    for rel in sources:
        for m in load(rel):
            m = dict(m)
            m["_file"] = rel
            records.append(m)

    # Files overlap by design (milestones.json is the live set, the history file is
    # the append-only archive), so dedupe on the pair the pipeline itself uses.
    seen: dict[tuple, dict] = {}
    duplicates = 0
    for m in records:
        key = (str(m.get("title") or "").strip().lower(), str(m.get("date") or "")[:10])
        if key in seen:
            duplicates += 1
            continue
        seen[key] = m
    unique = list(seen.values())

    geo = collections.Counter(geocode_state(m) for m in unique)
    years = collections.Counter()
    cats: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    unlocated = []
    for m in unique:
        raw = str(m.get("date") or "")
        year = int(raw[:4]) if raw[:4].isdigit() else None
        if year:
            years[year] += 1
            cats[year][m.get("category") or "(uncategorised)"] += 1
        if geocode_state(m) == "unlocated":
            unlocated.append({
                "title": (m.get("title") or "")[:90],
                "date": raw[:10],
                "category": m.get("category"),
                "source": m.get("source"),
                "url": m.get("url"),
            })

    populated = sorted(y for y in years if min_year <= y <= max_year)
    empty = [y for y in range(min_year, max_year + 1) if y not in years]
    sparse = [{"year": y, "count": years[y],
               "categories": len(cats[y]),
               "only": sorted(cats[y])}
              for y in populated if years[y] < 3 or len(cats[y]) < 2]

    return {
        "totals": {
            "records_read": len(records),
            "unique": len(unique),
            "duplicate_across_files": duplicates,
            "located": geo["located"],
            "unlocated": geo["unlocated"],
            "null_island": geo["null_island"],
            "malformed": geo["malformed"],
        },
        "years": {
            "range": [min_year, max_year],
            "populated": len(populated),
            "empty": len(empty),
            "empty_years": empty,
            "sparse_years": sparse,
            "by_year": {str(y): years[y] for y in sorted(years)},
        },
        "by_category": _by_category(unique),
        "unlocated": unlocated,
    }


def render(r: dict) -> str:
    t, y = r["totals"], r["years"]
    lines = []
    lines.append("milestone coverage")
    lines.append("=" * 60)
    lines.append("  unique milestones      %d  (from %d records, %d duplicated across files)"
                 % (t["unique"], t["records_read"], t["duplicate_across_files"]))
    lines.append("  geocoded              %d" % t["located"])
    lines.append("  unlocated             %d   (no dot on the map - correct, not a bug)"
                 % t["unlocated"])
    if t["null_island"]:
        lines.append("  NULL ISLAND           %d   <-- bug: these plot in the Gulf of Guinea"
                     % t["null_island"])
    if t["malformed"]:
        lines.append("  malformed             %d" % t["malformed"])
    lines.append("")
    lines.append("  years %d-%d  populated %d / %d   empty %d"
                 % (y["range"][0], y["range"][1], y["populated"],
                    y["range"][1] - y["range"][0] + 1, y["empty"]))
    if y["empty_years"]:
        # Compress to ranges so a 51-year gap is one line, not 51.
        runs, start = [], None
        prev = None
        for yr in y["empty_years"]:
            if start is None:
                start = prev = yr
            elif yr == prev + 1:
                prev = yr
            else:
                runs.append((start, prev)); start = prev = yr
        if start is not None:
            runs.append((start, prev))
        lines.append("  empty years: " + ", ".join(
            ("%d-%d" % (a, b)) if a != b else "%d" % a for a, b in runs))
    if y["sparse_years"]:
        lines.append("")
        lines.append("  years with <3 milestones or a single category "
                     "(thin on the slider):")
        for s in y["sparse_years"][:20]:
            lines.append("    %d  n=%-3d cats=%d  %s"
                         % (s["year"], s["count"], s["categories"],
                            ", ".join(s["only"])[:60]))
    lines.append("")
    lines.append("  per-category totals:")
    for c in r["by_category"]:
        lines.append("    %-28s %d" % (c, r["by_category"][c]))
    if r["unlocated"]:
        lines.append("")
        lines.append("  unlocated records (%d) - evidence available for a geocoding pass:"
                     % len(r["unlocated"]))
        for u in r["unlocated"][:25]:
            lines.append("    %s  %-26s %s" % (u["date"] or "----------",
                                                str(u["category"])[:26],
                                                u["title"][:56]))
        if len(r["unlocated"]) > 25:
            lines.append("    ... and %d more" % (len(r["unlocated"]) - 25))
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--min-year", type=int, default=1945)
    ap.add_argument("--max-year", type=int, default=2026)
    ap.add_argument("--fail-on-null-island", action="store_true",
                    help="exit 1 if any record is geocoded to (0,0)")
    args = ap.parse_args()

    r = build(args.min_year, args.max_year, DEFAULT_SOURCES)
    print(json.dumps(r, indent=2) if args.json else render(r))
    if args.fail_on_null_island and r["totals"]["null_island"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())