#!/usr/bin/env python3
"""
Milestone sync for transhumanists.github.io.

Fetches the canonical milestone database (transhumanists/milestones), then
derives three artifacts:

  data/milestones.json          mirror of the upstream current-best snapshot
  data/milestones_history.json  append-only archive of EVERY milestone ever
                                seen (union by id) - this is the durable
                                per-metric timeline "from the beginning of
                                scraping"
  data/activity.json            full-range activity series built from the
                                archive (daily buckets, weekly when the span
                                exceeds MAX_DAILY_DAYS) plus spikes
  data/events.json              current milestones flattened for the world map

Runs from GitHub Actions every 6 hours (see .github/workflows/milestone-check.yml).
Stdlib-only; usable locally with --dry-run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# Institution coordinates for geocoding fallback (shared with worldmap.js)
INSTITUTION_COORDS = {
    'arxiv': { 'lat': 42.4440, 'lon': -76.5019 },  # Cornell University, Ithaca NY
    'cornell': { 'lat': 42.4440, 'lon': -76.5019 },
    'cornell university': { 'lat': 42.4440, 'lon': -76.5019 },
    'mit': { 'lat': 42.3601, 'lon': -71.0942 },
    'stanford': { 'lat': 37.4275, 'lon': -122.1697 },
    'harvard': { 'lat': 42.3770, 'lon': -71.1167 },
    'berkeley': { 'lat': 37.8719, 'lon': -122.2585 },
    'cmu': { 'lat': 40.4433, 'lon': -79.9438 },
    'caltech': { 'lat': 34.1377, 'lon': -118.1253 },
    'princeton': { 'lat': 40.3440, 'lon': -74.6514 },
    'yale': { 'lat': 41.3111, 'lon': -72.9267 },
    'columbia': { 'lat': 40.8075, 'lon': -73.9626 },
    'chicago': { 'lat': 41.7886, 'lon': -87.5987 },
    'ucla': { 'lat': 34.0689, 'lon': -118.4452 },
    'ucsd': { 'lat': 32.8801, 'lon': -117.2340 },
    'eth zurich': { 'lat': 47.3769, 'lon': 8.5417 },
    'epfl': { 'lat': 46.5197, 'lon': 6.5667 },
    'oxford': { 'lat': 51.7548, 'lon': -1.2544 },
    'cambridge': { 'lat': 52.2053, 'lon': 0.1218 },
    'deepmind': { 'lat': 51.5074, 'lon': -0.1278 },
    'google': { 'lat': 37.4220, 'lon': -122.0841 },
    'openai': { 'lat': 37.7749, 'lon': -122.4194 },
    'anthropic': { 'lat': 37.7749, 'lon': -122.4194 },
    'nvidia': { 'lat': 37.3688, 'lon': -122.0363 },
    'ibm': { 'lat': 41.0323, 'lon': -73.5543 },
    'microsoft': { 'lat': 47.6062, 'lon': -122.3321 },
    'meta': { 'lat': 37.4848, 'lon': -122.1484 },
    'apple': { 'lat': 37.3349, 'lon': -122.0090 },
    'amazon': { 'lat': 47.6062, 'lon': -122.3321 },
    'spacex': { 'lat': 28.5728, 'lon': -80.6490 },
    'nasa': { 'lat': 28.5237, 'lon': -80.6810 },
    'jaxa': { 'lat': 35.6762, 'lon': 139.6503 },
    'esa': { 'lat': 48.9219, 'lon': 2.3646 },
    'cern': { 'lat': 46.2333, 'lon': 6.0500 },
    'llnl': { 'lat': 37.6881, 'lon': -121.7045 },
    'nifs': { 'lat': 35.6762, 'lon': 139.6503 },
    'ipp': { 'lat': 54.0956, 'lon': 13.4725 },
    'quantinuum': { 'lat': 51.5074, 'lon': -0.1278 },
    'qutech': { 'lat': 52.0116, 'lon': 4.3571 },
    'broad': { 'lat': 42.3375, 'lon': -71.1061 },
    'neuralink': { 'lat': 37.4861, 'lon': -122.1519 },
    'dexcom': { 'lat': 32.8844, 'lon': -117.2340 },
    'thermofisher': { 'lat': 44.4268, 'lon': -123.0764 },
    'hms': { 'lat': 42.3375, 'lon': -71.1061 },
    'mpi-cbg': { 'lat': 51.0504, 'lon': 13.7373 },
    'sparktx': { 'lat': 39.9526, 'lon': -75.1652 },
    'jcvi': { 'lat': 32.7157, 'lon': -117.1611 },
    'eth': { 'lat': 47.3769, 'lon': 8.5417 },
    'nvidia': { 'lat': 37.3688, 'lon': -122.0363 },
    'quantumscape': { 'lat': 37.5485, 'lon': -122.0591 },
    'autogpt': { 'lat': 37.7749, 'lon': -122.4194 },
    'cncell': { 'lat': 31.2304, 'lon': 121.4737 },
    'intel': { 'lat': 45.5215, 'lon': -122.6774 },
    'amd': { 'lat': 37.4220, 'lon': -122.0841 },
    'tsmc': { 'lat': 24.7867, 'lon': 120.9969 },
    'asml': { 'lat': 51.5900, 'lon': 5.0500 },
    'samsung': { 'lat': 37.2636, 'lon': 127.0286 },
    'hzdr': { 'lat': 51.2323, 'lon': 13.6830 },
    'nist': { 'lat': 38.8951, 'lon': -77.0364 },
    'csrc': { 'lat': 38.8951, 'lon': -77.0364 },
    'cisa': { 'lat': 38.8951, 'lon': -77.0364 },
    'nvd': { 'lat': 38.8951, 'lon': -77.0364 },
    'usaf': { 'lat': 38.8951, 'lon': -77.0364 },
    'norad': { 'lat': 38.8951, 'lon': -77.0364 },
    'us navy': { 'lat': 36.8508, 'lon': -76.2995 },
    'rafael': { 'lat': 32.0853, 'lon': 34.7818 },
    'idf': { 'lat': 32.0853, 'lon': 34.7818 },
    'almaz-antey': { 'lat': 55.7558, 'lon': 37.6173 },
    'nato': { 'lat': 50.8609, 'lon': 4.3676 },
    'ismsc': { 'lat': 13.5, 'lon': 43.0 },
    'unocha': { 'lat': 31.3, 'lon': 34.3 },
    'isw': { 'lat': 48.0, 'lon': 37.8 },
    'usni': { 'lat': 38.8951, 'lon': -77.0364 },
    'rn': { 'lat': 50.8, 'lon': -1.1 },
    'iiss': { 'lat': 51.5074, 'lon': -0.1278 },
    'in': { 'lat': 19.0, 'lon': 72.8 },
    'plan': { 'lat': 26.7, 'lon': 114.0 },
    'af': { 'lat': 38.8951, 'lon': -77.0364 },
    'iaea': { 'lat': 48.2082, 'lon': 16.3738 },
    'who_org': { 'lat': 46.2276, 'lon': 6.1424 },
    'un_org': { 'lat': 40.7580, 'lon': -73.9683 },
    'fda': { 'lat': 38.8951, 'lon': -77.0364 },
    'ncsc': { 'lat': 51.5074, 'lon': -0.1278 },
    'gchq': { 'lat': 51.5074, 'lon': -0.1278 },
    'mossad': { 'lat': 31.9686, 'lon': 35.5064 },
    'nsa': { 'lat': 38.8951, 'lon': -77.0364 },
    'plaff': { 'lat': 39.9042, 'lon': 116.4074 },
    'csir': { 'lat': 51.2323, 'lon': 13.6830 },
    'significant-gravitas': { 'lat': 37.7749, 'lon': -122.4194 },
    'github': { 'lat': 37.7749, 'lon': -122.4194 },
}

MILESTONES_REPO = os.environ.get("MILESTONES_REPO", "transhumanists/milestones")
MILESTONES_BRANCH = os.environ.get("MILESTONES_BRANCH", "main")
# Additional upstream sources for milestone data (merged in order)
ADDITIONAL_UPSTREAM_REPOS = os.environ.get("ADDITIONAL_UPSTREAM_REPOS", "").split(",")
ADDITIONAL_UPSTREAM_BRANCHES = os.environ.get("ADDITIONAL_UPSTREAM_BRANCHES", "").split(",")
TOKEN = os.environ.get("GITHUB_TOKEN", "")
STALE_WARN_DAYS = int(os.environ.get("STALE_WARN_DAYS", "2"))
STALE_ERROR_DAYS = int(os.environ.get("STALE_ERROR_DAYS", "8"))
MAX_DAILY_DAYS = int(os.environ.get("MAX_DAILY_DAYS", "400"))

# Upstream category keys -> website snake_case keys (for data file structure).
UPSTREAM_TO_SITE_KEY = {
    "Biotechnology": "biotechnology",
    "Computing & AGI": "computing_agi",
    "Quantum Physics": "quantum",
    "Quantum": "quantum",
    "Energy": "energy",
    "Renewable Energy": "energy",
    "Cybersecurity": "cybersecurity",
    "Spaceflight": "spaceflight",
    "Spaceflight & Aeronautics": "spaceflight",
    "Defense": "defense",
    "Military & Defense": "defense",
}

# Site keys -> display names for worldmap/catalog.
SITE_KEY_TO_DISPLAY = {
    "biotechnology": "Biotechnology",
    "computing_agi": "Computing & AGI",
    "quantum": "Quantum Physics",
    "energy": "Renewable Energy",
    "cybersecurity": "Cybersecurity",
    "spaceflight": "Spaceflight & Aeronautics",
    "defense": "Military & Defense",
}

# Display names -> site snake_case keys.
DISPLAY_TO_SITE_KEY = {v: k for k, v in SITE_KEY_TO_DISPLAY.items()}


def slugify(name: str) -> str:
    """Coarse snake_case slug so unknown category names still get a stable key."""
    return re.sub(r"[^a-z0-9_]+", "_", (name or "").lower().replace("&", "")).strip("_")


# Reverse map: display name -> display name (for backward compat with upstream data)
# Also include upstream display names that differ from site display names
DISPLAY_TO_DISPLAY = {v: v for v in SITE_KEY_TO_DISPLAY.values()}
DISPLAY_TO_DISPLAY.update({
    "Energy": "Renewable Energy",
    "Quantum": "Quantum Physics",
    "Spaceflight": "Spaceflight & Aeronautics",
    "Defense": "Military & Defense",
    "Computing & AGI": "Computing & AGI",
    "Cybersecurity": "Cybersecurity",
    "Biotechnology": "Biotechnology",
})


def display_category(name: str) -> str:
    # Try snake_case key first, then display name, then fallback
    return SITE_KEY_TO_DISPLAY.get(name or "", DISPLAY_TO_DISPLAY.get(name or "", name or "Unknown"))


def transform_upstream_to_site_format(upstream: dict) -> dict:
    """Convert upstream milestone data to site format (snake_case keys).

    Accepts either upstream shape - display-name category keys (pipeline
    output) or snake_case keys (protected mirror) - and normalises to the
    site's snake_case container with canonical display names.
    """
    if not upstream or "categories" not in upstream:
        return upstream
    site_categories = {}
    for upstream_key, cat_data in upstream.get("categories", {}).items():
        site_key = UPSTREAM_TO_SITE_KEY.get(upstream_key, upstream_key.lower().replace(" ", "_").replace("&", ""))
        display_name = cat_data.get("name") or SITE_KEY_TO_DISPLAY.get(site_key, upstream_key)
        site_categories[site_key] = {
            "name": display_name,
            "icon": cat_data.get("icon", "📌"),
            "color": cat_data.get("color", "#00d4ff"),
            "subcategories": cat_data.get("subcategories", []),
            "milestones": cat_data.get("milestones", []),
        }
    return {
        "last_update": upstream.get("last_update", now_iso()),
        "version": upstream.get("version", "1.0.0"),
        "schema": upstream.get("schema", "https://transhumanists.github.io/schema/milestone-v1.json"),
        "categories": site_categories,
    }


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def today_iso() -> str:
    return date.today().isoformat()


def load_json(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError):
            pass
    return default


def save_json(path: Path, data) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def fetch_upstream(repo: str, branch: str) -> dict | None:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        print(f"::error::Invalid MILESTONES_REPO format (expected owner/repo): {repo!r}")
        return None
    if not re.fullmatch(r"[A-Za-z0-9_/.-]+", branch):
        print(f"::error::Invalid MILESTONES_BRANCH format: {branch!r}")
        return None
    url = f"https://raw.githubusercontent.com/{repo}/{branch}/data/milestones.json"
    headers = {"User-Agent": "milestone-check/2.0"}
    if TOKEN:
        headers["Authorization"] = f"token {TOKEN}"
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as e:
            if attempt < 2:
                backoff = 5 * (2 ** attempt)
                print(f"::warning::Fetch attempt {attempt + 1} failed: {e}, retrying in {backoff}s...")
                time.sleep(backoff)
            else:
                print(f"::warning::Could not fetch from source after 3 attempts: {e}")
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            print(f"::error::Invalid JSON from source: {e}")
            break
    return None


def fetch_all_upstreams() -> list[dict]:
    """Fetch from all configured upstream repositories."""
    upstreams = []
    # Primary upstream
    primary = fetch_upstream(MILESTONES_REPO, MILESTONES_BRANCH)
    if primary:
        upstreams.append(primary)
    # Additional upstreams
    for repo, branch in zip(ADDITIONAL_UPSTREAM_REPOS, ADDITIONAL_UPSTREAM_BRANCHES):
        if repo and branch:
            upstream = fetch_upstream(repo.strip(), branch.strip())
            if upstream:
                upstreams.append(upstream)
            else:
                print(f"::warning::Failed to fetch additional upstream: {repo}/{branch}")
    return upstreams


def merge_upstreams(upstreams: list[dict]) -> dict:
    """Merge multiple upstream milestone datasets into one."""
    if not upstreams:
        return {}
    # Start with the first upstream as base
    merged = upstreams[0]
    for upstream in upstreams[1:]:
        # Merge categories
        for cat_key, cat_data in upstream.get("categories", {}).items():
            if cat_key not in merged.get("categories", {}):
                merged.setdefault("categories", {})[cat_key] = cat_data
            else:
                # Merge milestones, avoiding duplicates by ID
                existing_ids = {m.get("id") for m in merged["categories"][cat_key].get("milestones", [])}
                for milestone in cat_data.get("milestones", []):
                    if milestone.get("id") not in existing_ids:
                        merged["categories"][cat_key]["milestones"].append(milestone)
                        existing_ids.add(milestone.get("id"))
    return merged


def iter_milestones(data) -> list[dict]:
    out = []
    for cat_key, cat_data in data.get("categories", {}).items():
        cat_name = cat_data.get("name") or cat_key
        for m in cat_data.get("milestones", []):
            out.append({**m, "category_key": cat_key, "category": cat_name})
    return out


def validate(data) -> tuple[bool, str]:
    if not data or not isinstance(data, dict) or "categories" not in data:
        return False, "Missing categories"
    for cat_key, cat_data in data["categories"].items():
        if not isinstance(cat_data, dict) or "milestones" not in cat_data:
            return False, f"Category {cat_key} missing milestones"
        for m in cat_data["milestones"]:
            if not isinstance(m, dict):
                return False, f"Category {cat_key} has a non-object milestone"
            required = ["id", "title", "value", "unit", "source", "date", "url", "geolocation"]
            for field in required:
                if field not in m:
                    return False, f"Milestone {m.get('id', 'unknown')} missing {field}"
            geo = m.get("geolocation", {})
            if not isinstance(geo, dict) or "lat" not in geo or "lon" not in geo:
                return False, f"Milestone {m.get('id', 'unknown')} missing valid geolocation"
            try:
                lat, lon = float(geo["lat"]), float(geo["lon"])
                if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
                    return False, f"Milestone {m.get('id', 'unknown')} geolocation out of bounds"
            except (ValueError, TypeError):
                return False, f"Milestone {m.get('id', 'unknown')} geolocation not numeric"
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(m.get("date", ""))):
                return False, f"Milestone {m.get('id', 'unknown')} has malformed date {m.get('date')!r}"
            try:
                date.fromisoformat(str(m.get("date", "")))
            except ValueError:
                return False, f"Milestone {m.get('id', 'unknown')} has invalid date {m.get('date')!r}"
    return True, "OK"


def canonical_id(m: dict) -> str:
    ident = str(m.get("id", "")).strip()
    if ident:
        return ident
    blob = ":".join([
        str(m.get("category", "")), str(m.get("subcategory", "")),
        str(m.get("title", "")), str(m.get("date", "")),
    ])
    return "ms-" + hashlib.sha1(blob.encode("utf-8")).hexdigest()[:12]


def archive_record(m: dict, seen_on: str) -> dict:
    """Normalise an upstream milestone into an archive/history record."""
    src = m.get("source") or "Unknown"
    return {
        "id": canonical_id(m),
        "category": display_category(m.get("category")),
        "subcategory": (m.get("subcategory") or "general").strip(),
        "title": (m.get("title") or "")[:200],
        "value": m.get("value"),
        "unit": m.get("unit"),
        "source": src,
        "url": m.get("url"),
        "date": m.get("date"),
        "geolocation": m.get("geolocation", {"lat": 0.0, "lon": 0.0}),
        "first_seen": seen_on,
        "last_seen": seen_on,
    }


def merge_history(existing: list, current: list, seen_on: str) -> list:
    """Union current milestone records into the append-only archive.

    Existing records keep their original first_seen; a duplicate id is
    updated in place (fresh metadata wins, last_seen refreshed to seen_on).
    Superseded records stay - the archive is the full per-metric timeline.
    Sorted newest-first by milestone date.
    """
    by_id: dict[str, dict] = {}
    for rec in existing:
        if isinstance(rec, dict):
            by_id[rec.get("id", canonical_id(rec))] = rec
    for m in current:
        rec = archive_record(m, seen_on)
        key = rec["id"]
        prev = by_id.get(key)
        if prev is None:
            by_id[key] = rec
        else:
            rec["first_seen"] = prev.get("first_seen", seen_on)
            rec["last_seen"] = seen_on
            by_id[key] = rec  # fresh metadata wins on duplicate id
    out = list(by_id.values())
    out.sort(key=lambda r: (r.get("date") or "", r.get("title") or ""), reverse=True)
    return out


def merge_feed(current: list, history: list) -> list:
    """Union the upstream snapshot with everything the archive has ever seen.

    A thin or collapsed upstream snapshot must never empty the site feeds:
    every milestone ever recorded stays visible until a same-id record from
    upstream supersedes it (metadata wins). Deduplicated by canonical id.
    """
    by_id: dict[str, dict] = {}
    for rec in history:
        if isinstance(rec, dict):
            by_id[rec.get("id", canonical_id(rec))] = rec
    for m in current:
        by_id[m.get("id", canonical_id(m))] = m
    feed = list(by_id.values())
    feed.sort(key=lambda r: (r.get("date") or "", r.get("category") or "", r.get("title") or ""), reverse=True)
    return feed


def build_site_categories(milestones: list, upstream_categories: dict) -> dict:
    """Group a flat milestone list into the snake_case site-format container.

    Category keys/displays/colors/icons/subcategories are inherited from the
    (transformed) upstream container; anything else falls back to defaults so
    records retained from the archive still render correctly.
    """
    cats: dict[str, dict] = {}
    for m in milestones:
        key = m.get("category_key")
        key = key or DISPLAY_TO_SITE_KEY.get(m.get("category"), slugify(m.get("category", "Unknown")))
        if key not in cats:
            known = (upstream_categories or {}).get(key, {})
            name = known.get("name") or SITE_KEY_TO_DISPLAY.get(key, m.get("category") or key)
            cats[key] = {
                "name": name,
                "icon": known.get("icon", "📌"),
                "color": known.get("color", "#00d4ff"),
                "subcategories": list(known.get("subcategories", []) or []),
                "milestones": [],
            }
        record = dict(m)
        # Normalise every record in a bucket to the canonical category name so
        # retained (archive) records match freshly-mirrored ones in the feed.
        record["category"] = cats[key]["name"]
        record.setdefault("category_key", key)
        record.pop("first_seen", None)
        record.pop("last_seen", None)
        cats[key]["milestones"].append(record)
    return cats


def date_range(start: date, end: date) -> list[date]:
    days = []
    d = start
    while d <= end:
        days.append(d)
        d += timedelta(days=1)
    return days


def build_activity(history: list, today: date, include_spikes: bool = True) -> dict:
    """Full-range activity series from the archive.

    Daily buckets from the earliest milestone date to today; weekly buckets
    when the span exceeds MAX_DAILY_DAYS so the graph never overflows.
    """
    counts: Counter = Counter()
    for rec in history:
        ds = rec.get("date")
        if not ds or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(ds)):
            continue
        try:
            counts[date.fromisoformat(ds)] += 1
        except ValueError:
            continue

    if not counts:
        return {
            "last_update": now_iso(),
            "bucket": "day",
            "first": today_iso(),
            "last": today_iso(),
            "total": 0,
            "days": [{"date": (today - timedelta(days=i)).isoformat(), "count": 0} for i in range(29, -1, -1)],
            "spikes": [],
        }

    earliest = min(counts)
    span_days = (today - earliest).days
    bucket = "week" if span_days > MAX_DAILY_DAYS else "day"

    if bucket == "day":
        buckets: dict[date, int] = {d.isoformat(): counts.get(d, 0) for d in date_range(earliest, today)}
    else:
        # ISO week buckets: key = Monday of each week.
        week_counts: Counter = Counter()
        for d, c in counts.items():
            monday = d - timedelta(days=d.isoweekday() - 1)
            week_counts[monday] += c
        buckets = {}
        cursor = earliest - timedelta(days=earliest.isoweekday() - 1)
        while cursor <= today:
            buckets[cursor.isoformat()] = week_counts.get(cursor, 0)
            cursor += timedelta(days=7)

    series = [{"date": k, "count": v} for k, v in sorted(buckets.items())]
    spikes = []
    if include_spikes and counts:
        for d, c in counts.most_common(3):
            reasons = [r.get("title") for r in history
                       if r.get("date") == d.isoformat() and r.get("title")]
            spikes.append({
                "date": d.isoformat(),
                "count": c,
                "reason": "; ".join(reasons[:3]) if reasons else "Multiple milestones",
            })

    return {
        "last_update": now_iso(),
        "bucket": bucket,
        "first": series[0]["date"],
        "last": series[-1]["date"],
        "total": sum(c for _, c in buckets.items()),
        "days": series,
        "spikes": spikes,
    }


def event_value(m: dict) -> str:
    """Value string for an event/map pin.

    Milestones without a numeric metric publish their title (never a summary
    string presented as if it were a metric value).
    """
    if m.get("value") is not None:
        return f"{m.get('value')} {m.get('unit') or ''}".strip()
    return m.get("title") or ""


def geocode_milestone(m: dict) -> tuple[float, float] | None:
    """Attempt to geocode a milestone using institution name matching."""
    source = m.get("source", "")
    title = m.get("title", "")
    category = m.get("category", "")
    text = f"{source} {title} {category}".lower()
    for key, coords in INSTITUTION_COORDS.items():
        pattern = f"(^|[^a-z0-9]){key.lower()}([^a-z0-9]|\$)"
        if re.search(pattern, text):
            return coords["lat"], coords["lon"]
    return None


def build_events(milestones: list) -> dict:
    events = []
    for m in milestones:
        geo = m.get("geolocation", {})
        lat = geo.get("lat")
        lon = geo.get("lon")
        # Try to geocode if coordinates are missing or invalid (0,0)
        if lat is None or lon is None or lat == 0.0 or lon == 0.0:
            geocoded = geocode_milestone(m)
            if geocoded:
                lat, lon = geocoded
            else:
                continue
        events.append({
            "id": "ev-" + m.get("id", ""),
            "title": m.get("title", ""),
            "category": display_category(m.get("category")),
            "value": event_value(m),
            "source": m.get("source", ""),
            "url": m.get("url"),
            "date": m.get("date", ""),
            "geolocation": {"lat": lat, "lon": lon},
        })
    return {"last_update": now_iso(), "version": "1.0.0", "events": events}


def enrich_with_historic_milestones(feed: list, history: list, today: date) -> list:
    """Add historic milestones to the feed if recent milestones are sparse."""
    # Check how many milestones in the last 30 days
    recent_cutoff = today - timedelta(days=30)
    recent_count = sum(1 for m in feed 
                       if m.get("date") and m["date"] >= recent_cutoff.isoformat())
    
    # If fewer than 5 milestones in the last 30 days, add historic ones
    if recent_count < 5:
        # Get historic milestones from archive (older than 30 days)
        historic_cutoff = today - timedelta(days=30)
        historic_milestones = [h for h in history 
                               if h.get("date") and h["date"] < historic_cutoff.isoformat()]
        
        # Sort by date descending and take up to 20 historic milestones
        historic_milestones.sort(key=lambda x: x.get("date", ""), reverse=True)
        historic_to_add = historic_milestones[:20]
        
        # Add to feed if not already present
        existing_ids = {m.get("id") for m in feed}
        for h in historic_to_add:
            if h.get("id") not in {m.get("id") for m in feed}:
                feed.append(h)
    
    return feed


def latest_milestone_date(milestones: list) -> date | None:
    best = None
    for m in milestones:
        ds = m.get("date")
        if isinstance(ds, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", ds):
            try:
                d = date.fromisoformat(ds)
            except ValueError:
                continue
            if best is None or d > best:
                best = d
    return best


def content_fingerprint(*data) -> str:
    blob = "".join(json.dumps(x, sort_keys=True, ensure_ascii=False, default=str) for x in data)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def churn_free_view(site_format: dict, history: list, activity: dict, events: dict) -> tuple:
    """Stable projection of the artifacts we persist.

    Drops fields that change on every run without carrying meaning -
    "last_update" timestamps and per-record first_seen/last_seen sighting
    markers - so the commit fingerprint only flips on real content changes.
    """

    def scrub(obj):
        if isinstance(obj, dict):
            return {k: scrub(v) for k, v in obj.items() if k not in ("last_update", "first_seen", "last_seen")}
        if isinstance(obj, list):
            return [scrub(x) for x in obj]
        return obj

    return (scrub(site_format), scrub(history), scrub(activity), scrub(events))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="fetch/validate/derive but write nothing")
    ap.add_argument("--output-dir", default=".", help="directory containing data/ (default: cwd)")
    ap.add_argument("--upstream", default=None, help="read upstream JSON from file instead of network")
    ap.add_argument("--today", default=None, help="override 'today' (YYYY-MM-DD) for deterministic tests")
    args = ap.parse_args()

    data_dir = Path(args.output_dir) / "data"
    milestones_file = data_dir / "milestones.json"
    history_file = data_dir / "milestones_history.json"
    activity_file = data_dir / "activity.json"
    events_file = data_dir / "events.json"
    fingerprint_file = data_dir / ".sync_fingerprint"

    today = date.fromisoformat(args.today) if args.today else date.today()
    seen_on = today.isoformat()

    # 1. Fetch / read upstream
    upstream = None
    if args.upstream:
        upstream = load_json(Path(args.upstream), None)
        if upstream is None:
            print(f"::error::Local upstream file missing or invalid: {args.upstream}")
            return 1
    else:
        upstreams = fetch_all_upstreams()
        upstream = merge_upstreams(upstreams)

    if upstream is None:
        # Keep local data; do not churn. Loud so the breakage is visible.
        print("::error::No upstream data fetched - pipeline likely broken (scrape/score upstream). Keeping local data.")
        return 1

    valid, msg = validate(upstream)
    if not valid:
        print(f"::error::Upstream data invalid: {msg}")
        return 1
    print(f"OK: upstream data valid ({msg})")

    site_format = transform_upstream_to_site_format(upstream)
    current = iter_milestones(site_format)

    # 2. Merge into the history archive (the full per-metric timeline)
    existing_history = load_json(history_file, [])
    history = merge_history(existing_history if isinstance(existing_history, list) else [], current, seen_on)

    # 3. The published feed is the union of the upstream snapshot and every
    #    milestone the archive has ever seen - upstream collapse must never
    #    wipe the site's feeds.
    feed = merge_feed(current, history)
    site_format = {
        "last_update": now_iso(),
        "version": "1.0.0",
        "schema": "https://transhumanists.github.io/schema/milestone-v1.json",
        "categories": build_site_categories(feed, site_format.get("categories", {})),
    }

    # 4. Derive outputs
    activity = build_activity(history, today)
    
    # Enrich feed with historic milestones if recent data is sparse
    feed = enrich_with_historic_milestones(feed, history, today)
    
    events = build_events(feed)

    # 5. Staleness gate (milestone date freshness, not data-file freshness)
    latest = latest_milestone_date(feed)
    if latest is not None:
        stale_days = (today - latest).days
        if stale_days > STALE_ERROR_DAYS:
            print(f"::error::Milestone data is {stale_days} days stale (latest milestone {latest}). "
                  f"Extraction is likely broken upstream. Raising the sync failure.")
            return 1
        if stale_days > STALE_WARN_DAYS:
            print(f"::warning::Milestone data is {stale_days} days stale (latest milestone {latest}). "
                  f"No new records since {latest}.")
    else:
        print("::error::No dated milestones found - refusing to publish.")
        return 1

    # 6. Content gate: only write when the persisted artifacts actually change.
    #    Compute first so a content-identical run touches nothing on disk
    #    (skips last_update / last_seen-only churn that would otherwise
    #    produce a no-op commit on every schedule tick).
    prev_fp = load_json(fingerprint_file, None)
    new_fp = content_fingerprint(*churn_free_view(site_format, history, activity, events))

    if args.dry_run:
        print(f"[dry-run] would write {len(history)} history records, "
              f"{len(events['events'])} events, activity {activity['bucket']} x {len(activity['days'])}")
        return 0

    if new_fp == prev_fp:
        print("No content changes - leaving files untouched (no timestamp churn).")
        return 0

    data_dir.mkdir(parents=True, exist_ok=True)
    save_json(milestones_file, site_format)
    save_json(history_file, history)
    save_json(activity_file, activity)
    save_json(events_file, events)
    save_json(fingerprint_file, new_fp)

    print(f"OK: wrote {len(history)} history records (by {len({h.get('subcategory') for h in history})} metrics), "
          f"{len(feed)} feed milestones, {len(events['events'])} events, "
          f"activity {activity['bucket']} x {len(activity['days'])} days "
          f"({activity['first']} -> {activity['last']}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())