#!/usr/bin/env python3
"""Self-tests for scripts/check_data.py (stdlib only)."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_data as cd


def _events_payload(*events: dict) -> dict:
    return {"last_update": "2026-09-23", "version": "1.0.0", "events": list(events)}


def _layers_payload(zones: list[dict], fleets: list[dict], crises: list[dict] | None = None) -> dict:
    payload = {"version": "1.1.0", "last_update": "2026-09-25T00:00:00+00:00",
               "conflict_zones": zones, "fleet_movements": fleets}
    if crises is not None:
        payload["crisis_zones"] = crises
    return payload


class TestCheckEvents(unittest.TestCase):
    def test_happy_path(self):
        payload = _events_payload(
            {"title": "X", "category": "Energy", "date": "2026-03-15",
             "geolocation": {"lat": 1.5, "lon": 2.5}},
        )
        self.assertEqual(cd.check_events(payload["events"]), [])

    def test_missing_geolocation_fails(self):
        payload = _events_payload({"title": "X", "category": "Energy", "date": "2026-03-15"})
        self.assertTrue(cd.check_events(payload["events"]))

    def test_nonfinite_coordinate_fails(self):
        payload = _events_payload(
            {"title": "X", "category": "Biotech", "date": "2026-03-15",
             "geolocation": {"lat": 1e400, "lon": 0}},
        )
        issues = cd.check_events(payload["events"])
        self.assertTrue(any("geolocation" in i for i in issues))

    def test_bool_coordinate_fails(self):
        payload = _events_payload(
            {"title": "X", "category": "Biotech", "date": "2026-03-15",
             "geolocation": {"lat": True, "lon": 0}},
        )
        issues = cd.check_events(payload["events"])
        self.assertTrue(any("geolocation" in i for i in issues))

    def test_out_of_range_fails(self):
        payload = _events_payload(
            {"title": "X", "category": "Biotech", "date": "2026-03-15",
             "geolocation": {"lat": 91, "lon": 190}},
        )
        issues = cd.check_events(payload["events"])
        self.assertTrue(any("geolocation" in i for i in issues))

    def test_bad_title_type_fails(self):
        payload = _events_payload(
            {"title": 42, "category": "Biotech", "date": "2026-03-15",
             "geolocation": {"lat": 1, "lon": 1}},
        )
        self.assertTrue(any("title" in i for i in cd.check_events(payload["events"])))

    def test_missing_date_fails(self):
        payload = _events_payload(
            {"title": "X", "category": "Energy", "geolocation": {"lat": 1, "lon": 1}},
        )
        issues = cd.check_events(payload["events"])
        self.assertTrue(any("date" in i for i in issues))

    def test_non_string_date_fails(self):
        payload = _events_payload(
            {"title": "X", "category": "Energy", "date": 42,
             "geolocation": {"lat": 1, "lon": 1}},
        )
        issues = cd.check_events(payload["events"])
        self.assertTrue(any("date" in i for i in issues))

    def test_nonexistent_calendar_date_fails(self):
        # parseDateToISO would pass "2026-02-30" through unvalidated; the
        # validator must reject it so a non-date never renders on the map.
        payload = _events_payload(
            {"title": "X", "category": "Energy", "date": "2026-02-30",
             "geolocation": {"lat": 1, "lon": 1}},
        )
        issues = cd.check_events(payload["events"])
        self.assertTrue(any("date" in i for i in issues))

    def test_malformed_or_empty_date_fails(self):
        for bad in ("banana", "", "  ", "32/13/2026"):
            payload = _events_payload(
                {"title": "X", "category": "Energy", "date": bad,
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
                {"title": "X", "category": "Energy", "date": bad,
                 "geolocation": {"lat": 1, "lon": 1}},
            )
            issues = cd.check_events(payload["events"])
            self.assertTrue(any("date" in i for i in issues), f"bad date {bad!r}")

    def test_frontend_accepted_date_shapes_pass(self):
        # Same acceptance surface as worldmap.js parseDateToISO.
        for good in ("2026-03-15", "15/03/2026", "15-03-2026", "2026", "2026-03",
                     "2026-03-15T10:00:00", "2026-03-15T19:23:03+00:00"):
            payload = _events_payload(
                {"title": "X", "category": "Energy", "date": good,
                 "geolocation": {"lat": 1, "lon": 1}},
            )
            self.assertEqual(cd.check_events(payload["events"]), [], f"good date {good!r}")


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


class TestWorldLayersHeader(unittest.TestCase):
    def _payload(self, **overrides: object) -> dict:
        base = {"version": "1.1.0", "last_update": "2026-09-25T00:00:00+00:00",
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
        self.assertTrue(any("does not match the schema's expected '1.1.0'" in i for i in issues))

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
            (d / "events.json").write_text(
                json.dumps(_events_payload({"title": "X", "category": "C", "date": "2026-03-15",
                                            "geolocation": {"lat": 0, "lon": 0}})),
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