#!/usr/bin/env python3
"""
Historical milestone backfill for transhumanists.github.io.

Reads a curated catalog of pre-archive historical milestones
(data/historical_milestones.json) and merges the next batch of oldest
entries into milestones_history.json. Designed to run from GitHub Actions
when the 6-hourly upstream sync reports no new milestones, so the archive
keeps growing backwards in time.

Usage:
    python scripts/scrape_historical_milestones.py [--limit N] [--dry-run]
    python scripts/scrape_historical_milestones.py --validate-only

Options:
    --limit N           How many catalog entries to ingest per run (default: 5)
    --catalog PATH      Path to the historical milestone catalog
    --history PATH      Path to the archive file
    --today YYYY-MM-DD  Override today's date (for deterministic tests)
    --dry-run           Show what would be ingested without writing
    --validate-only     Validate the catalog schema and exit
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sync_milestones as sm

DEFAULT_CATALOG = Path("data/historical_milestones.json")
DEFAULT_HISTORY = Path("data/milestones_history.json")
DEFAULT_LIMIT = 5

REQUIRED_CATALOG_FIELDS = {"id", "category", "subcategory", "title", "date", "source", "url", "geolocation"}


def validate_catalog_entry(entry: dict, index: int) -> list[str]:
    """Validate a single catalog entry. Returns list of error strings."""
    errors = []
    for field in REQUIRED_CATALOG_FIELDS:
        if field not in entry:
            errors.append(f"Entry {index}: missing required field '{field}'")
    if "id" in entry and not str(entry["id"]).strip():
        errors.append(f"Entry {index}: empty id")
    if "title" in entry and not str(entry["title"]).strip():
        errors.append(f"Entry {index}: empty title")
    if "source" in entry and not str(entry["source"]).strip():
        errors.append(f"Entry {index}: empty source")
    if "subcategory" in entry and not str(entry["subcategory"]).strip():
        errors.append(f"Entry {index}: empty subcategory")
    if "date" in entry:
        ds = str(entry["date"])
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", ds):
            errors.append(f"Entry {index}: malformed date {ds!r}")
        else:
            try:
                date.fromisoformat(ds)
            except ValueError:
                errors.append(f"Entry {index}: invalid date {ds!r}")
    if "geolocation" in entry:
        geo = entry["geolocation"]
        if not isinstance(geo, dict) or "lat" not in geo or "lon" not in geo:
            errors.append(f"Entry {index}: missing valid geolocation")
        else:
            try:
                lat, lon = float(geo["lat"]), float(geo["lon"])
                if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
                    errors.append(f"Entry {index}: geolocation out of bounds")
                elif lat == 0.0 and lon == 0.0:
                    errors.append(f"Entry {index}: geolocation is (0, 0) - will be skipped by build_events")
            except (ValueError, TypeError):
                errors.append(f"Entry {index}: geolocation not numeric")
    if "value" in entry:
        v = entry["value"]
        if v is not None and not isinstance(v, (int, float)):
            errors.append(f"Entry {index}: value must be numeric or null")
    if "unit" in entry:
        u = entry["unit"]
        if u is not None and not isinstance(u, str):
            errors.append(f"Entry {index}: unit must be a string or null")
    if "value" in entry and "unit" in entry:
        v, u = entry["value"], entry["unit"]
        if (v is None) != (u is None):
            errors.append(f"Entry {index}: value and unit must both be set or both be null")
    if "url" in entry:
        url = str(entry["url"])
        if not re.match(r"^https?://", url):
            errors.append(f"Entry {index}: url must start with http:// or https://")
    return errors


def validate_catalog(catalog: dict) -> tuple[bool, list[str]]:
    """Validate the entire catalog. Returns (ok, errors)."""
    errors = []
    if not isinstance(catalog, dict):
        return False, ["Catalog must be a JSON object"]
    milestones = catalog.get("milestones")
    if not isinstance(milestones, list):
        return False, ["Catalog missing 'milestones' array"]
    seen_ids: set[str] = set()
    for i, entry in enumerate(milestones):
        if not isinstance(entry, dict):
            errors.append(f"Entry {i}: not an object")
            continue
        errors.extend(validate_catalog_entry(entry, i))
        entry_id = str(entry.get("id", "")).strip()
        if entry_id:
            if entry_id in seen_ids:
                errors.append(f"Entry {i}: duplicate id '{entry_id}'")
            seen_ids.add(entry_id)
    return len(errors) == 0, errors


def load_catalog(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"Catalog file not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def load_history(path: Path) -> list:
    """Load the archive file. Raises on malformed data to prevent silent data loss."""
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise ValueError(f"History file {path} is malformed: {e}") from e
    if not isinstance(data, list):
        raise ValueError(f"History file {path} must contain a JSON array")
    return data


def pick_next_batch(catalog: dict, existing_ids: set[str], limit: int) -> list[dict]:
    """Pick the next `limit` oldest catalog entries not yet in the archive."""
    candidates = []
    for entry in catalog.get("milestones", []):
        entry_id = str(entry.get("id", "")).strip()
        if entry_id and entry_id not in existing_ids:
            candidates.append(entry)
    candidates.sort(key=lambda e: (str(e.get("date", "")), str(e.get("id", ""))))
    return candidates[:limit]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                    help=f"Number of entries to ingest per run (default: {DEFAULT_LIMIT})")
    ap.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG,
                    help="Path to the historical milestone catalog")
    ap.add_argument("--history", type=Path, default=DEFAULT_HISTORY,
                    help="Path to the archive file")
    ap.add_argument("--today", default=None,
                    help="Override today's date (YYYY-MM-DD) for deterministic tests")
    ap.add_argument("--dry-run", action="store_true",
                    help="Show what would be ingested without writing")
    ap.add_argument("--validate-only", action="store_true",
                    help="Validate the catalog schema and exit")
    args = ap.parse_args()

    if args.limit <= 0:
        print("::error::--limit must be a positive integer")
        return 1

    if args.today:
        try:
            date.fromisoformat(args.today)
        except ValueError:
            print(f"::error::Invalid --today date: {args.today!r} (expected YYYY-MM-DD)")
            return 1

    try:
        catalog = load_catalog(args.catalog)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"::error::Failed to load catalog: {e}")
        return 1

    ok, errors = validate_catalog(catalog)
    if not ok:
        for err in errors:
            print(f"::error::Catalog validation: {err}")
        return 1

    if args.validate_only:
        print(f"OK: catalog valid ({len(catalog.get('milestones', []))} entries)")
        return 0

    today = date.fromisoformat(args.today) if args.today else date.today()
    seen_on = today.isoformat()

    try:
        existing = load_history(args.history)
    except ValueError as e:
        print(f"::error::{e}")
        return 1

    existing_ids = {str(r.get("id", "")).strip() for r in existing if isinstance(r, dict)}

    batch = pick_next_batch(catalog, existing_ids, args.limit)

    if not batch:
        print("No new historical milestones to ingest (catalog fully consumed).")
        return 0

    if args.dry_run:
        print(f"[dry-run] Would ingest {len(batch)} historical milestone(s):")
        for entry in batch:
            print(f"  - [{entry.get('date')}] {entry.get('title')} ({entry.get('category')})")
        return 0

    new_records = [sm.archive_record(entry, seen_on) for entry in batch]
    merged = sm.merge_history(existing, new_records, seen_on)

    sm.save_json(args.history, merged)

    print(f"OK: ingested {len(batch)} historical milestone(s) into {args.history}")
    for entry in batch:
        print(f"  + [{entry.get('date')}] {entry.get('title')} ({entry.get('category')})")
    print(f"Archive now holds {len(merged)} records.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
