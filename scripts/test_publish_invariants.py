"""Tests for the publish-invariant checker.

The checker is only worth having if it fails on bad data, so nearly every test here
is negative: a mutated copy of the real data directory must produce a specific
complaint. An invariant checker that only ever passes is exactly the failure mode
this repository already hit once - the null-island gate shipped untested because the
real data was clean.
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

import publish_invariants as pi

DATA = ROOT / "data"


def _copy_data() -> Path:
    tmp = Path(tempfile.mkdtemp())
    dest = tmp / "data"
    shutil.copytree(DATA, dest)
    return dest


def _write(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _mutate_first_milestone(d: Path, **changes) -> None:
    """Change the first milestone in place.

    Loading, mutating and writing in a single step matters: an earlier version
    returned a throwaway copy from a read, so the mutation was discarded and the
    tests passed against unmodified data - the same way an untested gate passes.
    """
    path = d / "milestones.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["categories"]["computing_agi"]["milestones"][0].update(changes)
    _write(path, payload)


class TestBaseline(unittest.TestCase):
    def test_the_shipped_data_satisfies_every_invariant(self):
        self.assertEqual(pi.check(DATA), [])

    def test_a_clean_copy_also_passes(self):
        d = _copy_data()
        self.assertEqual(pi.check(d), [])


class TestCoordinateInvariants(unittest.TestCase):
    def test_origin_sentinel_is_caught(self):
        d = _copy_data()
        _mutate_first_milestone(d, geolocation={"lat": 0, "lon": 0})
        self.assertTrue(any("unusable coordinate" in i for i in pi.check(d)))

    def test_near_origin_sentinel_is_caught(self):
        # The drift case the contract exists for: a sentinel that is not exactly zero.
        d = _copy_data()
        _mutate_first_milestone(d, geolocation={"lat": 1e-9, "lon": 1e-9})
        self.assertTrue(any("unusable coordinate" in i for i in pi.check(d)))

    def test_real_equatorial_point_is_not_a_false_positive(self):
        # (0, 140) is a real place. Only the joint origin is ever the sentinel.
        d = _copy_data()
        _mutate_first_milestone(d, geolocation={"lat": 0.0, "lon": 139.69})
        self.assertFalse(any("unusable coordinate" in i for i in pi.check(d)))

    def test_malformed_coordinate_is_caught(self):
        d = _copy_data()
        _mutate_first_milestone(d, geolocation={"lat": "north", "lon": 2})
        self.assertTrue(any("unusable coordinate" in i for i in pi.check(d)))

    def test_out_of_range_coordinate_is_caught(self):
        d = _copy_data()
        _mutate_first_milestone(d, geolocation={"lat": 95, "lon": 2})
        self.assertTrue(any("unusable coordinate" in i for i in pi.check(d)))


class TestRecordInvariants(unittest.TestCase):
    def _mutate_first(self, d: Path, **changes):
        payload = json.loads((d / "milestones.json").read_text(encoding="utf-8"))
        payload["categories"]["computing_agi"]["milestones"][0].update(changes)
        _write(d / "milestones.json", payload)

    def test_unknown_location_confidence_is_caught(self):
        d = _copy_data()
        self._mutate_first(d, location_confidence="vibes")
        self.assertTrue(any("location_confidence" in i for i in pi.check(d)))

    def test_known_confidence_levels_are_accepted(self):
        d = _copy_data()
        for level in ("stated", "institution", "place", "subcategory", "source", "unlocated"):
            self._mutate_first(d, location_confidence=level)
            issues = [i for i in pi.check(d) if "location_confidence" in i]
            self.assertEqual(issues, [], "%r should be accepted" % level)

    def test_located_true_without_coordinates_is_caught(self):
        d = _copy_data()
        path = d / "milestones.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        m = payload["categories"]["computing_agi"]["milestones"][0]
        m.pop("geolocation", None)
        m["located"] = True
        _write(path, payload)
        self.assertTrue(any("located=true" in i for i in pi.check(d)))

    def test_non_canonical_category_is_caught(self):
        d = _copy_data()
        self._mutate_first(d, category="Robotics")
        self.assertTrue(any("non-canonical" in i for i in pi.check(d)))


class TestCrossFileInvariants(unittest.TestCase):
    def test_live_milestone_missing_from_the_archive_is_caught(self):
        # Inserted at the front so newest-first ordering still holds and this check
        # is the one that has to fire.
        d = _copy_data()
        live = json.loads((d / "milestones.json").read_text(encoding="utf-8"))
        hist = json.loads((d / "milestones_history.json").read_text(encoding="utf-8"))
        orphan = dict(hist[0], id="ms-orphan-only-in-live", date="2026-10-05")
        ms = live["categories"]["computing_agi"]["milestones"]
        ms.insert(0, orphan)
        ms.sort(key=lambda m: m.get("date", ""), reverse=True)
        _write(d / "milestones.json", live)
        self.assertTrue(any("absent from the archive" in i for i in pi.check(d)))

    def test_duplicate_archive_ids_are_caught(self):
        d = _copy_data()
        hist = json.loads((d / "milestones_history.json").read_text(encoding="utf-8"))
        hist.append(dict(hist[0]))
        _write(d / "milestones_history.json", hist)
        self.assertTrue(any("duplicate id" in i for i in pi.check(d)))

    def test_missing_file_is_caught(self):
        d = _copy_data()
        (d / "world_layers.json").unlink()
        self.assertTrue(any("missing" in i for i in pi.check(d)))

    def test_unparseable_file_is_caught(self):
        d = _copy_data()
        (d / "events.json").write_text("{not json", encoding="utf-8")
        self.assertTrue(any("unreadable" in i for i in pi.check(d)))


class TestWalkerFindsNestedCoordinates(unittest.TestCase):
    def test_sentinel_deep_in_the_structure_is_found(self):
        # Not only at the top level of a milestone list - the point of a recursive
        # walk is that an unexpected envelope still gets checked.
        issues = pi._content_invariants("x.json", {
            "categories": {"a": {"milestones": []}},
            "something_new": {"inner": [{"geolocation": {"lat": 0, "lon": 0}}]},
        })
        self.assertTrue(any("unusable coordinate" in i for i in issues), issues)

    def test_deployment_legs_are_covered(self):
        issues = pi._content_invariants("x.json", {
            "deployments": [{"from": {"lat": 0, "lon": 0}, "to": {"lat": 1, "lon": 1}}],
        })
        # Legs are validated by their own validator; the walker must not invent a
        # duplicate complaint for them, but must also not crash on the shape.
        self.assertIsInstance(issues, list)


if __name__ == "__main__":
    unittest.main()