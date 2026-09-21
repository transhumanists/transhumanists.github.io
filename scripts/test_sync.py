#!/usr/bin/env python3
"""Self-tests for scripts/sync_milestones.py (stdlib only)."""
from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sync_milestones as sm


def make_milestone(**overrides):
    base = {
        "id": "ms-x",
        "category": "Energy",
        "subcategory": "fusion",
        "title": "Fusion yield record",
        "value": 100,
        "unit": "MW",
        "source": "ITER",
        "date": "2026-08-22",
        "url": "https://example.com",
        "geolocation": {"lat": 43.7, "lon": 5.7},
    }
    base.update(overrides)
    return base


class TestMergeHistory(unittest.TestCase):
    def test_union_keeps_superseded_records(self):
        # "a" exists in both snapshots (same id -> update in place);
        # "c" is a superseded older record no longer in the current snapshot
        # (must be retained); "b" is a brand-new record.
        current = [
            make_milestone(id="a", date="2026-08-22", title="updated"),
            make_milestone(id="b", date="2026-08-25", title="new best"),
        ]
        existing = [
            make_milestone(id="a", date="2026-08-20", title="older", first_seen="2026-08-20", last_seen="2026-08-20"),
            make_milestone(id="c", date="2026-04-05", title="superseded", first_seen="2026-04-05", last_seen="2026-04-05"),
        ]
        history = sm.merge_history(existing, current, "2026-09-21")
        self.assertEqual(len(history), 3)  # a updated, b added, c retained
        by_id = {h["id"]: h for h in history}
        self.assertEqual(by_id["a"]["date"], "2026-08-22")  # newer metadata wins
        self.assertEqual(by_id["a"]["last_seen"], "2026-09-21")
        self.assertEqual(by_id["b"]["date"], "2026-08-25")
        self.assertEqual(by_id["c"]["date"], "2026-04-05")  # superseded survives
        self.assertEqual(by_id["c"]["first_seen"], "2026-04-05")
        # newest-first sort
        self.assertEqual([h["date"] for h in history], ["2026-08-25", "2026-08-22", "2026-04-05"])

    def test_display_category_maps(self):
        self.assertEqual(sm.display_category("Energy"), "Renewable Energy")
        self.assertEqual(sm.display_category("Quantum"), "Quantum Physics")
        self.assertEqual(sm.display_category("Spaceflight"), "Spaceflight & Aeronautics")
        self.assertEqual(sm.display_category("Defense"), "Military & Defense")
        self.assertEqual(sm.display_category("Biotechnology"), "Biotechnology")


class TestActivity(unittest.TestCase):
    def test_full_range_daily(self):
        history = [
            make_milestone(id="1", date="2026-04-01"),
            make_milestone(id="2", date="2026-04-01"),
            make_milestone(id="3", date="2026-08-25"),
            make_milestone(id="4", date="2026-09-21"),
        ]
        activity = sm.build_activity(history, date(2026, 9, 21))
        self.assertEqual(activity["bucket"], "day")
        self.assertEqual(activity["first"], "2026-04-01")
        self.assertEqual(activity["last"], "2026-09-21")
        self.assertEqual(activity["total"], 4)
        self.assertEqual(len(activity["days"]), (date(2026, 9, 21) - date(2026, 4, 1)).days + 1)
        counts = {d["date"]: d["count"] for d in activity["days"]}
        self.assertEqual(counts["2026-04-01"], 2)
        self.assertEqual(counts["2026-08-25"], 1)
        self.assertEqual(counts["2026-09-21"], 1)
        self.assertEqual(counts["2026-09-01"], 0)  # gaps kept as zeroes
        self.assertEqual(activity["spikes"][0]["count"], 2)

    def test_weekly_when_span_large(self):
        history = [make_milestone(id="1", date="2020-01-01")]  # a Wednesday
        activity = sm.build_activity(history, date(2026, 9, 21))
        self.assertEqual(activity["bucket"], "week")
        # buckets start at the Monday-of-week containing the earliest milestone
        self.assertEqual(activity["first"], "2019-12-30")
        self.assertTrue("2026-09-21" in [d["date"] for d in activity["days"]])


class TestEvents(unittest.TestCase):
    def test_events_mapping(self):
        events = sm.build_events([make_milestone(id="ms-a", category="Energy", value=100, unit="MW")])
        self.assertEqual(events["events"][0]["id"], "ev-ms-a")
        self.assertEqual(events["events"][0]["category"], "Renewable Energy")
        self.assertEqual(events["events"][0]["value"], "100 MW")

    def test_events_skip_no_geolocation(self):
        no_geo = make_milestone(id="x", geolocation={"lat": 0.0, "lon": 0.0})
        self.assertEqual(sm.build_events([no_geo])["events"], [])


class TestValidate(unittest.TestCase):
    def test_valid(self):
        data = {"categories": {"energy": {"name": "Energy", "milestones": [make_milestone()]}}}
        ok, msg = sm.validate(data)
        self.assertTrue(ok, msg)

    def test_rejects_malformed_date(self):
        m = make_milestone(date="2026-8-1")
        data = {"categories": {"energy": {"name": "Energy", "milestones": [m]}}}
        ok, msg = sm.validate(data)
        self.assertFalse(ok)
        self.assertIn("malformed date", msg)

    def test_rejects_out_of_bounds_geo(self):
        m = make_milestone(geolocation={"lat": 91, "lon": 0})
        data = {"categories": {"energy": {"name": "Energy", "milestones": [m]}}}
        ok, msg = sm.validate(data)
        self.assertFalse(ok)
        self.assertIn("out of bounds", msg)

    def test_rejects_missing_files(self):
        m = make_milestone()
        del m["url"]
        data = {"categories": {"energy": {"name": "Energy", "milestones": [m]}}}
        ok, msg = sm.validate(data)
        self.assertFalse(ok)
        self.assertIn("missing url", msg)


class TestFreshness(unittest.TestCase):
    def test_latest_date(self):
        ms = [make_milestone(id="1", date="2026-04-01"), make_milestone(id="2", date="2026-08-25")]
        self.assertEqual(sm.latest_milestone_date(ms), date(2026, 8, 25))

    def test_latest_none_for_garbage(self):
        self.assertIsNone(sm.latest_milestone_date([make_milestone(date="nope")]))


if __name__ == "__main__":
    unittest.main(verbosity=2)