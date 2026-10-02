#!/usr/bin/env python3
"""Geocode milestones from the article they came from, not just their title.

The pipeline's existing cascade only ever sees `title`, `summary`, `subcategory` and
`source`. That is why 13 records publish without a dot: an arXiv preprint titled
"LV-ROVER-MLT achieves record-low CER in Maltese OCR" says Malta, and nothing looks
at the adjective. This module adds three evidence sources the cascade lacks:

1. **Demonyms and nationalities** - "Maltese", "Japanese", "Korean" resolve to a
   country. These come from the title and summary, so they need no network and stay
   deterministic.
2. **The article body**, fetched on demand: affiliations ("ETH Zurich", "University
   of Tokyo") and place mentions in prose that never reach the title or summary.
3. **A cached result**, so the pipeline stays deterministic and offline. Network
   access happens only when explicitly asked for with `--refresh`.

Every candidate is *scored* rather than first-match. Title mentions outrank summary
mentions, an affiliation outranks both, and a record only gets a dot if the winner
clears a margin over the runner-up. Ambiguity is left as no dot on purpose: a wrong
dot is worse than an absent one, because an absent one is visibly missing while a
wrong one is confidently wrong.

Usage:
    python scripts/article_geocode.py --report          # queue, no network
    python scripts/article_geocode.py --refresh         # fetch, update the cache
    python scripts/article_geocode.py --refresh --limit 20
    python scripts/article_geocode.py --apply --dry-run # write resolved coords
"""
from __future__ import annotations

import argparse
import json
import re
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import geo_hints as gh
import location_contract as lc
import sync_milestones as sm

ROOT = Path(__file__).resolve().parent.parent
CACHE_PATH = ROOT / "data" / "geocode_cache.json"

# Weights. Title is the strongest short signal: a paper named for a country or a
# city is usually *about* that place. An affiliation block is stronger still because
# it is where a paper states where the work was done.
W_TITLE = 3.0
W_SUMMARY = 1.0
W_AFFILIATION = 5.0

# A winner must beat the runner-up by this, and clear this floor, or the record is
# left unlocated. Tuned so single-mention weak signals do not win.
MIN_SCORE = 3.0
MIN_MARGIN = 2.0

# Two signals count as pointing at the same place if they are within ~40 km.
# Rounding to a fixed grid was tried first and failed the moment two tables
# disagreed in the last decimal (Malta is 35.9/14.5 in geo_hints and 35.9/14.4 in
# DEMONYMS) - a 0.1 degree gap straddles any grid boundary.
MERGE_KM = 40.0

MAX_BYTES = 4 * 1024 * 1024
TIMEOUT = 20
USER_AGENT = "transhumanists-milestone-geocoder/1.0 (+https://transhumanists.github.io/)"

# ---------------------------------------------------------------- demonyms
# Adjective/noun -> (lat, lon, canonical place name). Deliberately conservative:
# every entry is a country or a distinctive sub-national entity, and the regex below
# requires a word boundary plus a lowercase match so a proper noun cannot trigger
# it. Each is only consulted on the title and summary, never on the body, because
# "American" appears constantly in prose that has nothing to do with the US.
DEMONYMS: dict[str, tuple[float, float, str]] = {
    "american": (39.8, -98.6, "United States"),
    "british": (54.0, -2.0, "United Kingdom"),
    "english": (52.4, -1.5, "United Kingdom"),
    "scottish": (56.8, -4.2, "United Kingdom"),
    "welsh": (52.3, -3.7, "United Kingdom"),
    "irish": (53.4, -8.2, "Ireland"),
    "french": (46.6, 2.4, "France"),
    "german": (51.2, 10.4, "Germany"),
    "dutch": (52.2, 5.3, "Netherlands"),
    "belgian": (50.6, 4.6, "Belgium"),
    "swiss": (46.8, 8.2, "Switzerland"),
    "austrian": (47.6, 14.1, "Austria"),
    "swedish": (60.1, 15.6, "Sweden"),
    "norwegian": (60.5, 8.5, "Norway"),
    "danish": (56.3, 9.5, "Denmark"),
    "finnish": (64.0, 26.0, "Finland"),
    "icelandic": (64.9, -19.0, "Iceland"),
    "polish": (52.1, 19.4, "Poland"),
    "czech": (49.8, 15.5, "Czech Republic"),
    "slovak": (48.7, 19.7, "Slovakia"),
    "hungarian": (47.2, 19.5, "Hungary"),
    "romanian": (45.9, 25.0, "Romania"),
    "bulgarian": (42.7, 25.5, "Bulgaria"),
    "greek": (39.1, 21.8, "Greece"),
    "turkish": (39.0, 35.2, "Turkey"),
    "russian": (61.5, 105.3, "Russia"),
    "ukrainian": (48.4, 31.2, "Ukraine"),
    "chinese": (35.9, 104.2, "China"),
    "taiwanese": (23.7, 121.0, "Taiwan"),
    "japanese": (36.2, 138.3, "Japan"),
    "korean": (35.9, 127.8, "South Korea"),
    "indian": (20.6, 79.0, "India"),
    "pakistani": (30.4, 69.3, "Pakistan"),
    "chinese-": (35.9, 104.2, "China"),
    "singaporean": (1.35, 103.8, "Singapore"),
    "indonesian": (-0.8, 113.9, "Indonesia"),
    "vietnamese": (14.1, 108.3, "Vietnam"),
    "thai": (15.9, 101.0, "Thailand"),
    "malaysian": (4.2, 101.9, "Malaysia"),
    "filipino": (12.9, 121.8, "Philippines"),
    "australian": (-25.3, 133.8, "Australia"),
    "new zealand": (-40.9, 174.9, "New Zealand"),
    "israeli": (31.0, 34.9, "Israel"),
    "iranian": (32.4, 53.7, "Iran"),
    "egyptian": (26.8, 30.8, "Egypt"),
    "saudi": (23.9, 45.1, "Saudi Arabia"),
    "emirati": (23.4, 53.8, "United Arab Emirates"),
    "qatari": (25.4, 51.2, "Qatar"),
    "nigerian": (9.1, 8.7, "Nigeria"),
    "kenyan": (-0.02, 37.9, "Kenya"),
    "ethiopian": (9.1, 40.5, "Ethiopia"),
    "ghanaian": (7.9, -1.0, "Ghana"),
    "south african": (-30.6, 22.9, "South Africa"),
    "canadian": (56.1, -106.3, "Canada"),
    "mexican": (23.6, -102.5, "Mexico"),
    "brazilian": (-14.2, -51.9, "Brazil"),
    "argentine": (-38.4, -63.6, "Argentina"),
    "argentinian": (-38.4, -63.6, "Argentina"),
    "chilean": (-35.7, -71.5, "Chile"),
    "colombian": (4.6, -74.3, "Colombia"),
    "peruvian": (-9.2, -75.0, "Peru"),
    "venezuelan": (6.4, -66.6, "Venezuela"),
    "bolivian": (-16.3, -63.6, "Bolivia"),
    "ecuadorian": (-1.8, -78.2, "Ecuador"),
    "cuban": (21.5, -77.8, "Cuba"),
    "maltese": (35.9, 14.4, "Malta"),
    "cypriot": (35.1, 33.4, "Cyprus"),
    "luxembourgish": (49.8, 6.1, "Luxembourg"),
    "estonian": (58.6, 25.0, "Estonia"),
    "latvian": (56.9, 24.6, "Latvia"),
    "lithuanian": (55.2, 23.9, "Lithuania"),
    "slovenian": (46.1, 14.8, "Slovenia"),
    "bosnian": (43.9, 17.7, "Bosnia and Herzegovina"),
    "serbian": (44.0, 21.0, "Serbia"),
    "croatian": (45.1, 15.5, "Croatia"),
    "albanian": (41.2, 20.2, "Albania"),
    "moldovan": (47.4, 28.4, "Moldova"),
    "georgian": (42.3, 43.4, "Georgia"),
    "armenian": (40.1, 45.0, "Armenia"),
    "azerbaijani": (40.4, 49.9, "Azerbaijan"),
    "kazakh": (48.0, 67.0, "Kazakhstan"),
    "uzbek": (41.4, 64.6, "Uzbekistan"),
    "nepalese": (28.4, 84.1, "Nepal"),
    "sri lankan": (7.9, 80.8, "Sri Lanka"),
    "bangladeshi": (23.7, 90.4, "Bangladesh"),
    "burmese": (21.9, 96.0, "Myanmar"),
    "cambodian": (12.6, 104.99, "Cambodia"),
    "laotian": (18.2, 105.7, "Laos"),
    "mongolian": (46.9, 103.8, "Mongolia"),
    "kazakhstani": (48.0, 67.0, "Kazakhstan"),
    "inca": (-13.5, -71.9, "Peru"),
    "aztec": (19.4, -99.1, "Mexico"),
    "mayan": (17.2, -89.1, "Guatemala"),
    "roman": (41.9, 12.5, "Italy"),
    "greek-": (39.1, 21.8, "Greece"),
}

_DEMONYM_RE = {
    k: re.compile(r"(?<![a-z])" + re.escape(k.rstrip("-")) + r"(?![a-z])")
    for k in DEMONYMS
}

# ---------------------------------------------------------------- fetching
def _tls_context() -> ssl.SSLContext:
    return ssl.create_default_context()


def _public_host(url: str) -> tuple[bool, str]:
    """True if every address `url`'s host resolves to is a routable public address.

    The URLs come out of data/milestones.json, which upstream supplies and the cron
    commits. A compromised or hostile upstream could plant a URL pointing at
    169.254.169.254 or an internal service, and the next person to run --refresh
    would fetch it from their own machine. That is a narrow exposure - the flag is
    operator-invoked, not in CI - but "narrow" is not "none", and the check is a
    dozen lines.
    """
    import ipaddress
    import socket
    from urllib.parse import urlsplit

    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return False, "scheme not allowed"
    host = parts.hostname
    if not host:
        return False, "no host"
    try:
        infos = socket.getaddrinfo(host, parts.port or (443 if parts.scheme == "https" else 80),
                                   proto=socket.IPPROTO_TCP)
    except OSError as exc:
        return False, "dns: %s" % exc.strerror
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return False, "unparseable address %r" % addr
        if not ip.is_global:
            return False, "%s is not a public address" % ip
    return True, ""


class _NoPrivateRedirects(urllib.request.HTTPRedirectHandler):
    """Re-validate the host on every redirect hop.

    Validating only the first URL is not enough: a public host can 302 to
    169.254.169.254, so each hop goes through the same check.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        ok, why = _public_host(newurl)
        if not ok:
            raise urllib.error.URLError("redirect to %s blocked: %s" % (newurl, why))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_text(url: str) -> tuple[str | None, str]:
    """Fetch a URL and return (extracted text, reason-if-None)."""
    if not url or not url.startswith(("http://", "https://")):
        return None, "no usable url"
    ok, why = _public_host(url)
    if not ok:
        return None, why
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
    })
    try:
        opener = urllib.request.build_opener(_NoPrivateRedirects())
        with opener.open(req, timeout=TIMEOUT) as resp:
            raw = resp.read(MAX_BYTES)
            ctype = resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        return None, "http %s" % exc.code
    except Exception as exc:  # noqa: BLE001 - any network failure is just "no text"
        return None, type(exc).__name__
    if "pdf" in ctype.lower() or raw[:5] == b"%PDF-":
        return None, "pdf (no text extraction)"
    charset = "utf-8"
    m = re.search(r"charset=([\w-]+)", ctype, re.I)
    if m:
        charset = m.group(1)
    try:
        html = raw.decode(charset, errors="replace")
    except LookupError:
        html = raw.decode("utf-8", errors="replace")
    return extract_text(html), ""


_SCRIPTISH = re.compile(
    r"<(script|style|noscript|svg|head)\b[^>]*>.*?</\1>", re.I | re.S)
_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"[ \t\r\f\v]+")
_MULTI_NL = re.compile(r"\n{3,}")


def extract_text(html: str) -> str:
    """Readable text from an HTML document. Good enough for place matching."""
    if not html:
        return ""
    text = _SCRIPTISH.sub(" ", html)
    text = re.sub(r"<br\s*/?>|</p>|</div>|</li>|</h[1-6]>", "\n", text, flags=re.I)
    text = _TAG.sub(" ", text)
    import html as html_mod
    text = html_mod.unescape(text)
    text = _WS.sub(" ", text)
    return _MULTI_NL.sub("\n\n", text).strip()


# ------------------------------------------------------- affiliation blocks
AFFIL_CUE = re.compile(
    r"(?:university|universit\u00e4t|universit\u00e9|universidad|college of|"
    r"institute of|instituto|laborator(?:y|ies)|school of|faculty of|"
    r"academy of|research (?:center|centre)|research lab\w*|national lab\w*|"
    r"max planck|cnrs|fondation|department of|division of|hospital of|"
    r"a researcher at|a physicist at|a professor at|works at|"
    r"based in|located in|headquartered)",
    re.I,
)

# Page furniture that sits next to affiliation words without being a place. "NASA
# ADS" is the Astrophysics Data System link that appears on every arXiv page - it
# matched the `nasa` entry and would have plotted a preprint in Maryland.
JUNK_NEAR_CUE = re.compile(
    r"\b(?:NASA\s+ADS|Google\s+Scholar|Semantic\s+Scholar|arXiv|"
    r"Connect\s+with|Donate|Search|Submit|Log\s+in|References\s*&\s*Citations|"
    r"Cite\s+this\s+paper)\b",
    re.I,
)

AFFIL_WINDOW = 110


def affiliation_windows(text: str) -> list[str]:
    """Text following an affiliation cue, where a place usually sits.

    Affiliations live mid-sentence in prose far more often than on their own line -
    "a theorist at Tsinghua University in China" and "the Perimeter Institute for
    Theoretical Physics in Waterloo, Canada" are the ordinary shape in a magazine
    article. Matching whole lines found nothing at all in a real sample; matching
    the short span after a cue finds the place every time.
    """
    if not text:
        return []
    windows = []
    for m in AFFIL_CUE.finditer(text):
        start = m.end()
        window = text[start:start + AFFIL_WINDOW]
        if not window.strip():
            continue
        if JUNK_NEAR_CUE.search(text[max(0, m.start() - 30):start + 40]):
            continue
        windows.append(window)
        if len(windows) >= 60:
            break
    return windows


# ------------------------------------------------------------- the scoring
def all_places(text: str) -> list[tuple[str, tuple[float, float]]]:
    """Every place named in `text`, not just the single best one.

    `geo_hints.match_place` returns the first hit in longest-name order, which is
    right for "where is this about" and badly wrong here: a magazine article naming
    a theorist at Tsinghua, the Perimeter Institute in Waterloo and a physicist at
    Stanford would resolve to whichever happened to sort first. Collecting them all
    turns the others into rivals, so a genuinely multi-institution piece refuses
    itself instead of picking a winner by accident.
    """
    if not text or not isinstance(text, str):
        return []
    lowered = text.lower()
    out = []
    for name, _pattern, coords in gh._MATCHERS:
        if _pattern.search(lowered):
            out.append((name, (coords[0], coords[1])))
    return out


def match_demonym(text: str) -> tuple[float, float, str] | None:
    """First demonym in `text`, as (lat, lon, country).

    Deliberately a single match, not the highest-scoring one: the caller uses this as
    a last-resort fallback after every stronger pass has declined, so it wants the
    most specific adjective present rather than a judged winner.
    """
    if not text or not isinstance(text, str):
        return None
    lowered = text.lower()
    best = None
    for name, entry in DEMONYMS.items():
        m = _DEMONYM_RE[name].search(lowered)
        if m and (best is None or len(name) > len(best[0])):
            best = (name, entry)
    if best is None:
        return None
    _name, (lat, lon, country) = best
    return lat, lon, country


def _candidates(text: str, weight: float, use_demonyms: bool) -> dict:
    """{place: (score, evidence)} for one text field."""
    found: dict[str, tuple[float, str]] = {}
    if not text or not text.strip():
        return found
    lowered = text.lower()

    for name, (lat, lon, canonical) in DEMONYMS.items():
        if use_demonyms and _DEMONYM_RE[name].search(lowered):
            label = "demonym:" + name
            found[label] = (found.get(label, (0.0, ""))[0] + weight, canonical)

    hit = gh.match_place(lowered)
    if hit:
        name, (lat, lon, _region) = hit
        found["place:" + name] = (found.get("place:" + name, (0.0, ""))[0] + weight, name)

    inst = sm._match_institution(lowered)
    if inst:
        key, coords = inst
        found["inst:" + key] = (found.get("inst:" + key, (0.0, ""))[0] + weight, key)
        found["__coords__" + key] = coords
    return found


def _coord_for(key: str, evidence: str) -> tuple[float, float] | None:
    if key.startswith("place:"):
        entry = gh.PLACE_COORDS.get(evidence)
        return (entry[0], entry[1]) if entry else None
    if key.startswith("inst:"):
        coords = sm.INSTITUTION_COORDS.get(evidence)
        if coords and lc.is_located(coords):
            return coords["lat"], coords["lon"]
    if key.startswith("demonym:"):
        entry = DEMONYMS.get(evidence.split(":", 1)[1])
        return (entry[0], entry[1]) if entry else None
    return None


def _kind_of(key: str) -> str:
    if key.startswith("inst:"):
        return "institution"
    if key.startswith("place:"):
        return "place"
    return "demonym"


def _within_km(a, b) -> bool:
    """Great-circle distance between two coordinates, in km."""
    import math
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6371.0 * math.asin(min(1.0, math.sqrt(h))) <= MERGE_KM


def resolve(record: dict, body: str | None = None) -> dict:
    """Best (lat, lon, confidence, evidence) for one record, or a refusal.

    Candidates are merged by *resolved coordinate*, not by name. "Maltese" is both a
    place in the hints table and a demonym, and counting them as two rivals would
    make the strongest signal in this dataset look ambiguous. Two routes to the same
    place are corroboration, which is the point.
    """
    # coord -> {"score": float, "keys": set, "kinds": set}
    merged: dict[tuple, dict] = {}

    def offer(key: str, evidence: str, weight: float, kind: str):
        coord = _coord_for(key, evidence)
        if coord is None or lc.is_unlocated({"lat": coord[0], "lon": coord[1]}):
            return
        for (alat, alon), slot in merged.items():
            if _within_km(coord, (alat, alon)):
                slot["score"] += weight
                slot["keys"].add(key)
                slot["kinds"].add(kind)
                break
        else:
            merged[(coord[0], coord[1])] = {"score": weight, "keys": {key},
                                            "kinds": {kind}}

    def scan(field: str, weight: float, use_demonyms: bool):
        if not field or not field.strip():
            return
        lowered = field.lower()
        if use_demonyms:
            for name in DEMONYMS:
                if _DEMONYM_RE[name].search(lowered):
                    offer("demonym:" + name, "demonym:" + name, weight, "demonym")
        for name, _coords in all_places(lowered):
            offer("place:" + name, name, weight, "place")
        inst = sm._match_institution(lowered)
        if inst:
            offer("inst:" + inst[0], inst[0], weight, "institution")

    scan(str(record.get("title") or ""), W_TITLE, True)
    scan(str(record.get("summary") or ""), W_SUMMARY, True)
    if body:
        # Body prose is where affiliations live, but it is also where stray place
        # names appear, so no demonym matching here.
        # Each candidate gets one affiliation vote, however many overlapping
        # windows it appears in. Without this an institution named in two windows
        # scores 10.0 against a rival's 5.0 and wins on an artefact of window
        # overlap rather than on evidence.
        body_voted: set[str] = set()
        for window in affiliation_windows(body):
            for key, (_score, evidence) in _candidates(window, 0.0, False).items():
                if key in body_voted:
                    continue
                body_voted.add(key)
                offer(key, evidence, W_AFFILIATION, _kind_of(key))

    if not merged:
        return {"located": False, "reason": "no place, institution or demonym found"}

    ranked = sorted(
        ((v["score"], coord, v) for coord, v in merged.items()),
        key=lambda t: (t[0], str(t[1])), reverse=True)
    top_score, coord, top = ranked[0]
    runner_up = ranked[1][0] if len(ranked) > 1 else 0.0

    def label(entry):
        return sorted(entry["keys"])[0]

    if top_score < MIN_SCORE:
        return {"located": False,
                "reason": "best signal %s scored %.1f, below the %.1f floor"
                          % (label(top), top_score, MIN_SCORE)}
    # Either it beats the field outright, or it is corroborated by two independent
    # routes to the same place. Without the second clause a single weak mention with
    # no competitor wins by default - which is how a dataset about a federal agency
    # ends up plotted at that agency's headquarters on the strength of its acronym.
    # Either two independent routes agree on this place, or it beat a rival by a
    # clear margin. A single route with NO rival does not qualify: with runner-up at
    # zero the margin is trivially satisfied, which is how one weak title mention
    # wins by default and plots a dataset at some agency's headquarters.
    corroborated = len(top["keys"]) >= 2
    beat_a_rival = runner_up > 0 and (top_score - runner_up) >= MIN_MARGIN
    # An affiliation *is* a statement about where the work was done, so one with no
    # competition is self-evidencing. It only counts as stated when it is genuinely
    # alone: an article naming Tsinghua, Perimeter and Stanford produces three
    # affiliation-strength candidates that tie, and accepting one of them because
    # "institutions are strong" would pick a winner by sort order and call it a
    # finding. With a rival present the ordinary margin rule applies.
    stated = top_score >= W_AFFILIATION and runner_up == 0.0
    if not (corroborated or beat_a_rival or stated):
        return {"located": False,
                "reason": "uncorroborated: %s (%.1f), no rival and no second route"
                          % (label(top), top_score)}

    kinds = top["kinds"]
    if "institution" in kinds:
        confidence = "institution"
    elif "place" in kinds:
        confidence = "place"
    else:
        confidence = "article"
    return {"located": True, "lat": coord[0], "lon": coord[1],
            "confidence": confidence, "evidence": label(top),
            "corroborated_by": sorted(top["keys"])[1:],
            "score": top_score, "margin": top_score - runner_up}


# ------------------------------------------------------------------- cache
def load_cache() -> dict:
    if CACHE_PATH.exists():
        try:
            return json.loads(CACHE_PATH.read_text(encoding="utf-8")).get("articles", {})
        except Exception:  # noqa: BLE001 - a corrupt cache must not block the run
            return {}
    return {}


def save_cache(cache: dict, keep_urls: set[str] | None = None) -> None:
    """Persist *derived outcomes only* - never the fetched page text.

    An earlier version stored up to 200KB of extracted article text per URL: 108KB of
    third-party prose committed to the repository and, because everything under data/
    is published by Jekyll, republished on the live site. Nothing downstream needs the
    text - the outcome is what the pipeline reads - so the cache now holds a content
    hash plus the resolved coordinate and its evidence.

    Two things are stripped on every write rather than trusted to be rewritten:

      * any `text` key, which catches legacy entries from before this change. Those
        survived a purge because their records had already been resolved and left the
        unlocated queue, so `--refresh` never visited them again.
      * entries for records no longer in the queue, so the file cannot grow without
        bound as milestones get resolved.
    """
    clean = {}
    for url, entry in cache.items():
        if not isinstance(entry, dict):
            continue
        if "text" in entry:
            entry = {k: v for k, v in entry.items() if k != "text"}
        if keep_urls is not None and url not in keep_urls:
            continue
        clean[url] = entry
    cache.clear()
    cache.update(clean)
    CACHE_PATH.write_text(json.dumps({
        "description": "Derived article-body geocoding outcomes. Stores the resolved "
                       "coordinate and the evidence for it - never the fetched page "
                       "text. Written only by scripts/article_geocode.py --refresh.",
        "version": "1.0.0",
        "articles": cache}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _text_digest(text: str) -> str:
    import hashlib
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def iter_unlocated(sources=("data/milestones.json", "data/milestones_history.json")):
    """Every record with no usable coordinate, newest first."""
    seen = {}
    for rel in sources:
        path = ROOT / rel
        if not path.exists():
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        items = payload if isinstance(payload, list) else []
        if not items:
            for cat in (payload.get("categories") or {}).values():
                if isinstance(cat, dict):
                    items.extend(cat.get("milestones") or [])
        for m in items:
            if isinstance(m, dict) and lc.is_unlocated(m.get("geolocation")):
                key = m.get("url") or m.get("id") or m.get("title")
                seen.setdefault(key, m)
    return sorted(seen.values(), key=lambda m: str(m.get("date") or ""), reverse=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--report", action="store_true",
                    help="resolve from title/summary/cache only; no network")
    ap.add_argument("--refresh", action="store_true",
                    help="fetch article bodies for unlocated records and cache them")
    ap.add_argument("--apply", action="store_true",
                    help="write resolved coordinates into the data files")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=25)
    args = ap.parse_args()

    queue = iter_unlocated()
    cache = load_cache()

    if args.refresh:
        for rec in queue[:args.limit]:
            url = rec.get("url") or ""
            body, reason = fetch_text(url)
            if body is None:
                cache[url] = {"fetched": None, "reason": reason}
                print("  fetch failed  %-52s %s" % ((rec.get("title") or "")[:52], reason))
                continue
            outcome = resolve(rec, body)
            cache[url] = {"fetched": _text_digest(body), "outcome": outcome}
            print("  fetched %6d chars -> %-10s %s"
                  % (len(body), "resolved" if outcome.get("located") else "no signal",
                     (rec.get("title") or "")[:48]))
        save_cache(cache, keep_urls={r.get("url") or "" for r in queue})
        print("cache written: %s (%d entries)" % (CACHE_PATH.name, len(cache)))

    if not args.refresh and not args.apply and not args.report:
        ap.error("choose --report, --refresh or --apply")

    rows = []
    replayed = False
    for rec in queue:
        url = rec.get("url") or ""
        entry = cache.get(url) or {}
        outcome = entry.get("outcome")
        if outcome is None:
            # No cached body: fall back to the deterministic title/summary passes,
            # which need no network and are what the pipeline itself uses.
            outcome = resolve(rec)
        else:
            replayed = True
        rows.append((rec, outcome))

    resolved = [r for r in rows if r[1].get("located")]
    print("\n%d/%d unlocated records resolved%s"
          % (len(resolved), len(rows),
             " (replayed from cached article bodies)" if replayed else ""))
    for rec, out in rows:
        title = (rec.get("title") or "")[:56]
        if out.get("located"):
            print("  OK   %-56s %8.3f,%8.3f  %-11s %s"
                  % (title, out["lat"], out["lon"], out["confidence"], out["evidence"]))
        else:
            print("  --   %-56s %s" % (title, out.get("reason", "")[:60]))

    if args.apply:
        if args.dry_run:
            print("\n[dry-run] would apply %d coordinate(s)" % len(resolved))
        else:
            applied = _apply(resolved)
            print("\napplied %d coordinate(s)" % applied)
    return 0


def _apply(resolved) -> int:
    """Write resolved coordinates into the data files, marking provenance."""
    changed = 0
    for rel in ("data/milestones.json", "data/milestones_history.json"):
        path = ROOT / rel
        if not path.exists():
            continue
        raw = path.read_text(encoding="utf-8")
        nl = "\r\n" if "\r\n" in raw else "\n"
        payload = json.loads(raw)
        items = payload if isinstance(payload, list) else None
        if items is None:
            items = []
            for cat in (payload.get("categories") or {}).values():
                if isinstance(cat, dict):
                    items.extend(cat.get("milestones") or [])
        for m in items:
            for rec, out in resolved:
                if (m.get("url") or "") == (rec.get("url") or "") and \
                        lc.is_unlocated(m.get("geolocation")):
                    m["geolocation"] = {"lat": out["lat"], "lon": out["lon"]}
                    m["location_confidence"] = out["confidence"]
                    m.pop("located", None)
                    changed += 1
                    break
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False).replace("\n", nl) + nl,
                        encoding="utf-8", newline="")
    return changed


if __name__ == "__main__":
    sys.exit(main())