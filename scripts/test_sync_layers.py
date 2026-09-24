#!/usr/bin/env python3
"""Self-tests for scripts/sync_layers.py (stdlib only)."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sync_layers as sl


def _wikitext_fixture() -> str:
    return """\
Some intro prose.

=== Major wars (10,000+ deaths in one calendar year) ===

{| class="wikitable sortable"
|-
! Start
! Conflict
! Continent
! Location
! Fatalities
|-
| style="text-align:center;"| 1918
| {{Tree list}}
* [[Balochistan conflict|Insurgency in Balochistan]], [[Occupation of Balochistan]]
{{Tree list/end}}
| [[Asia]]
| {{flag|Iran}}<br>{{flag|Pakistan}}<br>{{flag|Afghanistan}}
| 219,000
|-
| style="text-align:center;"| 1948
| {{Tree list}}
* [[Israeli–Palestinian conflict]]<br>
** [[Israeli occupation of the West Bank]] (1967)
{{Tree list/end}}
| [[Asia]]
| {{flag|Palestine}}<br>{{flag|Israel}}
| 37,000+
|-
| style="text-align:center;"| 2022
| {{Tree list}}
* [[Russo-Ukrainian War]]
{{Tree list/end}}
| [[Eastern Europe]]
| {{flag|Ukraine}}<br>{{flag|Russia}}
| 500,000
|}

=== Minor wars (1,000-9,999 deaths in a calendar year) ===

{| class="wikitable sortable"
|-
! Start
! Conflict
! Continent
! Location
! Fatalities
|-
| style="text-align:center;"| 2013
| {{Tree list}}
* [[Mali War]]
{{Tree list/end}}
| [[Africa]]
| {{flag|Mali}}<br>{{flag|Burkina Faso}}
| 8,000
|-
| style="text-align:center;"| 1909
| {{Tree list}}
* [[Conflict with unknown country]]<br>
* [[Insurgency with no location]]
{{Tree list/end}}
| [[Antarctica|Unknown]]
| {{flag|Atlantis}}
| 5,000
|}

=== Conflicts (100-999 deaths in a calendar year) ===

{| class="wikitable sortable"
|-
| style="text-align:center;"| 2020
| {{Tree list}}
* [[Haitian crisis]]
{{Tree list/end}}
| [[Caribbean]]
| {{flag|Haiti}}
| 900
|}

=== Skirmishes and clashes (fewer than 100 deaths) ===

{| class="wikitable sortable"
|-
| style="text-align:center;"| 2024
| {{Tree list}}
* [[Border skirmish]]
{{Tree list/end}}
| [[Asia]]
| {{flag|India}}<br>{{flag|Pakistan}}
| 40
|}
"""


class TestParseWikipediaConflicts(unittest.TestCase):
    def test_parses_all_four_tiers(self):
        items = sl.parse_wikipedia_conflicts(_wikitext_fixture())
        self.assertEqual(len(items), 7)
        by_name = {i["name"]: i for i in items}
        self.assertEqual(by_name["Insurgency in Balochistan"]["tier"], "major")
        self.assertEqual(by_name["Israeli–Palestinian conflict"]["tier"], "major")
        self.assertEqual(by_name["Russo-Ukrainian War"]["year"], 2022)
        self.assertEqual(by_name["Mali War"]["tier"], "minor")
        self.assertEqual(by_name["Haitian crisis"]["tier"], "conflict")
        self.assertEqual(by_name["Border skirmish"]["tier"], "skirmish")

    def test_countries_and_region(self):
        by_name = {i["name"]: i for i in sl.parse_wikipedia_conflicts(_wikitext_fixture())}
        baloch = by_name["Insurgency in Balochistan"]
        self.assertEqual(baloch["countries"], ["Iran", "Pakistan", "Afghanistan"])
        self.assertEqual(baloch["continent"], "Asia")
        self.assertEqual(by_name["Russo-Ukrainian War"]["continent"], "Eastern Europe")

    def test_uses_display_name_from_piped_link(self):
        by_name = {i["name"]: i for i in sl.parse_wikipedia_conflicts(_wikitext_fixture())}
        self.assertIn("Insurgency in Balochistan", by_name)

    def test_rows_without_geolocatable_countries_are_still_parsed(self):
        items = sl.parse_wikipedia_conflicts(_wikitext_fixture())
        by_name = {i["name"]: i for i in items}
        self.assertEqual(by_name["Conflict with unknown country"]["countries"], ["Atlantis"])

    def test_empty_input(self):
        self.assertEqual(sl.parse_wikipedia_conflicts(""), [])


class TestConflictZonesFromWikipedia(unittest.TestCase):
    def setUp(self):
        self.items = sl.parse_wikipedia_conflicts(_wikitext_fixture())

    def test_skips_skirmishes_and_countryless(self):
        zones = sl.conflict_zones_from_wikipedia(self.items)
        names = {z["name"] for z in zones}
        self.assertNotIn("Border skirmish", names)
        self.assertNotIn("Conflict with unknown country", names)

    def test_radius_by_tier(self):
        zones = sl.conflict_zones_from_wikipedia(self.items)
        by_name = {z["name"]: z for z in zones}
        self.assertEqual(by_name["Russo-Ukrainian War"]["radiusDeg"], 5.0)
        self.assertEqual(by_name["Mali War"]["radiusDeg"], 4.0)
        self.assertEqual(by_name["Haitian crisis"]["radiusDeg"], 3.0)

    def test_lifecycle_fields_present(self):
        zones = sl.conflict_zones_from_wikipedia(self.items)
        self.assertTrue(all(z["status"] == "active" for z in zones))
        self.assertTrue(all(z["start_date"].endswith("-01-01") for z in zones))
        self.assertEqual(
            [z for z in zones if z["id"] == "zone-insurgency-in-balochistan"][0]["start_date"],
            "1918-01-01",
        )


class TestMergeConflictZones(unittest.TestCase):
    def test_enriches_curated_missing_start_date(self):
        curated = [{"id": "zone-ukraine", "name": "Ukraine · Donbas front", "region": "Eastern Europe"}]
        wiki = sl.conflict_zones_from_wikipedia(sl.parse_wikipedia_conflicts(_wikitext_fixture()))
        merged, changes = sl.merge_conflict_zones(curated, wiki)
        self.assertEqual(merged[0]["start_date"], "2022-01-01")
        self.assertTrue(any("enriched zone-ukraine" in c for c in changes))

    def test_keeps_more_precise_curated_start_date(self):
        curated = [{"id": "zone-ukraine", "name": "Ukraine · Donbas front", "region": "Eastern Europe",
                    "start_date": "2022-02-24"}]
        wiki = sl.conflict_zones_from_wikipedia(sl.parse_wikipedia_conflicts(_wikitext_fixture()))
        merged, _ = sl.merge_conflict_zones(curated, wiki)
        self.assertEqual(merged[0]["start_date"], "2022-02-24")

    def test_tracks_added_zones(self):
        curated = []
        wiki = sl.conflict_zones_from_wikipedia(sl.parse_wikipedia_conflicts(_wikitext_fixture()))
        merged, _ = sl.merge_conflict_zones(curated, wiki)
        ids = {z["id"] for z in merged}
        self.assertIn("zone-russo-ukrainian-war", ids)

    def test_adds_higher_priority_tiers_first_when_capped(self):
        curated = []
        wiki = sl.conflict_zones_from_wikipedia(sl.parse_wikipedia_conflicts(_wikitext_fixture()))
        merged, _ = sl.merge_conflict_zones(curated, wiki, max_new_zones=2)
        self.assertEqual(len(merged), 2)
        self.assertEqual([z["radiusDeg"] for z in merged], [5.0, 5.0])


class TestNormalization(unittest.TestCase):
    def test_fleet_concluded_derived_from_end_date(self):
        fleet = {"id": "fleet-01", "from": {"lat": 1, "lon": 2}, "to": {"lat": 3, "lon": 4},
                 "end_date": "2023-06-01"}
        out = sl.normalize_lifecycle_fleet(fleet)
        self.assertEqual(out["status"], "concluded")
        self.assertEqual(out["start_date"], "")

    def test_fleet_active_without_end_date(self):
        out = sl.normalize_lifecycle_fleet({"id": "fleet-02"})
        self.assertEqual(out["status"], "active")
        self.assertEqual(out["end_date"], "")

    def test_explicit_status_wins(self):
        out = sl.normalize_lifecycle_fleet({"id": "fleet-03", "status": "active",
                                            "end_date": "2023-01-01"})
        self.assertEqual(out["status"], "active")

    def test_zone_defaults(self):
        out = sl.normalize_lifecycle_zone({"id": "zone-x", "name": "X"})
        self.assertEqual(out["status"], "active")
        self.assertEqual(out["start_date"], "")
        self.assertEqual(out["end_date"], "")


class TestFingerprint(unittest.TestCase):
    def test_ignores_last_update(self):
        base = {"version": "1.0.0", "last_update": "2026-01-01", "conflict_zones": []}
        touched = dict(base, last_update="2026-09-24T12:00:00Z")
        self.assertEqual(sl.content_fingerprint(base), sl.content_fingerprint(touched))

    def test_changes_on_real_content(self):
        base = {"conflict_zones": [{"id": "a"}]}
        other = {"conflict_zones": [{"id": "a", "status": "active"}]}
        self.assertNotEqual(sl.content_fingerprint(base), sl.content_fingerprint(other))


class TestEndToEnd(unittest.TestCase):
    def _write(self, tmp: Path) -> Path:
        p = tmp / "world_layers.json"
        p.write_text(json.dumps({
            "version": "1.0.0",
            "last_update": "",
            "conflict_zones": [{"id": "zone-ukraine", "name": "Ukraine · Donbas front",
                                "region": "Eastern Europe", "lat": 48.38, "lon": 31.17,
                                "radiusDeg": 4.0}],
            "deployments": [{"id": "fleet-01", "from": {"lat": 41.5, "lon": 28.9},
                             "to": {"lat": 44.6, "lon": 33.5}, "name": "Black Sea Fleet"}] * 3,
        }), encoding="utf-8")
        return p

    def test_online_merge_is_applied_to_output(self):
        # Regression: the merged wiki zones must actually land in conflict_zones.
        original_fetch = sl.fetch_wikipedia_wikitext
        sl.fetch_wikipedia_wikitext = lambda url: _wikitext_fixture()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                p = self._write(Path(tmp))
                data = json.loads(p.read_text(encoding="utf-8"))
                updated, changes = sl.build_updated_layers(data, offline=False)
                self.assertTrue(any("enriched zone-ukraine" in c for c in changes))
                self.assertTrue(any("added zone-haitian-crisis" in c for c in changes))
                ids = {z["id"] for z in updated["conflict_zones"]}
                self.assertIn("zone-ukraine", ids)
                self.assertIn("zone-haitian-crisis", ids)
                self.assertGreater(len(updated["conflict_zones"]), 1)
        finally:
            sl.fetch_wikipedia_wikitext = original_fetch

    def test_offline_write_adds_lifecycle_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = self._write(Path(tmp))
            rc = sl.main(["--offline", "--write", "--json", str(p)])
            self.assertEqual(rc, 0)
            data = json.loads(p.read_text(encoding="utf-8"))
            self.assertTrue(all(z["start_date"] == "" for z in data["conflict_zones"]))
            self.assertTrue(all(f["status"] == "active" for f in data["deployments"]))
            self.assertEqual(data["version"], sl.LIFECYCLE_VERSION)
            self.assertTrue(data["last_update"])

    def test_legacy_fleet_movements_key_is_migrated(self):
        # Regression: a file using the old "fleet_movements" key must not end up
        # with an empty "deployments" array (which would hide every fleet arrow).
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "world_layers.json"
            p.write_text(json.dumps({
                "version": "1.0.0",
                "last_update": "",
                "conflict_zones": [{"id": "zone-ukraine", "name": "Ukraine", "lat": 48.38, "lon": 31.17}],
                "fleet_movements": [{"id": "fleet-01", "from": {"lat": 1, "lon": 2}, "to": {"lat": 3, "lon": 4}}],
            }), encoding="utf-8")
            rc = sl.main(["--offline", "--write", "--json", str(p)])
            self.assertEqual(rc, 0)
            data = json.loads(p.read_text(encoding="utf-8"))
            self.assertEqual(len(data["deployments"]), 1)
            self.assertNotIn("fleet_movements", data)

    def test_offline_noop_leaves_file_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = self._write(Path(tmp))
            rc = sl.main(["--offline", "--write", "--json", str(p)])
            self.assertEqual(rc, 0)
            stamp_before = p.stat().st_mtime
            rc = sl.main(["--offline", "--write", "--json", str(p)])
            self.assertEqual(rc, 0)
            stamp_after = p.stat().st_mtime
            self.assertEqual(stamp_before, stamp_after)

    def test_missing_file_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            rc = sl.main(["--offline", "--json", str(Path(tmp) / "nope.json")])
            self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main()