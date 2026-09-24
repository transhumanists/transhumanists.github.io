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
    payload = {"version": "1.1.0", "conflict_zones": zones, "fleet_movements": fleets}
    if crises is not None:
        payload["crisis_zones"] = crises
    return payload


class TestCheckEvents(unittest.TestCase):
    def test_happy_path(self):
        payload = _events_payload(
            {"title": "X", "category": "Energy", "geolocation": {"lat": 1.5, "lon": 2.5}},
        )
        self.assertEqual(cd.check_events(payload["events"]), [])

    def test_missing_geolocation_fails(self):
        payload = _events_payload({"title": "X", "category": "Energy"})
        self.assertTrue(cd.check_events(payload["events"]))

    def test_nonfinite_coordinate_fails(self):
        payload = _events_payload(
            {"title": "X", "category": "Biotech", "geolocation": {"lat": 1e400, "lon": 0}},
        )
        issues = cd.check_events(payload["events"])
        self.assertTrue(any("geolocation" in i for i in issues))

    def test_bool_coordinate_fails(self):
        payload = _events_payload(
            {"title": "X", "category": "Biotech", "geolocation": {"lat": True, "lon": 0}},
        )
        issues = cd.check_events(payload["events"])
        self.assertTrue(any("geolocation" in i for i in issues))

    def test_out_of_range_fails(self):
        payload = _events_payload(
            {"title": "X", "category": "Biotech", "geolocation": {"lat": 91, "lon": 190}},
        )
        issues = cd.check_events(payload["events"])
        self.assertTrue(any("geolocation" in i for i in issues))

    def test_bad_title_type_fails(self):
        payload = _events_payload(
            {"title": 42, "category": "Biotech", "geolocation": {"lat": 1, "lon": 1}},
        )
        self.assertTrue(any("title" in i for i in cd.check_events(payload["events"])))


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
        # "2022-03" (month of March) ends after the 2022-03-05 start; the range is
        # valid even though a naive string compare of prefix/suffix trips.
        zones = [
            self._zone(start_date="2022-03-05", end_date="2022-03"),
            self._zone(start_date="2021", end_date="2021-06-01"),
        ]
        self.assertEqual(cd.check_zones(zones), [])

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


class TestCheckFile(unittest.TestCase):
    def test_end_to_end_with_written_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "events.json").write_text(
                json.dumps(_events_payload({"title": "X", "category": "C", "geolocation": {"lat": 0, "lon": 0}})),
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