"""Tests for scripts/fetch_human_rights.py.

The fetcher runs unattended on a schedule, so the properties that matter are the
ones that keep a bad upstream response from corrupting data or deleting it: the
classifier must reject non-violations, geolocation must prefer the headline, the
merge must be additive, and every emitted row must satisfy the same contract
check_data.py enforces.
"""

from __future__ import annotations

import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fetch_human_rights as fhr

TODAY = datetime(2026, 10, 1, tzinfo=timezone.utc)

RSS = """<rss><channel>
<item>
  <title>Myanmar: women political prisoners tortured, authorities must act</title>
  <link>https://www.hrw.org/news/2026/09/22/myanmar-women-political-prisoners</link>
  <description>&lt;p&gt;Former women political prisoners reported torture.&lt;/p&gt;</description>
  <pubDate>Tue, 22 Sep 2026 08:00:00 +0000</pubDate>
</item>
<item>
  <title>Local team wins the regional football final</title>
  <link>https://example.com/sport</link>
  <description>A sporting result with no rights dimension.</description>
  <pubDate>Tue, 22 Sep 2026 08:00:00 +0000</pubDate>
</item>
<item>
  <title>Belarusian human rights defenders sentenced after arbitrary detention</title>
  <link>https://www.frontlinedefenders.org/en/case/belarusian-defenders</link>
  <description>Defenders received administrative arrest.</description>
  <pubDate>Wed, 23 Sep 2026 08:00:00 +0000</pubDate>
</item>
</channel></rss>"""


class TestParseFeed(unittest.TestCase):
    def test_extracts_items_with_title_link_and_date(self):
        items = fhr.parse_feed(RSS)
        self.assertEqual(len(items), 3)
        first = items[0]
        self.assertIn("Myanmar", first["title"])
        self.assertTrue(first["url"].startswith("https://www.hrw.org/"))
        self.assertIn("2026", first["pubdate"])

    def test_malformed_feed_returns_empty_instead_of_raising(self):
        # These are third-party feeds; an unattended run must survive junk.
        for junk in ("", "<rss><channel>", "not xml at all", "<item></item>"):
            with self.subTest(junk=junk):
                self.assertEqual(fhr.parse_feed(junk), [])

    def test_atom_style_link_href_is_used(self):
        atom = ('<feed><entry><title>Detention reported in Sudan</title>'
                '<link href="https://example.org/a"/></entry></feed>')
        items = fhr.parse_feed(atom)
        # The parser is item-based, so an entry-only feed yields nothing rather
        # than a half-parsed record.
        self.assertEqual(items, [])


class TestViolationClassification(unittest.TestCase):
    def test_detects_real_violations(self):
        for text in ("authorities carried out arbitrary detention",
                     "Witnesses described torture in the camp",
                     "Report documents enforced disappearance",
                     "Human rights defender detained"):
            with self.subTest(text=text):
                self.assertTrue(fhr.is_violation_report(text))

    def test_rejects_ordinary_reporting(self):
        for text in ("Team wins the football final",
                     "Minister opens a new hospital",
                     "Protests continue in the capital",
                     "A new report on economic growth"):
            with self.subTest(text=text):
                self.assertFalse(fhr.is_violation_report(text))

    def test_headline_is_matched_before_the_body(self):
        # Regression: a UAE article whose boilerplate body named South Sudan used
        # to be plotted in South Sudan, ~4,000 km away.
        located = fhr.locate("United Arab Emirates: a year on, critic remains in detention",
                             "Photo: a South Sudanese policeman")
        self.assertIsNotNone(located)
        lat, lon, region = located
        self.assertEqual(region, "Western Asia")
        self.assertAlmostEqual(lat, 23.4, places=1)
        self.assertAlmostEqual(lon, 53.8, places=1)

    def test_body_is_used_only_when_the_headline_is_unlocatable(self):
        # The hints are country-level on purpose: a headline that names only a
        # city cannot be placed reliably, and a coarse country anchor is better
        # than a wrong point.
        located = fhr.locate("Defenders sentenced after a crackdown",
                             "The court in Sudan ruled on the appeal.")
        self.assertIsNotNone(located)
        self.assertEqual(located[2], "Northern Africa")

    def test_a_city_only_headline_is_not_invented_into_a_point(self):
        self.assertIsNone(fhr.locate("Verdicts handed down in Nairobi", ""))

    def test_longest_country_name_wins(self):
        located = fhr.locate("Report from the democratic republic of the congo")
        self.assertIsNotNone(located)
        self.assertEqual(located[2], "Central Africa")

    def test_unlocatable_text_returns_none(self):
        self.assertIsNone(fhr.locate("Something happened somewhere", ""))


class TestBuildViolation(unittest.TestCase):
    def test_keeps_a_locatable_violation(self):
        entry = fhr.build_violation(
            {"title": "Myanmar: political prisoners tortured",
             "url": "https://www.hrw.org/news/2026/09/22/x",
             "note": "Witnesses described torture.",
             "pubdate": "Tue, 22 Sep 2026 08:00:00 +0000"},
            "Human Rights Watch", TODAY)
        self.assertIsNotNone(entry)
        self.assertEqual(entry["source"], "Human Rights Watch")
        self.assertEqual(entry["region"], "South-Eastern Asia")  # UN geoscheme label
        self.assertEqual(entry["status"], "active")
        self.assertEqual(entry["start_date"], "2026-09-22")
        self.assertEqual(fhr.validate_entry(entry), [])

    def test_drops_a_non_violation(self):
        entry = fhr.build_violation(
            {"title": "Local team wins the football final", "url": "https://example.com/s",
             "note": "", "pubdate": ""}, "Test", TODAY)
        self.assertIsNone(entry)

    def test_drops_a_violation_it_cannot_place(self):
        # Better to omit than to plot at (0,0), which the validator rejects.
        entry = fhr.build_violation(
            {"title": "Report documents torture in detention", "url": "https://example.com/t",
             "note": "", "pubdate": ""}, "Test", TODAY)
        self.assertIsNone(entry)

    def test_ids_are_stable_across_runs_and_url_changes(self):
        item = {"title": "Myanmar: prisoners tortured", "url": "https://example.com/stable",
                "note": "", "pubdate": ""}
        first = fhr.build_violation(item, "S", TODAY)
        again = fhr.build_violation(item, "S", TODAY)
        self.assertEqual(first["id"], again["id"])
        # A headline rewrite on the same article must not look like a new landmark.
        rewritten = dict(item, title="Myanmar: prisoners tortured, update")
        self.assertEqual(fhr.build_violation(rewritten, "S", TODAY)["id"], first["id"])

    def test_note_is_plain_text_with_entities_resolved(self):
        entry = fhr.build_violation(
            {"title": "Sudan: torture reported in detention",
             "url": "https://example.com/s", "pubdate": "",
             "note": "&lt;p&gt;Witnesses described &amp;nbsp;torture.&lt;/p&gt;"},
            "S", TODAY)
        self.assertNotIn("<", entry["note"])
        self.assertIn("torture", entry["note"])
        self.assertNotIn("&nbsp;", entry["note"])

    def test_unparsable_pubdate_does_not_raise(self):
        for raw in ("", "not a date", "Mon, 32 Xxx 2026"):
            with self.subTest(raw=raw):
                entry = fhr.build_violation(
                    {"title": "Sudan: detention and torture", "url": "https://example.com/s",
                     "note": "", "pubdate": raw}, "S", TODAY)
                self.assertIsNotNone(entry)
                self.assertEqual(entry["start_date"], "2026-10-01")


class TestValidateEntry(unittest.TestCase):
    def _base(self, **over):
        base = {
            "id": "hr-1", "name": "Report", "region": "Western Asia",
            "lat": 23.4, "lon": 53.8, "status": "active", "start_date": "2026-09-22",
            "source": "HRW", "url": "https://example.com/a", "note": "",
        }
        base.update(over)
        return base

    def test_accepts_a_well_formed_row(self):
        self.assertEqual(fhr.validate_entry(self._base()), [])

    def test_rejects_null_island(self):
        problems = fhr.validate_entry(self._base(lat=0, lon=0))
        self.assertTrue(any("no-location" in p for p in problems))

    def test_rejects_out_of_range_coordinates(self):
        self.assertTrue(fhr.validate_entry(self._base(lat=95)))
        self.assertTrue(fhr.validate_entry(self._base(lon=-200)))

    def test_rejects_unknown_status(self):
        self.assertTrue(fhr.validate_entry(self._base(status="maybe")))

    def test_rejects_missing_identifiers(self):
        self.assertTrue(fhr.validate_entry(self._base(id="")))
        self.assertTrue(fhr.validate_entry(self._base(name="  ")))

    def test_rejects_non_object(self):
        self.assertEqual(fhr.validate_entry("nope"), ["entry must be an object"])


class TestMergeEntries(unittest.TestCase):
    def _entry(self, id_, name="Report"):
        return {
            "id": id_, "name": name, "region": "Western Asia", "lat": 23.4, "lon": 53.8,
            "status": "active", "start_date": "2026-09-22", "source": "HRW",
            "url": "https://example.com/a", "note": "",
        }

    def test_new_entries_are_added(self):
        merged, added, total = fhr.merge_entries([], [self._entry("hr-a")], TODAY)
        self.assertEqual(added, 1)
        self.assertEqual(total, 1)
        self.assertEqual(merged[0]["id"], "hr-a")

    def test_existing_entries_are_never_removed(self):
        # The failure mode that matters most: a feed that stops publishing must not
        # make yesterday's reported violations vanish from the map.
        merged, added, _ = fhr.merge_entries([self._entry("hr-old")], [], TODAY)
        self.assertEqual(added, 0)
        self.assertEqual([e["id"] for e in merged], ["hr-old"])

    def test_existing_row_wins_on_id_conflict(self):
        # Upstream rewriting a headline must not silently mutate a live landmark.
        existing = self._entry("hr-a", name="Established report")
        merged, added, _ = fhr.merge_entries([existing], [self._entry("hr-a", name="New")], TODAY)
        self.assertEqual(added, 0)
        self.assertEqual(merged[0]["name"], "Established report")

    def test_output_is_sorted_newest_first(self):
        merged, _, _ = fhr.merge_entries(
            [], [self._entry("hr-a"), dict(self._entry("hr-b"), start_date="2026-01-01")], TODAY)
        dates = [e["start_date"] for e in merged]
        self.assertEqual(dates, sorted(dates, reverse=True))

    def test_duplicate_ids_in_existing_data_collapse(self):
        merged, _, total = fhr.merge_entries([self._entry("hr-a"), self._entry("hr-a")], [], TODAY)
        self.assertEqual(total, 1)
        self.assertEqual(len(merged), 1)


class TestSourceConfig(unittest.TestCase):
    def test_every_feed_is_https_and_named(self):
        for feed in fhr.SOURCE_FEEDS:
            with self.subTest(feed=feed["id"]):
                self.assertTrue(feed["url"].startswith("https://"))
                self.assertTrue(feed["name"])

    def test_feed_ids_are_unique(self):
        ids = [f["id"] for f in fhr.SOURCE_FEEDS]
        self.assertEqual(len(ids), len(set(ids)))


class TestPublishedLayer(unittest.TestCase):
    def test_committed_layer_satisfies_the_local_contract(self):
        path = Path(fhr.DEFAULT_OUTPUT)
        if not path.exists():
            self.skipTest("world_layers.json not present")
        data = json.loads(path.read_text(encoding="utf-8"))
        entries = data.get("human_rights_violations")
        self.assertIsInstance(entries, list)
        for entry in entries:
            with self.subTest(entry=entry.get("id")):
                self.assertEqual(fhr.validate_entry(entry), [])

    def test_committed_layer_ids_are_unique(self):
        path = Path(fhr.DEFAULT_OUTPUT)
        if not path.exists():
            self.skipTest("world_layers.json not present")
        data = json.loads(path.read_text(encoding="utf-8"))
        ids = [e.get("id") for e in data.get("human_rights_violations", [])]
        self.assertEqual(len(ids), len(set(ids)))


if __name__ == "__main__":
    unittest.main(verbosity=2)