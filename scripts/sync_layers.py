#!/usr/bin/env python3
"""
Sync the worldmap's operational layers (conflict zones + fleet deployments)
into data/world_layers.json.

What this script does:
  * conflict_zones: parses Wikipedia's "List of ongoing armed conflicts"
    (Major wars / Minor wars / Conflicts tiers). Enriches existing curated
    zones with start dates and appends newly-listed, geo-locatable conflicts.
    Curated active zones are never dropped (they are authoritative hand-picks).
  * deployments: normalizes the lifecycle schema (status / start_date /
    end_date). No conclusion states are fabricated; a deployment is only marked
    "concluded" when an explicit end_date exists.
  * crisis_zones: NOT managed here (kept separate) - the daily
    crisis-zone-fetch.yml workflow owns that key via fetch_crisis_zones.py.
  * Writes are content-gated: the fingerprint excludes 'last_update', so a
    no-op run never modifies the file (no empty commits).

The script is offline-safe: any Wikipedia fetch/parse failure keeps the
previous conflict_zones and only the lifecycle normalization is applied.

Usage:
    python scripts/sync_layers.py               # online, print changes only
    python scripts/sync_layers.py --write       # online, write when changed
    python scripts/sync_layers.py --offline     # normalize only, no network
    python scripts/sync_layers.py --json PATH   # target a different file
Exit code is 0 even when changes are reported; use the fingerprint/return to
decide whether to commit (mirrors sync_milestones.py conventions).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from fetch_crisis_zones import fetch_url

WIKIPEDIA_API = (
    "https://en.wikipedia.org/w/api.php"
    "?action=parse&page=List_of_ongoing_armed_conflicts"
    "&prop=wikitext&format=json&formatversion=2"
)
WIKIPEDIA_REF = "https://en.wikipedia.org/wiki/List_of_ongoing_armed_conflicts"

WORLD_LAYERS_FILE = Path("data/world_layers.json")
LIFECYCLE_VERSION = "1.1.0"

# Wikipedia tier -> collision radius (degrees) for the map. Skirmishes are
# parsed but never promoted to map zones (too noisy for a planet-wide view).
TIER_RADIUS = {"major": 5.0, "minor": 4.0, "conflict": 3.0}
TIER_ORDER = {"major": 0, "minor": 1, "conflict": 2}

MAX_TOTAL_ZONES = 30
MAX_NEW_WIKI_ZONES = 12


# Approximate country centroids (lat, lon) used to place conflict zones that
# Wikipedia only tags with flag templates. Grows organically as new conflicts
# appear; anything not in this table is skipped, never guessed.
COUNTRY_COORDS: dict[str, tuple[float, float]] = {
    "afghanistan": (33.94, 67.71),
    "angola": (-12.30, 17.54),
    "armenia": (40.07, 45.04),
    "azerbaijan": (40.14, 47.58),
    "bangladesh": (23.68, 90.36),
    "burkina faso": (12.24, -1.56),
    "cambodia": (12.57, 104.99),
    "cameroon": (7.37, 12.35),
    "chad": (15.45, 18.73),
    "china": (35.86, 104.20),
    "colombia": (4.57, -74.30),
    "congo": (-0.23, 15.83),
    "cote d'ivoire": (7.54, -5.55),
    "cyprus": (35.13, 33.43),
    "dr congo": (-4.04, 21.75),
    "ecuador": (-1.83, -78.18),
    "egypt": (26.82, 30.80),
    "el salvador": (13.79, -88.90),
    "eritrea": (15.18, 39.79),
    "ethiopia": (9.15, 40.49),
    "georgia": (42.32, 43.36),
    "guatemala": (15.78, -90.23),
    "haiti": (18.97, -72.29),
    "honduras": (15.20, -86.24),
    "india": (20.59, 78.96),
    "indonesia": (-0.79, 113.92),
    "iran": (32.43, 53.68),
    "iraq": (33.32, 43.68),
    "israel": (31.05, 34.85),
    "jordan": (30.59, 36.24),
    "kashmir": (33.78, 76.58),
    "laos": (19.86, 102.50),
    "lebanon": (33.85, 35.86),
    "libya": (26.34, 17.23),
    "mali": (17.57, -3.99),
    "mexico": (23.63, -102.55),
    "mozambique": (-18.67, 35.53),
    "myanmar": (21.92, 95.96),
    "niger": (17.61, 8.08),
    "nigeria": (9.08, 8.68),
    "pakistan": (30.38, 69.35),
    "palestine": (31.95, 35.23),
    "papua new guinea": (-6.31, 143.96),
    "peru": (-9.19, -75.02),
    "philippines": (12.88, 121.77),
    "russia": (55.75, 37.62),
    "saudi arabia": (23.89, 45.08),
    "somalia": (5.15, 46.20),
    "south africa": (-30.56, 22.94),
    "south sudan": (6.88, 31.31),
    "sudan": (12.86, 30.22),
    "syria": (34.80, 39.00),
    "thailand": (15.87, 100.99),
    "togo": (8.62, 0.82),
    "turkey": (38.96, 35.24),
    "ukraine": (48.38, 31.17),
    "united states": (37.09, -95.71),
    "venezuela": (6.42, -66.59),
    "west bank": (32.15, 35.30),
    "yemen": (15.55, 48.52),
}

COUNTRY_ALIASES = {
    "burma": "myanmar",
    "birmania": "myanmar",
    "democratic republic of the congo": "dr congo",
    "democratic republic of congo": "dr congo",
    "drc": "dr congo",
    "republic of the congo": "congo",
    "ivory coast": "cote d'ivoire",
    "rusia": "russia",
}


def _section_tier(title: str) -> str | None:
    t = title.lower()
    if "major war" in t:
        return "major"
    if "minor war" in t:
        return "minor"
    if "skirmish" in t or "clash" in t:
        return "skirmish"
    if t.startswith("conflict") or t.startswith("conflicts"):
        return "conflict"
    return None


def _country_key(name: str) -> str:
    cleaned = re.sub(r"[^a-z' ]+", "", name.strip().lower())
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return COUNTRY_ALIASES.get(cleaned, cleaned)


def country_centroid(name: str) -> tuple[float, float] | None:
    if not isinstance(name, str):
        return None
    key = _country_key(name)
    if key in COUNTRY_COORDS:
        return COUNTRY_COORDS[key]
    # Fuzzy match: a flag label like "DR Congo" -> "dr congo".
    for known, coord in COUNTRY_COORDS.items():
        if key and (key in known or known in key):
            return coord
    return None


# ---------------------------------------------------------------- parsing


def fetch_wikipedia_wikitext(url: str = WIKIPEDIA_API) -> str | None:
    data = fetch_url(url)
    if not data:
        return None
    try:
        payload = json.loads(data)
        wikitext = payload.get("parse", {}).get("wikitext")
        mode = payload.get("parse", {}).get("contentmodel") if wikitext is None else None
        if wikitext is None and mode == "wikitext":
            # Some API configs mirror the text under a different key.
            wikitext = payload.get("parse", {}).get("text")
        if isinstance(wikitext, str):
            return wikitext
    except (json.JSONDecodeError, AttributeError, KeyError, TypeError):
        pass
    return None


def _split_row_cells(lines: list[str]) -> list[str]:
    text = "\n".join(lines)
    parts = re.split(r"^(?:\s*\|)|\|\|", text, flags=re.MULTILINE)
    cells = [p.strip() for p in parts if p.strip()]
    # Drop header cells (start with '!') and any pure-pipe filler rows.
    if cells and cells[0].startswith("!"):
        return []
    return cells


def _cell_year(cell: str) -> int | None:
    m = re.search(r"(\d{4})", cell)
    return int(m.group(1)) if m else None


def _cell_conflict_name(cell: str) -> str | None:
    lines = [ln for ln in cell.splitlines() if ln.lstrip().startswith("*")]
    if not lines:
        m = re.search(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", cell)
        return (m.group(2) or m.group(1)).strip() if m else None
    for ln in lines:
        m = re.search(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", ln)
        if m:
            return (m.group(2) or m.group(1)).strip()
    return None


def _cell_continent(cell: str) -> str:
    m = re.search(r"\[\[\s*([^\]|]+?)(?:\|([^\]]+))?\s*\]\]", cell)
    return (m.group(2) or m.group(1)).strip() if m else ""


def _cell_countries(cell: str) -> list[str]:
    countries = re.findall(
        r"\{\{(?:flag|flagicon|flagu|flagcountry)\|([^}|]+)", cell, re.IGNORECASE
    )
    countries = [c.strip() for c in countries if c.strip()]
    return countries


def parse_wikipedia_conflicts(wikitext: str) -> list[dict]:
    """Parse the four-tier conflict table into dicts.

    Each result: {year, name, continent, countries, tier}. Rows that lack a
    year, a conflict link, or land outside the four tiers are skipped.
    """
    conflicts: list[dict] = []
    tier: str | None = None
    rows: list[list[str]] = []
    current: list[str] = []

    def flush() -> None:
        if current and tier:
            rows.append((tier, list(current)))
        current.clear()

    for raw in wikitext.splitlines():
        line = raw.rstrip()
        match = re.match(r"^=+\s*(.*?)\s*=+\s*$", line)
        if match:
            flush()
            tier = _section_tier(match.group(1))
            continue
        stripped = line.strip()
        if stripped == "|-":
            flush()
            if tier:
                current = []
            continue
        if stripped.startswith("|}"):
            flush()
            continue
        if tier and not stripped.startswith(("{|", "|+", "!")):
            current.append(line)

    flush()

    for row_tier, raw_lines in rows:
        cells = _split_row_cells(raw_lines)
        if len(cells) < 3 or not cells[0].startswith("style"):
            continue
        year = _cell_year(cells[0]) if len(cells) > 0 else None
        name = _cell_conflict_name(cells[1]) if len(cells) > 1 else None
        if year is None or not name or len(name) < 3:
            continue
        continent = _cell_continent(cells[2]) if len(cells) > 2 else ""
        countries = _cell_countries(cells[3]) if len(cells) > 3 else []
        conflicts.append(
            {
                "year": year,
                "name": name,
                "continent": continent,
                "countries": countries,
                "tier": row_tier,
            }
        )
    return conflicts


# ------------------------------------------------------------- zone build


def _zone_id(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40]
    return f"zone-{slug}"


def conflict_zones_from_wikipedia(items: list[dict]) -> list[dict]:
    """Turn parsed conflict rows into map zones (skipping noisy tiers)."""
    zones: list[dict] = []
    for item in items:
        if item["tier"] not in TIER_RADIUS:
            continue
        name = item["name"]
        country = next((c for c in item["countries"] if country_centroid(c)), None)
        if country is None:
            continue
        lat, lon = country_centroid(country)
        zones.append(
            {
                "id": _zone_id(name),
                "name": name,
                "region": item["continent"],
                "lat": lat,
                "lon": lon,
                "radiusDeg": TIER_RADIUS[item["tier"]],
                "tier": item["tier"],
                "countries": item["countries"],
                "status": "active",
                "start_date": f"{item['year']:04d}-01-01",
                "end_date": "",
                "source": "Wikipedia (List of ongoing armed conflicts)",
                "url": WIKIPEDIA_REF,
            }
        )
    return zones


def _zone_matches(zone: dict, wzone: dict) -> bool:
    hay = " ".join(
        str(zone.get(k, "")) for k in ("name", "region", "id")
    ).lower()
    for c in wzone.get("countries", []):
        if c.lower() in hay:
            return True
    return False


def merge_conflict_zones(
    curated: list[dict], wiki_zones: list[dict], max_new_zones: int | None = None
) -> tuple[list[dict], list[str]]:
    """Merge wiki-derived zones into curated ones; log every change made."""
    changes: list[str] = []
    curated = list(curated)
    max_new_zones = MAX_NEW_WIKI_ZONES if max_new_zones is None else max_new_zones
    wiki = sorted(
        wiki_zones,
        key=lambda z: (TIER_ORDER.get(z.get("tier"), 9), z.get("name", "")),
    )

    matched: set[int] = set()
    for ci, czone in enumerate(curated):
        if not czone.get("start_date"):
            for wi, wzone in enumerate(wiki):
                if wi not in matched and _zone_matches(czone, wzone):
                    czone["start_date"] = wzone["start_date"]
                    czone.setdefault("source", wzone["source"])
                    czone.setdefault("url", wzone["url"])
                    changes.append(f"enriched {czone.get('id')} start_date={wzone['start_date']}")
                    matched.add(wi)
                    break

    added = 0
    for wzone in wiki:
        if wzone.get("id") in {z.get("id") for z in curated} or any(
            _zone_matches(z, wzone) for z in curated
        ):
            continue
        if len(curated) >= MAX_TOTAL_ZONES or added >= max_new_zones:
            break
        curated.append(wzone)
        changes.append(f"added {wzone['id']} ({wzone['name']}) since {wzone['start_date']}")
        added += 1

    return curated, changes


# ----------------------------------------------------------- normalization


def _clean_date(value: object) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        return ""
    return value.strip()


def normalize_lifecycle_zone(zone: dict) -> dict:
    zone = dict(zone)
    zone.setdefault("status", "active")
    zone["start_date"] = _clean_date(zone.get("start_date"))
    zone["end_date"] = _clean_date(zone.get("end_date"))
    return zone


def normalize_lifecycle_fleet(fleet: dict) -> dict:
    fleet = dict(fleet)
    fleet["start_date"] = _clean_date(fleet.get("start_date"))
    fleet["end_date"] = _clean_date(fleet.get("end_date"))
    status = fleet.get("status")
    if status is None:
        fleet["status"] = "concluded" if fleet["end_date"] else "active"
    return fleet


# ------------------------------------------------------------ merge + save


def content_fingerprint(data: dict) -> str:
    payload = {k: v for k, v in data.items() if k != "last_update"}
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def build_updated_layers(
    data: dict, offline: bool, wikipedia_url: str = WIKIPEDIA_API
) -> tuple[dict, list[str]]:
    """Return (updated data, human-readable changes). Never raises."""
    # Deep-copy so callers can diff against the pristine input; also prevents
    # accidental aliasing when the same dict is fingerprinted twice.
    data = json.loads(json.dumps(data))
    changes: list[str] = []

    if not offline:
        try:
            wikitext = fetch_wikipedia_wikitext(wikipedia_url)
            if wikitext:
                items = parse_wikipedia_conflicts(wikitext)
                wiki_zones = conflict_zones_from_wikipedia(items)
                changes.append(f"parsed {len(items)} conflicts, {len(wiki_zones)} geo-locatable")
                curated = list(data.get("conflict_zones") or [])
                merged, merge_changes = merge_conflict_zones(curated, wiki_zones)
                data["conflict_zones"] = merged
                changes.extend(merge_changes)
            else:
                changes.append("wikipedia fetch failed - keeping existing conflicts")
        except Exception as exc:  # noqa: BLE001 - pipeline must stay green
            changes.append(f"wikipedia parse error ({exc}) - keeping existing conflicts")

    data["conflict_zones"] = [
        normalize_lifecycle_zone(z) for z in (data.get("conflict_zones") or [])
    ]
    data["deployments"] = [
        normalize_lifecycle_fleet(f) for f in (data.get("deployments") or [])
    ]
    data["version"] = LIFECYCLE_VERSION
    return data, changes


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="normalize only, no network")
    parser.add_argument("--write", action="store_true", help="write the file when changed")
    parser.add_argument("--json", dest="json_path", default=str(WORLD_LAYERS_FILE), help="target JSON file")
    parser.add_argument("--wikipedia", default=WIKIPEDIA_API, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    path = Path(args.json_path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[error] cannot read {path}: {exc}")
        return 1

    updated, changes = build_updated_layers(data, offline=args.offline, wikipedia_url=args.wikipedia)

    for line in changes:
        print(f"  {line}")

    changed = content_fingerprint(updated) != content_fingerprint(data)
    if changed and args.write:
        updated["last_update"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        try:
            path.write_text(
                json.dumps(updated, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
            )
            print(f"[ok] wrote {path} ({len(updated.get('conflict_zones', []))} zones, "
                  f"{len(updated.get('deployments', []))} deployments)")
        except OSError as exc:
            print(f"[error] cannot write {path}: {exc}")
            return 1
    elif changed:
        print("[info] changes pending (run with --write to apply)")
    else:
        print("[ok] no changes")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))