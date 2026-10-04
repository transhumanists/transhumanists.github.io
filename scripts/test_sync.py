#!/usr/bin/env python3
"""Self-tests for scripts/sync_milestones.py (stdlib only)."""

from __future__ import annotations

import contextlib
import json
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
            make_milestone(
                id="a",
                date="2026-08-20",
                title="older",
                first_seen="2026-08-20",
                last_seen="2026-08-20",
            ),
            make_milestone(
                id="c",
                date="2026-04-05",
                title="superseded",
                first_seen="2026-04-05",
                last_seen="2026-04-05",
            ),
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
        self.assertEqual(sm.display_category("Spaceflight"), "Spaceflight & Aeronautics")
        self.assertEqual(sm.display_category("Defense"), "Military & Defense")
        # Biotechnology was split and renamed; upstream's old label must fold in.
        self.assertEqual(sm.display_category("Biotechnology"), "Biotechnology & Biohacking")
        self.assertEqual(sm.display_category("Biohacking"), "Biotechnology & Biohacking")
        self.assertEqual(sm.display_category("Logistics"), "Mobility & Logistics")
        self.assertEqual(sm.display_category("Transportation"), "Mobility & Logistics")
        self.assertEqual(sm.display_category("Robotics"), "Robotics & Drones")

    def test_dedupe_buckets_on_the_published_category_not_the_raw_one(self):
        # Regression: the unifier bucketed on the record's raw category while the
        # feed publishes the canonical one, so a pair straddling a rename split
        # across buckets and then published as two records in one category. The
        # Khipu pair survived unification for exactly this reason despite sharing
        # date, value, unit AND article URL.
        upstream = {
            "id": "ms-a",
            "title": "ML-driven Structural Pattern Mining of Inka Khipus",
            "date": "2026-06-30",
            "value": "0.86",
            "unit": "F1 score",
            "category": "Computing & AGI",
            "source": "Open Khipu Repository",
            "url": "http://arxiv.org/abs/2607.00185v1",
            "geolocation": {"lat": -13.5, "lon": -71.9},
        }
        archived = {
            "id": "ms-b",
            "title": "ML pipeline achieves 0.86 F1 classifying Inka khipu provenance",
            "date": "2026-06-30",
            "value": "0.86",
            "unit": "F1 score",
            # The archive keeps whatever label upstream used years ago.
            "category": "Computational Archaeology",
            "source": "Academic researchers (Open Khipu Repository)",
            "url": "http://arxiv.org/abs/2607.00185v1",
            "geolocation": {"lat": -13.5, "lon": -71.9},
        }
        out, changes = sm.unify_duplicate_milestones([upstream, archived])
        self.assertEqual(len(out), 1, f"straddling alias pair was not unified: {changes}")
        self.assertEqual(len(out[0]["sources"]), 2)

    def test_geocoding_prefers_the_article_over_the_publisher(self):
        # A Nature Biotechnology paper from a Stanford lab was being plotted at
        # Nature's London headquarters, because the publisher name is also an
        # institution key and outranked anything the article itself said.
        got = sm.geocode_milestone(
            {
                "source": "Nature Biotechnology",
                "title": "Lipid nanoparticle delivery",
                "summary": "Researchers at Stanford University improved LNP design",
            }
        )
        self.assertIsNotNone(got)
        self.assertNotEqual(
            got[0],
            sm.INSTITUTION_COORDS["nature"]["lat"],
            "publisher headquarters overrode the article content",
        )

    def test_geocoding_falls_back_to_the_publisher_when_the_article_is_silent(self):
        got = sm.geocode_milestone(
            {
                "source": "Nature Biotechnology",
                "title": "New ionizable lipid LC-1",
                "summary": "Screening identified lipid LC-1",
            }
        )
        self.assertEqual(got[0], sm.INSTITUTION_COORDS["nature"]["lat"])

    def test_geocoding_keeps_corporate_anchors_for_corporate_events(self):
        # A SpaceX launch genuinely happens at the SpaceX site, so a publisher
        # anchor is the right answer here rather than a fallback to be avoided.
        got = sm.geocode_milestone(
            {
                "source": "SpaceX",
                "title": "Starship payload to LEO",
                "summary": "A Starship launch from the Texas site",
            }
        )
        self.assertIsNotNone(got)

    def test_geocoding_prefers_the_longest_matching_institution(self):
        # "cornell university" is a more precise claim than "cornell"; a shorter
        # alias must not shadow it by virtue of dictionary order.
        got = sm.geocode_milestone(
            {
                "source": "arXiv preprint",
                "title": "Structural pattern mining",
                "summary": "A Cornell University team reports the result",
            }
        )
        self.assertIsNotNone(got)

    def test_geocoding_returns_none_when_nothing_is_locatable(self):
        self.assertIsNone(
            sm.geocode_milestone(
                {
                    "source": "Unknown",
                    "title": "Nothing locatable",
                    "summary": "",
                }
            )
        )

    def test_every_alias_resolves_to_a_canonical_site_key(self):
        # Guards the invariant the bucket key now depends on: if an alias ever
        # fails to resolve, straddling pairs silently stop merging again.
        for alias in sm.CATEGORY_ALIASES:
            with self.subTest(alias=alias):
                resolved = sm._dedupe_category_key(alias)
                self.assertIn(resolved, sm.SITE_KEY_TO_DISPLAY)


class TestRetentionFeed(unittest.TestCase):
    def test_thin_upstream_never_wipes_feed(self):
        """Collapse regression at the site level: a 3-milestone snapshot
        mirrored after a 40-milestone history must still publish 40."""
        history = [
            make_milestone(id=f"ms-{i}", category="Energy", date="2026-08-01") for i in range(40)
        ]
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
            {
                "id": "ms-b",
                "category": "Spaceflight",
                "subcategory": "launch",
                "title": "Retained launch",
                "date": "2026-08-01",
                "category_key": None,
            },
        ]
        cats = sm.build_site_categories(ms, {})
        self.assertEqual(list(cats.keys()), ["spaceflight"])
        self.assertEqual(cats["spaceflight"]["name"], "Spaceflight & Aeronautics")
        self.assertEqual(
            cats["spaceflight"]["milestones"][0]["category"], "Spaceflight & Aeronautics"
        )


class TestFingerprint(unittest.TestCase):
    def _artifacts(self):
        site_format = {
            "last_update": "2026-09-22T00:00:00",
            "categories": {"energy": {"name": "Energy"}},
        }
        history = [make_milestone(id="ms-a", first_seen="2026-08-01", last_seen="2026-09-22")]
        activity = {"last_update": "2026-09-22T00:00:00", "days": [], "spikes": []}
        events = {"last_update": "2026-09-22T00:00:00", "events": []}
        return site_format, history, activity, events

    def _fp(self, *args):
        return sm.content_fingerprint(*sm.churn_free_view(*args))

    def test_fingerprint_ignores_timestamp_churn(self):
        a = self._artifacts()
        b = self._artifacts()
        b[0]["last_update"] = "2099-01-01T00:00:00"  # milestones last_update
        b[1][0]["last_seen"] = "2099-01-01"  # archive sighting marker
        b[2]["last_update"] = "2099-01-01T00:00:00"  # activity timestamp
        b[3]["last_update"] = "2099-01-01T00:00:00"  # events timestamp
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

    def test_monthly_when_span_very_large(self):
        history = [make_milestone(id="1", date="1980-01-01")]
        activity = sm.build_activity(history, date(2026, 9, 21))
        self.assertEqual(activity["bucket"], "month")
        self.assertEqual(activity["first"], "1980-01-01")
        self.assertEqual(activity["last"], "2026-09-01")
        self.assertEqual(activity["total"], 1)

    def test_yearly_when_span_huge(self):
        history = [make_milestone(id="1", date="1800-01-01")]
        activity = sm.build_activity(history, date(2026, 9, 21))
        self.assertEqual(activity["bucket"], "year")
        self.assertEqual(activity["first"], "1800-01-01")
        self.assertEqual(activity["last"], "2026-01-01")
        self.assertEqual(activity["total"], 1)

    def test_monthly_buckets_are_first_of_month(self):
        history = [
            make_milestone(id="1", date="1980-01-15"),
            make_milestone(id="2", date="1980-01-20"),
            make_milestone(id="3", date="1980-02-01"),
        ]
        activity = sm.build_activity(history, date(2026, 9, 21))
        self.assertEqual(activity["bucket"], "month")
        counts = {d["date"]: d["count"] for d in activity["days"]}
        self.assertEqual(counts["1980-01-01"], 2)
        self.assertEqual(counts["1980-02-01"], 1)

    def test_yearly_buckets_are_jan_first(self):
        history = [
            make_milestone(id="1", date="1800-06-15"),
            make_milestone(id="2", date="1800-12-01"),
            make_milestone(id="3", date="1801-01-01"),
        ]
        activity = sm.build_activity(history, date(2026, 9, 21))
        self.assertEqual(activity["bucket"], "year")
        counts = {d["date"]: d["count"] for d in activity["days"]}
        self.assertEqual(counts["1800-01-01"], 2)
        self.assertEqual(counts["1801-01-01"], 1)


class TestEvents(unittest.TestCase):
    def test_events_mapping(self):
        events = sm.build_events(
            [make_milestone(id="ms-a", category="Energy", value=100, unit="MW")]
        )
        self.assertEqual(events["events"][0]["id"], "ev-ms-a")
        self.assertEqual(events["events"][0]["category"], "Renewable Energy")
        self.assertEqual(events["events"][0]["value"], "100 MW")

    def test_events_keep_an_unlocatable_milestone_instead_of_dropping_it(self):
        # Deleting the record is the wrong answer: it disappears from the feed, the
        # dashboard, the catalog and the metrics, and nothing downstream notices.
        # It is published without a geolocation and the map declines to draw it.
        no_geo = make_milestone(
            id="x",
            geolocation={"lat": 0.0, "lon": 0.0},
            title="Unlocatable result",
            source="Nobody",
        )
        events = sm.build_events([no_geo])["events"]
        self.assertEqual(len(events), 1)
        self.assertNotIn("geolocation", events[0])
        self.assertIs(events[0]["located"], False)
        self.assertEqual(events[0]["title"], "Unlocatable result")

    def test_events_never_emit_null_island(self):
        # (0,0) upstream must never become a coordinate: it is the no-location
        # marker, and it previously published a dot in the Gulf of Guinea.
        no_geo = make_milestone(
            id="x", geolocation={"lat": 0.0, "lon": 0.0}, title="T", source="Nobody"
        )
        for ev in sm.build_events([no_geo])["events"]:
            geo = ev.get("geolocation")
            self.assertFalse(geo and geo["lat"] == 0.0 and geo["lon"] == 0.0)

    def test_events_geocode_from_place_names_in_the_article(self):
        # OSINT cascade: no institution named, but the title says which country.
        m = make_milestone(
            id="ms-mt",
            title="Record-low error rate in Maltese OCR",
            source="LV-ROVER-MLT researchers",
            summary="",
            geolocation={"lat": 0.0, "lon": 0.0},
        )
        events = sm.build_events([m])["events"]
        geo = events[0].get("geolocation")
        self.assertIsNotNone(geo, "place name in the title should have geocoded it")
        self.assertAlmostEqual(geo["lat"], 35.9, places=1)
        self.assertAlmostEqual(geo["lon"], 14.5, places=1)

    def test_events_article_place_beats_publisher_headquarters(self):
        # A paper from a US agency published by Nature must not land in London.
        m = make_milestone(
            id="ms-us",
            title="USCIS adjudication dataset",
            source="Nature Biotechnology",
            summary="",
            geolocation={"lat": 0.0, "lon": 0.0},
        )
        geo = sm.build_events([m])["events"][0].get("geolocation")
        self.assertIsNotNone(geo)
        self.assertNotAlmostEqual(geo["lon"], -0.1278, places=1)

    def test_events_value_uses_title_when_no_metric(self):
        m = make_milestone(
            id="ms-1",
            value=None,
            unit=None,
            category="Energy",
            title="Fusion milestone",
            summary="A milestone info string about fusion.",
        )
        events = sm.build_events([m])
        self.assertEqual(events["events"][0]["value"], "Fusion milestone")

    def test_events_value_keeps_metric_when_present(self):
        m = make_milestone(id="ms-2", value=100, unit="MW", category="Energy")
        events = sm.build_events([m])
        self.assertEqual(events["events"][0]["value"], "100 MW")


class TestUnifyDuplicateMilestones(unittest.TestCase):
    """The same result reported by several sources becomes one milestone."""

    def _m(self, mid, title, **over):
        rec = {
            "id": mid,
            "title": title,
            "summary": "",
            "category": "Computing & AGI",
            "category_key": "computing_agi",
            "value": "0.86",
            "unit": "F1 score",
            "source": "Open Khipu Repository",
            "date": "2026-06-30",
            "url": "https://example.com/a",
            "geolocation": {"lat": -13.5, "lon": -71.9},
        }
        rec.update(over)
        return rec

    def test_same_result_from_two_sources_is_unified_with_both_named(self):
        a = self._m("ms-1", "ML-driven Structural Pattern Mining of Inka Khipus")
        b = self._m(
            "ms-2",
            "ML pipeline achieves 0.86 F1 classifying Inka khipu provenance",
            source="Academic researchers",
            url="https://example.com/b",
        )
        out, changes = sm.unify_duplicate_milestones([a, b])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["sources"], ["Open Khipu Repository", "Academic researchers"])
        self.assertTrue(any("unified 2 records" in c for c in changes))

    def test_shared_url_alone_is_not_enough(self):
        # Two distinct IBM milestones are described in the same Wikipedia article.
        # A shared url must never merge them.
        a = self._m(
            "q1",
            "IBM Condor - the first 1,000+ qubit processor",
            category="Quantum Physics",
            category_key="quantum",
            value="1121",
            unit="qubits",
            date="2023-12-04",
            url="https://en.wikipedia.org/wiki/IBM_Q_System_One",
        )
        b = self._m(
            "q2",
            "IBM Eagle - the first 127-qubit processor",
            category="Quantum Physics",
            category_key="quantum",
            value="127",
            unit="qubits",
            date="2023-12-01",
            url="https://en.wikipedia.org/wiki/IBM_Q_System_One",
        )
        out, _ = sm.unify_duplicate_milestones([a, b])
        self.assertEqual(len(out), 2)

    def test_identical_metric_on_different_dates_is_not_merged(self):
        # "100 qubits" and similar recur constantly; the date is part of the key.
        a = self._m("z1", "Rigetti 100 qubit processor", date="2021-01-01")
        b = self._m("z2", "Rigetti 100 qubit processor", date="2023-01-01")
        out, _ = sm.unify_duplicate_milestones([a, b])
        self.assertEqual(len(out), 2)

    def test_identical_metric_in_different_categories_is_not_merged(self):
        a = self._m("c1", "0.86 F1 khipu result")
        b = self._m(
            "c2", "0.86 F1 khipu result", category="Biotechnology", category_key="biotechnology"
        )
        out, _ = sm.unify_duplicate_milestones([a, b])
        self.assertEqual(len(out), 2)

    def test_shared_value_with_unrelated_titles_is_not_merged(self):
        # Same date/value/unit/category but nothing in common: a coincidence, not
        # the same report. The title-token guard is what stops this.
        a = self._m("u1", "Alpha protein folding benchmark", url="https://a.example")
        b = self._m("u2", "Beta solar cell efficiency record", url="https://b.example")
        out, _ = sm.unify_duplicate_milestones([a, b])
        self.assertEqual(len(out), 2)

    def test_numeric_and_string_spellings_of_one_value_collapse(self):
        a = self._m("n1", "Khipu mining result", value=0.86)
        b = self._m("n2", "Khipu mining result reported", value="0.860")
        out, _ = sm.unify_duplicate_milestones([a, b])
        self.assertEqual(len(out), 1)

    def test_metricless_records_are_left_untouched_and_included(self):
        a = self._m("m1", "Qualitative note one", value=None, unit=None)
        b = self._m("m2", "Qualitative note two", value=None, unit=None)
        out, changes = sm.unify_duplicate_milestones([a, b])
        self.assertEqual(len(out), 2)
        self.assertEqual(changes, [])
        # No `sources` key is invented for a single-source record.
        self.assertNotIn("sources", out[0])

    def test_single_source_record_keeps_its_original_shape(self):
        a = self._m("s1", "Khipu mining result")
        b = self._m("s2", "Unrelated solar record", value="41.2", unit="%")
        out, _ = sm.unify_duplicate_milestones([a, b])
        for rec in out:
            self.assertNotIn("sources", rec)

    def test_richest_summary_wins_and_selection_is_deterministic(self):
        a = self._m("d1", "Khipu mining result", summary="")
        b = self._m(
            "d2",
            "Khipu mining result restated",
            summary="A considerably longer and more informative summary.",
        )
        first, _ = sm.unify_duplicate_milestones([a, b])
        second, _ = sm.unify_duplicate_milestones([b, a])
        # Same winner regardless of input order, so the commit fingerprint is stable.
        self.assertEqual(first[0]["id"], second[0]["id"])
        self.assertEqual(first[0]["id"], "d2")

    def test_unification_does_not_mutate_its_input(self):
        a = self._m("i1", "Khipu mining result")
        b = self._m("i2", "Khipu mining result restated", source="Other source")
        before = json.dumps([a, b], sort_keys=True)
        sm.unify_duplicate_milestones([a, b])
        self.assertEqual(json.dumps([a, b], sort_keys=True), before)

    def test_unification_preserves_input_order(self):
        # merge_feed() sorts newest-first and both build_site_categories() and
        # build_events() propagate list order into the published files, so this
        # function must not regroup. An earlier version bucketed by metric key and
        # appended the metric-less records at the end, which silently unsorted the
        # feed: the newest milestone ended up buried mid-list.
        ordered = [
            self._m("o1", "Newest khipu result", date="2026-06-30"),
            self._m("o2", "Second result", date="2026-05-01", value="1.5", unit="x"),
            self._m("o3", "Third khipu restatement", date="2026-06-30"),
            self._m("o4", "Metricless note", value=None, unit=None, date="2026-04-01"),
        ]
        out, _ = sm.unify_duplicate_milestones(ordered)
        self.assertEqual(
            [r["id"] for r in out],
            ["o1", "o2", "o4"],
            "merged record must appear at its first member's position",
        )

    def test_merged_record_is_not_duplicated_in_output(self):
        # The rest of a merged cluster must be dropped, not emitted alongside the
        # survivor (which would silently restore the duplicate).
        a = self._m("k1", "Khipu mining result")
        b = self._m("k2", "Khipu mining result restated", source="Other source")
        c = self._m("k3", "Khipu mining result third source", source="Third source")
        out, _ = sm.unify_duplicate_milestones([a, b, c])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["id"], "k1")
        self.assertEqual(len(out[0]["sources"]), 3)
        ids = [r["id"] for r in out]
        self.assertEqual(len(ids), len(set(ids)))

    def test_shipped_feed_stays_newest_first_after_unification(self):
        # End-to-end guard on the real artifacts: the published event list must
        # still be date-descending once the dedupe step is in the path.
        path = Path(__file__).resolve().parent.parent / "data" / "milestones.json"
        if not path.exists():
            self.skipTest("data/milestones.json not present")
        upstream = json.loads(path.read_text(encoding="utf-8"))
        site = sm.transform_upstream_to_site_format(upstream)
        current = sm.iter_milestones(site)
        history = sm.merge_history([], current, "2026-10-01")
        feed = sm.merge_feed(current, history)
        self.assertEqual(
            [r.get("date") for r in feed],
            sorted((r.get("date") for r in feed), reverse=True),
            "merge_feed must hand unify_duplicate_milestones a sorted feed",
        )
        unified, _ = sm.unify_duplicate_milestones(feed)
        dates = [r.get("date") for r in unified]
        self.assertEqual(dates, sorted(dates, reverse=True), "unification reordered the feed")

    def test_published_data_has_no_duplicate_reports_left(self):
        # Regression guard on the real published feed, not just fixtures.
        path = Path(__file__).resolve().parent.parent / "data" / "milestones.json"
        if not path.exists():
            self.skipTest("data/milestones.json not present")
        site = sm.transform_upstream_to_site_format(json.loads(path.read_text(encoding="utf-8")))
        unified, changes = sm.unify_duplicate_milestones(sm.iter_milestones(site))
        # Running it again over its own output must be a fixed point.
        again, again_changes = sm.unify_duplicate_milestones(unified)
        self.assertEqual(len(unified), len(again))
        self.assertEqual(again_changes, [])


class TestCategoryAliases(unittest.TestCase):
    """Legacy upstream names fold into a canonical category.

    The site has no "Other" bucket, so every milestone must land in one of the
    seven canonical categories that owns a colour, a legend row and a filter.
    """

    def test_every_alias_target_is_canonical(self):
        for alias, canonical in sm.CATEGORY_ALIASES.items():
            with self.subTest(alias=alias):
                self.assertIn(canonical, sm.SITE_KEY_TO_DISPLAY.values())

    def test_alias_resolves_from_display_name_and_snake_case(self):
        for alias, canonical in sm.CATEGORY_ALIASES.items():
            key = sm.DISPLAY_TO_SITE_KEY[canonical]
            with self.subTest(alias=alias):
                self.assertEqual(sm.UPSTREAM_TO_SITE_KEY[alias], key)
                self.assertEqual(sm.UPSTREAM_TO_SITE_KEY[sm.slugify(alias)], key)
                self.assertEqual(sm.display_category(alias), canonical)

    def test_alias_buckets_merge_into_the_canonical_bucket(self):
        upstream = {
            "categories": {
                "Mathematics": {
                    "name": "Mathematics",
                    "subcategories": ["graph_theory"],
                    "milestones": [make_milestone(id="ms-math")],
                },
                "Quantum Gravity": {
                    "name": "Quantum Gravity",
                    "subcategories": [],
                    "milestones": [make_milestone(id="ms-qg")],
                },
                "Quantum Physics": {
                    "name": "Quantum Physics",
                    "subcategories": ["error_correction"],
                    "milestones": [make_milestone(id="ms-qp")],
                },
            }
        }
        cats = sm.transform_upstream_to_site_format(upstream)["categories"]
        # Alias buckets are gone, and no milestone was lost on the way.
        self.assertEqual(sorted(cats), ["computing_agi", "quantum"])
        self.assertEqual({m["id"] for m in cats["quantum"]["milestones"]}, {"ms-qg", "ms-qp"})
        self.assertEqual([m["id"] for m in cats["computing_agi"]["milestones"]], ["ms-math"])

    def test_merge_unions_subcategories_without_duplicates(self):
        upstream = {
            "categories": {
                "Computer Vision": {
                    "name": "Computer Vision",
                    "subcategories": ["ocr", "shared"],
                    "milestones": [make_milestone(id="ms-cv")],
                },
                "Computing & AGI": {
                    "name": "Computing & AGI",
                    "subcategories": ["shared", "benchmarks"],
                    "milestones": [make_milestone(id="ms-agi")],
                },
            }
        }
        bucket = sm.transform_upstream_to_site_format(upstream)["categories"]["computing_agi"]
        self.assertEqual(sorted(bucket["subcategories"]), ["benchmarks", "ocr", "shared"])

    def test_merged_bucket_keeps_canonical_name_and_metadata(self):
        upstream = {
            "categories": {
                "Legal AI": {
                    "name": "Legal AI",
                    "icon": "x",
                    "color": "#ffffff",
                    "subcategories": ["legal_datasets"],
                    "milestones": [make_milestone(id="ms-1")],
                },
                "computing_agi": {
                    "name": "Computing & AGI",
                    "icon": "ai",
                    "color": "#ff0066",
                    "subcategories": ["agents"],
                    "milestones": [make_milestone(id="ms-2")],
                },
            }
        }
        bucket = sm.transform_upstream_to_site_format(upstream)["categories"]["computing_agi"]
        self.assertEqual(bucket["name"], "Computing & AGI")
        self.assertEqual(bucket["icon"], "ai")
        self.assertEqual(bucket["color"], "#ff0066")

    def test_published_records_are_canonicalised(self):
        out = sm.build_site_categories([make_milestone(id="a", category="Mathematics")], {})
        self.assertEqual(out["computing_agi"]["milestones"][0]["category"], "Computing & AGI")
        self.assertEqual(out["computing_agi"]["name"], "Computing & AGI")

    def test_build_site_categories_does_not_mutate_input(self):
        source = make_milestone(id="a", category="Quantum Gravity")
        snapshot = json.dumps(source, sort_keys=True)
        sm.build_site_categories([source], {})
        self.assertEqual(json.dumps(source, sort_keys=True), snapshot)


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
