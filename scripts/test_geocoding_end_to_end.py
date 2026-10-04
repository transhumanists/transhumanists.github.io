"""End-to-end geocoding test: upstream sentinel -> published data files.

Unit tests elsewhere cover each stage in isolation, and all of them passed while a
real leak was live: `merge_history` scrubbed its output, so a test asserting on the
archive was green, but `merge_feed` then overwrote the clean record with the raw
upstream one and `build_site_categories` emitted a null-island milestone.

The stages are wired together here exactly as `sync_milestones.main()` wires them,
because the defect lived in the wiring rather than in any single stage.
"""

from __future__ import annotations

import datetime as dt
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import sync_milestones as sm

NULL_ISLAND = {"lat": 0, "lon": 0}


def _upstream(records, category="computing_agi"):
    return {
        "version": "1.0.0",
        "last_update": "2026-10-02T00:00:00Z",
        "categories": {category: {"milestones": list(records)}},
    }


def _milestone(**over):
    m = {
        "id": "ms-e2e-1",
        "title": "A milestone",
        "value": 1,
        "unit": "units",
        "source": "Example",
        "date": "2024-05-01",
        "url": "https://example.org/a",
        "category": "Computing & AGI",
        "subcategory": "benchmarks",
    }
    m.update(over)
    return m


def _null_island_in(node):
    """Recursively find any (0,0) coordinate in a published structure."""
    found = []
    if isinstance(node, dict):
        geo = node.get("geolocation")
        if isinstance(geo, dict) and geo.get("lat") == 0 and geo.get("lon") == 0:
            found.append(node.get("id") or node.get("title") or "?")
        for v in node.values():
            found.extend(_null_island_in(v))
    elif isinstance(node, list):
        for v in node:
            found.extend(_null_island_in(v))
    return found


class TestUpstreamSentinelNeverReachesPublishedData(unittest.TestCase):
    def _run_pipeline(self, records, category="computing_agi"):
        upstream = _upstream(records, category)
        ok, msg = sm.validate(upstream)
        self.assertTrue(ok, msg)
        site = sm.transform_upstream_to_site_format(upstream)
        current = list(sm.iter_milestones(site))
        history = sm.merge_history([], current, "2026-10-02")
        feed, _ = sm.unify_duplicate_milestones(sm.merge_feed(current, history))
        feed = sm.enrich_with_historic_milestones(feed, history, dt.date(2026, 10, 2))
        return {
            "history": history,
            "feed": feed,
            "categories": sm.build_site_categories(feed, site.get("categories", {})),
        }

    def test_null_island_upstream_record_is_scrubbed_everywhere(self):
        out = self._run_pipeline([_milestone(geolocation=dict(NULL_ISLAND))])
        for stage in ("history", "feed", "categories"):
            self.assertEqual(_null_island_in(out[stage]), [], "null-island leaked into %s" % stage)

    def test_record_still_survives_as_unlocated(self):
        # Scrubbing must drop the coordinate, never the milestone.
        out = self._run_pipeline([_milestone(geolocation=dict(NULL_ISLAND))])
        ids = {m.get("id") for m in out["feed"]}
        self.assertIn("ms-e2e-1", ids)

    def test_real_coordinates_survive_the_whole_path(self):
        geo = {"lat": 51.5074, "lon": -0.1278}
        out = self._run_pipeline([_milestone(geolocation=dict(geo))])
        cats = out["categories"]["computing_agi"]["milestones"]
        self.assertEqual(cats[0]["geolocation"], geo)

    def test_mixed_batch_keeps_the_good_one_located(self):
        out = self._run_pipeline(
            [
                _milestone(id="ms-bad", geolocation=dict(NULL_ISLAND)),
                _milestone(id="ms-good", geolocation={"lat": 35.68, "lon": 139.69}),
            ]
        )
        by_id = {m["id"]: m for m in out["categories"]["computing_agi"]["milestones"]}
        self.assertNotIn("geolocation", by_id["ms-bad"])
        self.assertEqual(by_id["ms-good"]["geolocation"], {"lat": 35.68, "lon": 139.69})

    def test_malformed_upstream_geolocation_is_rejected_at_the_gate(self):
        # Deliberately a different assertion from the (0,0) case. The sentinel is
        # valid-but-meaningless and must survive validation so it can be scrubbed
        # downstream; a non-numeric coordinate is corrupt input and is refused before
        # it reaches any merge. Asserting it gets "dropped, not published" would be
        # asserting the wrong layer.
        ok, msg = sm.validate(_upstream([_milestone(geolocation={"lat": "abc", "lon": 2})]))
        self.assertFalse(ok)
        self.assertIn("not numeric", msg)

    def test_out_of_bounds_upstream_geolocation_is_rejected_at_the_gate(self):
        ok, msg = sm.validate(_upstream([_milestone(geolocation={"lat": 200, "lon": 2})]))
        self.assertFalse(ok)
        self.assertIn("out of bounds", msg)

    def test_archived_sentinel_survives_a_second_run(self):
        # A record already in the archive as unlocated must not be resurrected as
        # (0,0) merely because upstream still sends the sentinel for it.
        archived = {
            "id": "ms-e2e-1",
            "title": "A milestone",
            "category": "Computing & AGI",
            "subcategory": "benchmarks",
            "date": "2024-05-01",
            "source": "Example",
            "url": "https://example.org/a",
            "first_seen": "2024-05-02",
            "last_seen": "2024-05-02",
            "located": False,
        }
        upstream = _upstream([_milestone(geolocation=dict(NULL_ISLAND))])
        site = sm.transform_upstream_to_site_format(upstream)
        current = list(sm.iter_milestones(site))
        history = sm.merge_history([archived], current, "2026-10-03")
        feed = sm.merge_feed(current, history)
        self.assertEqual(_null_island_in(feed), [])
        self.assertEqual(_null_island_in(history), [])


if __name__ == "__main__":
    unittest.main()
