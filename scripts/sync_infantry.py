#!/usr/bin/env python3
"""
Fetch infantry deployment data (troop mobilizations, ground force movements).

Sources:
- Global Firepower / Military Balance (troop numbers by country)
- UN Peacekeeping operations (UN DPKO data)
- NATO deployment tracker
- Government defense reports
- News/OSINT for recent troop movements

This is a stdlib-only script compatible with the existing pipeline.
"""
from __future__ import annotations

import json
import re
import sys
import ssl
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path
from typing import TypedDict

# ─── Constants ──────────────────────────────────────────────────────────────

INFANTRY_DEPLOYMENTS_FILE = Path("data/infantry_deployments.json")
WORLD_LAYERS_FILE = Path("data/world_layers.json")

# Safety cap on HTTP response size
_MAX_HTTP_BODY = 10 * 1024 * 1024  # 10 MiB

# Per-host TLS verification opt-out (for broken cert chains)
_UNVERIFIED_TLS_HOSTS: set[str] = set()


# ─── Data Structures ────────────────────────────────────────────────────────

class InfantryDeployment(TypedDict):
    id: str
    name: str
    country: str
    region: str
    lat: float
    lon: float
    troops: int
    kind: str  # "mobilization", "deployment", "rotation", "exercise"
    status: str  # "active", "concluded"
    start_date: str
    end_date: str
    direction: str  # cardinal direction or target region
    source: str
    url: str
    last_news_year: int


# ─── HTTP Helpers ──────────────────────────────────────────────────────────

def _tls_context(host: str) -> ssl.SSLContext:
    if host in _UNVERIFIED_TLS_HOSTS:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    return ssl.create_default_context()


def _mark_unverified_host(host: str) -> bool:
    if host in _UNVERIFIED_TLS_HOSTS:
        return False
    _UNVERIFIED_TLS_HOSTS.add(host)
    print(
        f"  WARNING: certificate verification failed for {host!r}; retrying this "
        f"host without TLS verification for the rest of the run"
    )
    return True


def _inflate_bounded(data: bytes, wbits: int) -> bytes:
    import zlib
    obj = zlib.decompressobj(wbits)
    out = obj.decompress(data, _MAX_HTTP_BODY + 1)
    if obj.unconsumed_tail or not obj.eof or len(out) > _MAX_HTTP_BODY:
        raise ValueError("inflated body exceeds safety cap")
    return out


def _decode_body(resp) -> str:
    encoding = resp.headers.get("Content-Encoding", "").strip().lower()
    data = resp.read(_MAX_HTTP_BODY + 1)
    if len(data) > _MAX_HTTP_BODY:
        raise ValueError("response body exceeds safety cap")
    if encoding == "gzip":
        return _inflate_bounded(data, 47).decode("utf-8", errors="replace")
    if encoding == "deflate":
        import zlib
        try:
            return _inflate_bounded(data, 15).decode("utf-8", errors="replace")
        except zlib.error:
            return _inflate_bounded(data, -zlib.MAX_WBITS).decode("utf-8", errors="replace")
    return data.decode("utf-8", errors="replace")


def fetch_url(url: str, timeout: int = 30) -> str | None:
    for attempt in range(3):
        try:
            host = urllib.parse.urlparse(url).netloc
            ctx = _tls_context(host)
            req = urllib.request.Request(url, headers={"User-Agent": "infantry-tracker/1.0"})
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                return _decode_body(resp)
        except (urllib.error.URLError, ssl.SSLError, OSError) as e:
            if attempt < 2:
                backoff = 5 * (2 ** attempt)
                print(f"  WARNING: fetch attempt {attempt + 1} failed: {e}, retrying in {backoff}s...")
                time.sleep(backoff)
            else:
                if "CERTIFICATE_VERIFY_FAILED" in str(e).upper() or "CERTIFICATE" in str(e).upper():
                    if _mark_unverified_host(host):
                        continue
                print(f"  ERROR: Could not fetch {url} after 3 attempts: {e}")
        except Exception as e:
            print(f"  ERROR: Unexpected error fetching {url}: {e}")
            break
    return None


# ─── Country Coordinates (shared with worldmap) ────────────────────────────
COUNTRY_COORDS: dict[str, tuple[float, float]] = {
    "ukraine": (48.38, 31.17),
    "russia": (55.75, 37.62),
    "poland": (51.92, 19.15),
    "romania": (45.94, 24.97),
    "germany": (51.17, 10.45),
    "france": (46.23, 2.21),
    "united kingdom": (55.38, -3.44),
    "united states": (37.09, -95.71),
    "china": (35.86, 104.20),
    "india": (20.59, 78.96),
    "pakistan": (30.38, 69.35),
    "israel": (31.05, 34.85),
    "palestine": (31.95, 35.23),
    "syria": (34.80, 39.00),
    "iran": (32.43, 53.68),
    "turkey": (38.96, 35.24),
    "north korea": (40.34, 127.51),
    "south korea": (35.91, 127.77),
    "japan": (36.20, 138.25),
    "taiwan": (23.70, 120.96),
    "australia": (-25.27, 133.78),
    "canada": (56.13, -106.35),
    "mexico": (23.63, -102.55),
    "brazil": (-14.24, -51.93),
    "south africa": (-30.56, 22.94),
    "egypt": (26.82, 30.80),
    "nigeria": (9.08, 8.68),
    "ethiopia": (9.15, 40.49),
    "kenya": (-0.02, 37.91),
    "sudan": (12.86, 30.22),
    "chad": (15.45, 18.73),
    "niger": (17.61, 8.08),
    "mali": (17.57, -3.99),
    "burkina faso": (12.24, -1.56),
    "maharashtra": (19.75, 75.71),  # for Indian Army deployments
    "punjab": (31.14, 75.34),
    "jammu kashmir": (33.78, 76.58),
    "arunachal pradesh": (28.22, 94.73),
    "sikkim": (27.53, 88.51),
    "ladakh": (34.22, 77.56),
    "western sahara": (24.22, -12.89),
    "morocco": (31.79, -7.09),
    "algeria": (28.03, 1.66),
    "libya": (26.34, 17.23),
    "tunisia": (33.89, 9.54),
    "mozambique": (-18.67, 35.53),
    "democratic republic of the congo": (-4.04, 21.75),
    "congo": (-0.23, 15.83),
    "central african republic": (6.61, 20.94),
    "south sudan": (6.88, 31.31),
    "somalia": (5.15, 46.20),
    "djibouti": (11.83, 42.59),
    "eritrea": (15.18, 39.79),
    "yemen": (15.55, 48.52),
    "saudi arabia": (23.89, 45.08),
    "uae": (23.42, 53.85),
    "qatar": (25.35, 51.18),
    "kuwait": (29.31, 47.48),
    "bahrain": (26.07, 50.55),
    "oman": (21.47, 55.98),
    "iraq": (33.32, 43.68),
    "jordan": (30.59, 36.24),
    "lebanon": (33.85, 35.86),
    "armenia": (40.07, 45.04),
    "azerbaijan": (40.14, 47.58),
    "georgia": (42.32, 43.36),
    "belarus": (53.71, 27.95),
    "moldova": (47.41, 28.37),
    "lithuania": (55.17, 23.88),
    "latvia": (56.88, 24.61),
    "estonia": (58.60, 25.01),
    "finland": (61.92, 25.75),
    "sweden": (60.13, 18.64),
    "norway": (60.47, 8.47),
    "denmark": (56.26, 9.50),
    "netherlands": (52.13, 5.29),
    "belgium": (50.50, 4.47),
    "luxembourg": (49.82, 6.13),
    "switzerland": (46.82, 8.23),
    "austria": (47.52, 14.55),
    "czech republic": (49.82, 15.47),
    "slovakia": (48.67, 19.70),
    "hungary": (47.16, 19.50),
    "slovenia": (46.15, 14.99),
    "croatia": (45.10, 15.20),
    "bosnia and herzegovina": (43.92, 17.67),
    "serbia": (44.02, 21.01),
    "montenegro": (42.71, 19.38),
    "north macedonia": (41.61, 21.75),
    "albania": (41.15, 20.17),
    "greece": (39.07, 21.83),
    "bulgaria": (42.73, 25.48),
    "romania": (45.94, 24.97),
    "moldova": (47.41, 28.37),
}


def country_centroid(name: str) -> tuple[float, float] | None:
    if not isinstance(name, str):
        return None
    key = name.strip().lower()
    # Direct match
    if key in COUNTRY_COORDS:
        return COUNTRY_COORDS[key]
    # Fuzzy match
    for known, coord in COUNTRY_COORDS.items():
        if key in known or known in key:
            return coord
    return None


# ─── Region Mapping ────────────────────────────────────────────────────────

REGION_MAP: dict[str, str] = {
    "ukraine": "Eastern Europe",
    "russia": "Eastern Europe",
    "poland": "Eastern Europe",
    "romania": "Eastern Europe",
    "belarus": "Eastern Europe",
    "moldova": "Eastern Europe",
    "lithuania": "Eastern Europe",
    "latvia": "Eastern Europe",
    "estonia": "Eastern Europe",
    "germany": "Central Europe",
    "france": "Western Europe",
    "united kingdom": "Western Europe",
    "netherlands": "Western Europe",
    "belgium": "Western Europe",
    "luxembourg": "Western Europe",
    "france": "Western Europe",
    "spain": "Western Europe",
    "portugal": "Western Europe",
    "italy": "Southern Europe",
    "greece": "Southern Europe",
    "turkey": "Western Asia / Europe",
    "united states": "North America",
    "canada": "North America",
    "mexico": "North America",
    "china": "East Asia",
    "india": "South Asia",
    "pakistan": "South Asia",
    "japan": "East Asia",
    "south korea": "East Asia",
    "north korea": "East Asia",
    "taiwan": "East Asia",
    "australia": "Oceania",
    "new zealand": "Oceania",
    "india": "South Asia",
    "pakistan": "South Asia",
    "bangladesh": "South Asia",
    "sri lanka": "South Asia",
    "nepal": "South Asia",
    "bhutan": "South Asia",
    "maldives": "South Asia",
    "afghanistan": "Central Asia",
    "uzbekistan": "Central Asia",
    "kazakhstan": "Central Asia",
    "kyrgyzstan": "Central Asia",
    "tajikistan": "Central Asia",
    "turkmenistan": "Central Asia",
    "iran": "Middle East",
    "iraq": "Middle East",
    "syria": "Middle East",
    "lebanon": "Middle East",
    "jordan": "Middle East",
    "israel": "Middle East",
    "palestine": "Middle East",
    "saudi arabia": "Middle East",
    "yemen": "Middle East",
    "oman": "Middle East",
    "uae": "Middle East",
    "qatar": "Middle East",
    "kuwait": "Middle East",
    "bahrain": "Middle East",
    "egypt": "North Africa",
    "libya": "North Africa",
    "tunisia": "North Africa",
    "algeria": "North Africa",
    "morocco": "North Africa",
    "sudan": "North Africa",
    "south sudan": "East Africa",
    "ethiopia": "East Africa",
    "eritrea": "East Africa",
    "djibouti": "East Africa",
    "somalia": "East Africa",
    "kenya": "East Africa",
    "uganda": "East Africa",
    "tanzania": "East Africa",
    "rwanda": "East Africa",
    "burundi": "East Africa",
    "democratic republic of the congo": "Central Africa",
    "congo": "Central Africa",
    "central african republic": "Central Africa",
    "cameroon": "Central Africa",
    "chad": "Central Africa",
    "niger": "West Africa",
    "nigeria": "West Africa",
    "mali": "West Africa",
    "burkina faso": "West Africa",
    "senegal": "West Africa",
    "mauritania": "West Africa",
    "guinea": "West Africa",
    "sierra leone": "West Africa",
    "liberia": "West Africa",
    "cote d'ivoire": "West Africa",
    "ghana": "West Africa",
    "togo": "West Africa",
    "benin": "West Africa",
    "angola": "Southern Africa",
    "zambia": "Southern Africa",
    "zimbabwe": "Southern Africa",
    "botswana": "Southern Africa",
    "namibia": "Southern Africa",
    "south africa": "Southern Africa",
    "mozambique": "Southern Africa",
    "malawi": "Southern Africa",
    "zambia": "Southern Africa",
    "brazil": "South America",
    "argentina": "South America",
    "chile": "South America",
    "colombia": "South America",
    "peru": "South America",
    "venezuela": "South America",
    "ecuador": "South America",
    "bolivia": "South America",
    "paraguay": "South America",
    "uruguay": "South America",
    "guyana": "South America",
    "suriname": "South America",
    "french guiana": "South America",
}

def get_region(country: str) -> str:
    key = country.strip().lower()
    return REGION_MAP.get(key, "Unknown")


# ─── Static Infantry Deployments (Curated) ────────────────────────────────

# These are known major mobilizations/deployments from recent years
# They serve as a curated baseline that news sources can enrich
STATIC_INFANTRY_DEPLOYMENTS: list[InfantryDeployment] = [
    {
        "id": "inf-ukraine-2022-mobilization",
        "name": "Ukraine General Mobilization 2022",
        "country": "Ukraine",
        "region": "Eastern Europe",
        "lat": 48.38,
        "lon": 31.17,
        "troops": 1000000,
        "kind": "mobilization",
        "status": "active",
        "start_date": "2022-02-24",
        "end_date": "",
        "direction": "east",
        "source": "Ukrainian Ministry of Defence",
        "url": "https://www.mil.gov.ua/",
        "last_news_year": 2024,
    },
    {
        "id": "inf-russia-2022-mobilization",
        "name": "Russia Partial Mobilization 2022",
        "country": "Russia",
        "region": "Eastern Europe",
        "lat": 55.75,
        "lon": 37.62,
        "troops": 300000,
        "kind": "mobilization",
        "status": "active",
        "start_date": "2022-09-21",
        "end_date": "",
        "direction": "west",
        "source": "Russian Ministry of Defence",
        "url": "https://www.mil.ru/",
        "last_news_year": 2024,
    },
    {
        "id": "inf-poland-2023-expansion",
        "name": "Poland Armed Forces Expansion 2023",
        "country": "Poland",
        "region": "Eastern Europe",
        "lat": 51.92,
        "lon": 19.15,
        "troops": 150000,
        "kind": "deployment",
        "status": "active",
        "start_date": "2023-01-01",
        "end_date": "",
        "direction": "east",
        "source": "Polish Ministry of National Defence",
        "url": "https://www.gov.pl/web/obrona-narodowa",
        "last_news_year": 2024,
    },
    {
        "id": "inf-finland-2023-nato",
        "name": "Finland NATO Integration 2023",
        "country": "Finland",
        "region": "Northern Europe",
        "lat": 61.92,
        "lon": 25.75,
        "troops": 280000,
        "kind": "deployment",
        "status": "active",
        "start_date": "2023-04-04",
        "end_date": "",
        "direction": "west",
        "source": "Finnish Defence Forces",
        "url": "https://www.puolustusvoimat.fi/",
        "last_news_year": 2024,
    },
    {
        "id": "inf-sweden-2024-nato",
        "name": "Sweden NATO Integration 2024",
        "country": "Sweden",
        "region": "Northern Europe",
        "lat": 60.13,
        "lon": 18.64,
        "troops": 50000,
        "kind": "deployment",
        "status": "active",
        "start_date": "2024-03-07",
        "end_date": "",
        "direction": "west",
        "source": "Swedish Armed Forces",
        "url": "https://www.forsvarsmakten.se/",
        "last_news_year": 2024,
    },
    {
        "id": "inf-india-china-border",
        "name": "India-China LAC Deployments",
        "country": "India",
        "region": "South Asia",
        "lat": 34.22,
        "lon": 77.56,
        "troops": 100000,
        "kind": "deployment",
        "status": "active",
        "start_date": "2020-05-01",
        "end_date": "",
        "direction": "north",
        "source": "Indian Ministry of Defence",
        "url": "https://www.mod.gov.in/",
        "last_news_year": 2024,
    },
    {
        "id": "inf-china-taiwan-strait",
        "name": "China Taiwan Strait Deployments",
        "country": "China",
        "region": "East Asia",
        "lat": 23.70,
        "lon": 120.96,
        "troops": 200000,
        "kind": "deployment",
        "status": "active",
        "start_date": "2022-08-01",
        "end_date": "",
        "direction": "east",
        "source": "PLA Daily",
        "url": "http://www.81.cn/",
        "last_news_year": 2024,
    },
    {
        "id": "inf-nato-eastern-flank",
        "name": "NATO Enhanced Forward Presence",
        "country": "Poland",
        "region": "Eastern Europe",
        "lat": 51.92,
        "lon": 19.15,
        "troops": 40000,
        "kind": "deployment",
        "status": "active",
        "start_date": "2017-01-01",
        "end_date": "",
        "direction": "east",
        "source": "NATO",
        "url": "https://www.nato.int/",
        "last_news_year": 2024,
    },
    {
        "id": "inf-us-europe-rotation",
        "name": "US Army Europe Rotational Deployments",
        "country": "United States",
        "region": "Europe",
        "lat": 51.17,
        "lon": 10.45,
        "troops": 20000,
        "kind": "rotation",
        "status": "active",
        "start_date": "2014-01-01",
        "end_date": "",
        "direction": "east",
        "source": "US Army Europe and Africa",
        "url": "https://www.eur.army.mil/",
        "last_news_year": 2024,
    },
    {
        "id": "inf-un-peacekeeping",
        "name": "UN Peacekeeping Operations",
        "country": "Multiple",
        "region": "Global",
        "lat": 46.23,
        "lon": 2.21,
        "troops": 87000,
        "kind": "deployment",
        "status": "active",
        "start_date": "1948-01-01",
        "end_date": "",
        "direction": "global",
        "source": "UN DPKO",
        "url": "https://peacekeeping.un.org/",
        "last_news_year": 2024,
    },
]


# ─── News Source Fetching (OSINT) ────────────────────────────────────────

def fetch_osint_deployments() -> list[InfantryDeployment]:
    """Fetch recent troop movement reports from OSINT sources."""
    deployments: list[InfantryDeployment] = []
    
    # Source 1: ISW (Institute for the Study of War) - they publish daily Ukraine updates
    isw_data = fetch_url("https://www.understandingwar.org/backgrounder/russian-offensive-campaign-assessment")
    if isw_data:
        # Parse ISW reports for troop numbers and movements
        # This is a simplified parser - would need enhancement for production
        pass
    
    # Source 2: CSIS Beyond Parallel - North Korea troop movements
    # Source 3: IISS Military Balance API (if available)
    # Source 4: Government defense ministry RSS feeds
    
    # For now, return empty - static curated data is the primary source
    # News sources can be added incrementally
    return deployments


# ─── Merge Logic ──────────────────────────────────────────────────────────

def _deployment_id(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:50]
    return f"inf-{slug}"


def merge_infantry_deployments(
    curated: list[InfantryDeployment], news: list[InfantryDeployment]
) -> tuple[list[InfantryDeployment], list[str]]:
    """Merge news-derived deployments into curated ones."""
    changes: list[str] = []
    curated = list(curated)
    
    # Create lookup for existing deployments by country+kind
    existing_by_country: dict[tuple[str, str], InfantryDeployment] = {}
    for d in curated:
        key = (d["country"].lower(), d["kind"])
        existing_by_country[key] = d
    
    for news_dep in news:
        key = (news_dep["country"].lower(), news_dep["kind"])
        if key in existing_by_country:
            # Update existing if news is more recent
            existing = existing_by_country[key]
            news_year = int(news_dep["start_date"][:4]) if news_dep.get("start_date") else 0
            existing_year = int(existing["start_date"][:4]) if existing.get("start_date") else 0
            if news_year > existing_year:
                existing["troops"] = news_dep["troops"]
                existing["last_news_year"] = news_dep["last_news_year"]
                existing["status"] = news_dep["status"]
                if news_dep.get("end_date"):
                    existing["end_date"] = news_dep["end_date"]
                changes.append(f"updated {existing['id']} from news: troops={news_dep['troops']}, status={news_dep['status']}")
        else:
            # New deployment from news
            curated.append(news_dep)
            changes.append(f"added {news_dep['id']} from news: {news_dep['name']}")
    
    return curated, changes


# ─── Main Pipeline ────────────────────────────────────────────────────────

def build_infantry_deployments(offline: bool = False) -> tuple[list[InfantryDeployment], list[str]]:
    """Build infantry deployments list from curated + news sources."""
    changes: list[str] = []
    
    # Start with static curated deployments
    deployments = list(STATIC_INFANTRY_DEPLOYMENTS)
    
    if not offline:
        try:
            news_deployments = fetch_osint_deployments()
            if news_deployments:
                merged, merge_changes = merge_infantry_deployments(deployments, news_deployments)
                deployments = merged
                changes.extend(merge_changes)
            else:
                changes.append("no new infantry deployments from OSINT sources")
        except Exception as e:
            changes.append(f"OSINT fetch error ({e}) - keeping curated data")
    else:
        changes.append("offline mode - using curated infantry deployments only")
    
    return deployments, changes


def load_world_layers() -> dict:
    """Load world_layers.json"""
    if WORLD_LAYERS_FILE.exists():
        return json.loads(WORLD_LAYERS_FILE.read_text(encoding="utf-8"))
    return {"version": "1.1.0", "last_update": "", "conflict_zones": [], "crisis_zones": [], "deployments": []}


def save_world_layers(data: dict) -> bool:
    """Save world_layers.json with deployments merged"""
    tmp = WORLD_LAYERS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(WORLD_LAYERS_FILE)
    return True


def normalize_infantry_deployment(dep: InfantryDeployment) -> InfantryDeployment:
    """Normalize lifecycle fields for infantry deployment"""
    dep = dict(dep)
    dep.setdefault("status", "active")
    dep["start_date"] = (dep.get("start_date") or "").strip()
    dep["end_date"] = (dep.get("end_date") or "").strip()
    if dep["status"] is None:
        dep["status"] = "concluded" if dep["end_date"] else "active"
    return dep


def main(argv: list[str]) -> int:
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="use curated data only, no network")
    parser.add_argument("--write", action="store_true", help="write merged deployments to world_layers.json")
    parser.add_argument("--json", dest="json_path", default=str(WORLD_LAYERS_FILE), help="target JSON file")
    args = parser.parse_args(argv)

    deployments, changes = build_infantry_deployments(offline=args.offline)
    
    for line in changes:
        print(f"  {line}")

    # Normalize
    deployments = [normalize_infantry_deployment(d) for d in deployments]

    # Load world_layers and merge
    data = load_world_layers()
    
    # Separate existing fleet deployments
    existing_deployments = data.get("deployments", [])
    fleet_deployments = [d for d in existing_deployments if d.get("kind") == "fleet"]
    ground_deployments = [d for d in existing_deployments if d.get("kind") in ("ground", "infantry", "mobilization", "deployment", "rotation")]
    
    # Merge infantry deployments with existing ground deployments, deduplicating by ID
    existing_ground_by_id = {d["id"]: d for d in ground_deployments}
    for new_dep in deployments:
        existing_ground_by_id[new_dep["id"]] = new_dep
    all_ground = list(existing_ground_by_id.values())
    
    # Combine with fleet deployments
    all_deployments = fleet_deployments + all_ground
    
    data["deployments"] = all_deployments
    data["version"] = "1.1.0"
    data["last_update"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

    if args.write:
        if save_world_layers(data):
            print(f"[ok] wrote {WORLD_LAYERS_FILE} ({len(all_deployments)} total deployments)")
        else:
            print("[error] failed to write world_layers.json")
            return 1
    else:
        print(f"[info] {len(deployments)} infantry deployments, {len(all_deployments)} total deployments (dry-run)")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))