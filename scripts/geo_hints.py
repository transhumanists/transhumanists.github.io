"""Shared place-name hints for geocoding milestone and human-rights records.

Two callers need the same knowledge and were keeping separate copies:
``sync_milestones`` (where was this paper done?) and ``fetch_human_rights``
(where was this reported?). The first copy carried five duplicate dict keys,
which Python silently collapsed - a bug that was invisible in review and would
have been invisible in production too.

Matching is longest-name-first, so "democratic republic of the congo" beats
"congo" and "united kingdom" beats "kingdom". Coordinates are deliberately
coarse - a country centroid, not a city point. A milestone placed on the wrong
island is worse than one placed on the right continent, and nothing here should
ever be treated as a precise address.

No entry may be (0, 0): that is the project's "no location" marker, and a real
hint returning it would publish a dot in the Gulf of Guinea.
"""

from __future__ import annotations

import re

# Country and region anchors. Region strings are for the tooltip, not matching.
PLACE_COORDS: dict[str, tuple[float, float, str]] = {
    # --- Europe -------------------------------------------------------------
    "united kingdom": (54.0, -2.0, "Western Europe"),
    "great britain": (54.0, -2.0, "Western Europe"),
    "england": (52.5, -1.5, "Western Europe"),
    "scotland": (57.0, -4.0, "Western Europe"),
    "ireland": (53.2, -8.0, "Western Europe"),
    "france": (46.6, 2.4, "Western Europe"),
    "spain": (40.3, -3.7, "Southern Europe"),
    "portugal": (39.6, -8.0, "Southern Europe"),
    "italy": (41.9, 12.6, "Southern Europe"),
    "germany": (51.2, 10.4, "Western Europe"),
    "netherlands": (52.2, 5.3, "Western Europe"),
    "belgium": (50.6, 4.6, "Western Europe"),
    "switzerland": (46.8, 8.2, "Western Europe"),
    "austria": (47.6, 14.1, "Western Europe"),
    "sweden": (62.0, 15.0, "Northern Europe"),
    "norway": (64.5, 12.5, "Northern Europe"),
    "denmark": (56.1, 9.5, "Northern Europe"),
    "finland": (63.0, 26.0, "Northern Europe"),
    "iceland": (64.9, -19.0, "Northern Europe"),
    "estonia": (58.6, 25.0, "Northern Europe"),
    "latvia": (56.9, 24.6, "Northern Europe"),
    "lithuania": (55.2, 23.9, "Northern Europe"),
    "poland": (52.0, 19.1, "Eastern Europe"),
    "czech republic": (49.8, 15.5, "Eastern Europe"),
    "czechia": (49.8, 15.5, "Eastern Europe"),
    "slovakia": (48.7, 19.7, "Eastern Europe"),
    "hungary": (47.2, 19.5, "Eastern Europe"),
    "romania": (45.9, 25.0, "Eastern Europe"),
    "bulgaria": (42.7, 25.5, "Eastern Europe"),
    "greece": (39.1, 21.8, "Southern Europe"),
    "croatia": (45.1, 15.2, "Southern Europe"),
    "serbia": (44.0, 21.0, "Southern Europe"),
    "slovenia": (46.1, 14.8, "Southern Europe"),
    "ukraine": (49.0, 31.4, "Eastern Europe"),
    "belarus": (53.9, 27.6, "Eastern Europe"),
    "russia": (55.8, 37.6, "Eastern Europe"),
    "moldova": (47.4, 28.4, "Eastern Europe"),
    "malta": (35.9, 14.5, "Southern Europe"),
    "maltese": (35.9, 14.5, "Southern Europe"),
    "cyprus": (35.1, 33.4, "Western Asia"),
    # --- North America ------------------------------------------------------
    "united states": (39.8, -98.6, "North America"),
    "united states of america": (39.8, -98.6, "North America"),
    "canada": (56.1, -106.3, "North America"),
    "mexico": (23.6, -102.5, "North America"),
    "guatemala": (15.8, -90.2, "Central America"),
    "honduras": (15.2, -86.2, "Central America"),
    "costa rica": (9.7, -84.0, "Central America"),
    "panama": (8.5, -80.8, "Central America"),
    "cuba": (21.5, -77.8, "Caribbean"),
    "haiti": (19.0, -72.3, "Caribbean"),
    "jamaica": (18.1, -77.3, "Caribbean"),
    # --- South America ------------------------------------------------------
    "brazil": (-14.2, -51.9, "South America"),
    "argentina": (-38.4, -63.6, "South America"),
    "chile": (-35.7, -71.5, "South America"),
    "colombia": (4.6, -74.1, "South America"),
    "peru": (-9.2, -75.0, "South America"),
    "venezuela": (6.4, -66.6, "South America"),
    "bolivia": (-16.3, -63.6, "South America"),
    "ecuador": (-1.8, -78.2, "South America"),
    "uruguay": (-32.5, -55.8, "South America"),
    "paraguay": (-23.4, -58.4, "South America"),
    # --- Asia ---------------------------------------------------------------
    "china": (35.9, 104.2, "Eastern Asia"),
    "japan": (36.2, 138.3, "Eastern Asia"),
    "south korea": (36.5, 127.9, "Eastern Asia"),
    "korea": (36.5, 127.9, "Eastern Asia"),
    "north korea": (40.3, 127.5, "Eastern Asia"),
    "taiwan": (23.7, 121.0, "Eastern Asia"),
    "hong kong": (22.3, 114.2, "Eastern Asia"),
    "singapore": (1.35, 103.8, "South-Eastern Asia"),
    "india": (20.6, 79.0, "Southern Asia"),
    "pakistan": (30.4, 69.3, "Southern Asia"),
    "bangladesh": (23.7, 90.4, "Southern Asia"),
    "sri lanka": (7.9, 80.8, "Southern Asia"),
    "nepal": (28.4, 84.1, "Southern Asia"),
    "bhutan": (27.5, 90.5, "Southern Asia"),
    "afghanistan": (33.9, 67.7, "Central Asia"),
    "kazakhstan": (48.0, 66.9, "Central Asia"),
    "uzbekistan": (41.4, 64.6, "Central Asia"),
    "turkmenistan": (38.9, 59.5, "Central Asia"),
    "tajikistan": (38.9, 71.3, "Central Asia"),
    "kyrgyzstan": (41.2, 74.8, "Central Asia"),
    "mongolia": (46.9, 103.8, "Eastern Asia"),
    "indonesia": (-0.8, 113.9, "South-Eastern Asia"),
    "malaysia": (4.2, 101.9, "South-Eastern Asia"),
    "thailand": (15.9, 101.0, "South-Eastern Asia"),
    "vietnam": (14.1, 108.3, "South-Eastern Asia"),
    "cambodia": (12.6, 105.0, "South-Eastern Asia"),
    "laos": (19.9, 102.5, "South-Eastern Asia"),
    "myanmar": (21.9, 95.9, "South-Eastern Asia"),
    "burma": (21.9, 95.9, "South-Eastern Asia"),
    "philippines": (12.9, 121.8, "South-Eastern Asia"),
    "brunei": (4.5, 114.7, "South-Eastern Asia"),
    "australia": (-25.3, 133.8, "Oceania"),
    "new zealand": (-41.0, 174.0, "Oceania"),
    # --- Middle East & West Asia -------------------------------------------
    "israel": (31.4, 34.9, "Western Asia"),
    "palestine": (31.9, 35.2, "Western Asia"),
    "gaza": (31.5, 34.5, "Western Asia"),
    "west bank": (32.0, 35.3, "Western Asia"),
    "jordan": (31.2, 36.5, "Western Asia"),
    "lebanon": (33.9, 35.5, "Western Asia"),
    "syria": (34.8, 39.0, "Western Asia"),
    "turkey": (39.0, 35.2, "Western Asia"),
    "turkiye": (39.0, 35.2, "Western Asia"),
    "iraq": (33.2, 43.7, "Western Asia"),
    "iran": (32.4, 53.7, "Western Asia"),
    "saudi arabia": (23.9, 45.1, "Western Asia"),
    "united arab emirates": (23.4, 53.8, "Western Asia"),
    "qatar": (25.4, 51.2, "Western Asia"),
    "bahrain": (26.0, 50.6, "Western Asia"),
    "kuwait": (29.3, 47.5, "Western Asia"),
    "oman": (21.0, 57.0, "Western Asia"),
    "yemen": (15.4, 44.2, "Western Asia"),
    "georgia": (42.3, 43.4, "Western Asia"),
    "armenia": (40.1, 45.0, "Western Asia"),
    "azerbaijan": (40.1, 47.6, "Western Asia"),
    # --- Africa -------------------------------------------------------------
    "morocco": (31.8, -7.1, "Northern Africa"),
    "algeria": (28.0, 1.7, "Northern Africa"),
    "tunisia": (33.9, 9.5, "Northern Africa"),
    "libya": (26.3, 17.2, "Northern Africa"),
    "egypt": (26.8, 30.8, "Northern Africa"),
    "sudan": (12.8, 30.2, "Northern Africa"),
    "south sudan": (6.9, 31.3, "Northern Africa"),
    "ethiopia": (9.1, 40.5, "Eastern Africa"),
    "eritrea": (15.2, 39.8, "Eastern Africa"),
    "somalia": (5.2, 46.2, "Eastern Africa"),
    "kenya": (-0.02, 37.9, "Eastern Africa"),
    "uganda": (1.37, 32.3, "Eastern Africa"),
    "tanzania": (-6.4, 34.9, "Eastern Africa"),
    "rwanda": (-1.9, 29.9, "Eastern Africa"),
    "burundi": (-3.4, 29.9, "Eastern Africa"),
    "mozambique": (-18.7, 35.5, "Eastern Africa"),
    "nigeria": (9.1, 8.7, "Western Africa"),
    "ghana": (7.9, -1.0, "Western Africa"),
    "senegal": (14.5, -14.5, "Western Africa"),
    "niger": (17.6, 8.1, "Western Africa"),
    "mali": (17.6, -4.0, "Western Africa"),
    "chad": (15.5, 18.7, "Central Africa"),
    "cameroon": (7.4, 12.4, "Central Africa"),
    "congo": (-4.0, 21.8, "Central Africa"),
    "democratic republic of the congo": (-4.0, 21.8, "Central Africa"),
    "ivory coast": (7.5, -5.5, "Western Africa"),
    "cote d'ivoire": (7.5, -5.5, "Western Africa"),
    "angola": (-11.2, 17.9, "Central Africa"),
    "zambia": (-13.1, 27.8, "Eastern Africa"),
    "zimbabwe": (-19.0, 29.2, "Southern Africa"),
    "south africa": (-30.6, 22.9, "Southern Africa"),
    "eswatini": (-26.5, 31.5, "Southern Africa"),
    # --- Agencies, datasets and venues --------------------------------------
    # Not countries, but they do carry a country in their name often enough that
    # matching them beats dropping the milestone.
    "uscis": (39.8, -98.6, "North America"),
    "european union": (50.6, 10.4, "Western Europe"),
    "european commission": (50.6, 10.4, "Western Europe"),
    "nasa": (38.9, -77.0, "North America"),
    "cern": (46.2, 6.1, "Western Europe"),
    "esa": (50.7, 4.9, "Western Europe"),
    "jaxa": (35.7, 139.7, "Eastern Asia"),
    "isro": (12.9, 77.6, "Southern Asia"),
    "who": (46.2, 6.1, "Western Europe"),
}

# Longest first, so a more specific name always wins over a shorter substring.
_ORDERED_PLACE_NAMES = sorted(PLACE_COORDS, key=len, reverse=True)

# Multi-word names need flexible internal whitespace: feed headlines and paper
# titles hyphenate, underscore and line-wrap inconsistently.
_SEP = r"[\s\-_/,]+"


def _compile(name: str):
    """Boundary-anchored, whitespace-tolerant matcher for one place name."""
    body = _SEP.join(re.escape(part) for part in name.split())
    return re.compile(r"(?<![a-z0-9])" + body + r"(?![a-z0-9])")


# Compiled once at import. These patterns never change, and match_place runs per
# record across several geocoding passes: rebuilding 156 of them inside the loop
# cost ~380us per call, which is ~160ms of pure regex compilation in a single
# milestone sync. Anchored on both ends so "india" cannot match inside
# "reimagining" and "in" cannot match a bare conjunction.
_MATCHERS = tuple(
    (name, _compile(name), PLACE_COORDS[name]) for name in _ORDERED_PLACE_NAMES if len(name) >= 4
)


def match_place(text: str):
    """Best place named in `text` as ``(name, (lat, lon, region))``, or None.

    Keys shorter than four characters are skipped: too short to anchor safely
    against prose without false positives.
    """
    if not text or not isinstance(text, str):
        return None
    lowered = text.lower()
    for name, pattern, coords in _MATCHERS:
        if pattern.search(lowered):
            return name, coords
    return None


def place_coords(text: str):
    """Just the ``(lat, lon)`` for the best place in `text`, or None."""
    hit = match_place(text)
    return (hit[1][0], hit[1][1]) if hit else None


def place_region(text: str) -> str | None:
    """Region label for the best place in `text`, or None."""
    hit = match_place(text)
    return hit[1][2] if hit else None
