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


def _layers_payload(zones: list[dict], fleets: list[dict]) -> dict:
    return {"version": "1.0.0", "conflict_zones": zones, "fleet_movements": fleets}


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
        fleets = [{"from": {"lat": 1e400, "lon": 0}, "to": {"lat": 0, "lon": 0}}]
        issues = cd.check_fleets(fleets)
        self.assertTrue(any("from" in i for i in issues))


class TestCheckFile(unittest.TestCase):
    def test_end_to_end_with_written_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "events.json").write_text(
                json.dumps(_events_payload({"title": "X", "category": "C", "geolocation": {"lat": 0, "lon": 0}})),
                encoding="utf-8",
            )
            (d / "world_layers.json").write_text(
                json.dumps(_layers_payload([{"name": "Z", "lat": 1, "lon": 1}], [{"from": {"lat": 0, "lon": 0}, "to": {"lat": 1, "lon": 1}}])),
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