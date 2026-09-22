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
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

MILESTONES_REPO = os.environ.get("MILESTONES_REPO", "transhumanists/milestones")
MILESTONES_BRANCH = os.environ.get("MILESTONES_BRANCH", "main")
TOKEN = os.environ.get("GITHUB_TOKEN", "")
STALE_WARN_DAYS = int(os.environ.get("STALE_WARN_DAYS", "2"))
STALE_ERROR_DAYS = int(os.environ.get("STALE_ERROR_DAYS", "8"))
MAX_DAILY_DAYS = int(os.environ.get("MAX_DAILY_DAYS", "400"))

# apis category names -> canonical site display names (worldmap/catalog).
CATEGORY_DISPLAY_MAP = {
    "Biotechnology": "Biotechnology",
    "Computing & AGI": "Computing & AGI",
    "Quantum Physics": "Quantum Physics",
    "Quantum": "Quantum Physics",
    "Energy": "Renewable Energy",
    "Renewable Energy": "Renewable Energy",
    "Cybersecurity": "Cybersecurity",
    "Spaceflight": "Spaceflight & Aeronautics",
    "Spaceflight & Aeronautics": "Spaceflight & Aeronautics",
    "Defense": "Military & Defense",
    "Military & Defense": "Military & Defense",
}


def display_category(name: str) -> str:
    return CATEGORY_DISPLAY_MAP.get(name or "", name or "Unknown")


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

    Existing records keep their original first_seen (and oldest date if a
    duplicate id arrives), superseded records stay - the archive is the full
    per-metric timeline. Sorted newest-first by milestone date.
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
            # Keep the oldest observed date if a duplicate id reappears with a
            # different date; otherwise prefer the newer record's metadata.
            if prev.get("date") and prev["date"] < rec["date"]:
                pass
            by_id[key] = rec
    out = list(by_id.values())
    out.sort(key=lambda r: (r.get("date") or "", r.get("title") or ""), reverse=True)
    return out


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
            "days": [{"date": (today - timedelta(days=29 + i)).isoformat() if False else today.isoformat(), "count": 0}],
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


def build_events(milestones: list) -> dict:
    events = []
    for m in milestones:
        geo = m.get("geolocation", {})
        if geo.get("lat") is None or geo.get("lon") is None:
            continue
        events.append({
            "id": "ev-" + m.get("id", ""),
            "title": m.get("title", ""),
            "category": display_category(m.get("category")),
            "value": f"{m.get('value', '')} {m.get('unit', '') or ''}".strip(),
            "source": m.get("source", ""),
            "url": m.get("url"),
            "date": m.get("date", ""),
            "geolocation": geo,
        })
    return {"last_update": now_iso(), "version": "1.0.0", "events": events}


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
        upstream = fetch_upstream(MILESTONES_REPO, MILESTONES_BRANCH)

    if upstream is None:
        # Keep local data; do not churn. Loud so the breakage is visible.
        print("::error::No upstream data fetched - pipeline likely broken (scrape/score upstream). Keeping local data.")
        return 1

    valid, msg = validate(upstream)
    if not valid:
        print(f"::error::Upstream data invalid: {msg}")
        return 1
    print(f"OK: upstream data valid ({msg})")

    current = iter_milestones(upstream)

    # 2. Merge into the history archive (the full per-metric timeline)
    existing_history = load_json(history_file, [])
    history = merge_history(existing_history if isinstance(existing_history, list) else [], current, seen_on)

    # 3. Derive outputs
    activity = build_activity(history, today)
    events = build_events(current)

    # 4. Staleness gate (milestone date freshness, not data-file freshness)
    latest = latest_milestone_date(current)
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
        print(f"::error::No dated milestones found - refusing to publish.")
        return 1

    # 5. Write (content-only commits: fingerprint skips last_update-only churn)
    if args.dry_run:
        print(f"[dry-run] would write {len(history)} history records, "
              f"{len(events['events'])} events, activity {activity['bucket']} x {len(activity['days'])}")
        return 0

    data_dir.mkdir(parents=True, exist_ok=True)
    save_json(milestones_file, upstream)
    save_json(history_file, history)
    save_json(activity_file, activity)
    save_json(events_file, events)

    prev_fp = load_json(fingerprint_file, None)
    new_fp = content_fingerprint(current, history, activity, events)
    if new_fp == prev_fp:
        print("No content changes - leaving files untouched (no timestamp churn).")
        return 0
    save_json(fingerprint_file, new_fp)

    print(f"OK: wrote {len(history)} history records (by {len({h.get('subcategory') for h in history})} metrics), "
          f"{len(events['events'])} events, activity {activity['bucket']} x {len(activity['days'])} days "
          f"({activity['first']} -> {activity['last']}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())