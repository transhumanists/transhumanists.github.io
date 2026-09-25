#!/usr/bin/env python3
"""Self-tests for scripts/sync_milestones.py (stdlib only)."""
from __future__ import annotations

import contextlib
import ssl
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


class TestRetentionFeed(unittest.TestCase):
    def test_thin_upstream_never_wipes_feed(self):
        """Collapse regression at the site level: a 3-milestone snapshot
        mirrored after a 40-milestone history must still publish 40."""
        history = [make_milestone(id=f"ms-{i}", category="Energy", date="2026-08-01") for i in range(40)]
        thin = [make_milestone(id="ms-0", title="only record left today")]
        feed = sm.merge_feed(thin, history)
        self.assertEqual(len(feed), 40)

    def test_current_metadata_wins_on_same_id(self):
        history = [make_milestone(id="ms-a", date="2026-08-01", title="old")]
        current = [make_milestone(id="ms-a", date="2026-08-22", title="fresh")]
        feed = sm.merge_feed(current, history)
        self.assertEqual(len(feed), 1)
        self.assertEqual(feed[0]["title"], "fresh")
        self.assertEqual(feed[0]["date"], "2026-08-22")

    def test_build_site_categories_normalises_retained_names(self):
        # Retained archive records carry short display names ("Spaceflight");
        # the site container must normalise them to the canonical display name.
        ms = [
            {"id": "ms-b", "category": "Spaceflight", "subcategory": "launch",
             "title": "Retained launch", "date": "2026-08-01", "category_key": None},
        ]
        cats = sm.build_site_categories(ms, {})
        self.assertEqual(list(cats.keys()), ["spaceflight"])
        self.assertEqual(cats["spaceflight"]["name"], "Spaceflight & Aeronautics")
        self.assertEqual(cats["spaceflight"]["milestones"][0]["category"], "Spaceflight & Aeronautics")


class TestFingerprint(unittest.TestCase):
    def _artifacts(self):
        site_format = {"last_update": "2026-09-22T00:00:00", "categories": {"energy": {"name": "Energy"}}}
        history = [make_milestone(id="ms-a", first_seen="2026-08-01", last_seen="2026-09-22")]
        activity = {"last_update": "2026-09-22T00:00:00", "days": [], "spikes": []}
        events = {"last_update": "2026-09-22T00:00:00", "events": []}
        return site_format, history, activity, events

    def _fp(self, *args):
        return sm.content_fingerprint(*sm.churn_free_view(*args))

    def test_fingerprint_ignores_timestamp_churn(self):
        a = self._artifacts()
        b = self._artifacts()
        b[0]["last_update"] = "2099-01-01T00:00:00"       # milestones last_update
        b[1][0]["last_seen"] = "2099-01-01"               # archive sighting marker
        b[2]["last_update"] = "2099-01-01T00:00:00"       # activity timestamp
        b[3]["last_update"] = "2099-01-01T00:00:00"       # events timestamp
        self.assertEqual(self._fp(*a), self._fp(*b))

    def test_fingerprint_changes_on_real_content(self):
        a = self._artifacts()
        b = self._artifacts()
        b[1][0]["title"] = "A real content change"
        self.assertNotEqual(self._fp(*a), self._fp(*b))


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

    def test_events_value_uses_title_when_no_metric(self):
        m = make_milestone(
            id="ms-1", value=None, unit=None, category="Energy",
            title="Fusion milestone", summary="A milestone info string about fusion.",
        )
        events = sm.build_events([m])
        self.assertEqual(events["events"][0]["value"], "Fusion milestone")

    def test_events_value_keeps_metric_when_present(self):
        m = make_milestone(id="ms-2", value=100, unit="MW", category="Energy")
        events = sm.build_events([m])
        self.assertEqual(events["events"][0]["value"], "100 MW")


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


class TestEnrichHistoric(unittest.TestCase):
    TODAY = date(2026, 9, 15)

    def test_sparse_recent_feed_is_enriched(self):
        feed = [make_milestone(id="new", date="2026-09-10")]
        history = feed + [make_milestone(id="h1", date="2026-01-01")]
        out = sm.enrich_with_historic_milestones(feed, history, self.TODAY)
        ids = {m["id"] for m in out}
        self.assertIn("h1", ids)

    def test_dense_recent_feed_is_left_alone(self):
        feed = [make_milestone(id=f"r{i}", date=f"2026-09-{i:02d}") for i in range(1, 6)]
        history = feed + [make_milestone(id="h1", date="2026-01-01")]
        out = sm.enrich_with_historic_milestones(feed, history, self.TODAY)
        self.assertEqual({m["id"] for m in out}, {m["id"] for m in feed})

    def test_dupes_are_never_added_and_cap_is_twenty(self):
        feed = [make_milestone(id="new", date="2026-09-10")]
        history = feed + [make_milestone(id=f"h{i}", date="2025-01-01") for i in range(30)]
        out = sm.enrich_with_historic_milestones(feed, history, self.TODAY)
        ids = [m["id"] for m in out]
        self.assertEqual(len(ids), 1 + 20)
        self.assertEqual(len(set(ids)), len(ids))


class _FakeResp:
    def __init__(self, body: bytes):
        self._body = body

    def read(self, n: int = -1) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@contextlib.contextmanager
def _patched_network(fake_open):
    """Swap urlopen AND the retry backoff sleep for deterministic unit tests."""
    orig_open = sm.urllib.request.urlopen
    orig_sleep = sm.time.sleep
    sm.urllib.request.urlopen = fake_open
    sm.time.sleep = lambda seconds: None
    try:
        yield
    finally:
        sm.urllib.request.urlopen = orig_open
        sm.time.sleep = orig_sleep


class TestFetchUpstream(unittest.TestCase):
    def test_success_parses_json(self):
        body = b'{"categories": {"Energy": {"milestones": []}}}'
        calls = {"n": 0}

        def fake_open(req, timeout):
            calls["n"] += 1
            return _FakeResp(body)

        with _patched_network(fake_open):
            out = sm.fetch_upstream("owner/repo", "main")
        self.assertEqual(out, {"categories": {"Energy": {"milestones": []}}})
        self.assertEqual(calls["n"], 1)

    def test_tls_cert_failure_retries_then_returns_none(self):
        # Certificate-verification errors must degrade to the keep-local path
        # (return None), never crash the run with an uncaught ssl error.
        calls = {"n": 0}

        def fake_open(req, timeout):
            calls["n"] += 1
            raise ssl.SSLCertVerificationError("certificate verify failed")

        with _patched_network(fake_open):
            out = sm.fetch_upstream("owner/repo", "main")
        self.assertIsNone(out)
        self.assertEqual(calls["n"], 3)

    def test_socket_timeout_retries_then_returns_none(self):
        calls = {"n": 0}

        def fake_open(req, timeout):
            calls["n"] += 1
            raise TimeoutError("timed out")

        with _patched_network(fake_open):
            out = sm.fetch_upstream("owner/repo", "main")
        self.assertIsNone(out)
        self.assertEqual(calls["n"], 3)

    def test_bad_json_does_not_retry(self):
        calls = {"n": 0}

        def fake_open(req, timeout):
            calls["n"] += 1
            return _FakeResp(b"{not json")

        with _patched_network(fake_open):
            out = sm.fetch_upstream("owner/repo", "main")
        self.assertIsNone(out)
        self.assertEqual(calls["n"], 1)

    def test_invalid_repo_or_branch_rejected_before_network(self):
        calls = {"n": 0}

        def fake_open(req, timeout):
            calls["n"] += 1
            raise AssertionError("must not hit the network")

        with _patched_network(fake_open):
            self.assertIsNone(sm.fetch_upstream("not-a-valid-repo", "main"))
            self.assertIsNone(sm.fetch_upstream("ok/repo", "bad branch!"))
        self.assertEqual(calls["n"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)