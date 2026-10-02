"""Tests for the archive validation and the inherited-record scrub.

Both close gaps found reviewing the null-island fix:

- `milestones_history.json` was in no validator's scope at all - 106 published
  records the year slider draws from, checked by nobody.
- `archive_record` sanitised records built from upstream, but records inherited
  from the existing archive bypassed it, so a pre-fix (0,0) record was never
  re-examined and stayed in the file indefinitely.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import check_data as cd
import sync_milestones as sm


def _rec(**over):
    r = {
        "id": "ms-a1",
        "category": "Computing & AGI",
        "subcategory": "benchmarks",
        "title": "A milestone",
        "date": "2024-05-01",
        "source": "Example",
        "url": "https://example.org/a",
        "geolocation": {"lat": 51.5, "lon": -0.12},
        "first_seen": "2024-05-02",
        "last_seen": "2024-05-02",
    }
    r.update(over)
    return r


class TestArchiveValidator(unittest.TestCase):
    def test_well_formed_archive_passes(self):
        self.assertEqual(cd.check_archive([_rec()], "milestones_history.json"), [])

    def test_must_be_a_list(self):
        issues = cd.check_archive({"milestones": [_rec()]}, "milestones_history.json")
        self.assertTrue(any("must be a JSON array" in i for i in issues), issues)

    def test_null_island_rejected(self):
        issues = cd.check_archive([_rec(geolocation={"lat": 0, "lon": 0})], "milestones_history.json")
        self.assertTrue(any("(0,0)" in i for i in issues), issues)

    def test_absent_geolocation_accepted(self):
        r = _rec()
        del r["geolocation"]
        self.assertEqual(cd.check_archive([r], "milestones_history.json"), [])

    def test_duplicate_ids_rejected(self):
        issues = cd.check_archive([_rec(), _rec()], "milestones_history.json")
        self.assertTrue(any("duplicate id" in i for i in issues), issues)

    def test_missing_fields_rejected(self):
        r = _rec()
        del r["url"]
        issues = cd.check_archive([r], "milestones_history.json")
        self.assertTrue(any(".url" in i for i in issues), issues)

    def test_non_canonical_category_rejected(self):
        issues = cd.check_archive([_rec(category="Robotics")], "milestones_history.json")
        self.assertTrue(any("not a canonical category" in i for i in issues), issues)

    def test_relative_url_rejected(self):
        issues = cd.check_archive([_rec(url="/local/page")], "milestones_history.json")
        self.assertTrue(any(".url" in i for i in issues), issues)

    def test_out_of_range_coords_rejected(self):
        issues = cd.check_archive([_rec(geolocation={"lat": 200, "lon": 0})], "milestones_history.json")
        self.assertTrue(any("lat/lon pair in range" in i for i in issues), issues)

    def test_shipped_archive_is_valid(self):
        path = ROOT / "data" / "milestones_history.json"
        if not path.exists():
            self.skipTest("archive not checked out")
        import json
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(cd.check_archive(data, "milestones_history.json"), [])

    def test_archive_is_in_the_validated_set(self):
        # Otherwise the validator exists and never runs.
        self.assertIn("milestones_history.json", cd.ARCHIVE_FILES)


class TestInheritedRecordsAreScrubbed(unittest.TestCase):
    def test_merge_history_scrubs_legacy_null_island(self):
        existing = [_rec(geolocation={"lat": 0.0, "lon": 0.0})]
        out = sm.merge_history(existing, [], "2026-10-02")
        self.assertNotIn("geolocation", out[0])
        self.assertIs(out[0]["located"], False)

    def test_merge_feed_scrubs_legacy_null_island(self):
        history = [_rec(geolocation={"lat": 0.0, "lon": 0.0})]
        feed = sm.merge_feed([], history)
        self.assertNotIn("geolocation", feed[0])

    def test_merge_history_keeps_real_coordinates(self):
        out = sm.merge_history([_rec()], [], "2026-10-02")
        self.assertEqual(out[0]["geolocation"]["lat"], 51.5)
        self.assertNotIn("located", out[0])

    def test_scrub_preserves_other_fields(self):
        out = sm.merge_history([_rec(geolocation={"lat": 0.0, "lon": 0.0})], [], "2026-10-02")
        for field in ("id", "title", "category", "url", "first_seen"):
            self.assertIn(field, out[0])

    def test_scrub_is_idempotent(self):
        once = sm._scrub_inherited(_rec(geolocation={"lat": 0.0, "lon": 0.0}))
        twice = sm._scrub_inherited(once)
        self.assertEqual(once, twice)

    def test_fresh_metadata_still_wins_on_duplicate_id(self):
        existing = [_rec(geolocation={"lat": 0.0, "lon": 0.0}, first_seen="2020-01-01")]
        current = [{"id": "ms-a1", "category": "Computing & AGI", "subcategory": "benchmarks",
                    "title": "A milestone", "date": "2024-05-01", "source": "Example",
                    "url": "https://example.org/a", "value": 1, "unit": "u",
                    "geolocation": {"lat": 1.0, "lon": 2.0}}]
        out = sm.merge_history(existing, current, "2026-10-02")
        self.assertEqual(out[0]["geolocation"], {"lat": 1.0, "lon": 2.0})
        self.assertEqual(out[0]["first_seen"], "2020-01-01")


class TestUpstreamValidationParity(unittest.TestCase):
    """validate_upstream must not require what the pipeline now treats as optional."""

    def _upstream(self, **over):
        cat = {"milestones": [{
            "id": "ms-a1", "title": "T", "value": 1, "unit": "u",
            "source": "S", "date": "2024-05-01", "url": "https://e.org/a",
        }]}
        cat["milestones"][0].update(over)
        return {"version": "1.0.0", "last_update": "2026-01-01T00:00:00+00:00",
                "categories": {"computing_agi": cat}}

    def test_absent_geolocation_accepted(self):
        ok, msg = sm.validate(self._upstream())
        self.assertTrue(ok, msg)

    def test_null_island_accepted_as_unlocated(self):
        # Upstream uses (0,0) as its sentinel; it is not an upstream error, it is
        # the pipeline's job to drop it at the archive boundary.
        ok, msg = sm.validate(self._upstream(geolocation={"lat": 0, "lon": 0}))
        self.assertTrue(ok, msg)

    def test_malformed_geolocation_still_rejected(self):
        ok, _ = sm.validate(self._upstream(geolocation={"lat": "x", "lon": 2}))
        self.assertFalse(ok)

    def test_out_of_bounds_still_rejected(self):
        ok, _ = sm.validate(self._upstream(geolocation={"lat": 95, "lon": 2}))
        self.assertFalse(ok)

    def test_missing_url_still_rejected(self):
        d = self._upstream()
        del d["categories"]["computing_agi"]["milestones"][0]["url"]
        ok, msg = sm.validate(d)
        self.assertFalse(ok)
        self.assertIn("url", msg)


if __name__ == "__main__":
    unittest.main()