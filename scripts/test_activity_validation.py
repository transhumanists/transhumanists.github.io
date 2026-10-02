"""Tests for the activity-series and historical-catalog validators.

Both files are fetched by the browser or read by the cron, and until now neither had
a validator: `activity.json` had no validator at all despite dashboard.js calling
`d.date.startsWith(year)` on every entry, and the curated historical catalog had a
validator that was only ever pointed at synthetic fixtures.

As with the publish invariants, these are mostly negative - a validator that only
ever sees good data proves nothing.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import check_data as cd

DATA = ROOT / "data"


def _copy() -> Path:
    tmp = Path(tempfile.mkdtemp())
    dest = tmp / "data"
    shutil.copytree(DATA, dest)
    return dest


def _load(d: Path, name: str):
    return json.loads((d / name).read_text(encoding="utf-8"))


def _save(d: Path, name: str, payload) -> None:
    (d / name).write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


class TestBothFilesAreInScope(unittest.TestCase):
    def test_activity_and_catalog_are_validated(self):
        # Otherwise the validators exist and never run.
        self.assertIn("activity.json", cd.ACTIVITY_FILES)
        self.assertIn("historical_milestones.json", cd.CATALOG_FILES)

    def test_the_shipped_files_pass(self):
        self.assertEqual(cd.check_activity(_load(DATA, "activity.json"), "activity.json"), [])
        self.assertEqual(
            cd.check_catalog(_load(DATA, "historical_milestones.json"),
                             "historical_milestones.json"), [])

    def test_catalog_legacy_categories_are_legitimate(self):
        # The curated catalog carries old labels like "Biotechnology" on purpose; the
        # ingest folds them through CATEGORY_ALIASES. It must not be held to the
        # output contract's canonical-category rule.
        d = _copy()
        payload = _load(d, "historical_milestones.json")
        legacy = [m for m in payload["milestones"]
                  if m.get("category") not in cd._CATEGORIES]
        self.assertTrue(legacy, "expected the catalog to exercise a legacy label")
        import publish_invariants as pi
        self.assertEqual(pi.check(d), [])

    def test_check_data_walks_every_browser_fetched_file(self):
        d = _copy()
        (d / "activity.json").unlink()
        self.assertEqual(cd.main([str(d)]), 1)


class TestActivityValidator(unittest.TestCase):
    def _check(self, mutate):
        d = _copy()
        payload = _load(d, "activity.json")
        mutate(payload)
        return cd.check_activity(payload, "activity.json")

    def test_missing_date_is_caught(self):
        # The exact shape that throws inside dashboard.js's year filter.
        issues = self._check(lambda d: d["days"][0].pop("date"))
        self.assertTrue(any(".date" in i for i in issues), issues)

    def test_non_numeric_count_is_caught(self):
        self.assertTrue(any(".count" in i for i in self._check(
            lambda d: d["days"][0].__setitem__("count", "x"))))

    def test_negative_count_is_caught(self):
        self.assertTrue(any(".count" in i for i in self._check(
            lambda d: d["days"][0].__setitem__("count", -1))))

    def test_boolean_count_is_caught(self):
        # bool is an int subclass; without the guard True passes as a count.
        self.assertTrue(any(".count" in i for i in self._check(
            lambda d: d["days"][0].__setitem__("count", True))))

    def test_out_of_order_series_is_caught(self):
        # The chart labels the last bar as newest, so ordering is load bearing.
        self.assertTrue(any("out of order" in i for i in self._check(
            lambda d: d["days"].reverse())))

    def test_duplicate_date_is_caught(self):
        self.assertTrue(any("duplicate" in i for i in self._check(
            lambda d: d["days"].__setitem__(1, dict(d["days"][0])))))

    def test_total_must_match_the_sum(self):
        # The header count and the bars silently disagreeing is exactly the drift
        # that arithmetic catches and eyeballing does not.
        issues = self._check(lambda d: d.__setitem__("total", 999))
        self.assertTrue(any(".total" in i for i in issues), issues)

    def test_bounds_must_match_the_series(self):
        for field, value in (("first", "1900-01-01"), ("last", "2999-12-31")):
            issues = self._check(lambda d, f=field, v=value: d.__setitem__(f, v))
            self.assertTrue(any("." + field in i for i in issues), issues)

    def test_unknown_bucket_is_caught(self):
        self.assertTrue(any(".bucket" in i for i in self._check(
            lambda d: d.__setitem__("bucket", "fortnight"))))

    def test_spike_without_a_reason_is_caught(self):
        self.assertTrue(any("reason" in i for i in self._check(
            lambda d: d["spikes"][0].__setitem__("reason", ""))))

    def test_empty_days_is_caught(self):
        self.assertTrue(any(".days" in i for i in self._check(
            lambda d: d.__setitem__("days", []))))

    def test_non_object_is_caught(self):
        self.assertTrue(cd.check_activity([], "activity.json"))

    def test_a_well_formed_mutation_still_passes(self):
        # Guards against the validator being so strict it would reject good data.
        self.assertEqual(self._check(lambda d: None), [])


class TestCatalogValidator(unittest.TestCase):
    def _check(self, mutate):
        d = _copy()
        payload = _load(d, "historical_milestones.json")
        mutate(payload)
        return cd.check_catalog(payload, "historical_milestones.json")

    def test_entry_missing_url_is_caught(self):
        self.assertTrue(self._check(lambda d: d["milestones"][0].pop("url")))

    def test_entry_missing_source_is_caught(self):
        self.assertTrue(self._check(lambda d: d["milestones"][0].pop("source")))

    def test_malformed_date_is_caught(self):
        self.assertTrue(self._check(
            lambda d: d["milestones"][0].__setitem__("date", "01/01/1945")))

    def test_empty_subcategory_is_caught(self):
        self.assertTrue(self._check(
            lambda d: d["milestones"][0].__setitem__("subcategory", "")))

    def test_missing_version_is_caught(self):
        self.assertTrue(self._check(lambda d: d.pop("version")))

    def test_it_uses_the_ingest_script_validator_not_a_copy(self):
        # Delegating is the point; a restated rule would drift like every other copy.
        src = (ROOT / "scripts" / "check_data.py").read_text(encoding="utf-8")
        self.assertIn("sh.validate_catalog_entry(entry, i)", src)


if __name__ == "__main__":
    unittest.main()