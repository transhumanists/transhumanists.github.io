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
import ssl
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# Share the "same reported result" identity rule with the data validator; see
# milestone_identity.py. sys.path[0] is this file's directory when run as a script,
# but the explicit insert keeps the import working under `python -m scripts...` too.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import milestone_identity

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
    # Additional entries for better geocoding coverage
    'quanta magazine': { 'lat': 40.7580, 'lon': -73.9683 },  # NYC
    'nature biotechnology': { 'lat': 51.5074, 'lon': -0.1278 },  # London (Nature Publishing)
    'nature': { 'lat': 51.5074, 'lon': -0.1278 },
    'fiercebiotech': { 'lat': 42.3601, 'lon': -71.0942 },  # Boston area
    'open khipu repository': { 'lat': -13.5, 'lon': -71.9 },  # Cusco, Peru (Inca region)
    'research team': { 'lat': 0.0, 'lon': 0.0 },  # Will not match - generic
    'research authors': { 'lat': 0.0, 'lon': 0.0 },  # Will not match - generic
    'academic researchers': { 'lat': 0.0, 'lon': 0.0 },  # Will not match - generic
    'international mathematics collaboration': { 'lat': 48.8566, 'lon': 2.3522 },  # Paris (IMU)
    'quantamagazine': { 'lat': 40.7580, 'lon': -73.9683 },  # NYC (Quanta Magazine)
    'ieee': { 'lat': 40.7580, 'lon': -73.9683 },  # NYC
    'acm': { 'lat': 40.7580, 'lon': -73.9683 },  # NYC
    'usenix': { 'lat': 37.7749, 'lon': -122.4194 },  # Berkeley/SF
    'siggraph': { 'lat': 34.0522, 'lon': -118.2437 },  # LA
    'neurips': { 'lat': 37.7749, 'lon': -122.4194 },  # Usually virtual/varied
    'icml': { 'lat': 37.7749, 'lon': -122.4194 },
    'aaai': { 'lat': 37.7749, 'lon': -122.4194 },
    'cvpr': { 'lat': 37.7749, 'lon': -122.4194 },
    'iclr': { 'lat': 37.7749, 'lon': -122.4194 },
    'ijcai': { 'lat': 37.7749, 'lon': -122.4194 },
    'aaai': { 'lat': 37.7749, 'lon': -122.4194 },
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
MAX_WEEKLY_DAYS = int(os.environ.get("MAX_WEEKLY_DAYS", "3650"))
MAX_MONTHLY_DAYS = int(os.environ.get("MAX_MONTHLY_DAYS", "36500"))
_MAX_UPSTREAM_BYTES = 10 * 1024 * 1024  # safety cap on the mirrored upstream file

# Upstream category keys -> website snake_case keys (for data file structure).
UPSTREAM_TO_SITE_KEY = {
    "Biotechnology": "biotechnology",
    "Biotechnology & Biohacking": "biotechnology",
    "Biohacking": "biotechnology",
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
    "Mobility & Logistics": "mobility",
    "Logistics": "mobility",
    "Transportation": "mobility",
    "Robotics": "robotics",
    "Robotics & Automation": "robotics",
}

# Site keys -> display names for worldmap/catalog.
SITE_KEY_TO_DISPLAY = {
    "biotechnology": "Biotechnology & Biohacking",
    "computing_agi": "Computing & AGI",
    "quantum": "Quantum Physics",
    "energy": "Renewable Energy",
    "mobility": "Mobility & Logistics",
    "cybersecurity": "Cybersecurity",
    "robotics": "Robotics",
    "spaceflight": "Spaceflight & Aeronautics",
    "defense": "Military & Defense",
}

# A category can render with more than one landmark colour, the way the
# deployments layer splits ground from fleet. A record takes the secondary colour
# when it falls in the secondary "tone"; the legend row then shows both colours so
# the split is always discoverable.
#
# The keyword lists here are the single source of truth and are mirrored in
# schema/worldmap-data.schema.json; scripts/test_check_data.py::TestSchemaParity
# fails CI if the two drift.
CATEGORY_SUBTONES = {
    "biotechnology": {
        "primary": "Biotechnology",
        "secondary": "Biohacking",
        # Matched case-insensitively as substrings against the title, summary and
        # source. Includes the transhumanist vocabulary the category was widened
        # for: cyborgs, biohackers, and the implant/prosthesis work that
        # motivates them (e.g. Neil Harbisson's frequency-relaying implant).
        "keywords": (
            "biohacking", "biohack", "cyborg", "transhumanist", "transhumanism",
            "neuroprosthetic", "neuroprosthesis", "neural implant", "neuralink",
            "brain-computer interface", "brain computer interface",
            "neural interface", "implant", "bone-conductive", "bone conductive",
            "bone conduction", "sensory substitution", "cochlear", "retinal prosthesis",
            "retinal implant", "prosthetic", "prostheses", "openwetware",
            "body hacking", "bodyhack", "grinder", "wearable computing",
            "human-computer interface", "human computer interface",
            "augmented reality", "brainwave", "eeg headset", "mind-machine",
            "mind machine", "sonic toothbrush", "cyborgs",
        ),
    },
}


def classify_tone(m: dict) -> str | None:
    """Return the secondary tone label for a record, or None for the primary tone.

    Only meaningful for categories that declare a subtone; every other category
    returns None and renders in its single colour.
    """
    key = m.get("category_key")
    if not key:
        display = m.get("category") or ""
        key = DISPLAY_TO_SITE_KEY.get(display, slugify(display))
    spec = CATEGORY_SUBTONES.get(key)
    if not spec:
        return None
    # The subcategory is the strongest signal (it is curated); title and summary
    # catch the upstream buckets that never filled it in. `source` is excluded on
    # purpose: outlets like "MIT Technology Review" host implants and also host
    # ordinary biotech, so a publisher name is not evidence of a tone.
    haystack = " ".join(
        str(m.get(field) or "") for field in ("subcategory", "title", "summary")
    ).lower()
    for kw in spec["keywords"]:
        if kw in haystack:
            return spec["secondary"]
    return None


# Legend order. Distinct from the site-key map above (which only maps names) because
# the map has a deliberate visual reading order: most human-progress categories
# first, then infrastructure, then the operational ones.
SITE_KEY_LEGEND_ORDER = [
    "biotechnology",
    "computing_agi",
    "quantum",
    "energy",
    "mobility",
    "cybersecurity",
    "robotics",
    "spaceflight",
    "defense",
]

# Upstream display names that are not one of the canonical categories.
# They fold into a canonical category here so the site never needs an "Other"
# bucket: every milestone lands in a category that has a colour, a legend row and
# a catalog filter. Mirrors CATEGORY_ALIASES in assets/js/worldmap.js - keep the
# two in step (that map stays for legacy payloads and the dev sample data).
CATEGORY_ALIASES = {
    "Quantum Gravity": "Quantum Physics",
    "Mathematics": "Computing & AGI",
    "Computational Archaeology": "Computing & AGI",
    "Computer Vision": "Computing & AGI",
    "Legal AI": "Computing & AGI",
    # Category splits and renames. Upstream buckets keep whatever name they had;
    # the site folds them into the canonical bucket so history is preserved
    # instead of orphaning every pre-existing milestone in a dead key.
    "Biotechnology": "Biotechnology & Biohacking",
    "Biohacking": "Biotechnology & Biohacking",
    "Biotech": "Biotechnology & Biohacking",
    "Synthetic Biology": "Biotechnology & Biohacking",
    "Logistics": "Mobility & Logistics",
    "Transportation": "Mobility & Logistics",
    "Transport": "Mobility & Logistics",
    "Robotics": "Robotics",
    "Robotics & Automation": "Robotics",
    "Automation": "Robotics",
}

def slugify(name: str) -> str:
    """Coarse snake_case slug so unknown category names still get a stable key."""
    return re.sub(r"[^a-z0-9_]+", "_", (name or "").lower().replace("&", "")).strip("_")


# Display names -> site snake_case keys, including the aliases.
DISPLAY_TO_SITE_KEY = {v: k for k, v in SITE_KEY_TO_DISPLAY.items()}
DISPLAY_TO_SITE_KEY.update(
    {alias: DISPLAY_TO_SITE_KEY[canonical] for alias, canonical in CATEGORY_ALIASES.items()}
)

# Aliases resolve to the canonical bucket of their target category, so upstream
# buckets for e.g. "Mathematics" merge into computing_agi instead of becoming a
# category of their own. Both the display name and its snake_case slug are
# registered because upstream may deliver either shape.
UPSTREAM_TO_SITE_KEY.update(
    {alias: DISPLAY_TO_SITE_KEY[canonical] for alias, canonical in CATEGORY_ALIASES.items()}
)
UPSTREAM_TO_SITE_KEY.update(
    {slugify(alias): DISPLAY_TO_SITE_KEY[canonical] for alias, canonical in CATEGORY_ALIASES.items()}
)

# Every spelling that marks a bucket as a folded alias rather than the category
# itself. Used to decide whose icon/colour wins when buckets merge.
_ALIAS_KEYS = set(CATEGORY_ALIASES) | {slugify(alias) for alias in CATEGORY_ALIASES}


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
    # Split/renamed categories: upstream's old names fold into the new canonical
    # display so historical milestones are re-labelled, not duplicated.
    "Biotechnology": "Biotechnology & Biohacking",
    "Biohacking": "Biotechnology & Biohacking",
    "Logistics": "Mobility & Logistics",
    "Transportation": "Mobility & Logistics",
    "Robotics": "Robotics",
})
DISPLAY_TO_DISPLAY.update(CATEGORY_ALIASES)


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
    site_categories: dict = {}
    # Site keys whose bucket is already branded by a canonical (non-alias) entry.
    canonical_keys: set = set()
    for upstream_key, cat_data in upstream.get("categories", {}).items():
        site_key = UPSTREAM_TO_SITE_KEY.get(upstream_key, upstream_key.lower().replace(" ", "_").replace("&", ""))
        # The canonical display name wins over the upstream one: a bucket that
        # arrived as an alias must be labelled with the category it folded into.
        display_name = SITE_KEY_TO_DISPLAY.get(site_key) or cat_data.get("name") or upstream_key
        milestones = cat_data.get("milestones", [])
        subcategories = cat_data.get("subcategories", [])
        # Whether upstream described this site category under its own name
        # rather than through an alias. An alias bucket borrows a colour/icon it
        # was never branded with, so a real bucket always wins that metadata no
        # matter which key the JSON happens to list first.
        is_canonical = upstream_key == site_key or upstream_key not in _ALIAS_KEYS
        existing = site_categories.get(site_key)
        if existing:
            # Two upstream buckets resolved to the same site category (e.g. an
            # alias folding into a canonical one). Merge them - overwriting here
            # would silently drop every milestone in one of the two buckets.
            existing["milestones"].extend(milestones)
            for sub in subcategories:
                if sub not in existing["subcategories"]:
                    existing["subcategories"].append(sub)
            if is_canonical and site_key not in canonical_keys:
                # This later bucket is the real one; promote its branding.
                existing["icon"] = cat_data.get("icon", existing["icon"])
                existing["color"] = cat_data.get("color", existing["color"])
                canonical_keys.add(site_key)
            continue
        site_categories[site_key] = {
            "name": display_name,
            "icon": cat_data.get("icon", "📌"),
            "color": cat_data.get("color", "#00d4ff"),
            "subcategories": list(subcategories),
            # Copied so merging a later bucket cannot mutate the parsed upstream.
            "milestones": list(milestones),
        }
        if is_canonical:
            canonical_keys.add(site_key)
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
                body = resp.read(_MAX_UPSTREAM_BYTES + 1)
                if len(body) > _MAX_UPSTREAM_BYTES:
                    print("::error::Upstream response exceeds safety cap")
                    return None
                return json.loads(body.decode("utf-8"))
        except (urllib.error.URLError, ssl.SSLError, OSError) as e:
            # HTTP error responses, TLS/certificate failures and socket timeouts
            # are all transient in practice - retry with backoff, then degrade
            # to the keep-local path instead of crashing the pipeline.
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


# ---------------------------------------------------------------------------
# Duplicate unification
# ---------------------------------------------------------------------------
# Content tokens used only for the "is this plausibly the same record" guard, plus
# the bucketing key. These live in milestone_identity so check_data.py enforces
# exactly the rule the unifier applies; see that module's docstring.
_content_tokens = milestone_identity.content_tokens
_dedupe_same_report = milestone_identity.same_report
_DEDUPE_STOPWORDS = milestone_identity.DEDUPE_STOPWORDS


def _dedupe_category_key(category: object) -> str:
    """Normalise a category to the site key the record will be published under.

    Must match build_site_categories, otherwise unification buckets on a different
    label than the one that ends up in the feed.
    """
    return DISPLAY_TO_SITE_KEY.get(category, slugify(category or ""))


def _dedupe_metric_key(m: dict) -> tuple | None:
    """Identity key for a reported metric, or None when the record has no metric.

    Two records describing the same measurement share the date, the value, the
    unit and the category. All four are required, so two unrelated milestones that
    happen to share a number never collapse.
    """
    return milestone_identity.report_group_key(
        m, include_unit=True, category_resolver=_dedupe_category_key
    )


def unify_duplicate_milestones(milestones: list) -> tuple[list, list[str]]:
    """Collapse milestones that are the same reported result from several sources.

    Upstream mirrors can describe one real-world result twice under different
    titles - typically when two scrapers (a repository feed and a paper listing)
    both publish it. Each becomes its own record, so the dashboard counts it twice
    and the map stacks two dots on one location.

    A pair is merged only when ALL of these hold, which is what keeps genuinely
    distinct milestones apart:

      * identical date, value, unit and category (a shared *value* alone is far too
        weak - 100 qubits recurs constantly), and
      * either a shared specific document URL, or at least one shared content
        token in the titles.

    Deliberately NOT a merge signal: a bare/generic URL. Two different milestones
    routinely cite the same landing page (e.g. two SpaceX flights citing
    spacex.com, or two IBM milestones citing one Wikipedia article), and merging
    those would erase real history.

    The surviving record keeps the most informative title and gains a `sources`
    list naming every source that reported it, so provenance is preserved rather
    than discarded.

    Input order is preserved exactly: a merged record is emitted at the position
    of its first member and the rest of the cluster is dropped. merge_feed() has
    already sorted the feed newest-first, and build_site_categories()/build_events()
    both propagate list order into the published files, so regrouping here would
    silently unsort the feed and reshuffle the map's co-located stacks.

    Returns (unified_records, human_readable_changes).
    """
    # Pass 1: assign each record to a cluster, without emitting anything.
    buckets: dict[tuple, list[dict]] = {}
    for m in milestones:
        key = _dedupe_metric_key(m)
        if key is None:
            continue
        buckets.setdefault(key, []).append(m)

    # leader_of maps a cluster's first encountered member to the whole cluster, so
    # the survivor can be emitted at that member's position in pass 2. Records
    # without a metric key are never clustered and always pass through untouched.
    leader_of: dict[int, list[dict]] = {}
    emitted: set[int] = set()
    for bucket in buckets.values():
        clusters: list[list[dict]] = []
        for rec in bucket:
            for cluster in clusters:
                if _dedupe_same_report(cluster[0], rec):
                    cluster.append(rec)
                    break
            else:
                clusters.append([rec])
        for cluster in clusters:
            if len(cluster) > 1:
                leader_of[id(cluster[0])] = cluster

    # Pass 2: emit in the original order.
    out: list[dict] = []
    changes: list[str] = []
    for m in milestones:
        cluster = leader_of.get(id(m))
        if cluster is None:
            if id(m) in emitted:
                continue
            emitted.add(id(m))
            out.append(dict(m))
            continue
        # Only the first member emits; the rest collapse into it.
        if id(m) in emitted:
            continue
        emitted.update(id(r) for r in cluster)
        primary = _dedupe_pick_primary(cluster)
        sources = _dedupe_collect_sources(cluster)
        merged = dict(primary)
        # Only attach `sources` when it adds something, so a single-source record
        # keeps exactly the shape it had before.
        if len(sources) > 1:
            merged["sources"] = sources
        out.append(merged)
        ids = ", ".join(str(r.get("id")) for r in cluster)
        changes.append(
            f"unified {len(cluster)} records into {primary.get('id')} "
            f"({'; '.join(sources)})"
        )
        changes.append(f"  merged ids: {ids}")

    return out, changes


def _dedupe_pick_primary(cluster: list[dict]) -> dict:
    """Choose the record to keep.

    Preference order: the most informative summary, then a record that actually
    links somewhere, then the lowest id. Deterministic on purpose, so repeated
    runs over the same input always produce the same output and the commit
    fingerprint does not churn.
    """
    def rank(rec: dict) -> tuple:
        summary = str(rec.get("summary") or "")
        url = str(rec.get("url") or "").strip()
        # Negated so `min` picks the longest summary.
        return (-len(summary), 0 if url else 1, str(rec.get("id") or ""))

    return min(cluster, key=rank)


def _dedupe_collect_sources(cluster: list[dict]) -> list[str]:
    """Every distinct source name in the cluster, in first-seen order."""
    seen: list[str] = []
    for rec in cluster:
        name = str(rec.get("source") or "").strip()
        if name and name not in seen:
            seen.append(name)
    return seen


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
    when the span exceeds MAX_DAILY_DAYS; monthly when it exceeds
    MAX_WEEKLY_DAYS; yearly when it exceeds MAX_MONTHLY_DAYS. This keeps the
    chart readable no matter how far back the archive reaches.
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
            "first": today.isoformat(),
            "last": today.isoformat(),
            "total": 0,
            "days": [{"date": (today - timedelta(days=i)).isoformat(), "count": 0} for i in range(29, -1, -1)],
            "spikes": [],
        }

    earliest = min(counts)
    span_days = (today - earliest).days
    if span_days > MAX_MONTHLY_DAYS:
        bucket = "year"
    elif span_days > MAX_WEEKLY_DAYS:
        bucket = "month"
    elif span_days > MAX_DAILY_DAYS:
        bucket = "week"
    else:
        bucket = "day"

    if bucket == "day":
        buckets: dict[str, int] = {d.isoformat(): counts.get(d, 0) for d in date_range(earliest, today)}
    elif bucket == "week":
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
    elif bucket == "month":
        # Monthly buckets: key = first day of each month.
        month_counts: Counter = Counter()
        for d, c in counts.items():
            month_counts[d.replace(day=1)] += c
        buckets = {}
        cursor = earliest.replace(day=1)
        while cursor <= today:
            buckets[cursor.isoformat()] = month_counts.get(cursor, 0)
            if cursor.month == 12:
                cursor = cursor.replace(year=cursor.year + 1, month=1)
            else:
                cursor = cursor.replace(month=cursor.month + 1)
    else:
        # Yearly buckets: key = January 1 of each year.
        year_counts: Counter = Counter()
        for d, c in counts.items():
            year_counts[d.replace(month=1, day=1)] += c
        buckets = {}
        cursor = earliest.replace(month=1, day=1)
        while cursor <= today:
            buckets[cursor.isoformat()] = year_counts.get(cursor, 0)
            cursor = cursor.replace(year=cursor.year + 1)

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
        pattern = fr"(^|[^a-z0-9]){key.lower()}([^a-z0-9]|\$)"
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
        ev = {
            "id": "ev-" + m.get("id", ""),
            "title": m.get("title", ""),
            "category": display_category(m.get("category")),
            "value": event_value(m),
            "source": m.get("source", ""),
            "url": m.get("url"),
            "date": m.get("date", ""),
            "geolocation": {"lat": lat, "lon": lon},
        }
        # Only present when the record is in the secondary tone of a two-tone
        # category; the front end defaults to the category's primary colour.
        tone = classify_tone(m)
        if tone:
            ev["tone"] = tone
        events.append(ev)
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
        existing_ids = {m.get("id") for m in feed}
        unseen = [h for h in historic_milestones if h.get("id") not in existing_ids]
        feed.extend(unseen[:20])
    
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
    # Collapse reports of the same result that arrived from more than one source
    # before they reach the published feed, so the dashboard and the map count a
    # single breakthrough once and its provenance names every source.
    feed, dedupe_changes = unify_duplicate_milestones(feed)
    for line in dedupe_changes:
        print(line)
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