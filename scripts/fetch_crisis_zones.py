#!/usr/bin/env python3
"""
Fetch crisis zones from UN OCHA / WHO APIs and update world_layers.json crisis_zones.

Designed for daily GitHub Actions run. Stdlib-only.
"""
from __future__ import annotations

import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

WORLD_LAYERS_FILE = Path("data/world_layers.json")
CRISIS_ZONES_KEY = "crisis_zones"

# API endpoints (stdlib only - using public RSS/JSON feeds where available)
# ReliefWeb API - requires appname parameter for identification
RELIEFWEB_API_V2 = "https://api.reliefweb.int/v2/disasters?appname=crisis-zone-fetcher&preset=latest&limit=50&fields[id,name,date,primary_country,url,description]"
RELIEFWEB_API_V1 = "https://api.reliefweb.int/v1/disasters?appname=crisis-zone-fetcher&preset=latest&limit=50&fields[id,name,date,primary_country,url,description]"

# RSS feeds that work (verified)
OCHA_RSS = "https://www.unocha.org/rss.xml"  # OCHA official RSS feed
UNHCR_RSS = "https://www.unhcr.org/rss.xml"  # UNHCR official RSS feed
WFP_RSS = "https://www.wfp.org/rss.xml"  # WFP official RSS feed
FAO_RSS = "https://www.fao.org/rss.xml"  # FAO official RSS feed
WHO_EMERGENCIES = "https://www.who.int/emergencies/disease-outbreak-news"  # WHO emergencies page
RELIEFWEB_API_V2 = "https://api.reliefweb.int/v2/disasters"  # ReliefWeb API v2
RELIEFWEB_API_V1 = "https://api.reliefweb.int/v1/disasters"  # ReliefWeb API v1 fallback

# Additional crisis data sources
UNHCR_RSS = "https://www.unhcr.org/rss.xml"  # UNHCR official RSS feed
WFP_RSS = "https://www.wfp.org/rss.xml"  # WFP official RSS feed
FAO_RSS = "https://www.fao.org/rss.xml"  # FAO official RSS feed
OCHA_HAPI = "https://data.humdata.org/api/3/action/package_search?q=humanitarian+crisis&rows=50"  # HDX API

# Better headers to avoid 403/410 errors
REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, application/xml, text/xml, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
}

# Create SSL context that doesn't verify certificates (for sites with cert issues)
SSL_CONTEXT = ssl.create_default_context()
SSL_CONTEXT.check_hostname = False
SSL_CONTEXT.verify_mode = ssl.CERT_NONE

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


def fetch_url(url: str, timeout: int = 30) -> str | None:
    """Fetch URL with retry, return text or None. Handles gzip compression and SSL issues."""
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=REQUEST_HEADERS)
            # Use SSL context that doesn't verify certificates for problematic sites
            ssl_context = ssl.create_default_context()
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_NONE
            with urllib.request.urlopen(req, timeout=timeout, context=ssl_context) as resp:
                # Handle gzip compression
                content_encoding = resp.headers.get('Content-Encoding', '')
                if content_encoding == 'gzip':
                    import gzip
                    return gzip.decompress(resp.read()).decode("utf-8", errors="replace")
                return resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            print(f"  Attempt {attempt + 1}/3 failed: HTTP {e.code} - {e.reason}")
        except urllib.error.URLError as e:
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
                    crises.append({
                        "title": name[:100],
                        "link": url,
                        "date": date_str,
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
    
    # Priority: ReliefWeb (structured) > OCHA > HDX > UNHCR > WFP > FAO > WHO
    for source in [reliefweb_data, ocha_data, hdx_data, unhcr_data, wfp_data, fao_data, who_data]:
        for item in source:
            title = item.get("title", "").strip()
            if not title or title in seen_names:
                continue

            # Simple geo-location inference from title/keywords
            lat, lon, region = infer_location(item.get("title", "") + " " + item.get("description", "") + " " + item.get("link", ""))
            # Drop items that cannot be geolocated (they would plot at 0,0
            # "Null Island" - the Gulf of Guinea - and mislead the map).
            if lat == 0.0 and lon == 0.0:
                continue
            seen_names.add(title)
            
            crisis_id = "crisis-" + re.sub(r"[^a-z0-9]+", "-", item.get("title", "crisis").lower()).strip("-")[:50]
            zones.append({
                "id": crisis_id,
                "name": item.get("title", "Crisis")[:80],
                "region": infer_region(item.get("title", "")),
                "lat": lat,
                "lon": lon,
                "radiusDeg": 4.0,
                "status": "active",
                "note": item.get("description", item.get("title", ""))[:200],
                "source": "ReliefWeb / OCHA / WHO / UNHCR / WFP / FAO / HDX",
                "url": item.get("link", "https://www.unocha.org"),
            })
            if len(zones) >= 15:  # Limit to 15 crisis zones
                break
        if len(zones) >= 15:
            break
    
    # Fallback to static if API failed
    if not zones:
        print("All APIs failed, using static crisis zones")
        return STATIC_CRISIS_ZONES
    
    return zones[:15]


def infer_location(text: str) -> tuple[float, float, str]:
    """Infer lat/lon/region from crisis text keywords."""
    text_lower = text.lower()
    
    locations = {
        "sudan": (13.0, 24.5, "East Africa"),
        "darfur": (13.0, 24.5, "East Africa"),
        "yemen": (15.5, 44.2, "Middle East"),
        "myanmar": (20.5, 92.5, "Southeast Asia"),
        "rohingya": (20.5, 92.5, "Southeast Asia"),
        "afghanistan": (33.5, 65.5, "Central Asia"),
        "somalia": (2.5, 45.5, "East Africa"),
        "ethiopia": (9.0, 39.5, "East Africa"),
        "tigray": (14.0, 38.5, "East Africa"),
        "syria": (34.8, 38.9, "Middle East"),
        "ukraine": (48.0, 31.0, "Eastern Europe"),
        "gaza": (31.3, 34.3, "Middle East"),
        "palestine": (31.3, 34.3, "Middle East"),
        "haiti": (18.5, -72.3, "Caribbean"),
        "chad": (15.45, 18.73, "Central Africa"),
        "niger": (17.61, 8.08, "West Africa"),
        "nigeria": (9.08, 8.68, "West Africa"),
        "mozambique": (-18.67, 35.53, "Southern Africa"),
        "cabo delgado": (-12.5, 40.5, "Southern Africa"),
        "mali": (17.57, -3.99, "West Africa"),
        "kenya": (-1.29, 36.82, "East Africa"),
        "bangladesh": (23.68, 90.36, "South Asia"),
        "sahel": (13.0, 2.0, "West Africa"),
        "suez": (29.96, 32.55, "Middle East"),
        "red sea": (19.0, 38.0, "Middle East"),
        "africa": (5.0, 20.0, "Africa"),
        "middle east": (25.0, 45.0, "Middle East"),
    }
    
    for keyword, (lat, lon, region) in locations.items():
        if keyword in text_lower:
            return lat, lon, region
    
    return 0.0, 0.0, "Unknown"


def infer_region(text: str) -> str:
    _, _, region = infer_location(text)
    return region


def load_world_layers() -> dict:
    if WORLD_LAYERS_FILE.exists():
        try:
            return json.loads(WORLD_LAYERS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"version": "1.0.0", "last_update": "", "conflict_zones": [], "crisis_zones": [], "deployments": []}


def save_world_layers(data: dict) -> bool:
    try:
        data["last_update"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        WORLD_LAYERS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        return True
    except OSError:
        return False


def fetch_hdx_crises() -> list[dict]:
    """Fetch crisis data from HDX API."""
    hdx_data = []
    try:
        url = "https://data.humdata.org/api/3/action/package_search?q=humanitarian+crisis&rows=50"
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
    data = load_world_layers()
    old_crisis = data.get(CRISIS_ZONES_KEY, [])
    
    # Check if content changed
    new_crisis_json = json.dumps(crisis_zones, sort_keys=True)
    old_crisis_json = json.dumps(old_crisis, sort_keys=True)
    
    if new_crisis_json == old_crisis_json:
        print("No changes to crisis zones")
        return 0
    
    # Update and save
    data[CRISIS_ZONES_KEY] = crisis_zones
    if save_world_layers(data):
        print(f"Updated {WORLD_LAYERS_FILE} with {len(crisis_zones)} crisis zones")
        return 0
    else:
        print("Error saving world_layers.json")
        return 1


if __name__ == "__main__":
    sys.exit(main())