"""Shared identity rules for milestone records.

Single source of truth for "are these two records the same reported result?".
Both the pipeline and the data validator need that judgement, and when they
disagree the validator either misses real duplicates or rejects the feed:

* ``sync_milestones.unify_duplicate_milestones`` merges them, so its rule decides
  which records survive into the published feed.
* ``check_data.check_duplicate_reports`` fails CI if a duplicate survives.

They previously carried two hand-written copies of the same predicate. This module
removes the second copy so a change to the merge policy cannot silently leave the
validator enforcing a stale rule.

One deliberate difference is parameterised rather than duplicated: the unifier runs
on full milestone records and keys on ``date + value + unit + category``, while the
validator runs on published events, which deliberately drop ``unit`` (see
``build_events`` in sync_milestones.py). Callers therefore pass ``include_unit``
explicitly, and the asymmetry is visible at the call site instead of hidden inside
two near-identical functions.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

# Content words carrying no discriminating power. Excluded so that a generic
# phrase like "new milestone reported" cannot corroborate two unrelated records.
DEDUPE_STOPWORDS = frozenset("""
a an the of for and in on to new via using with at by from is are was were be been
that this its as into over under more most less least than then which we our
""".split())


def content_tokens(title: object) -> set:
    """Lowercased alphanumeric content words of a title.

    Returns an empty set for a missing or non-string title, which callers treat
    as "no corroboration available".
    """
    if not isinstance(title, str):
        return set()
    return {
        t
        for t in re.findall(r"[a-z0-9]+", title.lower())
        if t not in DEDUPE_STOPWORDS and len(t) > 2
    }


def normalize_metric_value(value: object):
    """Hashable form of a reported metric.

    Numeric-equivalent spellings must collapse (``0.86``, ``"0.86"`` and ``"0.860"``
    are one result); anything unparsable falls back to a normalised string so it
    still buckets deterministically. Returns ``None`` when the record reports no
    metric at all - such records can never be duplicates of each other.
    """
    if value in (None, ""):
        return None
    try:
        return round(float(value), 9)
    except (TypeError, ValueError):
        return str(value).strip().lower()


def report_group_key(record: dict, *, include_unit: bool, category_resolver=None):
    """Bucket key for "same reported metric", or ``None`` if not reportable.

    Identity is date + value + category, plus ``unit`` when the record carries one.
    All components are required, so two unrelated milestones that happen to share
    a number never collapse.

    ``category_resolver`` must normalise the record's category to the same label
    the record will be *published* under, and is required by the unifier. Without
    it, a pair straddling a rename - one copy from upstream carrying the canonical
    name, one from the archive carrying the legacy alias - buckets apart and then
    publishes as two records in one category. That is exactly how the Khipu pair
    survived unification despite sharing date, value, unit and article URL.
    """
    value_key = normalize_metric_value(record.get("value"))
    if value_key is None:
        return None
    date = record.get("date")
    if not isinstance(date, str) or not date:
        return None
    category = record.get("category_key") or record.get("category") or ""
    if category_resolver is not None:
        category = category_resolver(category)
    if include_unit:
        unit = str(record.get("unit") or "").strip().lower()
        return (date, value_key, unit, str(category))
    return (date, value_key, str(category))


def is_specific_url(url: object) -> bool:
    """Whether a URL points at a particular document rather than an org landing page.

    A bare origin such as ``https://spacex.com`` is cited by every milestone that
    company produces, so two records sharing one say nothing about being the same
    reported result. A URL that carries a path or a query identifies a specific
    document and is treated as corroboration.

    Parsed with urllib rather than by counting slashes: the host always contributes
    two, so a naive depth test cannot distinguish ``https://spacex.com`` from
    ``https://spacex.com/launches`` without also having to special-case schemes.
    """
    if not isinstance(url, str):
        return False
    candidate = url.strip()
    if not candidate:
        return False
    try:
        parts = urlsplit(candidate if "//" in candidate else "//" + candidate, scheme="https")
    except ValueError:
        return False
    if not parts.netloc:
        return False
    path = (parts.path or "").strip("/")
    return bool(path or parts.query)


def same_report(a: dict, b: dict) -> bool:
    """Whether two already co-bucketed records plausibly describe one result.

    A shared date, value and category is not sufficient on its own - "100 qubits"
    and several other recurring values recur across unrelated records all the time.
    The records must additionally corroborate each other, by either:

    * an identical *specific* ``url``, or
    * a shared content title token.

    A bare org URL is deliberately not corroboration: two distinct SpaceX flights
    both cite ``https://spacex.com`` and must stay separate.
    """
    url_a = str(a.get("url") or "").strip().lower()
    url_b = str(b.get("url") or "").strip().lower()
    if url_a and url_a == url_b and is_specific_url(url_a):
        return True
    tokens_a, tokens_b = content_tokens(a.get("title")), content_tokens(b.get("title"))
    if not tokens_a or not tokens_b:
        return False
    return bool(tokens_a & tokens_b)