"""Tests for the coverage report and the null-island rule it enforces.

The null-island guard is the load-bearing one: 27 shipped records carried (0, 0)
straight from upstream for months, because check_events rejected it and
check_milestones did not. These tests pin both halves - the validator and the
report - so the two cannot drift apart again.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import check_data as cd
import coverage_report as cr


def _milestone(**over):
    m = {
        "id": "ms-test-1",
        "title": "Something happened",
        "category": "Computing & AGI",
        "subcategory": "benchmarks",
        "date": "2024-05-01",
        "source": "Example",
        "url": "https://example.org/a",
        "geolocation": {"lat": 51.5, "lon": -0.12},
    }
    m.update(over)
    return m


def _payload(milestones):
    return {
        "version": "1.2.0",
        "last_update": "2026-01-01T00:00:00+00:00",
        "categories": {"computing_agi": {"milestones": milestones}},
    }


class TestNullIslandEnforcement(unittest.TestCase):
    """check_events has always rejected (0,0); milestones must match."""

    def test_milestone_at_null_island_is_rejected(self):
        issues = cd.check_milestones(_payload([_milestone(geolocation={"lat": 0, "lon": 0})]))
        self.assertTrue(any("(0,0)" in i for i in issues), issues)

    def test_milestone_with_absent_geolocation_is_accepted(self):
        m = _milestone()
        del m["geolocation"]
        self.assertEqual(cd.check_milestones(_payload([m])), [])

    def test_milestone_located_false_flag_is_accepted(self):
        m = _milestone(located=False)
        del m["geolocation"]
        self.assertEqual(cd.check_milestones(_payload([m])), [])

    def test_out_of_range_still_rejected(self):
        issues = cd.check_milestones(_payload([_milestone(geolocation={"lat": 91, "lon": 0})]))
        self.assertTrue(any("lat/lon pair in range" in i for i in issues), issues)

    def test_zero_lat_with_real_lon_is_not_null_island(self):
        """Only the exact pair is the sentinel. A point on the equator is real."""
        self.assertEqual(
            cd.check_milestones(_payload([_milestone(geolocation={"lat": 0, "lon": 121.5})])), [])

    def test_events_and_milestones_agree_on_the_rule(self):
        """The two validators must not drift: same input, same verdict."""
        geo = {"lat": 0, "lon": 0}
        ev_issues = cd.check_events([{
            "title": "T", "category": "Computing & AGI", "date": "2024-05-01",
            "geolocation": geo}])
        ms_issues = cd.check_milestones(_payload([_milestone(geolocation=geo)]))
        self.assertTrue(any("(0,0)" in i for i in ev_issues))
        self.assertTrue(any("(0,0)" in i for i in ms_issues))


class TestNoShippedRecordIsNullIsland(unittest.TestCase):
    """Regression guard on the data itself, not just the validator."""

    def test_no_milestone_file_contains_null_island(self):
        offenders = []
        for rel in cr.DEFAULT_SOURCES:
            for m in cr.load(rel):
                if cr.geocode_state(m) == "null_island":
                    offenders.append("%s: %s" % (rel, (m.get("title") or "")[:60]))
        self.assertEqual(offenders, [], "null-island records shipped: %s" % offenders)


class TestGeocodeState(unittest.TestCase):
    def test_classifies_each_outcome(self):
        self.assertEqual(cr.geocode_state({"geolocation": {"lat": 1, "lon": 2}}), "located")
        self.assertEqual(cr.geocode_state({"geolocation": {"lat": 0, "lon": 0}}), "null_island")
        self.assertEqual(cr.geocode_state({}), "unlocated")
        self.assertEqual(cr.geocode_state({"geolocation": {"lat": "x", "lon": 2}}), "malformed")
        self.assertEqual(cr.geocode_state({"geolocation": "51.5,-0.1"}), "malformed")

    def test_absent_key_and_explicit_none_agree(self):
        self.assertEqual(cr.geocode_state({"title": "x"}), cr.geocode_state({"title": "x", "geolocation": None}))


class TestCoverageReport(unittest.TestCase):
    def test_builds_and_totals_are_consistent(self):
        r = cr.build(1945, 2026, cr.DEFAULT_SOURCES)
        t = r["totals"]
        self.assertEqual(
            t["located"] + t["unlocated"] + t["null_island"] + t["malformed"], t["unique"])

    def test_year_range_is_exact(self):
        r = cr.build(1945, 2026, cr.DEFAULT_SOURCES)
        span = 2026 - 1945 + 1
        self.assertEqual(r["years"]["populated"] + r["years"]["empty"], span)

    def test_empty_and_populated_years_are_disjoint(self):
        r = cr.build(1945, 2026, cr.DEFAULT_SOURCES)
        self.assertEqual(
            set(r["years"]["empty_years"]) & set(int(y) for y in r["years"]["by_year"]), set())

    def test_deduplicates_across_overlapping_files(self):
        # milestones.json and milestones_history.json intentionally overlap, so the
        # unique count must be well below the raw read count.
        r = cr.build(1945, 2026, cr.DEFAULT_SOURCES)
        self.assertLess(r["totals"]["unique"], r["totals"]["records_read"])
        self.assertGreater(r["totals"]["duplicate_across_files"], 0)

    def test_every_category_appears_in_the_report(self):
        r = cr.build(1945, 2026, cr.DEFAULT_SOURCES)
        self.assertEqual(sorted(r["by_category"]), sorted(cd._CATEGORIES))

    def test_render_does_not_crash_on_empty_input(self):
        empty = cr.build(1900, 1901, ())
        self.assertEqual(empty["totals"]["unique"], 0)
        self.assertIn("empty years", cr.render(empty))

    def test_json_output_is_valid(self):
        r = cr.build(1945, 2026, cr.DEFAULT_SOURCES)
        json.loads(json.dumps(r))  # must round-trip for CI consumption


class TestArchiveDropsUpstreamSentinel(unittest.TestCase):
    def test_archive_record_omits_null_island(self):
        import sync_milestones as sm
        rec = sm.archive_record(_milestone(geolocation={"lat": 0, "lon": 0}), "2026-01-01")
        self.assertNotIn("geolocation", rec)
        self.assertIs(rec["located"], False)

    def test_archive_record_keeps_real_coordinates(self):
        import sync_milestones as sm
        rec = sm.archive_record(_milestone(), "2026-01-01")
        self.assertEqual(rec["geolocation"]["lat"], 51.5)

    def test_archive_record_handles_absent_key(self):
        import sync_milestones as sm
        m = _milestone()
        del m["geolocation"]
        rec = sm.archive_record(m, "2026-01-01")
        self.assertNotIn("geolocation", rec)

    def test_archive_record_rejects_non_finite(self):
        import sync_milestones as sm
        rec = sm.archive_record(
            _milestone(geolocation={"lat": float("nan"), "lon": 1.0}), "2026-01-01")
        self.assertNotIn("geolocation", rec)


if __name__ == "__main__":
    unittest.main()