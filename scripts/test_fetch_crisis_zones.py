#!/usr/bin/env python3
"""Self-tests for scripts/fetch_crisis_zones.py (stdlib only, offline).

The build/inference functions are pure (no network); this suite focuses on the
geo-location guards that protect the map from "Null Island" (0,0) entries, the
dedupe/cap contract shared by the sourced and static paths, and the RSS parser.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fetch_crisis_zones as fz


class TestInferLocation(unittest.TestCase):
    def test_known_countries_resolve(self):
        cases = {
            "sudan": ((13.0, 24.5, "East Africa")),
            "chad": ((15.45, 18.73, "Central Africa")),
            "cabo delgado": ((-12.5, 40.5, "Southern Africa")),
            "red sea": ((19.0, 38.0, "Middle East")),
            "sahel": ((13.0, 2.0, "West Africa")),
        }
        for text, expected in cases.items():
            self.assertEqual(fz.infer_location(f"Crisis in {text}"), expected, text)

    def test_unknown_returns_null_island_marker(self):
        self.assertEqual(fz.infer_location("Some completely unknown place"), (0.0, 0.0, "Unknown"))

    def test_infer_region(self):
        self.assertEqual(fz.infer_region("Boumba-et-Nkam chad flood"), "Central Africa")


class TestBuildCrisisZones(unittest.TestCase):
    def _item(self, title: str, country: str = "", desc: str = ""):
        return {"title": title, "link": "https://example.org", "description": desc, "country": country}

    def test_null_island_items_are_dropped(self):
        # Un-locatable items never become zones; a fully-empty sourcing result
        # triggers the curated static fallback instead (see next test).
        items = [self._item("Some unknown emergency without a location"),
                 self._item("Sudan famine emergency")]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertEqual([z["id"] for z in zones], ["crisis-sudan-famine-emergency"])

    def test_all_unlocatable_falls_back_to_static(self):
        items = [self._item("Some unknown emergency without a location")]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertEqual(zones, fz._finalize_crisis_zones(fz.STATIC_CRISIS_ZONES))

    def test_geolocatable_items_survive(self):
        items = [self._item("Sudan famine emergency")]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0]["lat"], 13.0)
        self.assertEqual(zones[0]["lon"], 24.5)
        self.assertTrue(zones[0]["id"].startswith("crisis-"))

    def test_country_field_geolocates_otherwise_opaque_titles(self):
        items = [self._item("Cyclone damage and hunger", country="Mozambique")]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0]["lat"], -18.67)

    def test_dedupes_identical_titles_across_sources(self):
        a = [self._item("Haiti quake aftermath")]
        b = [self._item("Haiti quake aftermath")]
        zones = fz.build_crisis_zones_from_sources(a, b, [], [], [], [], [])
        self.assertEqual(len(zones), 1)

    def test_dedupes_slug_collisions(self):
        # Same slug after punctuation is stripped -> same id -> second is dropped.
        a = [self._item("Sudan! Emergency")]
        b = [self._item("Sudan ? Emergency")]
        zones = fz.build_crisis_zones_from_sources(a, b, [], [], [], [], [])
        self.assertEqual(len(zones), 1)

    def test_respects_fifteen_zone_cap(self):
        items = [self._item(f"Sudan situation number {i}") for i in range(30)]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertLessEqual(len(zones), 15)
        self.assertEqual(len(zones), 15)

    def test_priority_order_reliefweb_first(self):
        relief = [self._item("Yemen cholera emergency")]
        who = [self._item("Yemen cholera emergency")]
        zones = fz.build_crisis_zones_from_sources([], who, relief, [], [], [], [])
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0]["url"], "https://example.org")


class TestFinalizeCrisisZones(unittest.TestCase):
    def test_dedupes_ids_without_mutating_input(self):
        source = [
            {"id": "crisis-x", "name": "X", "lat": 1, "lon": 1},
            {"id": "crisis-x", "name": "X again", "lat": 1, "lon": 1},
            {"id": "crisis-y", "name": "Y", "lat": 2, "lon": 2},
        ]
        out = fz._finalize_crisis_zones(source)
        self.assertEqual([z["id"] for z in out], ["crisis-x", "crisis-y"])
        self.assertEqual(len(source), 3)  # caller's list untouched

    def test_clamps_to_cap(self):
        source = [{"id": f"crisis-{i}", "lat": 0, "lon": 0} for i in range(30)]
        out = fz._finalize_crisis_zones(source)
        self.assertLessEqual(len(out), 15)

    def test_skips_malformed_entries(self):
        out = fz._finalize_crisis_zones([{"lat": 1}, "junk", {"id": "", "lat": 1}, {"id": "crisis-ok", "lat": 2, "lon": 2}])
        self.assertEqual([z["id"] for z in out], ["crisis-ok"])


class TestStaticFallback(unittest.TestCase):
    def test_static_list_has_unique_ids_and_no_null_island(self):
        ids = [z["id"] for z in fz.STATIC_CRISIS_ZONES]
        self.assertEqual(len(ids), len(set(ids)))
        for z in fz.STATIC_CRISIS_ZONES:
            self.assertFalse(z["lat"] == 0.0 and z["lon"] == 0.0, z["id"])
            self.assertIn(z["status"], {"active", "ongoing", "concluded", "inactive", "ended", "resolved"})

    def test_static_caps_at_fifteen(self):
        out = fz._finalize_crisis_zones(fz.STATIC_CRISIS_ZONES)
        self.assertLessEqual(len(out), 15)


class TestParseOchaRss(unittest.TestCase):
    def _rss(self, *titles: str) -> str:
        items = "".join(f"<item><title><![CDATA[{t}]]></title><link>https://e.example/{i}</link></item>"
                        for i, t in enumerate(titles))
        return f"<rss><channel>{items}</channel></rss>"

    def test_parses_crisis_mentions(self):
        rss = self._rss("Sudan: famine warning issued", "World Cup 2026 finals")
        crises = fz.parse_ocha_rss(rss)
        self.assertEqual(len(crises), 1)
        self.assertIn("Sudan", crises[0]["title"])
        self.assertEqual(crises[0]["link"], "https://e.example/0")

    def test_no_items_yields_empty(self):
        self.assertEqual(fz.parse_ocha_rss("<rss></rss>"), [])


class TestSchemaVersion(unittest.TestCase):
    def test_schema_version_is_current(self):
        # Kept in sync with sync_layers.LIFECYCLE_VERSION (checked at runtime).
        self.assertEqual(fz.SCHEMA_VERSION, "1.1.0")


if __name__ == "__main__":
    unittest.main()