"""Tests for the coverage snapshot.

The snapshot is a changelog of progress toward filling the year gaps, so the
behaviour that matters is: write when findings change, stay silent when they do not.
A snapshot that rewrites every run is noise in git history and buries the entries
worth reading.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import coverage_report as cr


def _report(unique=10, located=8, years_populated=5):
    by_year = {str(1945 + i): 1 for i in range(years_populated)}
    return {
        "totals": {
            "records_read": unique,
            "unique": unique,
            "located": located,
            "unlocated": unique - located,
            "null_island": 0,
            "malformed": 0,
            "duplicate_across_files": 0,
            "same_title_and_day_different_source": 0,
        },
        "years": {
            "range": [1945, 2026],
            "populated": years_populated,
            "empty": 82 - years_populated,
            "empty_years": [1999, 2000],
            "sparse_years": [],
            "by_year": by_year,
        },
        "by_category": {"Computing & AGI": unique},
        "unlocated": [
            {
                "title": "No dot",
                "date": "2024-01-01",
                "category": "X",
                "source": "S",
                "url": "https://e.org/a",
            }
        ],
        "null_island_records": [],
    }


class TestSnapshotDigest(unittest.TestCase):
    def test_identical_findings_hash_identically(self):
        self.assertEqual(cr.snapshot_digest(_report()), cr.snapshot_digest(_report()))

    def test_a_new_milestone_changes_the_digest(self):
        self.assertNotEqual(
            cr.snapshot_digest(_report(unique=10)), cr.snapshot_digest(_report(unique=11))
        )

    def test_a_newly_populated_year_changes_the_digest(self):
        self.assertNotEqual(
            cr.snapshot_digest(_report(years_populated=5)),
            cr.snapshot_digest(_report(years_populated=6)),
        )

    def test_a_null_island_changes_the_digest(self):
        a = _report()
        b = _report()
        b["totals"]["null_island"] = 1
        self.assertNotEqual(cr.snapshot_digest(a), cr.snapshot_digest(b))


class TestSnapshotWriting(unittest.TestCase):
    def _write(self, report, data_dir):
        return cr.write_snapshot(report, data_dir, "2026-10-02T00:00:00Z")

    def test_first_run_appends(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            self.assertEqual(self._write(_report(), d), "appended")
            hist = json.loads((d / cr.SNAPSHOT_PATH).read_text(encoding="utf-8"))["history"]
            self.assertEqual(len(hist), 1)

    def test_unchanged_findings_do_not_append(self):
        # The whole point: a green run every 6 hours must not produce 4 commits a day
        # of identical snapshots.
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            self._write(_report(), d)
            before = (d / cr.SNAPSHOT_PATH).read_text(encoding="utf-8")
            self.assertEqual(self._write(_report(), d), "unchanged")
            self.assertEqual((d / cr.SNAPSHOT_PATH).read_text(encoding="utf-8"), before)

    def test_changed_findings_append_a_second_entry(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            self._write(_report(), d)
            self.assertEqual(self._write(_report(unique=11), d), "appended")
            hist = json.loads((d / cr.SNAPSHOT_PATH).read_text(encoding="utf-8"))["history"]
            self.assertEqual(len(hist), 2)
            self.assertEqual(hist[-1]["unique"], 11)

    def test_history_is_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            for i in range(260):
                self._write(_report(unique=10 + i), d)
            hist = json.loads((d / cr.SNAPSHOT_PATH).read_text(encoding="utf-8"))["history"]
            self.assertLessEqual(len(hist), 200)

    def test_a_corrupt_snapshot_is_replaced_not_fatal(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / cr.SNAPSHOT_PATH).write_text("{not json", encoding="utf-8")
            self.assertEqual(self._write(_report(), d), "appended")
            hist = json.loads((d / cr.SNAPSHOT_PATH).read_text(encoding="utf-8"))["history"]
            self.assertEqual(len(hist), 1)

    def test_entries_carry_the_numbers_a_trend_needs(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            self._write(_report(), d)
            e = json.loads((d / cr.SNAPSHOT_PATH).read_text(encoding="utf-8"))["history"][0]
            for key in (
                "measured_at",
                "unique",
                "located",
                "unlocated",
                "null_island",
                "years_populated",
                "years_empty",
                "by_category",
                "by_year",
            ):
                self.assertIn(key, e)


class TestShippedSnapshot(unittest.TestCase):
    def test_the_committed_snapshot_is_valid_json(self):
        path = ROOT / "data" / cr.SNAPSHOT_PATH
        if not path.exists():
            self.skipTest("no snapshot committed yet")
        payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertIn("history", payload)
        self.assertTrue(payload["history"])


if __name__ == "__main__":
    unittest.main()
