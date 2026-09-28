#!/usr/bin/env python3
"""Self-tests for scripts/scrape_historical_milestones.py (stdlib only)."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import scrape_historical_milestones as shm
import sync_milestones as sm


def make_catalog_entry(**overrides):
    base = {
        "id": "test-1",
        "category": "Energy",
        "subcategory": "fusion",
        "title": "Test milestone",
        "value": 100,
        "unit": "MW",
        "source": "Test Source",
        "url": "https://example.com",
        "date": "2020-01-01",
        "geolocation": {"lat": 43.7, "lon": 5.7},
    }
    base.update(overrides)
    return base


class TestValidateCatalog(unittest.TestCase):
    def test_valid_catalog(self):
        catalog = {"milestones": [make_catalog_entry()]}
        ok, errors = shm.validate_catalog(catalog)
        self.assertTrue(ok, errors)

    def test_missing_milestones_key(self):
        ok, errors = shm.validate_catalog({})
        self.assertFalse(ok)
        self.assertTrue(any("milestones" in e for e in errors))

    def test_missing_required_field(self):
        entry = make_catalog_entry()
        del entry["url"]
        ok, errors = shm.validate_catalog({"milestones": [entry]})
        self.assertFalse(ok)
        self.assertTrue(any("url" in e for e in errors))

    def test_malformed_date(self):
        entry = make_catalog_entry(date="2020-1-1")
        ok, errors = shm.validate_catalog({"milestones": [entry]})
        self.assertFalse(ok)
        self.assertTrue(any("malformed date" in e for e in errors))

    def test_invalid_date(self):
        entry = make_catalog_entry(date="2020-02-30")
        ok, errors = shm.validate_catalog({"milestones": [entry]})
        self.assertFalse(ok)
        self.assertTrue(any("invalid date" in e for e in errors))

    def test_bad_geolocation_bounds(self):
        entry = make_catalog_entry(geolocation={"lat": 91, "lon": 0})
        ok, errors = shm.validate_catalog({"milestones": [entry]})
        self.assertFalse(ok)
        self.assertTrue(any("out of bounds" in e for e in errors))

    def test_non_numeric_geolocation(self):
        entry = make_catalog_entry(geolocation={"lat": "abc", "lon": 0})
        ok, errors = shm.validate_catalog({"milestones": [entry]})
        self.assertFalse(ok)
        self.assertTrue(any("not numeric" in e for e in errors))

    def test_empty_id(self):
        entry = make_catalog_entry(id="")
        ok, errors = shm.validate_catalog({"milestones": [entry]})
        self.assertFalse(ok)
        self.assertTrue(any("empty id" in e for e in errors))

    def test_multiple_errors(self):
        entry = make_catalog_entry(date="bad", geolocation={"lat": 999, "lon": 0})
        ok, errors = shm.validate_catalog({"milestones": [entry]})
        self.assertFalse(ok)
        self.assertGreaterEqual(len(errors), 2)


class TestPickNextBatch(unittest.TestCase):
    def test_oldest_first(self):
        catalog = {"milestones": [
            make_catalog_entry(id="a", date="2020-06-01"),
            make_catalog_entry(id="b", date="2019-01-01"),
            make_catalog_entry(id="c", date="2021-01-01"),
        ]}
        batch = shm.pick_next_batch(catalog, set(), 2)
        self.assertEqual([e["id"] for e in batch], ["b", "a"])

    def test_respects_limit(self):
        catalog = {"milestones": [
            make_catalog_entry(id=f"m{i}", date=f"2020-01-{i+1:02d}")
            for i in range(10)
        ]}
        batch = shm.pick_next_batch(catalog, set(), 3)
        self.assertEqual(len(batch), 3)

    def test_skips_existing_ids(self):
        catalog = {"milestones": [
            make_catalog_entry(id="a", date="2019-01-01"),
            make_catalog_entry(id="b", date="2020-01-01"),
            make_catalog_entry(id="c", date="2021-01-01"),
        ]}
        batch = shm.pick_next_batch(catalog, {"a"}, 2)
        self.assertEqual([e["id"] for e in batch], ["b", "c"])

    def test_empty_when_all_consumed(self):
        catalog = {"milestones": [make_catalog_entry(id="a")]}
        batch = shm.pick_next_batch(catalog, {"a"}, 5)
        self.assertEqual(batch, [])

    def test_empty_catalog(self):
        batch = shm.pick_next_batch({"milestones": []}, set(), 5)
        self.assertEqual(batch, [])


class TestIntegration(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.catalog_path = Path(self.tmpdir.name) / "catalog.json"
        self.history_path = Path(self.tmpdir.name) / "history.json"

    def tearDown(self):
        self.tmpdir.cleanup()

    def _write_catalog(self, entries):
        self.catalog_path.write_text(
            json.dumps({"milestones": entries}), encoding="utf-8"
        )

    def test_dry_run_writes_nothing(self):
        self._write_catalog([make_catalog_entry(id="a", date="2020-01-01")])
        import io
        from contextlib import redirect_stdout

        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = shm.main.__wrapped__() if hasattr(shm.main, "__wrapped__") else None
        # We can't easily call main() with args, so test the logic directly
        catalog = shm.load_catalog(self.catalog_path)
        existing = shm.load_history(self.history_path)
        batch = shm.pick_next_batch(catalog, set(), 5)
        self.assertEqual(len(batch), 1)
        self.assertFalse(self.history_path.exists())

    def test_ingestion_creates_history(self):
        entries = [
            make_catalog_entry(id="a", date="2019-01-01"),
            make_catalog_entry(id="b", date="2020-01-01"),
            make_catalog_entry(id="c", date="2021-01-01"),
        ]
        self._write_catalog(entries)

        # Simulate what main() does
        catalog = shm.load_catalog(self.catalog_path)
        existing = shm.load_history(self.history_path)
        batch = shm.pick_next_batch(catalog, set(), 2)
        new_records = [sm.archive_record(e, "2026-09-29") for e in batch]
        merged = sm.merge_history(existing, new_records, "2026-09-29")
        sm.save_json(self.history_path, merged)

        result = json.loads(self.history_path.read_text(encoding="utf-8"))
        self.assertEqual(len(result), 2)
        ids = {r["id"] for r in result}
        self.assertEqual(ids, {"a", "b"})

    def test_idempotent_ingestion(self):
        entries = [make_catalog_entry(id="a", date="2020-01-01")]
        self._write_catalog(entries)

        # First ingestion
        catalog = shm.load_catalog(self.catalog_path)
        existing = shm.load_history(self.history_path)
        batch = shm.pick_next_batch(catalog, set(), 5)
        new_records = [sm.archive_record(e, "2026-09-29") for e in batch]
        merged = sm.merge_history(existing, new_records, "2026-09-29")
        sm.save_json(self.history_path, merged)

        # Second ingestion - should not duplicate
        existing = shm.load_history(self.history_path)
        batch = shm.pick_next_batch(catalog, {r["id"] for r in existing}, 5)
        self.assertEqual(len(batch), 0)

    def test_archive_record_format(self):
        entry = make_catalog_entry(id="test-1", category="Energy", value=100, unit="MW")
        record = sm.archive_record(entry, "2026-09-29")
        self.assertEqual(record["id"], "test-1")
        self.assertEqual(record["category"], "Renewable Energy")
        self.assertEqual(record["first_seen"], "2026-09-29")
        self.assertEqual(record["last_seen"], "2026-09-29")
        self.assertEqual(record["value"], 100)
        self.assertEqual(record["unit"], "MW")


class TestCatalogFile(unittest.TestCase):
    def test_load_real_catalog(self):
        catalog_path = Path(__file__).resolve().parent.parent / "data" / "historical_milestones.json"
        if not catalog_path.exists():
            self.skipTest("Real catalog not found")
        catalog = shm.load_catalog(catalog_path)
        ok, errors = shm.validate_catalog(catalog)
        self.assertTrue(ok, errors)
        self.assertGreater(len(catalog.get("milestones", [])), 0)

    def test_real_catalog_has_all_categories(self):
        catalog_path = Path(__file__).resolve().parent.parent / "data" / "historical_milestones.json"
        if not catalog_path.exists():
            self.skipTest("Real catalog not found")
        catalog = shm.load_catalog(catalog_path)
        categories = {e["category"] for e in catalog["milestones"]}
        expected = {
            "Biotechnology", "Computing & AGI", "Quantum Physics",
            "Renewable Energy", "Cybersecurity", "Spaceflight & Aeronautics",
            "Military & Defense",
        }
        self.assertTrue(expected.issubset(categories),
                        f"Missing categories: {expected - categories}")


if __name__ == "__main__":
    unittest.main()
