"""The single definition of "this record has no location", and how sure we are.

Five scripts each grew their own copy of "if lat == 0 and lon == 0, treat as
unlocated". That is the same rule written five times, and they had already drifted
once - `check_events` enforced it while `check_milestones` did not, which is how 27
records plotted a dot in the Gulf of Guinea from a green build.

`is_unlocated` is the one predicate now. It is deliberately shared with the
validators rather than duplicated into them, so a change to what counts as
"unlocated" cannot leave the pipeline and the gate disagreeing.

No imports beyond the standard library: `check_data.py` is loaded by CI with no
third-party packages available.
"""
from __future__ import annotations

import math

# How close to the origin counts as "not a real place". Exactly 0.0 is upstream's
# documented sentinel; the tolerance is deliberately tiny - it exists to catch
# sentinel-ish values like 1e-9 that survive a rounding pass, NOT to sweep up genuine
# equatorial/prime-meridian points. Null island itself is not a plausible milestone
# location, but (0, 140) Tokyo is, so only the joint origin case is ever rejected.
ORIGIN_EPSILON = 1e-6

# Confidence levels, strongest evidence first. These mirror the passes in
# `sync_milestones.geocode_with_confidence()`:
#
#   stated      - coordinates supplied by the upstream record itself
#   institution - an institution or lab named in the article's own text
#   place       - a place named in the article's own text
#   article     - a demonym in the article's own text, naming a country neither
#                 table lists ("Bosnian" -> Bosnia); the weakest placed signal
#   subcategory - a weak hint carried by the subcategory label alone
#   source      - the publisher or preprint server, as a last resort
#   unlocated   - nothing matched; the record publishes without a dot
#
# "source" is the one worth distrusting: it places a Stanford paper at Nature's
# London office. Surfacing the level lets a consumer weight or filter on it instead
# of treating every dot as equally authoritative.
CONFIDENCE_LEVELS = ("stated", "institution", "place", "article",
                   "subcategory", "source", "unlocated")

UNLOCATED = "unlocated"


def is_unlocated(geo) -> bool:
    """True if `geo` means "no location" rather than a real point.

    Covers every shape the pipeline can be handed: absent, null, a non-dict, a
    missing/non-numeric/non-finite coordinate, out-of-range values, and the origin
    sentinel. Returns True for anything it cannot vouch for, because the cost of
    calling a located record unlocated (no dot on the map) is far lower than the cost
    of the reverse (a dot in the Atlantic).
    """
    if not isinstance(geo, dict):
        return True
    lat, lon = geo.get("lat"), geo.get("lon")
    if isinstance(lat, bool) or isinstance(lon, bool):
        return True
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return True
    if not math.isfinite(lat) or not math.isfinite(lon):
        return True
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return True
    return abs(lat) <= ORIGIN_EPSILON and abs(lon) <= ORIGIN_EPSILON


def is_located(geo) -> bool:
    """Inverse of `is_unlocated`, for call sites that read better positively."""
    return not is_unlocated(geo)


def strip_unlocated(record: dict) -> dict:
    """Return a copy of `record` with an unusable geolocation removed.

    Omits the key rather than storing null: consumers must not each have to
    special-case a null coordinate, and "absent" and "null" are different things to
    a reader. Adds `location_confidence: "unlocated"` so the reason survives the
    removal - otherwise a record silently loses its provenance. Returns the original
    object unchanged when the coordinate is fine.
    """
    geo = record.get("geolocation")
    if not is_unlocated(geo):
        return record
    out = {k: v for k, v in record.items() if k != "geolocation"}
    # `located: false` is the boolean the renderer keys off (worldmap.js reads
    # `located === false`). `location_confidence` carries the provenance the boolean
    # cannot express. Both, so every boundary that scrubs produces the same shape
    # and no caller has to remember which flag to set.
    out["located"] = False
    out["location_confidence"] = UNLOCATED
    return out


def validate_confidence(value) -> bool:
    return isinstance(value, str) and value in CONFIDENCE_LEVELS