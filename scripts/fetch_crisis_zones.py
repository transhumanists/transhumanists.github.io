#!/usr/bin/env python3
"""
Fetch crisis zones from UN OCHA / WHO APIs and update world_layers.json crisis_zones.

Designed for daily GitHub Actions run. Stdlib-only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import zlib
from datetime import datetime, timezone
from pathlib import Path

WORLD_LAYERS_FILE = Path("data/world_layers.json")
CRISIS_ZONES_KEY = "crisis_zones"

# API endpoints (stdlib only - using public RSS/JSON feeds where available)
# ReliefWeb API base URLs (fields are appended by fetch_reliefweb_crises)
RELIEFWEB_API_V2 = "https://api.reliefweb.int/v2/disasters"  # ReliefWeb API v2
RELIEFWEB_API_V1 = "https://api.reliefweb.int/v1/disasters"  # ReliefWeb API v1 fallback

# RSS feeds that work (verified)
OCHA_RSS = "https://www.unocha.org/rss.xml"  # OCHA official RSS feed
UNHCR_RSS = "https://www.unhcr.org/rss.xml"  # UNHCR official RSS feed
WFP_RSS = "https://www.wfp.org/rss.xml"  # WFP official RSS feed
FAO_RSS = "https://www.fao.org/rss.xml"  # FAO official RSS feed
WHO_EMERGENCIES = "https://www.who.int/emergencies/disease-outbreak-news"  # WHO emergencies page
OCHA_HAPI = "https://data.humdata.org/api/3/action/package_search?q=humanitarian+crisis&rows=50"  # HDX API

# Better headers to avoid 403/410 errors
REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, application/xml, text/xml, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
}

# Schema version written by load_world_layers when the file is missing; keep in
# sync with sync_layers.py's LIFECYCLE_VERSION (the authoritative value).
SCHEMA_VERSION = "1.1.0"

# Fallback static crisis zones (used when API unavailable)
STATIC_CRISIS_ZONES = [
    {
        "id": "crisis-sudan",
        "name": "Sudan · Darfur famine",
        "region": "East Africa",
        "lat": 13.0,
        "lon": 24.5,
        "radiusDeg": 4.5,
        "status": "active",
        "note": "Humanitarian catastrophe, 25M+ in need",
        "source": "UN OCHA",
        "url": "https://www.unocha.org"
    },
    {
        "id": "crisis-yemen",
        "name": "Yemen · Cholera & famine",
        "region": "Middle East",
        "lat": 15.5,
        "lon": 44.2,
        "radiusDeg": 3.8,
        "status": "active",
        "note": "World's worst humanitarian crisis",
        "source": "WHO",
        "url": "https://www.who.int"
    },
    {
        "id": "crisis-myanmar",
        "name": "Myanmar · Rohingya displacement",
        "region": "Southeast Asia",
        "lat": 20.5,
        "lon": 92.5,
        "radiusDeg": 3.0,
        "status": "active",
        "note": "1M+ stateless refugees in camps",
        "source": "UNHCR",
        "url": "https://www.unhcr.org"
    },
    {
        "id": "crisis-afghanistan",
        "name": "Afghanistan · Winter hunger crisis",
        "region": "Central Asia",
        "lat": 33.5,
        "lon": 65.5,
        "radiusDeg": 5.0,
        "status": "active",
        "note": "28M+ facing acute food insecurity",
        "source": "WFP",
        "url": "https://www.wfp.org"
    },
    {
        "id": "crisis-somalia",
        "name": "Somalia · Drought & famine",
        "region": "East Africa",
        "lat": 2.5,
        "lon": 45.5,
        "radiusDeg": 4.0,
        "status": "active",
        "note": "5 consecutive failed rainy seasons",
        "source": "FAO",
        "url": "https://www.fao.org"
    },
    {
        "id": "crisis-syria",
        "name": "Syria · Humanitarian crisis",
        "region": "Middle East",
        "lat": 34.8,
        "lon": 38.9,
        "radiusDeg": 4.0,
        "status": "active",
        "note": "15M+ in need of humanitarian aid",
        "source": "UN OCHA",
        "url": "https://www.unocha.org"
    },
    {
        "id": "crisis-haiti",
        "name": "Haiti · Gang violence & hunger",
        "region": "Caribbean",
        "lat": 18.5,
        "lon": -72.3,
        "radiusDeg": 3.5,
        "status": "active",
        "note": "5M+ in need, gang violence & cholera",
        "source": "UN OCHA",
        "url": "https://www.unocha.org"
    },
    {
        "id": "crisis-ethiopia",
        "name": "Ethiopia · Tigray conflict",
        "region": "East Africa",
        "lat": 14.0,
        "lon": 38.5,
        "radiusDeg": 4.0,
        "status": "active",
        "note": "Millions displaced, famine risk",
        "source": "UN OCHA",
        "url": "https://www.unocha.org"
    },
    {
        "id": "crisis-sahel",
        "name": "Sahel · Conflict & hunger",
        "region": "West Africa",
        "lat": 13.0,
        "lon": 2.0,
        "radiusDeg": 6.0,
        "status": "active",
        "note": "10M+ displaced across Sahel",
        "source": "UN OCHA",
        "url": "https://www.unocha.org"
    },
    {
        "id": "crisis-drc",
        "name": "DRC · Conflict & Ebola",
        "region": "Central Africa",
        "lat": -1.5,
        "lon": 25.0,
        "radiusDeg": 5.0,
        "status": "active",
        "note": "Conflict, Ebola, displacement",
        "source": "WHO",
        "url": "https://www.who.int"
    },
]


# Hosts that served broken certificate chains from the runner and were thereby
# opted into unverified-TLS retries for the rest of this process. Process-scoped
# and per-host: verification stays ON for everything else, and first opt-in is
# always surfaced as a warning.
_UNVERIFIED_TLS_HOSTS: set[str] = set()


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


_MAX_HTTP_BODY = 10 * 1024 * 1024  # 10 MiB safety cap on untrusted public feed bodies


def _inflate_bounded(data: bytes, wbits: int) -> bytes:
    # zlib decompressobj lets us cap the decompressed size, not just the read:
    # a tiny compressed bomb can't expand into gigabytes of memory.
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
        try:
            return _inflate_bounded(data, 15).decode("utf-8", errors="replace")
        except zlib.error:
            return _inflate_bounded(data, -zlib.MAX_WBITS).decode("utf-8", errors="replace")
    return data.decode("utf-8", errors="replace")


def fetch_url(url: str, timeout: int = 30) -> str | None:
    """Fetch URL with retry, return text or None. Handles gzip/deflate.

    TLS is certificate-verified by default. An upstream host with a broken
    certificate chain is retried once WITHOUT verification, scoped to that exact
    host for the rest of the process and flagged with a warning — never a
    blanket, all-hosts verification bypass.
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        raise ValueError(f"refusing non-HTTPS URL: {url!r}")
    netloc = parsed.netloc.rpartition("@")[2]
    host = netloc.partition(":")[0]
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=REQUEST_HEADERS)
            with urllib.request.urlopen(req, timeout=timeout, context=_tls_context(host)) as resp:
                return _decode_body(resp)
        except urllib.error.HTTPError as e:
            print(f"  Attempt {attempt + 1}/3 failed: HTTP {e.code} - {e.reason}")
        except ssl.SSLError as e:
            if isinstance(e, ssl.SSLCertVerificationError) and _mark_unverified_host(host):
                continue
            print(f"  Attempt {attempt + 1}/3 failed: TLS error: {e}")
        except urllib.error.URLError as e:
            if isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError) and _mark_unverified_host(host):
                continue
            print(f"  Attempt {attempt + 1}/3 failed: {e.reason}")
        except Exception as e:
            print(f"  Attempt {attempt + 1}/3 failed with unexpected error: {e}")
    return None


def parse_ocha_rss(xml_text: str) -> list[dict]:
    """Parse OCHA/ReliefWeb RSS feed for crisis mentions."""
    crises = []
    items = re.findall(r"<item>(.*?)</item>", xml_text, re.DOTALL)
    for item in items:
        title_match = re.search(r"<title><!\[CDATA\[(.*?)\]\]></title>|<title>(.*?)</title>", item)
        link_match = re.search(r"<link><!\[CDATA\[(.*?)\]\]></link>|<link>(.*?)</link>", item)
        desc_match = re.search(r"<description><!\[CDATA\[(.*?)\]\]></description>|<description>(.*?)</description>", item)
        
        title = (title_match.group(1) or title_match.group(2) or "").strip() if title_match else ""
        link = (link_match.group(1) or link_match.group(2) or "").strip() if link_match else ""
        desc = (desc_match.group(1) or desc_match.group(2) or "").strip() if desc_match else ""
        
        text = (title + " " + desc).lower()
        crisis_keywords = ["famine", "cholera", "displacement", "refugee", "drought", "hunger", "crisis", "emergency", "outbreak", "epidemic"]
        if any(kw in text for kw in crisis_keywords):
            crises.append({
                "title": title[:100],
                "link": link,
                "description": desc[:200],
            })
    return crises


def parse_who_page(html_text: str) -> list[dict]:
    """Parse WHO emergencies page for crisis mentions."""
    crises = []
    # WHO disease outbreak news - try multiple selectors
    # Try article tags first
    items = re.findall(r'<article[^>]*>(.*?)</article>', html_text, re.DOTALL)
    if not items:
        # Try div with class containing 'outbreak' or 'emergency'
        items = re.findall(r'<div[^>]*class="[^"]*(outbreak|emergency|crisis)[^"]*"[^>]*>(.*?)</div>', html_text, re.DOTALL | re.IGNORECASE)
    if not items:
        # Fallback: any link with emergency/outbreak in href
        items = re.findall(r'<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>', html_text, re.DOTALL)
        items = [(m[1], m[0]) for m in items]  # swap to match expected format
    
    for item in items:
        if isinstance(item, tuple):
            title, link = item[0].strip(), item[1].strip()
        else:
            title_match = re.search(r'<h[23][^>]*>(.*?)</h[23]>', item)
            link_match = re.search(r'href="([^"]+)"', item)
            title = title_match.group(1).strip() if title_match else ""
            link = link_match.group(1) if link_match else ""
        
        if title and any(kw in title.lower() for kw in ["outbreak", "emergency", "crisis", "cholera", "famine", "epidemic", "disease"]):
            crises.append({
                "title": title[:100],
                "link": link,
            })
    return crises


def fetch_reliefweb_crises() -> list[dict]:
    """Fetch active crises from ReliefWeb API (v2 with v1 fallback)."""
    for base_url in [RELIEFWEB_API_V2, RELIEFWEB_API_V1]:
        url = f"{base_url}?appname=crisis-zone-fetcher&preset=latest&limit=50&fields[id,name,date,primary_country,url,description]"
        data = fetch_url(url)
        if data:
            try:
                resp = json.loads(data)
                crises = []
                for item in resp.get("data", []):
                    fields = item.get("fields", {})
                    name = fields.get("name", "")
                    url = fields.get("url", "")
                    date_str = fields.get("date", {}).get("created", "")
                    # primary_country is authoritative geo context (better than
                    # keyword guessing); tolerate either dict or plain string.
                    country = fields.get("primary_country")
                    if isinstance(country, dict):
                        country = country.get("name", "")
                    crises.append({
                        "title": name[:100],
                        "link": url,
                        "date": date_str,
                        "country": country if isinstance(country, str) else "",
                    })
                if crises:
                    return crises
            except (json.JSONDecodeError, KeyError):
                continue
    return []


def build_crisis_zones_from_sources(ocha_data: list, who_data: list, reliefweb_data: list, 
                                    unhcr_data: list, wfp_data: list, fao_data: list, hdx_data: list) -> list[dict]:
    """Build crisis zones from fetched sources, merging with static fallback."""
    zones = []
    seen_names = set()
    seen_ids = set()
    seen_keywords = set()
    
    # Priority: ReliefWeb (structured) > OCHA > HDX > UNHCR > WFP > FAO > WHO
    for source in [reliefweb_data, ocha_data, hdx_data, unhcr_data, wfp_data, fao_data, who_data]:
        for item in source:
            title = item.get("title", "").strip()
            if not title or title in seen_names:
                continue

            # Simple geo-location inference from title/keywords (the ReliefWeb
            # primary_country field, when present, is authoritative context).
            geo_text = " ".join(str(item.get(k, "")) for k in ("country", "title", "description", "link"))
            lat, lon, region, keyword = _locate(geo_text)
            # Drop items that cannot be geolocated (they would plot at 0,0
            # "Null Island" - the Gulf of Guinea - and mislead the map).
            if lat == 0.0 and lon == 0.0:
                continue

            # One readable, specific zone per affected place: generic datasets
            # about the same location collapse together (e.g. two items for
            # "South Sudan: Humanitarian Needs/Access" become a single
            # "South Sudan · Conflict & flooding" zone).
            if keyword and keyword in seen_keywords:
                continue
            if keyword:
                seen_keywords.add(keyword)
            seen_names.add(title)

            # Prefer the curated specific label; fall back to a cleaned title
            # for places that exist in the location table but have no label.
            label = CRISIS_LABELS.get(keyword) if keyword else None
            if label:
                zone_name, zone_note, zone_source = label
            else:
                zone_name, zone_note = _crisis_title_fallback(title)
                zone_source = "ReliefWeb / OCHA / WHO / UNHCR / WFP / FAO / HDX"

            crisis_id = "crisis-" + re.sub(r"[^a-z0-9]+", "-", zone_name.lower()).strip("-")[:50]
            # Two source titles can slug to the same id (e.g. different word
            # separators); skip so the saved file never carries duplicate ids.
            if crisis_id in seen_ids:
                continue
            seen_ids.add(crisis_id)
            zones.append({
                "id": crisis_id,
                "name": zone_name,
                "region": region,
                "lat": lat,
                "lon": lon,
                "radiusDeg": 4.0,
                "status": "active",
                "note": zone_note[:200],
                "source": zone_source,
                "url": item.get("link", "https://www.unocha.org"),
            })
            if len(zones) >= 15:  # Limit to 15 crisis zones
                break
        if len(zones) >= 15:
            break
    
    # Fallback to static if API failed (dedupe ids + clamp to the 15-zone cap,
    # the same contract the sourced path enforces; the input list is left as-is).
    if not zones:
        print("All APIs failed, using static crisis zones")
        return _finalize_crisis_zones(STATIC_CRISIS_ZONES)

    return zones[:15]


def _finalize_crisis_zones(zones: list[dict]) -> list[dict]:
    """Deduplicate by id (first occurrence wins) and clamp to the 15-zone cap."""
    out: list[dict] = []
    seen: set[str] = set()
    for z in zones:
        if not isinstance(z, dict):
            continue
        ident = z.get("id")
        if not isinstance(ident, str) or not ident or ident in seen:
            continue
        seen.add(ident)
        out.append(z)
        if len(out) >= 15:
            break
    return out


# Canonical place lookup: keyword -> (lat, lon, region). Matching is longest
# key first so that overlapping names resolve to the most specific place
# (e.g. "south sudan" is not swallowed by "sudan"; "nigeria" by "niger").
_LOCATIONS: dict[str, tuple[float, float, str]] = {
    "cabo delgado": (-12.5, 40.5, "Southern Africa"),
    "afghanistan": (33.5, 65.5, "Central Asia"),
    "syria": (34.8, 38.9, "Middle East"),
    "ukraine": (48.0, 31.0, "Eastern Europe"),
    "mozambique": (-18.67, 35.53, "Southern Africa"),
    "nigeria": (9.08, 8.68, "West Africa"),
    "niger": (17.61, 8.08, "West Africa"),
    "somalia": (2.5, 45.5, "East Africa"),
    "sudan": (13.0, 24.5, "East Africa"),
    "darfur": (13.0, 24.5, "East Africa"),
    "south sudan": (7.86, 30.2, "East Africa"),
    "yemen": (15.5, 44.2, "Middle East"),
    "myanmar": (20.5, 92.5, "Southeast Asia"),
    "rohingya": (20.5, 92.5, "Southeast Asia"),
    "ethiopia": (9.0, 39.5, "East Africa"),
    "tigray": (14.0, 38.5, "East Africa"),
    "palestine": (31.3, 34.3, "Middle East"),
    "gaza": (31.3, 34.3, "Middle East"),
    "haiti": (18.5, -72.3, "Caribbean"),
    "chad": (15.45, 18.73, "Central Africa"),
    "mali": (17.57, -3.99, "West Africa"),
    "kenya": (-1.29, 36.82, "East Africa"),
    "bangladesh": (23.68, 90.36, "South Asia"),
    "drc": (-1.5, 25.0, "Central Africa"),
    "congo": (-1.5, 25.0, "Central Africa"),
    "sahel": (13.0, 2.0, "West Africa"),
    "suez": (29.96, 32.55, "Middle East"),
    "red sea": (19.0, 38.0, "Middle East"),
    "africa": (5.0, 20.0, "Africa"),
    "middle east": (25.0, 45.0, "Middle East"),
}

# Readable, specific crisis labels in the style of the curated static list.
# They replace raw feed titles (e.g. "Chad: Humanitarian Needs" -> a specific,
# human-summarised crisis) so the map never shows un-parseable dataset text.
# Keyed by the _LOCATIONS keyword the item resolved to; value is
# (display name, note, source attribution).
CRISIS_LABELS: dict[str, tuple[str, str, str]] = {
    "sudan": ("Sudan · Darfur famine", "Humanitarian catastrophe, 25M+ in need", "UN OCHA"),
    "darfur": ("Sudan · Darfur famine", "Humanitarian catastrophe, 25M+ in need", "UN OCHA"),
    "south sudan": ("South Sudan · Conflict & flooding", "Civil conflict, displacement and food insecurity", "UN OCHA"),
    "yemen": ("Yemen · Cholera & famine", "World's worst humanitarian crisis", "WHO"),
    "myanmar": ("Myanmar · Rohingya displacement", "1M+ stateless refugees in camps", "UNHCR"),
    "rohingya": ("Myanmar · Rohingya displacement", "1M+ stateless refugees in camps", "UNHCR"),
    "afghanistan": ("Afghanistan · Winter hunger crisis", "28M+ facing acute food insecurity", "WFP"),
    "somalia": ("Somalia · Drought & famine", "5 consecutive failed rainy seasons", "FAO"),
    "syria": ("Syria · Humanitarian crisis", "15M+ in need of humanitarian aid", "UN OCHA"),
    "haiti": ("Haiti · Gang violence & hunger", "5M+ in need, gang violence & cholera", "UN OCHA"),
    "ethiopia": ("Ethiopia · Tigray conflict", "Millions displaced, famine risk", "UN OCHA"),
    "tigray": ("Ethiopia · Tigray conflict", "Millions displaced, famine risk", "UN OCHA"),
    "sahel": ("Sahel · Conflict & hunger", "10M+ displaced across the Sahel", "UN OCHA"),
    "drc": ("DRC · Conflict & displacement", "Armed conflict, Ebola and displacement", "UN OCHA"),
    "congo": ("DRC · Conflict & displacement", "Armed conflict, Ebola and displacement", "UN OCHA"),
    "ukraine": ("Ukraine · War & civilian needs", "Full-scale invasion, millions displaced", "UN OCHA"),
    "gaza": ("Gaza · Humanitarian emergency", "Mass displacement and famine risk", "UN OCHA"),
    "palestine": ("Gaza · Humanitarian emergency", "Mass displacement and famine risk", "UN OCHA"),
    "chad": ("Chad · Displacement crisis", "Hundreds of thousands displaced from Darfur", "UNHCR"),
    "nigeria": ("Nigeria · Insurgency & hunger", "Armed conflict, displacement and food insecurity", "UN OCHA"),
    "niger": ("Niger · Conflict & hunger", "Armed conflict, displacement and food insecurity", "UN OCHA"),
    "mali": ("Mali · Displacement crisis", "Armed conflict, displacement and food insecurity", "UN OCHA"),
    "mozambique": ("Mozambique · Cabo Delgado insurgency", "Insurgent attacks and internal displacement", "UN OCHA"),
    "cabo delgado": ("Mozambique · Cabo Delgado insurgency", "Insurgent attacks and internal displacement", "UN OCHA"),
    "kenya": ("Kenya · Floods & displacement", "Flooding, displacement and mudslides", "UN OCHA"),
    "bangladesh": ("Bangladesh · Floods & displacement", "Flooding, displacement and health needs", "UN OCHA"),
    "red sea": ("Red Sea · Shipping disruption", "Attacks disrupting commercial shipping routes", "UN OCHA"),
}


def _locate(text: str) -> tuple[float, float, str, str | None]:
    """Infer lat/lon/region and the matched location keyword from crisis text.

    Returns (0.0, 0.0, "Unknown", None) when nothing matches so callers can
    drop the un-geolocatable entry instead of plotting it at Null Island.
    """
    text_lower = text.lower()
    for keyword in sorted(_LOCATIONS, key=len, reverse=True):
        if keyword in text_lower:
            lat, lon, region = _LOCATIONS[keyword]
            return lat, lon, region, keyword
    return 0.0, 0.0, "Unknown", None


def infer_location(text: str) -> tuple[float, float, str]:
    lat, lon, region, _ = _locate(text)
    return lat, lon, region


def infer_region(text: str) -> str:
    return _locate(text)[2]


def _crisis_title_fallback(title: str) -> tuple[str, str]:
    """Readable name/note for a place that has no curated label.

    Strips the generic "...: Humanitarian Needs/Access" dataset suffix, which
    is precisely the boilerplate the readable style is meant to replace.
    """
    cleaned = re.sub(
        r"(?i)\s*:\s*(humanitarian\s+(needs?|access|snapshot|assessment|situation)).*$",
        "",
        title,
    ).strip(" :-")
    if cleaned:
        return f"{cleaned} · Humanitarian crisis", f"{cleaned} — live humanitarian situation"
    return "Humanitarian crisis", "Live humanitarian situation"


def load_world_layers(path: Path | None = None) -> dict:
    target = path or WORLD_LAYERS_FILE
    if target.exists():
        try:
            return json.loads(target.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"version": SCHEMA_VERSION, "last_update": "", "conflict_zones": [], "crisis_zones": [], "deployments": []}


def save_world_layers(data: dict, path: Path | None = None) -> bool:
    try:
        data["last_update"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        (path or WORLD_LAYERS_FILE).write_text(
            json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        return True
    except OSError:
        return False


def fetch_hdx_crises() -> list[dict]:
    """Fetch crisis data from HDX API."""
    hdx_data = []
    try:
        url = OCHA_HAPI
        data = fetch_url(url)
        if data:
            resp = json.loads(data)
            for pkg in resp.get("result", {}).get("results", []):
                title = pkg.get("title", "")
                notes = pkg.get("notes", "")
                url = f"https://data.humdata.org/dataset/{pkg.get('name', '')}"
                if title:
                    hdx_data.append({
                        "title": title,
                        "description": notes[:200],
                        "link": url,
                    })
    except Exception as e:
        print(f"  HDX API error: {e}")
    return hdx_data


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0] if __doc__ else None)
    ap.add_argument("--dry-run", action="store_true",
                    help="fetch, build and compare only - never write (live probe mode)")
    ap.add_argument("--output", default=None,
                    help="write to this world_layers.json path instead of the repo data dir")
    args = ap.parse_args()
    out_file: Path | None = Path(args.output) if args.output else None

    print("Fetching crisis zone data...")
    
    # Fetch from sources
    print("  Fetching ReliefWeb...")
    reliefweb = fetch_reliefweb_crises()
    print(f"  Got {len(reliefweb)} ReliefWeb items")
    
    print("  Fetching OCHA RSS...")
    ocha_xml = fetch_url(OCHA_RSS)
    ocha = parse_ocha_rss(ocha_xml) if ocha_xml else []
    print(f"  Got {len(ocha)} OCHA items")
    
    print("  Fetching UNHCR RSS...")
    unhcr_xml = fetch_url(UNHCR_RSS)
    unhcr = parse_ocha_rss(unhcr_xml) if unhcr_xml else []
    print(f"  Got {len(unhcr)} UNHCR items")
    
    print("  Fetching WFP RSS...")
    wfp_xml = fetch_url(WFP_RSS)
    wfp = parse_ocha_rss(wfp_xml) if wfp_xml else []
    print(f"  Got {len(wfp)} WFP items")
    
    print("  Fetching FAO RSS...")
    fao_xml = fetch_url(FAO_RSS)
    fao = parse_ocha_rss(fao_xml) if fao_xml else []
    print(f"  Got {len(fao)} FAO items")
    
    print("  Fetching HDX API...")
    hdx = fetch_hdx_crises()
    print(f"  Got {len(hdx)} HDX items")
    
    print("  Fetching WHO emergencies...")
    who_html = fetch_url(WHO_EMERGENCIES)
    who = parse_who_page(who_html) if who_html else []
    print(f"  Got {len(who)} WHO items")
    
    # Build crisis zones
    crisis_zones = build_crisis_zones_from_sources(ocha, who, reliefweb, unhcr, wfp, fao, hdx)
    print(f"Built {len(crisis_zones)} crisis zones")
    
    # Load existing world_layers
    data = load_world_layers(out_file)
    old_crisis = data.get(CRISIS_ZONES_KEY, [])
    
    # Check if content changed
    new_crisis_json = json.dumps(crisis_zones, sort_keys=True)
    old_crisis_json = json.dumps(old_crisis, sort_keys=True)
    
    if new_crisis_json == old_crisis_json:
        print("No changes to crisis zones")
        return 0
    
    if args.dry_run:
        print(f"[dry-run] would update {len(crisis_zones)} crisis zones "
              f"(differs from current {len(old_crisis)})")
        return 0
    
    # Update and save
    data[CRISIS_ZONES_KEY] = crisis_zones
    if save_world_layers(data, out_file):
        print(f"Updated {(out_file or WORLD_LAYERS_FILE)} with {len(crisis_zones)} crisis zones")
        return 0
    else:
        print("Error saving world_layers.json")
        return 1


if __name__ == "__main__":
    sys.exit(main())