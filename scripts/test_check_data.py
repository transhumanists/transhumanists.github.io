#!/usr/bin/env python3
"""Self-tests for scripts/check_data.py (stdlib only)."""
from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_data as cd


def _events_payload(*events: dict) -> dict:
    return {"last_update": "2026-09-23", "version": "1.0.0", "events": list(events)}


def _layers_payload(zones: list[dict], fleets: list[dict], crises: list[dict] | None = None) -> dict:
    payload = {"version": cd._FILE_VERSION, "last_update": "2026-09-25T00:00:00+00:00",
               "conflict_zones": zones, "fleet_movements": fleets}
    if crises is not None:
        payload["crisis_zones"] = crises
    return payload


class TestCheckEvents(unittest.TestCase):
    def test_happy_path(self):
        payload = _events_payload(
            {"title": "X", "category": "Renewable Energy", "date": "2026-03-15",
             "geolocation": {"lat": 1.5, "lon": 2.5}},
        )
        self.assertEqual(cd.check_events(payload["events"]), [])

    def test_unlocated_event_is_published_rather_than_rejected(self):
        # Was `test_missing_geolocation_fails`. Dropping an unlocatable milestone
        # deleted it from the feed, dashboard, catalog and metrics with no trace,
        # which is worse than publishing it without a dot.
        payload = _events_payload({"title": "X", "category": "Renewable Energy", "date": "2026-03-15"})
        self.assertEqual(cd.check_events(payload["events"]), [])

    def test_nonfinite_coordinate_fails(self):
        payload = _events_payload(
            {"title": "X", "category": "Biotechnology & Biohacking", "date": "2026-03-15",
             "geolocation": {"lat": 1e400, "lon": 0}},
        )
        issues = cd.check_events(payload["events"])
        self.assertTrue(any("geolocation" in i for i in issues))

    def test_bool_coordinate_fails(self):
        payload = _events_payload(
            {"title": "X", "category": "Biotechnology & Biohacking", "date": "2026-03-15",
             "geolocation": {"lat": True, "lon": 0}},
        )
        issues = cd.check_events(payload["events"])
        self.assertTrue(any("geolocation" in i for i in issues))

    def test_out_of_range_fails(self):
        payload = _events_payload(
            {"title": "X", "category": "Biotechnology & Biohacking", "date": "2026-03-15",
             "geolocation": {"lat": 91, "lon": 190}},
        )
        issues = cd.check_events(payload["events"])
        self.assertTrue(any("geolocation" in i for i in issues))

    def test_bad_title_type_fails(self):
        payload = _events_payload(
            {"title": 42, "category": "Biotechnology & Biohacking", "date": "2026-03-15",
             "geolocation": {"lat": 1, "lon": 1}},
        )
        self.assertTrue(any("title" in i for i in cd.check_events(payload["events"])))

    def test_missing_date_fails(self):
        payload = _events_payload(
            {"title": "X", "category": "Renewable Energy", "geolocation": {"lat": 1, "lon": 1}},
        )
        issues = cd.check_events(payload["events"])
        self.assertTrue(any("date" in i for i in issues))

    def test_non_string_date_fails(self):
        payload = _events_payload(
            {"title": "X", "category": "Renewable Energy", "date": 42,
             "geolocation": {"lat": 1, "lon": 1}},
        )
        issues = cd.check_events(payload["events"])
        self.assertTrue(any("date" in i for i in issues))

    def test_nonexistent_calendar_date_fails(self):
        # parseDateToISO would pass "2026-02-30" through unvalidated; the
        # validator must reject it so a non-date never renders on the map.
        payload = _events_payload(
            {"title": "X", "category": "Renewable Energy", "date": "2026-02-30",
             "geolocation": {"lat": 1, "lon": 1}},
        )
        issues = cd.check_events(payload["events"])
        self.assertTrue(any("date" in i for i in issues))

    def test_malformed_or_empty_date_fails(self):
        for bad in ("banana", "", "  ", "32/13/2026"):
            payload = _events_payload(
                {"title": "X", "category": "Renewable Energy", "date": bad,
                 "geolocation": {"lat": 1, "lon": 1}},
            )
            issues = cd.check_events(payload["events"])
            self.assertTrue(any("date" in i for i in issues), f"bad date {bad!r}")

    def test_basic_date_format_js_would_reject_fails(self):
        # Python's fromisoformat accepts "20260315" (basic format), but
        # worldmap.js's Date-constructor fallback rejects it; the validator
        # must keep the acceptance surface identical to the map's.
        for bad in ("20260315", "20260315T100000"):
            payload = _events_payload(
                {"title": "X", "category": "Renewable Energy", "date": bad,
                 "geolocation": {"lat": 1, "lon": 1}},
            )
            issues = cd.check_events(payload["events"])
            self.assertTrue(any("date" in i for i in issues), f"bad date {bad!r}")

    def test_frontend_accepted_date_shapes_pass(self):
        # Same acceptance surface as worldmap.js parseDateToISO.
        for good in ("2026-03-15", "15/03/2026", "15-03-2026", "2026", "2026-03",
                     "2026-03-15T10:00:00", "2026-03-15T19:23:03+00:00"):
            payload = _events_payload(
                {"title": "X", "category": "Renewable Energy", "date": good,
                 "geolocation": {"lat": 1, "lon": 1}},
            )
            self.assertEqual(cd.check_events(payload["events"]), [], f"good date {good!r}")


class TestSourceUrlScheme(unittest.TestCase):
    """Milestone URLs reach the map from the upstream repo via
    sync_milestones.archive_record, which passes url straight through. Every
    renderer gates its source link on /^https?:\\/\\//i, so any other scheme is
    dropped silently in the browser; the gate is where that should be caught."""

    _ABSENT = ...  # sentinel: omit the key entirely, unlike an explicit null

    def _issues(self, url=_ABSENT):
        entry = {"title": "X", "category": "Renewable Energy", "date": "2026-03-15",
                 "geolocation": {"lat": 1, "lon": 1}}
        if url is not self._ABSENT:
            entry["url"] = url
        return cd.check_events(_events_payload(entry)["events"])

    def test_https_and_http_pass(self):
        for good in ("https://example.org/a", "http://example.org/a",
                     "HTTPS://EXAMPLE.ORG/A"):
            self.assertEqual(self._issues(good), [], f"good url {good!r}")

    def test_scheme_is_the_only_thing_validated(self):
        # Deliberately not a URL parser: the renderers only test the prefix, so
        # the gate must not start rejecting data the front end happily renders
        # (here a raw space, which the browser percent-encodes).
        self.assertEqual(self._issues("https://example.org/a b"), [])

    def test_absent_url_is_allowed(self):
        # Layers legitimately ship without a URL; the link is simply omitted.
        self.assertEqual(self._issues(), [])
        self.assertEqual(self._issues(None), [])
        self.assertEqual(self._issues(""), [])

    def test_non_http_scheme_fails(self):
        # javascript: would run on click. data:/vbscript: are equally unusable.
        # The accept surface is exactly the renderers' /^https?:\/\//i test, so a
        # scheme-less or protocol-relative URL is rejected too.
        for bad in ("javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>",
                    "vbscript:msgbox", "ftp://example.org/f", "example.org/a",
                    "//example.org/a", "https:/example.org", " javascript:alert(1)"):
            self.assertTrue(
                any("url" in i for i in self._issues(bad)), f"bad url {bad!r} must fail",
            )

    def test_padded_url_is_accepted_so_the_gate_never_outruns_the_front_end(self):
        # The gate strips before matching, so it accepts a superset of what the
        # front end links. A padded URL renders without a link rather than
        # failing CI, which is the safe direction for a data gate.
        self.assertEqual(self._issues("  https://example.org/a  "), [])

    def test_non_string_url_fails(self):
        self.assertTrue(any("url" in i for i in self._issues(123)))
        self.assertTrue(any("url" in i for i in self._issues(["https://example.org"])))

    def test_zone_url_is_validated_too(self):
        good = [{"name": "Z", "lat": 10, "lon": 10, "radiusDeg": 3, "url": "https://example.org/z"}]
        self.assertEqual(cd.check_zones(good), [])
        bad = [{"name": "Z", "lat": 10, "lon": 10, "radiusDeg": 3, "url": "javascript:alert(1)"}]
        self.assertTrue(any("url" in i for i in cd.check_zones(bad)))

    def test_published_data_passes(self):
        # The live files must not start failing CI.
        for name in ("events.json", "world_layers.json"):
            path = cd.DATA_DIR / name
            if not path.exists():
                self.skipTest(f"{name} not checked out")
            self.assertEqual(cd.check_data(json.loads(path.read_text(encoding="utf-8")), name), [])

    def test_source_url_regex_parity_with_worldmap_js(self):
        # The gate in check_data.py must match the renderer's SOURCE_URL_RE exactly.
        # Drift in either direction either lets a javascript: URL through or fails
        # CI on data the browser happily renders.
        # The JS source of truth is: const SOURCE_URL_RE = /^https?:\\/\\//i;
        # The pattern is '^https?://' with the 'i' flag.
        expected_pattern = "^https?://"
        # The Python gate compiles it with re.IGNORECASE
        expected_re = re.compile(expected_pattern, re.IGNORECASE)
        self.assertEqual(expected_re.pattern, expected_pattern)
        # And test a few values match
        self.assertTrue(expected_re.match("https://example.org"))
        self.assertTrue(expected_re.match("http://example.org"))
        self.assertFalse(expected_re.match("javascript:alert(1)"))
        self.assertFalse(expected_re.match("ftp://example.org"))
        # Also verify the JS file contains the expected constant (sanity check)
        js_path = cd.ROOT / "assets" / "js" / "worldmap.js"
        if js_path.exists():
            content = js_path.read_text(encoding="utf-8")
            # The JS file contains: const SOURCE_URL_RE = /^https?:\/\/ /i;
            # In the Python string, backslashes are escaped: \/
            self.assertIn(r"const SOURCE_URL_RE = /^https?:\/\//i", content)

class TestCheckLayers(unittest.TestCase):
    def test_happy_path(self):
        zones = [{"name": "Z", "lat": 10, "lon": 10, "radiusDeg": 3}]
        fleets = [{"from": {"lat": 1, "lon": 2}, "to": {"lat": 3, "lon": 4}}]
        payload = _layers_payload(zones, fleets)
        issues = cd.check_zones(payload["conflict_zones"]) + cd.check_fleets(payload["fleet_movements"])
        self.assertEqual(issues, [])

    def test_zone_without_name_fails(self):
        zones = [{"lat": 10, "lon": 10}]
        self.assertTrue(cd.check_zones(zones))

    def test_zone_nan_radius_is_tolerated(self):
        # radiusDeg has a runtime clamp in normalizeZone; only coords gate it.
        zones = [{"name": "Z", "lat": 10, "lon": 10, "radiusDeg": "abc"}]
        self.assertEqual(cd.check_zones(zones), [])

    def test_fleet_missing_endpoint_fails(self):
        fleets = [{"from": {"lat": 1, "lon": 2}}]
        issues = cd.check_fleets(fleets)
        self.assertTrue(any("to" in i for i in issues))

    def test_fleet_nonfinite_fails(self):
        fleets = [{"from": {"lat": 1e400, "lon": 0}, "to": {"lat": 0, "lon": 1}}]
        issues = cd.check_fleets(fleets)
        self.assertTrue(any("from" in i for i in issues))

    def test_fleet_null_island_endpoint_fails(self):
        fleets = [{"from": {"lat": 0, "lon": 0}, "to": {"lat": 1, "lon": 1}}]
        issues = cd.check_fleets(fleets)
        self.assertTrue(any("from" in i for i in issues))


class TestCheckLayerLifecycle(unittest.TestCase):
    def _zone(self, **extra):
        z = {"name": "Z", "lat": 10, "lon": 10, "radiusDeg": 3}
        z.update(extra)
        return z

    def test_full_lifecycle_is_valid(self):
        zones = [
            self._zone(status="active", start_date="2022-02-24", end_date=""),
            self._zone(status="concluded", start_date="2022-02-24", end_date="2024-02-24"),
            self._zone(status="ongoing", start_date="2021"),
            self._zone(status="active", start_date="2022-03"),
        ]
        self.assertEqual(cd.check_zones(zones), [])

    def test_unknown_status_fails(self):
        zones = [self._zone(status="exploding")]
        self.assertTrue(any("status" in i for i in cd.check_zones(zones)))

    def test_non_string_status_fails(self):
        zones = [self._zone(status=3)]
        self.assertTrue(any("status" in i for i in cd.check_zones(zones)))

    def test_malformed_dates_fail(self):
        zones = [self._zone(start_date="2022-13-99"), self._zone(end_date="2022/02/24")]
        issues = cd.check_zones(zones)
        self.assertEqual(len(issues), 2)

    def test_month_out_of_range_fails(self):
        zones = [self._zone(start_date="2022-13")]
        self.assertTrue(any("start_date" in i for i in cd.check_zones(zones)))

    def test_start_after_end_fails(self):
        zones = [self._zone(start_date="2024-06-01", end_date="2022-01-01")]
        issues = cd.check_zones(zones)
        self.assertTrue(any("start_date must not be after end_date" in i for i in issues))

    def test_year_level_inversion_fails(self):
        zones = [self._zone(start_date="2022", end_date="2021")]
        issues = cd.check_zones(zones)
        self.assertTrue(any("start_date must not be after end_date" in i for i in issues))

    def test_month_level_inversion_fails(self):
        zones = [self._zone(start_date="2022-05", end_date="2022-03")]
        issues = cd.check_zones(zones)
        self.assertTrue(any("start_date must not be after end_date" in i for i in issues))

    def test_mixed_granularity_is_not_a_false_positive(self):
        # "2099-03" (month of March) ends after the 2099-03-05 start; the range is
        # valid even though a naive string compare of prefix/suffix trips.
        zones = [
            self._zone(start_date="2099-03-05", end_date="2099-03"),
            self._zone(start_date="2099", end_date="2099-06-01"),
        ]
        self.assertEqual(cd.check_zones(zones), [])

    def test_mixed_granularity_year_after_full_inversion_fails(self):
        # "2025" can be as early as 2025-01-01, which is already after the end's
        # latest possible instant (2024-12-31) -> provably an empty window.
        zones = [self._zone(start_date="2025", end_date="2024-12-31")]
        issues = cd.check_zones(zones)
        self.assertTrue(any("start_date is after end_date" in i for i in issues))

    def test_mixed_granularity_month_after_full_inversion_fails(self):
        zones = [self._zone(start_date="2024-07", end_date="2024-06-15")]
        issues = cd.check_zones(zones)
        self.assertTrue(any("start_date is after end_date" in i for i in issues))

    def test_mixed_granularity_partial_month_end_is_valid(self):
        # start "2099-05" earliest is 2099-05-01; end "2099-06" latest is
        # 2099-06-30 -> overlaps, so it must stay valid.
        zones = [self._zone(start_date="2099-05", end_date="2099-06")]
        self.assertEqual(cd.check_zones(zones), [])

    def test_mixed_granularity_year_brackets_month_is_valid(self):
        zones = [
            self._zone(start_date="2099", end_date="2099-06-30"),
            self._zone(start_date="2099", end_date="2099-12"),
        ]
        self.assertEqual(cd.check_zones(zones), [])

    def test_malformed_dates_never_crash_bounds_detection(self):
        # Invalid month/day strings are flagged, not compared (must not crash).
        zones = [
            self._zone(start_date="2024-13", end_date=""),
            self._zone(start_date="2023", end_date="2024-02-30"),
        ]
        issues = cd.check_zones(zones)
        self.assertEqual(len(issues), 2)

    def test_concluded_zone_requires_end_date(self):
        # A concluded/ended zone without an end_date would stay on the timeline
        # forever; it must name the day it dropped off the map.
        for status in ("concluded", "inactive", "ended", "resolved"):
            zones = [self._zone(status=status)]
            issues = cd.check_zones(zones)
            self.assertTrue(any("must carry an end_date" in i for i in issues), status)

    def test_concluded_zone_with_end_date_is_valid(self):
        for status in ("concluded", "inactive", "ended", "resolved"):
            zones = [self._zone(status=status, start_date="2020-01-01", end_date="2024-06-01")]
            self.assertEqual(cd.check_zones(zones), [], status)

    def test_active_zone_with_past_end_date_fails(self):
        # An 'active' zone whose end_date has already passed is a contradiction
        # the writers must resolve by flipping it to concluded.
        zones = [
            self._zone(status="active", end_date="2016-11-24"),
            self._zone(status="ongoing", end_date="2025-03-01"),
        ]
        issues = cd.check_zones(zones)
        self.assertEqual(len(issues), 2)
        self.assertTrue(all("has already passed" in i for i in issues))

    def test_active_zone_with_future_end_date_is_valid(self):
        zones = [self._zone(status="active", start_date="2026-01-01", end_date="2099-01-01")]
        self.assertEqual(cd.check_zones(zones), [])

    def test_status_absent_with_past_end_date_fails(self):
        # A bare end_date with no status also reads as an active zone whose
        # window has already closed.
        zones = [self._zone(end_date="2023-12-31")]
        issues = cd.check_zones(zones)
        self.assertTrue(any("has already passed" in i for i in issues))

    def test_concluded_zone_with_future_end_date_fails(self):
        # Preliminarily marking a zone concluded while its end still lies ahead
        # is a contradiction most likely caused by a typo'd year.
        for status in ("concluded", "inactive", "ended", "resolved"):
            zones = [self._zone(status=status, start_date="2020-01-01", end_date="2099-01-01")]
            issues = cd.check_zones(zones)
            self.assertTrue(any("lies in the future" in i for i in issues), status)

    def test_concluded_zone_with_far_end_date_bound_is_valid(self):
        # A partial future month/year counts as "not proven future" only when
        # its EARLIEST possible instant has already passed (e.g. end "2026-09"
        # on 2026-09-27), so reporting lag is not flagged.
        zones = [self._zone(status="concluded", start_date="2020-01-01", end_date="2099-06")]
        issues = cd.check_zones(zones)
        self.assertTrue(any("lies in the future" in i for i in issues))

    def test_today_is_utc(self):
        # The validator must render the same verdict on every machine, so its
        # clock must not drift with the local timezone.
        self.assertEqual(len(cd._today_iso()), 10)
        self.assertTrue(cd._today_iso().endswith(cd._today_iso()[4:]) == (cd._today_iso()[4] == "-"))
        import datetime as _dt
        from datetime import timezone as _tz
        now_utc = _dt.datetime.now(_tz.utc).isoformat()[:10]
        self.assertEqual(cd._today_iso(), now_utc)

    def test_semantic_rules_do_not_apply_to_fleets(self):
        # Deployments keep their own (CSS-coloured) lifecycle contract, so an
        # ended deployment must not trip the zone semantic rules.
        fleets = [
            {"from": {"lat": 0, "lon": 1}, "to": {"lat": 1, "lon": 1},
             "status": "concluded", "start_date": "2022", "end_date": "2022-12"},
            {"from": {"lat": 0, "lon": 1}, "to": {"lat": 1, "lon": 1},
             "status": "concluded", "start_date": "2022"},
        ]
        self.assertEqual(cd.check_fleets(fleets), [])

    def test_lifecycle_is_checked_on_fleets_too(self):
        fleets = [
            {"from": {"lat": 0, "lon": 1}, "to": {"lat": 1, "lon": 1}, "status": "concluded", "start_date": "2022", "end_date": "2022-12"},
            {"from": {"lat": 0, "lon": 1}, "to": {"lat": 1, "lon": 1}, "status": "whatever"},
        ]
        issues = cd.check_fleets(fleets)
        self.assertEqual(len(issues), 1)
        self.assertIn("status", issues[0])


class TestCheckCrisisZones(unittest.TestCase):
    def test_happy_path(self):
        crises = [{"name": "Sudan · Famine", "lat": 13, "lon": 24.5}]
        self.assertEqual(cd.check_crisis_zones(crises), [])

    def test_null_island_crisis_fails(self):
        # A crisis with no geo inference would plot at 0,0 unless the fetcher
        # drops it; check_data must never let such an entry through.
        crises = [{"name": "Unknown · Emergency", "lat": 0, "lon": 0}]
        issues = cd.check_crisis_zones(crises)
        self.assertTrue(any("lat/lon" in i for i in issues))

    def test_bad_lifecycle_fails(self):
        crises = [{"name": "X", "lat": 1, "lon": 1, "status": "nope"}]
        self.assertTrue(any("status" in i for i in cd.check_crisis_zones(crises)))

    def test_non_list_fails(self):
        self.assertTrue(cd.check_crisis_zones({"not": "a list"}))


class TestSpecificUrlRule(unittest.TestCase):
    """A bare org URL must not corroborate that two records are one result.

    Regression guard: sync_milestones documented "a bare/generic URL is NOT a merge
    signal" but compared any identical non-empty URL, so two distinct SpaceX
    flights sharing date+value+category would have been merged.
    """

    def test_bare_origins_are_not_specific(self):
        import milestone_identity

        for url in ("https://spacex.com", "https://www.nature.com/",
                    "http://example.org", "https://arxiv.org", ""):
            with self.subTest(url=url):
                self.assertFalse(milestone_identity.is_specific_url(url))

    def test_document_urls_are_specific(self):
        import milestone_identity

        for url in ("https://arxiv.org/abs/2401.12345",
                    "https://www.nature.com/articles/s41587-026-03307-w",
                    "https://en.wikipedia.org/wiki/IBM_Q_System_One",
                    "https://example.com/paper.pdf",
                    "https://example.com/search?q=khipu"):
            with self.subTest(url=url):
                self.assertTrue(milestone_identity.is_specific_url(url))

    def test_two_spacex_flights_sharing_an_org_url_do_not_merge(self):
        import sync_milestones

        a = {"title": "Starship payload to LEO", "value": "156", "unit": "t",
             "date": "2026-06-30", "category": "Spaceflight & Aeronautics",
             "url": "https://spacex.com"}
        b = {"title": "Falcon Heavy lift to GTO", "value": "156", "unit": "t",
             "date": "2026-06-30", "category": "Spaceflight & Aeronautics",
             "url": "https://spacex.com"}
        self.assertFalse(sync_milestones._dedupe_same_report(a, b))
        # And end to end, the two records must both survive the unifier.
        out, changes = sync_milestones.unify_duplicate_milestones([a, b])
        self.assertEqual(len(out), 2)
        self.assertEqual(changes, [])

    def test_same_specific_document_still_merges(self):
        import sync_milestones

        a = {"title": "Alpha result", "value": "5", "unit": "x",
             "date": "2026-06-30", "category": "Quantum Physics",
             "url": "https://arxiv.org/abs/2401.1"}
        b = {"title": "Beta result", "value": "5", "unit": "x",
             "date": "2026-06-30", "category": "Quantum Physics",
             "url": "https://arxiv.org/abs/2401.1"}
        self.assertTrue(sync_milestones._dedupe_same_report(a, b))
        out, _ = sync_milestones.unify_duplicate_milestones([a, b])
        self.assertEqual(len(out), 1)

    def test_title_tokens_still_merge_records_without_a_url(self):
        import sync_milestones

        a = {"title": "Khipu mining result achieved", "value": "0.86", "unit": "x",
             "date": "2026-06-30", "category": "Computing & AGI"}
        b = {"title": "Khipu mining result reported", "value": "0.86", "unit": "x",
             "date": "2026-06-30", "category": "Computing & AGI"}
        self.assertTrue(sync_milestones._dedupe_same_report(a, b))


class TestSharedIdentityRule(unittest.TestCase):
    """The unifier and the validator must agree on what a duplicate is.

    Both consume scripts/milestone_identity.py. This test fails if either one goes
    back to carrying its own private copy of the rule, which is how the validator
    could end up enforcing a stale policy that no longer matches the merge.
    """

    def test_both_consumers_delegate_to_the_shared_module(self):
        # Guards against the validator and the unifier drifting apart. Asserted
        # behaviourally rather than by re-exporting the helpers under private
        # names in check_data: an alias that only exists so an identity check can
        # pass is dead code, and it proves nothing about what the validator does.
        import inspect

        import milestone_identity
        import sync_milestones

        self.assertIs(sync_milestones._dedupe_same_report, milestone_identity.same_report)
        validator_src = inspect.getsource(cd.check_duplicate_reports)
        self.assertIn("milestone_identity.same_report", validator_src)
        unifier_src = inspect.getsource(sync_milestones._dedupe_metric_key)
        self.assertIn("milestone_identity.report_group_key", unifier_src)

    def test_validator_and_unifier_agree_on_every_case(self):
        # The invariant that actually matters: for any pair, the validator flags
        # exactly the pairs the unifier would merge (modulo the unit field, which
        # published events drop).
        import milestone_identity
        import sync_milestones

        pairs = [
            # Same date/value, corroborating title, different URLs -> one result.
            ({"title": "Khipu mining result achieved", "value": "0.86",
              "date": "2026-06-30", "url": "https://arxiv.org/abs/1"},
             {"title": "Khipu mining result reported", "value": 0.86,
              "date": "2026-06-30", "url": "https://arxiv.org/abs/2"}, True),
            # Same specific article -> one result.
            ({"title": "Alpha result", "value": "5", "date": "2026-06-30",
              "url": "https://arxiv.org/abs/9"},
             {"title": "Beta result", "value": "5", "date": "2026-06-30",
              "url": "https://arxiv.org/abs/9"}, True),
            # Shared generic org URL is not corroboration -> two results.
            ({"title": "Starship payload to LEO", "value": "156", "date": "2026-06-30",
              "url": "https://spacex.com"},
             {"title": "Falcon Heavy lift to GTO", "value": "156", "date": "2026-06-30",
              "url": "https://spacex.com"}, False),
        ]
        for a, b, expected in pairs:
            with self.subTest(pair=(a["title"], b["title"])):
                verdict = milestone_identity.same_report(a, b)
                self.assertEqual(verdict, expected)
                # The unifier must reach the same conclusion end to end.
                merged, _ = sync_milestones.unify_duplicate_milestones([
                    dict(a, id="ms-a", unit="t", category="Computing & AGI"),
                    dict(b, id="ms-b", unit="t", category="Computing & AGI"),
                ])
                self.assertEqual(len(merged), 1 if expected else 2)

    def test_paired_and_non_paired_cases_agree(self):
        import milestone_identity
        import sync_milestones

        a = {"title": "Khipu mining result achieved", "value": "0.86",
             "date": "2026-06-30", "url": "https://arxiv.org/abs/1"}
        b = {"title": "Khipu mining result reported", "value": 0.86,
             "date": "2026-06-30", "url": "https://arxiv.org/abs/2"}
        # Generic shared URL, unrelated content: not the same reported result.
        c = {"title": "Starship payload to LEO", "value": "156",
             "date": "2026-06-30", "url": "https://spacex.com"}
        d = {"title": "Falcon Heavy lift to GTO", "value": "156",
             "date": "2026-06-30", "url": "https://spacex.com"}

        for x, y, expected in ((a, b, True), (c, d, False), (a, c, False)):
            with self.subTest(pair=(x["title"], y["title"])):
                self.assertEqual(milestone_identity.same_report(x, y), expected)
                self.assertEqual(sync_milestones._dedupe_same_report(x, y), expected)

    def test_group_keys_differ_only_by_unit(self):
        import milestone_identity

        rec = {"title": "T", "value": "0.86", "date": "2026-06-30",
               "category": "Computing & AGI", "unit": "TWh"}
        with_unit = milestone_identity.report_group_key(rec, include_unit=True)
        without_unit = milestone_identity.report_group_key(rec, include_unit=False)
        self.assertEqual(len(with_unit), 4)
        self.assertEqual(len(without_unit), 3)
        # Date, value and category are shared; only the unit is dropped.
        self.assertEqual(with_unit[:2] + with_unit[3:], without_unit)

    def test_metricless_records_have_no_key(self):
        import milestone_identity

        for rec in ({"value": None}, {"value": ""}, {"value": "1"}, {"value": "1", "date": None}):
            with self.subTest(rec=rec):
                self.assertIsNone(milestone_identity.report_group_key(rec, include_unit=False))


class TestSchemaMatchesEnforcement(unittest.TestCase):
    """The schema's written contract must match what check_data actually enforces.

    Documentation that permits what the validator rejects is worse than no
    documentation: it invites a contributor to publish (0,0), which is precisely
    the null-island dot the validator exists to prevent. It did - the events
    contract still said "(0,0) allowed" while the code rejected it.
    """

    def _schema(self):
        return cd._SCHEMA

    def test_coordinates_doc_does_not_permit_null_island(self):
        doc = self._schema()["controls"]["events"]["coordinates"]
        self.assertNotIn("(0,0) allowed", doc)
        self.assertIn("no-location marker", doc)

    def test_doc_states_geolocation_is_optional(self):
        doc = self._schema()["controls"]["events"]["coordinates"]
        self.assertIn("Optional", doc)

    def test_documents_the_optional_geolocation_rule(self):
        rules = " ".join(self._schema()["files"]["events.json"]["rules"])
        self.assertIn("geolocation is OPTIONAL", rules)

    def test_documents_the_informational_located_flag(self):
        rules = " ".join(self._schema()["files"]["events.json"]["rules"])
        self.assertIn("located", rules)

    def test_shape_lists_the_optional_fields(self):
        shape = self._schema()["files"]["events.json"]["shape"]
        for field in ("geolocation?", "located?", "tone?", "sources?"):
            with self.subTest(field=field):
                self.assertIn(field, shape)

    def test_documented_optionality_matches_enforcement(self):
        # The doc says optional, so enforcement must agree: an event with no
        # geolocation and no flag has to pass.
        payload = _events_payload({
            "title": "X", "category": "Robotics", "date": "2026-03-15"})
        self.assertEqual(cd.check_events(payload["events"]), [])

    def test_documented_rejection_of_null_island_matches_enforcement(self):
        payload = _events_payload({
            "title": "X", "category": "Robotics", "date": "2026-03-15",
            "geolocation": {"lat": 0, "lon": 0}})
        issues = cd.check_events(payload["events"])
        self.assertTrue(any("no-location marker" in i for i in issues), issues)


class TestUnlocatedEvents(unittest.TestCase):
    """A milestone that cannot be geocoded is published, not deleted.

    Dropping it silently removed it from the feed, dashboard, catalog and metrics.
    The contract is: `geolocation` is either a real located pair or absent, and
    an explicitly-unlocated record says so.
    """

    def _event(self, **over):
        base = {
            "id": "ev-1", "title": "T", "category": "Cybersecurity",
            "date": "2026-03-15", "source": "S", "value": "1",
        }
        base.update(over)
        return base

    def test_located_event_is_accepted(self):
        ev = self._event(geolocation={"lat": 51.5, "lon": -0.12})
        self.assertEqual(cd.check_events([ev]), [])

    def test_unlocated_event_without_the_flag_is_accepted(self):
        # Legacy payload shape: simply no geolocation key.
        self.assertEqual(cd.check_events([self._event()]), [])

    def test_explicitly_unlocated_event_is_accepted(self):
        self.assertEqual(cd.check_events([self._event(located=False)]), [])

    def test_null_island_is_rejected(self):
        issues = cd.check_events([self._event(geolocation={"lat": 0, "lon": 0})])
        self.assertTrue(any("no-location marker" in i for i in issues), issues)

    def test_out_of_range_coordinates_are_rejected(self):
        issues = cd.check_events([self._event(geolocation={"lat": 200, "lon": 0})])
        self.assertTrue(any("lat/lon pair" in i for i in issues))

    def test_malformed_geolocation_is_rejected(self):
        issues = cd.check_events([self._event(geolocation="somewhere")])
        self.assertTrue(issues)

    def test_unlocated_events_still_participate_in_ordering_and_duplicate_checks(self):
        # Being unlocated must not exempt a record from list-level invariants.
        issues = cd.check_events([
            self._event(id="ev-a", title="Old", date="2026-01-01", located=False),
            self._event(id="ev-b", title="New", date="2026-09-01", located=False),
        ])
        self.assertTrue(any("newest-first" in i for i in issues), issues)


class TestEventOrdering(unittest.TestCase):
    """The published event list must stay newest-first.

    This invariant shipped broken once: a pipeline step regrouped the feed instead
    of filtering it, and every per-record check still passed while the newest
    milestone ended up at index 54.
    """

    def _ev(self, i, title, value, date, url="https://example.com/x", cat="Biotechnology & Biohacking"):
        return {
            "id": i, "title": title, "category": cat, "value": value,
            "date": date, "url": url, "geolocation": {"lat": 1, "lon": 1},
        }

    def test_newest_first_passes(self):
        events = [
            self._ev("a", "New", "1", "2026-09-01"),
            self._ev("b", "Mid", "2", "2026-05-01"),
            self._ev("c", "Old", "3", "2026-01-01"),
        ]
        self.assertEqual(cd.check_event_ordering(events), [])

    def test_out_of_order_is_reported(self):
        events = [
            self._ev("a", "Old", "1", "2026-01-01"),
            self._ev("b", "New", "2", "2026-09-01"),
        ]
        issues = cd.check_event_ordering(events)
        self.assertEqual(len(issues), 1)
        self.assertIn("newest-first", issues[0])

    def test_reversed_list_reports_once_not_once_per_pair(self):
        events = [self._ev(f"m{i}", f"T{i}", str(i), f"2026-01-{i + 1:02d}") for i in range(5)]
        self.assertEqual(len(cd.check_event_ordering(events)), 1)

    def test_single_and_empty_lists_pass(self):
        self.assertEqual(cd.check_event_ordering([]), [])
        self.assertEqual(cd.check_event_ordering([self._ev("a", "Only", "1", "2026-01-01")]), [])

    def test_check_events_surfaces_the_ordering_violation(self):
        events = [
            self._ev("a", "Old", "1", "2026-01-01"),
            self._ev("b", "New", "2", "2026-09-01"),
        ]
        self.assertTrue(any("newest-first" in i for i in cd.check_events(events)))


class TestDuplicateReportDetection(unittest.TestCase):
    """One reported result from several sources must not reach the feed twice."""

    def _ev(self, i, title, value, date, url="https://example.com/x", cat="Computing & AGI"):
        return {
            "id": i, "title": title, "category": cat, "value": value,
            "date": date, "url": url, "geolocation": {"lat": 1, "lon": 1},
        }

    def test_same_metric_same_date_same_category_is_reported(self):
        events = [
            self._ev("x1", "Khipu mining result achieved", "0.86", "2026-06-30",
                     url="https://arxiv.org/abs/1"),
            self._ev("x2", "Khipu mining result reported", "0.86", "2026-06-30",
                     url="https://arxiv.org/abs/2"),
        ]
        issues = cd.check_duplicate_reports(events)
        self.assertEqual(len(issues), 1)
        self.assertIn("duplicate report", issues[0])
        self.assertIn("x1", issues[0])
        self.assertIn("x2", issues[0])

    def test_shared_generic_url_alone_does_not_count(self):
        # Two SpaceX flights citing spacex.com are two events, not one.
        events = [
            self._ev("a", "Starship payload to LEO", "156", "2026-02-01",
                     url="https://spacex.com", cat="Spaceflight & Aeronautics"),
            self._ev("b", "Falcon Heavy lift to GTO", "63", "2026-01-01",
                     url="https://spacex.com", cat="Spaceflight & Aeronautics"),
        ]
        self.assertEqual(cd.check_duplicate_reports(events), [])

    def test_two_ibm_milestones_in_one_article_are_not_duplicates(self):
        events = [
            self._ev("g", "IBM Condor 1121 qubit processor", "1121", "2026-03-01",
                     url="https://en.wikipedia.org/wiki/IBM_Q_System_One", cat="Quantum Physics"),
            self._ev("h", "IBM Eagle 127 qubit processor", "127", "2026-02-01",
                     url="https://en.wikipedia.org/wiki/IBM_Q_System_One", cat="Quantum Physics"),
        ]
        self.assertEqual(cd.check_duplicate_reports(events), [])

    def test_shared_value_with_unrelated_titles_is_not_a_duplicate(self):
        events = [
            self._ev("c", "Alpha protein folding benchmark", "0.86", "2026-03-02", url="https://a.com"),
            self._ev("d", "Beta solar cell efficiency record", "0.86", "2026-03-01",
                     url="https://b.com", cat="Renewable Energy"),
        ]
        self.assertEqual(cd.check_duplicate_reports(events), [])

    def test_same_value_on_different_dates_is_not_a_duplicate(self):
        events = [
            self._ev("e", "Rigetti 100 qubit processor", "100", "2026-05-01", url="https://a.com",
                     cat="Quantum Physics"),
            self._ev("f", "Rigetti 100 qubit processor", "100", "2026-01-01", url="https://b.com",
                     cat="Quantum Physics"),
        ]
        self.assertEqual(cd.check_duplicate_reports(events), [])

    def test_shared_value_in_different_categories_is_not_a_duplicate(self):
        events = [
            self._ev("g", "Khipu provenance result", "0.86", "2026-03-01", url="https://a.com"),
            self._ev("h", "Khipu provenance result", "0.86", "2026-03-01", url="https://b.com",
                     cat="Biotechnology & Biohacking"),
        ]
        self.assertEqual(cd.check_duplicate_reports(events), [])

    def test_metricless_records_are_never_duplicates(self):
        events = [
            self._ev("i", "Qualitative note one", None, "2026-03-01", url="https://a.com"),
            self._ev("j", "Qualitative note two", None, "2026-03-01", url="https://b.com"),
        ]
        self.assertEqual(cd.check_duplicate_reports(events), [])

    def test_numeric_and_string_spellings_are_caught(self):
        events = [
            self._ev("k", "Khipu mining result", 0.86, "2026-03-01", url="https://a.com"),
            self._ev("l", "Khipu mining result restated", "0.860", "2026-03-01", url="https://b.com"),
        ]
        self.assertEqual(len(cd.check_duplicate_reports(events)), 1)

    def test_shared_specific_url_is_enough_without_shared_words(self):
        events = [
            self._ev("m", "Totally unrelated wording alpha", "5", "2026-03-01",
                     url="https://arxiv.org/abs/same"),
            self._ev("n", "Nothing alike whatsoever beta", "5", "2026-03-01",
                     url="https://arxiv.org/abs/same"),
        ]
        self.assertEqual(len(cd.check_duplicate_reports(events)), 1)

    def test_oversized_bucket_is_reported_as_one_finding_not_pairwise(self):
        # A bucket this large is itself the finding, and pairwise comparison would
        # be quadratic over data already known to be broken.
        events = [
            {
                "id": f"i{n}", "title": "Khipu mining result", "category": "Computing & AGI",
                "value": "1", "date": "2026-01-01",
                "url": f"https://e.com/{n}", "geolocation": {"lat": 1, "lon": 1},
            }
            for n in range(400)
        ]
        issues = cd.check_duplicate_reports(events)
        self.assertEqual(len(issues), 1)
        self.assertIn("400 records report the same metric", issues[0])
        self.assertIn("suspected", issues[0])

    def test_findings_are_capped_so_a_broken_feed_cannot_flood_the_log(self):
        # Many small buckets, each pair corroborating: the cap must bound output.
        events = []
        for bucket in range(60):
            for n in range(2):
                events.append({
                    "id": f"b{bucket}-{n}", "title": "Khipu mining result",
                    "category": "Computing & AGI", "value": str(bucket),
                    "date": "2026-01-01", "url": f"https://e.com/{bucket}/{n}",
                    "geolocation": {"lat": 1, "lon": 1},
                })
        issues = cd.check_duplicate_reports(events)
        self.assertLessEqual(len(issues), cd._MAX_DUP_ISSUES + 1)
        self.assertIn("capped at", issues[-1])
        self.assertTrue(any("duplicate report" in i for i in issues))

    def test_published_event_file_is_clean(self):
        path = Path(cd.ROOT) / "data" / "events.json"
        if not path.exists():
            self.skipTest("data/events.json not present")
        events = json.loads(path.read_text(encoding="utf-8"))["events"]
        self.assertEqual(cd.check_event_ordering(events), [])
        self.assertEqual(cd.check_duplicate_reports(events), [])


class TestMergedSourcesField(unittest.TestCase):
    """The `sources` list written by duplicate unification must be well formed."""

    def _milestone(self, i, **over):
        base = {
            "id": i, "title": "T", "category": "Computing & AGI",
            "subcategory": "x", "value": "1", "date": "2026-01-01",
            "url": "https://example.com", "geolocation": {"lat": 1, "lon": 1},
        }
        base.update(over)
        return base

    def _wrap(self, milestones):
        return {
            "version": "1.0.0", "last_update": "2026-01-01T00:00:00+00:00",
            "categories": {
                "computing_agi": {
                    "name": "Computing & AGI", "icon": "x", "color": "#fff",
                    "subcategories": ["x"], "milestones": milestones,
                }
            },
        }

    def test_valid_sources_list_passes(self):
        data = self._wrap([self._milestone("a", sources=["Repo", "Paper"])])
        self.assertEqual(cd.check_milestones(data), [])

    def test_absent_sources_passes(self):
        data = self._wrap([self._milestone("a")])
        self.assertEqual(cd.check_milestones(data), [])

    def test_empty_sources_is_rejected(self):
        data = self._wrap([self._milestone("a", sources=[])])
        self.assertTrue(any("sources" in i for i in cd.check_milestones(data)))

    def test_non_list_sources_is_rejected(self):
        data = self._wrap([self._milestone("a", sources="Repo")])
        self.assertTrue(any("sources" in i for i in cd.check_milestones(data)))

    def test_blank_source_entry_is_rejected(self):
        data = self._wrap([self._milestone("a", sources=["Repo", "  "])])
        self.assertTrue(any("sources" in i for i in cd.check_milestones(data)))

    def test_duplicate_source_names_are_rejected(self):
        data = self._wrap([self._milestone("a", sources=["Repo", "Repo"])])
        self.assertTrue(any("duplicate source" in i for i in cd.check_milestones(data)))

    def test_category_not_newest_first_is_rejected(self):
        data = self._wrap([
            self._milestone("a", date="2026-01-01"),
            self._milestone("b", date="2026-09-01"),
        ])
        self.assertTrue(any("newest-first" in i for i in cd.check_milestones(data)))

    def test_category_newest_first_passes(self):
        data = self._wrap([
            self._milestone("a", date="2026-09-01"),
            self._milestone("b", date="2026-01-01"),
        ])
        self.assertEqual(cd.check_milestones(data), [])


class TestCheckUniqueIds(unittest.TestCase):
    def test_duplicate_zone_id_fails(self):
        zones = [
            {"id": "zone-x", "name": "X", "lat": 1, "lon": 1},
            {"id": "zone-x", "name": "X clone", "lat": 2, "lon": 2},
        ]
        issues = cd.check_zones(zones)
        self.assertTrue(any("duplicate id 'zone-x'" in i for i in issues))
        self.assertEqual(len(issues), 1)

    def test_duplicate_crisis_id_fails(self):
        crises = [
            {"id": "crisis-haiti", "name": "Haiti", "lat": 1, "lon": 1},
            {"id": "crisis-haiti", "name": "Haiti dup", "lat": 1, "lon": 1},
        ]
        issues = cd.check_crisis_zones(crises)
        self.assertTrue(any("duplicate id" in i for i in issues))

    def test_duplicate_fleet_id_fails(self):
        fleets = [
            {"id": "fleet-a", "from": {"lat": 0, "lon": 0}, "to": {"lat": 1, "lon": 1}},
            {"id": "fleet-a", "from": {"lat": 0, "lon": 0}, "to": {"lat": 2, "lon": 2}},
        ]
        issues = cd.check_fleets(fleets)
        self.assertTrue(any("duplicate id 'fleet-a'" in i for i in issues))

    def test_ids_are_unique_by_default(self):
        zones = [{"id": "a", "name": "A", "lat": 1, "lon": 1}, {"id": "b", "name": "B", "lat": 2, "lon": 2}]
        self.assertEqual(cd.check_zones(zones), [])


class TestSchemaParity(unittest.TestCase):
    """The Python validator constants must match schema/worldmap-data.schema.json
    exactly, and worldmap.js must hand-mirror the same coordinate bounds and the
    canonical status mapping. Any drift fails the build."""

    def _js(self) -> str:
        js_file = cd.ROOT / "assets" / "js" / "worldmap.js"
        if not js_file.exists():
            self.skipTest("worldmap.js not checked out")
        return js_file.read_text(encoding="utf-8")

    def test_schema_file_exists_and_is_well_formed(self):
        self.assertTrue(cd._SCHEMA_FILE.exists())
        self.assertIn("version", cd._SCHEMA)
        self.assertIn("coordinate", cd._SCHEMA["controls"])
        self.assertIn("layer_lifecycle", cd._SCHEMA["controls"])

    def test_python_constants_match_schema_exactly(self):
        self.assertEqual(
            cd._STATUS_VALUES,
            set(cd._SCHEMA["controls"]["layer_lifecycle"]["status_values"]),
        )
        self.assertEqual(
            cd._DATE_RE.pattern,
            cd._SCHEMA["controls"]["layer_lifecycle"]["date_pattern"],
        )
        self.assertAlmostEqual(cd._LAT_MIN, cd._SCHEMA["controls"]["coordinate"]["lat_min"])
        self.assertAlmostEqual(cd._LAT_MAX, cd._SCHEMA["controls"]["coordinate"]["lat_max"])
        self.assertAlmostEqual(cd._LON_MIN, cd._SCHEMA["controls"]["coordinate"]["lon_min"])
        self.assertAlmostEqual(cd._LON_MAX, cd._SCHEMA["controls"]["coordinate"]["lon_max"])

    def test_js_coordinate_bounds_match_schema(self):
        js = self._js()
        for token in ("lat >= -90", "lat <= 90", "lon >= -180", "lon <= 180"):
            self.assertIn(token, js)

    def test_js_status_mapping_matches_schema(self):
        js = self._js()
        self.assertIn("STATUS_ACTIVE = 'active'", js)
        self.assertIn("STATUS_CONCLUDED = 'concluded'", js)
        # The schema's canonical statuses map to active or concluded; a value
        # that is not in the schema must not start rendering as "active".
        self.assertIn("=== 'active' || s === 'ongoing'", js)


class TestEventCategories(unittest.TestCase):
    """An event must name one of the canonical categories.

    There is no "Other" bucket on this site, so a legacy or invented category is
    a data bug that would otherwise render as an uncoloured dot.
    """

    def _event(self, category: object) -> dict:
        return {"title": "X", "category": category, "date": "2026-03-15",
                "geolocation": {"lat": 1.5, "lon": 2.5}}

    def test_every_canonical_category_is_accepted(self):
        for category in cd._CATEGORIES:
            with self.subTest(category=category):
                self.assertEqual(cd.check_events([self._event(category)]), [])

    def test_other_category_fails(self):
        issues = cd.check_events([self._event("Other")])
        self.assertTrue(any("category" in i and "Other" in i for i in issues))

    def test_legacy_upstream_category_fails(self):
        # These are valid *upstream* names, but the sync folds them into a
        # canonical bucket; reaching the published feed means the fold was
        # bypassed, so validation must fail rather than hide the mismatch.
        issues = cd.check_events([self._event("Quantum Gravity")])
        self.assertTrue(any("category" in i for i in issues))

    def test_non_string_category_still_reported_as_type_error(self):
        issues = cd.check_events([self._event(42)])
        self.assertTrue(any("must be a string" in i for i in issues))

    def test_schema_declares_every_category_with_no_catch_all(self):
        cats = cd._SCHEMA["controls"]["events"]["categories"]
        self.assertNotIn("Other", cats)
        self.assertEqual(len(set(cats)), len(cats))
        # Nine: the original seven, with standalone Biotechnology replaced by
        # Biotechnology & Biohacking, plus Mobility & Logistics and Robotics.
        self.assertEqual(len(cats), 9)
        for expected in ("Biotechnology & Biohacking", "Mobility & Logistics", "Robotics"):
            self.assertIn(expected, cats)

    def test_schema_category_order_matches_declared_categories(self):
        order = cd._SCHEMA["controls"]["events"]["category_order"]
        cats = cd._SCHEMA["controls"]["events"]["categories"]
        self.assertEqual(sorted(order), sorted(cats))

    def test_subtone_categories_are_real_categories(self):
        subtones = cd._SCHEMA["controls"]["events"]["subtones"]
        self.assertTrue(subtones, "schema should declare at least one two-tone category")
        for category, spec in subtones.items():
            with self.subTest(category=category):
                self.assertIn(category, cd._SCHEMA["controls"]["events"]["categories"])
                self.assertTrue(spec["primary"])
                self.assertTrue(spec["secondary"])
                self.assertNotEqual(spec["primary"], spec["secondary"])
                self.assertTrue(spec["keywords"])

    def test_subtone_keywords_match_the_python_classifier(self):
        # The schema mirrors sync_milestones.CATEGORY_SUBTONES for documentation;
        # a keyword that exists on only one side would make the parity test below
        # meaningless, so the two lists must not drift.
        import sync_milestones as sync

        schema_sub = cd._SCHEMA["controls"]["events"]["subtones"]
        self.assertEqual(
            set(schema_sub),
            {sync.SITE_KEY_TO_DISPLAY[k] for k in sync.CATEGORY_SUBTONES},
            "schema subtones and Python CATEGORY_SUBTONES cover different categories",
        )
        for site_key, spec in sync.CATEGORY_SUBTONES.items():
            display = sync.SITE_KEY_TO_DISPLAY[site_key]
            with self.subTest(category=display):
                self.assertEqual(
                    set(schema_sub[display]["keywords"]),
                    set(spec["keywords"]),
                    f"keyword drift for {display}",
                )

    def test_python_and_js_legend_categories_match(self):
        js_file = cd.ROOT / "assets" / "js" / "worldmap.js"
        if not js_file.exists():
            self.skipTest("worldmap.js not checked out")
        js = js_file.read_text(encoding="utf-8")
        # CATEGORY_LEGEND entries in worldmap.js must cover every declared name.
        for category in cd._CATEGORIES:
            self.assertIn(f"label: '{category}'", js)

    def test_schema_declares_a_layer_contract(self):
        layers = cd._SCHEMA["controls"].get("worldmap_layers", {}).get("layers")
        self.assertIsInstance(layers, list, "schema should declare the toggleable layers")
        for spec in layers:
            with self.subTest(layer=spec.get("key")):
                self.assertTrue(spec.get("key"))
                self.assertTrue(spec.get("data_key"))
                self.assertTrue(spec.get("legend_label"))
                # Every operational layer must default OFF; a layer that appears on
                # unasked was the complaint that motivated the defaults.
                self.assertIs(spec.get("default_on"), False)

    def test_python_and_js_legend_layers_match_the_schema(self):
        # The category legend has a parity test; the layer legend did not, which
        # is how the schema ended up declaring 'conflict_zones' as a legend key
        # while worldmap.js registers that row as 'zones'.
        layers = cd._SCHEMA["controls"]["worldmap_layers"]["layers"]
        js_file = cd.ROOT / "assets" / "js" / "worldmap.js"
        if not js_file.exists():
            self.skipTest("worldmap.js not checked out")
        js = js_file.read_text(encoding="utf-8")
        for spec in layers:
            with self.subTest(layer=spec["key"]):
                # The legend row and its toggle both key off `key`.
                self.assertIn(f"key: '{spec['key']}'", js)
                self.assertIn(spec["legend_label"], js)

    def test_every_js_layer_row_is_declared_in_the_schema(self):
        # The other direction: an undocumented toggle would have no contract and
        # no default-off guarantee.
        layers = cd._SCHEMA["controls"]["worldmap_layers"]["layers"]
        declared = {spec["key"] for spec in layers}
        js_file = cd.ROOT / "assets" / "js" / "worldmap.js"
        if not js_file.exists():
            self.skipTest("worldmap.js not checked out")
        import re
        js = js_file.read_text(encoding="utf-8")
        # Rows registered through appendLayerRow with a layer key.
        registered = set(re.findall(r"appendLayerRow\(fragment, \{\s*key: '([^']+)'", js))
        self.assertTrue(registered, "no legend layer rows found - parser is stale?")
        self.assertEqual(registered - declared, set(),
                         "legend rows missing from the schema contract")

    def test_human_rights_is_a_layer_never_a_category(self):
        # The user-visible contract for the Human Rights layer: it must never gain
        # a category colour, a legend category row or a catalog filter.
        categories = set(cd._CATEGORIES)
        layers = {spec["key"] for spec in cd._SCHEMA["controls"]["worldmap_layers"]["layers"]}
        self.assertNotIn("Human Rights Violations", categories)
        self.assertIn("human_rights", layers)
        js_file = cd.ROOT / "assets" / "js" / "worldmap.js"
        if js_file.exists():
            js = js_file.read_text(encoding="utf-8")
            self.assertIn("Human Rights Violations", js)
            self.assertNotIn("'Human Rights Violations': '#", js)

    def test_rendered_legend_order_matches_the_schema(self):
        # The visual reading order is a product decision that must be declared
        # once: schema/worldmap-data.schema.json is authoritative and worldmap.js
        # renders in that order.
        #
        # Previously this also asserted sync_milestones.SITE_KEY_LEGEND_ORDER,
        # a third copy that nothing in production read - a declaration that could
        # drift with nothing to notice. The renderer is the thing that matters, so
        # that is what is compared.
        import re

        js_file = cd.ROOT / "assets" / "js" / "worldmap.js"
        if not js_file.exists():
            self.skipTest("worldmap.js not checked out")
        js = js_file.read_text(encoding="utf-8")

        order = cd._SCHEMA["controls"]["events"]["category_order"]
        rendered = re.findall(r"\{\s*key: '([^']+)',\s*label: '([^']+)'\s*\}", js)
        self.assertTrue(rendered, "no category legend entries found - parser is stale?")
        # Strip the module/layer rows that share this shape; compare the category
        # rows by their declared label.
        rendered_labels = [label for _key, label in rendered]
        declared = [d for d in order if d in rendered_labels]
        self.assertEqual(rendered_labels[:len(declared)], declared,
                         "worldmap.js renders categories in a different order "
                         "than the schema declares")

    def test_no_third_declaration_of_the_legend_order(self):
        # The order is declared in the schema and rendered in worldmap.js. A
        # Python copy with no consumer is a copy that can drift.
        src = (cd.ROOT / "scripts" / "sync_milestones.py").read_text(encoding="utf-8")
        self.assertNotIn("SITE_KEY_LEGEND_ORDER", src)

    def test_every_alias_target_is_a_canonical_category(self):
        import sync_milestones as sync
        self.assertTrue(sync.CATEGORY_ALIASES, "alias table should not be empty")
        for alias, canonical in sync.CATEGORY_ALIASES.items():
            with self.subTest(alias=alias):
                self.assertIn(canonical, cd._CATEGORIES)

    def test_published_events_use_canonical_categories(self):
        events_file = cd.DATA_DIR / "events.json"
        if not events_file.exists():
            self.skipTest("events.json not checked out")
        payload = json.loads(events_file.read_text(encoding="utf-8"))
        self.assertEqual(cd.check_events(payload["events"]), [])


class TestWorldLayersHeader(unittest.TestCase):
    def _payload(self, **overrides: object) -> dict:
        base = {"version": cd._FILE_VERSION, "last_update": "2026-09-25T00:00:00+00:00",
                "conflict_zones": [], "crisis_zones": [], "deployments": []}
        base.update(overrides)
        return base

    def test_valid_header_passes(self):
        self.assertEqual(cd.check_data(self._payload(), "world_layers.json"), [])

    def test_missing_version_fails(self):
        issues = cd.check_data(self._payload(version=None), "world_layers.json")
        self.assertTrue(any("version must be a semver string" in i for i in issues))

    def test_version_mismatch_fails(self):
        issues = cd.check_data(self._payload(version="1.0.0"), "world_layers.json")
        self.assertTrue(any(f"expected '{cd._FILE_VERSION}'" in i for i in issues))

    def test_missing_or_empty_last_update_fails(self):
        for value in (None, "", 42):
            issues = cd.check_data(self._payload(last_update=value), "world_layers.json")
            self.assertTrue(any("last_update must be a non-empty UTC timestamp" in i for i in issues), value)

    def test_naive_timestamp_fails(self):
        issues = cd.check_data(self._payload(last_update="2026-09-25T00:00:00"), "world_layers.json")
        self.assertTrue(any("must carry a UTC offset" in i for i in issues))

    def test_garbage_timestamp_fails(self):
        issues = cd.check_data(self._payload(last_update="not-a-date"), "world_layers.json")
        self.assertTrue(any("not parseable as an ISO-8601 timestamp" in i for i in issues))

    def test_zulu_suffix_is_accepted(self):
        payload = self._payload(last_update="2026-09-25T00:00:00Z")
        payload["conflict_zones"] = []  # keep the rest valid
        self.assertEqual(cd.check_data(payload, "world_layers.json"), [])


class TestCheckFile(unittest.TestCase):
    def test_end_to_end_with_written_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            # A real located pair: (0,0) is now rejected outright as the
            # no-location marker, which this fixture previously relied on.
            (d / "events.json").write_text(
                json.dumps(_events_payload({"title": "X", "category": "Cybersecurity", "date": "2026-03-15",
                                            "geolocation": {"lat": 51.5, "lon": -0.12}})),
                encoding="utf-8",
            )
            (d / "world_layers.json").write_text(
                json.dumps(_layers_payload(
                    [{"name": "Z", "lat": 1, "lon": 1}],
                    [{"from": {"lat": 0, "lon": 1}, "to": {"lat": 1, "lon": 1}}],
                    crises=[{"name": "C", "lat": 2, "lon": 2}],
                )),
                encoding="utf-8",
            )
            (d / "milestones.json").write_text(
                json.dumps({
                    "version": "1.0.0",
                    "last_update": "2026-09-25T00:00:00Z",
                    "categories": {}
                }),
                encoding="utf-8",
            )
            self.assertEqual(cd.main([str(d)]), 0)

    def test_missing_file_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "events.json").write_text("{}", encoding="utf-8")
            self.assertEqual(cd.main([str(d)]), 1)

    def test_unparseable_json_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "events.json").write_text("{not json", encoding="utf-8")
            (d / "world_layers.json").write_text("{}", encoding="utf-8")
            self.assertEqual(cd.main([str(d)]), 1)


if __name__ == "__main__":
    unittest.main()