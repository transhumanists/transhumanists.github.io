"""Tests for the coverage report and the null-island rule it enforces.

The null-island guard is the load-bearing one: 27 shipped records carried (0, 0)
straight from upstream for months, because check_events rejected it and
check_milestones did not. These tests pin both halves - the validator and the
report - so the two cannot drift apart again.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile
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
        self.assertTrue(any("no-location marker" in i for i in issues), issues)

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
            cd.check_milestones(_payload([_milestone(geolocation={"lat": 0, "lon": 121.5})])), []
        )

    def test_events_and_milestones_agree_on_the_rule(self):
        """The two validators must not drift: same input, same verdict."""
        geo = {"lat": 0, "lon": 0}
        ev_issues = cd.check_events(
            [
                {
                    "title": "T",
                    "category": "Computing & AGI",
                    "date": "2024-05-01",
                    "geolocation": geo,
                }
            ]
        )
        ms_issues = cd.check_milestones(_payload([_milestone(geolocation=geo)]))
        self.assertTrue(any("no-location marker" in i for i in ev_issues), ev_issues)
        self.assertTrue(any("no-location marker" in i for i in ms_issues), ms_issues)


class TestNoShippedRecordIsNullIsland(unittest.TestCase):
    """Regression guard on the data itself, not just the validator."""

    def test_no_milestone_file_contains_null_island(self):
        offenders = []
        for rel in cr.DEFAULT_FILES:
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
        self.assertEqual(
            cr.geocode_state({"title": "x"}), cr.geocode_state({"title": "x", "geolocation": None})
        )


class TestCoverageReport(unittest.TestCase):
    def test_builds_and_totals_are_consistent(self):
        r = cr.build(1945, 2026, cr.DEFAULT_FILES)
        t = r["totals"]
        self.assertEqual(
            t["located"] + t["unlocated"] + t["null_island"] + t["malformed"], t["unique"]
        )

    def test_year_range_is_exact(self):
        r = cr.build(1945, 2026, cr.DEFAULT_FILES)
        span = 2026 - 1945 + 1
        self.assertEqual(r["years"]["populated"] + r["years"]["empty"], span)

    def test_empty_and_populated_years_are_disjoint(self):
        r = cr.build(1945, 2026, cr.DEFAULT_FILES)
        self.assertEqual(
            set(r["years"]["empty_years"]) & set(int(y) for y in r["years"]["by_year"]), set()
        )

    def test_deduplicates_across_overlapping_files(self):
        # milestones.json and milestones_history.json intentionally overlap, so the
        # unique count must be well below the raw read count.
        r = cr.build(1945, 2026, cr.DEFAULT_FILES)
        self.assertLess(r["totals"]["unique"], r["totals"]["records_read"])
        self.assertGreater(r["totals"]["duplicate_across_files"], 0)

    def test_every_category_appears_in_the_report(self):
        r = cr.build(1945, 2026, cr.DEFAULT_FILES)
        self.assertEqual(sorted(r["by_category"]), sorted(cd._CATEGORIES))

    def test_render_does_not_crash_on_empty_input(self):
        empty = cr.build(1900, 1901, ())
        self.assertEqual(empty["totals"]["unique"], 0)
        self.assertIn("empty years", cr.render(empty))

    def test_json_output_is_valid(self):
        r = cr.build(1945, 2026, cr.DEFAULT_FILES)
        json.loads(json.dumps(r))  # must round-trip for CI consumption


class TestArchiveDropsUpstreamSentinel(unittest.TestCase):
    def test_archive_record_omits_null_island(self):
        import sync_milestones as sm

        rec = sm.archive_record(_milestone(geolocation={"lat": 0, "lon": 0}), "2026-01-01")
        self.assertNotIn("geolocation", rec)
        self.assertIs(rec["located"], False)
        self.assertEqual(rec["location_confidence"], "unlocated")

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
            _milestone(geolocation={"lat": float("nan"), "lon": 1.0}), "2026-01-01"
        )
        self.assertNotIn("geolocation", rec)


if __name__ == "__main__":
    unittest.main()


class TestDataDirIsOverridable(unittest.TestCase):
    """The gate's whole value is its failure path, so it has to be reachable."""

    def _tree(self, root: pathlib.Path, records):
        (root / "data").mkdir(exist_ok=True)
        (root / "data" / "milestones.json").write_text(
            json.dumps(
                {
                    "version": "1.0.0",
                    "last_update": "2026-01-01T00:00:00+00:00",
                    "categories": {"computing_agi": {"milestones": records}},
                }
            ),
            encoding="utf-8",
        )
        for name in ("milestones_history.json", "historical_milestones.json"):
            (root / "data" / name).write_text(json.dumps(records), encoding="utf-8")

    def _run(self, root: pathlib.Path, *args):
        env = dict(os.environ, WORLDMAP_DATA_DIR=str(root / "data"))
        return subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "coverage_report.py"), *args],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(root),
        )

    def test_clean_tree_exits_zero_and_prints_nothing_when_quiet(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            self._tree(
                root,
                [
                    {
                        "id": "ms-1",
                        "category": "Computing & AGI",
                        "subcategory": "x",
                        "title": "T",
                        "date": "2024-05-01",
                        "source": "S",
                        "url": "https://e.org/a",
                        "geolocation": {"lat": 51.5, "lon": -0.12},
                    }
                ],
            )
            r = self._run(root, "--fail-on-null-island", "--quiet")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(r.stdout, "")

    def test_null_island_exits_one_and_names_the_record(self):
        # A quiet gate that fails without saying why is indistinguishable from a
        # crash, and nobody debugs a silent non-zero exit.
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            self._tree(
                root,
                [
                    {
                        "id": "ms-1",
                        "category": "Computing & AGI",
                        "subcategory": "x",
                        "title": "Badly geocoded",
                        "date": "2024-05-01",
                        "source": "S",
                        "url": "https://e.org/a",
                        "geolocation": {"lat": 0, "lon": 0},
                    }
                ],
            )
            r = self._run(root, "--fail-on-null-island", "--quiet")
            self.assertEqual(r.returncode, 1)
            self.assertEqual(r.stdout, "")
            self.assertIn("::error::", r.stderr)
            self.assertIn("Badly geocoded", r.stderr)

    def test_json_mode_still_emits_a_document_on_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            self._tree(
                root,
                [
                    {
                        "id": "ms-1",
                        "category": "Computing & AGI",
                        "subcategory": "x",
                        "title": "Bad",
                        "date": "2024-05-01",
                        "source": "S",
                        "url": "https://e.org/a",
                        "geolocation": {"lat": 0, "lon": 0},
                    }
                ],
            )
            r = self._run(root, "--fail-on-null-island", "--json")
            self.assertEqual(r.returncode, 1)
            payload = json.loads(r.stdout)
            # One null-island record, present in all three files, deduped to one.
            self.assertEqual(payload["totals"]["null_island"], 1)
            self.assertEqual(payload["totals"]["records_read"], 3)
            self.assertEqual(len(payload["null_island_records"]), 1)

    def test_real_checkout_is_reported_on(self):
        # Guards the env plumbing itself: with the default DATA_DIR the real data
        # must still be found, not silently zero records.
        r = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "coverage_report.py"), "--json"],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
            env={k: v for k, v in os.environ.items() if k != "WORLDMAP_DATA_DIR"},
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertGreater(json.loads(r.stdout)["totals"]["unique"], 50)


class TestDedupKeyKeepsDistinctRecords(unittest.TestCase):
    """Two milestones can share a title and a date and still be different events."""

    def _report_for(self, records):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "data").mkdir()
            for name in ("milestones.json", "milestones_history.json"):
                (root / "data" / name).write_text(
                    json.dumps([dict(r) for r in records]), encoding="utf-8"
                )
            (root / "data" / "historical_milestones.json").write_text("[]", encoding="utf-8")
            old = cr.DATA_DIR
            try:
                cr.DATA_DIR = root / "data"
                return cr.build(1945, 2026, cr.DEFAULT_FILES)
            finally:
                cr.DATA_DIR = old

    def test_same_title_same_day_different_url_stay_separate(self):
        r = self._report_for(
            [
                {"title": "Consortium result", "date": "2024-05-01", "url": "https://a.org/1"},
                {"title": "Consortium result", "date": "2024-05-01", "url": "https://b.org/2"},
            ]
        )
        self.assertEqual(r["totals"]["unique"], 2)
        self.assertEqual(r["totals"]["records_read"], 4)
        self.assertEqual(r["totals"]["duplicate_across_files"], 2)
        self.assertEqual(r["totals"]["same_title_and_day_different_source"], 1)

    def test_identical_records_across_files_are_still_deduplicated(self):
        rec = {"title": "Same thing", "date": "2024-05-01", "url": "https://a.org/1"}
        r = self._report_for([rec, dict(rec)])
        # The fixture writes both copies into milestones.json and
        # milestones_history.json (historical_milestones.json stays empty), so the
        # single unique record is read 4 times and collapses to 1.
        self.assertEqual(r["totals"]["unique"], 1)
        self.assertEqual(r["totals"]["records_read"], 4)
        self.assertEqual(r["totals"]["duplicate_across_files"], 3)


if __name__ == "__main__":
    unittest.main()
