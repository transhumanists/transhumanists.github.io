"""Fetch human rights violations for the map's Human Rights Violations layer.

This layer is deliberately NOT a milestone category: it carries no colour in the
category legend, has no catalog filter and is off by default. It is an
operational layer in world_layers.json, rendered as landmarks with the same
tooltip treatment as milestones, sitting alongside conflict zones, crisis zones
and deployments.

Sources are public human-rights feeds (OHCHR, Human Rights Watch, Amnesty
International). Everything here is best-effort: the script is designed to be run
by an unattended workflow, so a source outage, a rate limit or a schema change
must degrade to "no new rows", never to "erase the layer". Entries already in
world_layers.json are always preserved, and only entries that fail validation are
dropped.

Usage:
    python scripts/fetch_human_rights.py [--dry-run] [--output PATH]
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import ssl
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import geo_hints

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / "data" / "world_layers.json"
USER_AGENT = "transhumanists-worldmap/1.0 (+https://transhumanists.github.io)"

# Status values shared with the layer_lifecycle contract in
# schema/worldmap-data.schema.json. check_data.py enforces membership.
STATUS_VALUES = ("active", "ongoing", "concluded", "inactive", "ended", "resolved")

# Feed metadata. Kept declarative so adding a source is a one-line change and the
# parsers stay source-agnostic.
SOURCE_FEEDS = (
    {"id": "ohchr", "name": "OHCHR", "url": "https://www.ohchr.org/en/rss.xml"},
    {"id": "hrw", "name": "Human Rights Watch", "url": "https://www.hrw.org/rss/news"},
    {"id": "amnesty", "name": "Amnesty International", "url": "https://www.amnesty.org/en/rss/news/"},
    {"id": "frontlinedefenders", "name": "Front Line Defenders", "url": "https://www.frontlinedefenders.org/en/rss.xml"},
)

# An item is only promoted to the map if it reports a violation, not general news.
# Deliberately specific: broad terms like "protest" would drag in ordinary
# political reporting and turn the layer into noise.
VIOLATION_KEYWORDS = (
    "arbitrary detention", "arbitrary arrest", "detained", "detention",
    "disappearance", "enforced disappearance", "extrajudicial", "summary execution",
    "torture", "forced disappearance", "forced displacement", "ethnic cleansing",
    "genocide", "war crime", "crimes against humanity", "human trafficking",
    "child soldier", "child marriage", "forced marriage", "female genital mutilation",
    "persecution", "indigenous rights", "land rights", "press freedom",
    "journalist killed", "human rights defender", "activist detained",
    "hate crime", "religious freedom", "conscription", "internment",
)


def _tls_context() -> ssl.SSLContext:
    """Default TLS context.

    Deliberately no "tolerant" fallback. An earlier version had one that set
    CERT_NONE, which can never actually fire because create_default_context()
    sits outside its try block - dead code that would have silently disabled
    certificate verification on a feed whose contents get published as map
    landmarks if it were ever reached.
    """
    return ssl.create_default_context()


def fetch_url(url: str, timeout: int = 30) -> str | None:
    """GET a URL, returning decoded text or None. Never raises."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_tls_context()) as resp:
            raw = resp.read(4 * 1024 * 1024)
            charset = resp.headers.get_content_charset() or "utf-8"
    except Exception as exc:  # network, TLS, HTTP status, size - all non-fatal
        print(f"    fetch failed ({type(exc).__name__}): {url}")
        return None
    return raw.decode(charset, errors="replace")


_TAG_RE = {
    "title": re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I),
    "link": re.compile(r"<link[^>]*>(.*?)</link>", re.S | re.I),
    "description": re.compile(r"<description[^>]*>(.*?)</description>", re.S | re.I),
    "pubdate": re.compile(r"<pubDate[^>]*>(.*?)</pubDate>", re.S | re.I),
}


def _strip_html(raw: str) -> str:
    """Plain text from an HTML fragment.

    These feeds double-encode: the body arrives as `&lt;p&gt;` wrapping markup
    that was already rendered. One unescape therefore reveals tags that still need
    stripping, so the sequence has to be unescape -> strip -> unescape. Doing it
    the other way round leaves raw `<div class=...>` visible in every tooltip.
    """
    text = html.unescape(raw or "")
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    # Feeds also embed replacement characters for smart quotes and dashes.
    text = text.replace("\ufffd", "'")
    return re.sub(r"\s+", " ", text).strip()


def parse_feed(xml_text: str) -> list[dict]:
    """Minimal RSS/Atom item extraction.

    A full XML parser is deliberately avoided: these are third-party feeds that can
    emit slightly malformed markup, and xml.etree refuses documents a browser
    renders fine. Regex extraction with a graceful empty result keeps an unattended
    workflow alive instead of failing the whole run.
    """
    items: list[dict] = []
    for block in re.findall(r"<item[^>]*>(.*?)</item>", xml_text, re.S | re.I):
        def field(name: str) -> str:
            match = _TAG_RE[name].search(block)
            return _strip_html(match.group(1)) if match else ""

        title = field("title")
        if not title:
            continue
        link = field("link")
        if not link:
            # Atom puts the URL in an href attribute.
            href = re.search(r'<link[^>]*href="([^"]+)"', block, re.I)
            link = href.group(1) if href else ""
        items.append({
            "title": title,
            "url": link,
            "note": field("description")[:280],
            "pubdate": field("pubdate"),
        })
    return items


def is_violation_report(text: str) -> bool:
    """Whether a headline/body reports an actual rights violation."""
    lowered = (text or "").lower()
    return any(kw in lowered for kw in VIOLATION_KEYWORDS)


def locate(text: str, fallback_text: str = "") -> tuple[float, float, str] | None:
    """Best-effort country anchor, or None when unrecognised.

    The headline is searched first and the body only as a fallback. Feed bodies
    carry boilerplate naming other countries - an HRW article about a critic
    detained in the UAE sat above "a South Sudanese policeman", and matching the
    body first plotted the landmark 4,000 km away in South Sudan. The headline
    states the subject; the boilerplate does not.

    Hints live in geo_hints, shared with the milestone geocoder. This file used to
    keep its own copy, and that copy carried five duplicate keys that Python
    silently collapsed.
    """
    for haystack in (text, fallback_text):
        hit = geo_hints.match_place(haystack or "")
        if hit:
            lat, lon, region = hit[1]
            return lat, lon, region
    return None


def _slugify_id(title: str, url: str) -> str:
    """Stable id derived from the URL, falling back to the title.

    Stability matters: the id is the map's identity for a landmark, so re-running
    the fetch must not make yesterday's entry look like a new one. A URL hash
    survives a headline rewrite; the title fallback cannot, which is acceptable
    because those feeds always carry links.
    """
    basis = url.strip() or title.strip()
    digest = hashlib.sha256(basis.encode("utf-8", "replace")).hexdigest()[:10]
    return f"hr-{digest}"


def _parse_pubdate(raw: str) -> str | None:
    if not raw:
        return None
    for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z",
                "%d %b %Y %H:%M:%S %z", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw.strip(), fmt).date().isoformat()
        except ValueError:
            continue
    return None


def build_violation(item: dict, source_name: str, today: datetime) -> dict | None:
    """Turn one feed item into a layer entry, or None if it is unusable."""
    haystack = f"{item.get('title','')} {item.get('note','')}"
    if not is_violation_report(haystack):
        return None
    located = locate(item.get("title", ""), item.get("note", ""))
    if located is None:
        # A violation we cannot place is not a landmark. Dropping it is safer than
        # plotting it at (0,0), which the validator rejects as null island.
        return None
    lat, lon, region = located
    start = _parse_pubdate(item.get("pubdate", "")) or today.date().isoformat()
    title = _strip_html(item.get("title", ""))
    return {
        "id": _slugify_id(title, item.get("url", "")),
        "name": title[:160],
        "region": region,
        "lat": lat,
        "lon": lon,
        "status": "active",
        "start_date": start,
        "note": _strip_html(item.get("note", ""))[:280],
        "source": source_name,
        "url": item.get("url", "") or "",
    }


def validate_entry(entry: object) -> list[str]:
    """Local guard mirroring check_data.py, so a bad row never reaches the file."""
    problems: list[str] = []
    if not isinstance(entry, dict):
        return ["entry must be an object"]
    for field in ("id", "name", "region", "status"):
        if not isinstance(entry.get(field), str) or not entry[field].strip():
            problems.append(f"{field} must be a non-empty string")
    for field in ("lat", "lon"):
        val = entry.get(field)
        if not isinstance(val, (int, float)) or val != val:  # NaN check
            problems.append(f"{field} must be a finite number")
    lat, lon = entry.get("lat"), entry.get("lon")
    if isinstance(lat, (int, float)) and not -90 <= lat <= 90:
        problems.append("lat out of range")
    if isinstance(lon, (int, float)) and not -180 <= lon <= 180:
        problems.append("lon out of range")
    if lat == 0.0 and lon == 0.0:
        problems.append("(0,0) is the no-location marker and must not be plotted")
    if entry.get("status") not in STATUS_VALUES:
        problems.append(f"status {entry.get('status')!r} not in {list(STATUS_VALUES)}")
    return problems


def load_world_layers(path: Path | None = None) -> dict:
    target = path or DEFAULT_OUTPUT
    if not target.exists():
        return {"version": "1.1.0", "last_update": "", "human_rights_violations": []}
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"  ERROR: cannot read {target}: {exc}")
        raise SystemExit(1)
    if not isinstance(data, dict):
        print(f"  ERROR: {target} is not a JSON object")
        raise SystemExit(1)
    data.setdefault("human_rights_violations", [])
    return data


def _layer_schema_version() -> str:
    schema = ROOT / "schema" / "worldmap-data.schema.json"
    try:
        return json.loads(schema.read_text(encoding="utf-8"))["files"]["world_layers.json"]["version"]
    except (OSError, json.JSONDecodeError, KeyError):
        return "1.1.0"


def merge_entries(existing: list, fresh: list) -> tuple[list, int, int]:
    """Union new rows into the existing layer, keyed by id.

    Existing rows win on conflict so an established entry is never silently
    rewritten by a changed upstream headline, and nothing is ever removed: a feed
    that stops publishing must not make yesterday's violations vanish.
    """
    by_id = {e["id"]: e for e in existing if isinstance(e, dict) and e.get("id")}
    added = 0
    for entry in fresh:
        if entry["id"] in by_id:
            continue
        by_id[entry["id"]] = entry
        added += 1
    merged = sorted(by_id.values(), key=lambda e: (e.get("start_date") or "", e.get("id") or ""), reverse=True)
    return merged, added, len(merged)


def collect(today: datetime) -> list[dict]:
    """Fetch every configured feed and keep only locatable violation reports."""
    fresh: list[dict] = []
    for feed in SOURCE_FEEDS:
        print(f"  Fetching {feed['name']}...")
        body = fetch_url(feed["url"])
        if not body:
            print(f"    unavailable")
            continue
        items = parse_feed(body)
        kept = 0
        for item in items:
            entry = build_violation(item, feed["name"], today)
            if entry:
                fresh.append(entry)
                kept += 1
        print(f"    {len(items)} items -> {kept} located violation reports")
    return fresh


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("--dry-run", action="store_true",
                    help="fetch, build and report only - never write")
    ap.add_argument("--output", default=None, help="write to this path instead of data/")
    args = ap.parse_args()
    out_path = Path(args.output) if args.output else None

    today = datetime.now(timezone.utc)
    print("Fetching human rights violations...")

    data = load_world_layers(out_path)
    data["version"] = _layer_schema_version()
    existing = [e for e in data.get("human_rights_violations", []) if isinstance(e, dict)]

    fresh = collect(today)

    # Validate before merging: a malformed row is dropped here rather than
    # failing check_data.py in the workflow after a commit.
    valid: list[dict] = []
    dropped = 0
    for entry in fresh:
        problems = validate_entry(entry)
        if problems:
            dropped += 1
            print(f"    dropped {entry.get('id')}: {problems[0]}")
        else:
            valid.append(entry)

    merged, added, total = merge_entries(existing, valid)
    data["human_rights_violations"] = merged
    data["last_update"] = today.strftime("%Y-%m-%dT%H:%M:%S+00:00")

    print(f"  {len(fresh)} fresh -> {len(valid)} valid ({dropped} dropped), "
          f"{added} new, {total} total in layer")

    if not args.dry_run:
        target = out_path or DEFAULT_OUTPUT
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"OK: wrote {len(merged)} human rights landmarks to {target}")
    else:
        print("dry run: nothing written")
    return 0


if __name__ == "__main__":
    sys.exit(main())