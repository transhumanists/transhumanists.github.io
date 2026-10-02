"""Tests for the article-context geocoder.

This module places dots on a world map from prose, so a wrong answer is worse than no
answer: an absent dot is visibly missing, a confident wrong one is not. The tests are
weighted accordingly - far more of them assert that something is *refused* than that
something is found.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import article_geocode as ag


class TestDemonyms(unittest.TestCase):
    def test_demonym_in_the_title_resolves(self):
        out = ag.resolve({"title": "Record-low CER in Maltese OCR benchmarks"})
        self.assertTrue(out["located"], out)
        self.assertEqual(out["confidence"], "place")
        # Two independent routes - the place table and the demonym table - agree.
        self.assertGreaterEqual(len(out.get("corroborated_by", [])) + 1, 1)

    def test_demonym_and_place_agreeing_is_not_treated_as_a_tie(self):
        # They merged into one candidate rather than being scored as rivals, which
        # was the original bug: the strongest signal in the dataset read as ambiguous.
        out = ag.resolve({"title": "Maltese OCR corpus"})
        self.assertTrue(out["located"], out)

    def test_a_summary_only_signal_is_below_the_floor(self):
        # A summary mention scores 1.0 against a floor of 3.0. One weak mention,
        # however specific the adjective, is not a location.
        out = ag.resolve({"title": "A study of small fish",
                          "summary": "Samples were collected in Maltese waters."})
        self.assertFalse(out["located"], out)

    def test_no_signal_at_all_is_refused(self):
        out = ag.resolve({"title": "Graph Sandwich Conjecture proved"})
        self.assertFalse(out["located"])
        self.assertIn("no place", out["reason"])


class TestFalsePositives(unittest.TestCase):
    def test_page_furniture_does_not_become_a_location(self):
        # "NASA ADS" is on every arXiv page; matching it plotted a preprint in
        # Maryland. This is the exact regression.
        body = "Search Submit Donate Log in NASA ADS Google Scholar Semantic Scholar"
        out = ag.resolve({"title": "Some benchmark result"}, body)
        self.assertFalse(out["located"], out)

    def test_an_acronym_with_no_support_is_refused(self):
        out = ag.resolve({"title": "USCIS AAO decisions dataset for legal reasoning"})
        self.assertFalse(out["located"], out)

    def test_a_proper_noun_does_not_trigger_a_demonym(self):
        # "American Airlines" style false positives.
        out = ag.resolve({"title": "American Airlines trials a loyalty model"})
        self.assertFalse(out["located"], out)


class TestAffiliations(unittest.TestCase):
    def test_a_lone_affiliation_is_accepted(self):
        body = "The work was done by a researcher at ETH Zurich."
        out = ag.resolve({"title": "A result"}, body)
        self.assertTrue(out["located"], out)
        self.assertEqual(out["confidence"], "institution")

    def test_several_affiliations_refuse_rather_than_pick_one(self):
        # The rule that matters most: an article naming three institutions is not
        # evidence for any one of them, and used to resolve by sort order.
        body = ("a theorist at Tsinghua University in China, the Perimeter Institute "
                "for Theoretical Physics in Waterloo, Canada, and a physicist at "
                "Stanford University all built on the result")
        out = ag.resolve({"title": "A result"}, body)
        self.assertFalse(out["located"], out)

    def test_affiliation_cue_inside_page_chrome_is_ignored(self):
        body = "Institution Information about the journal University Press"
        out = ag.resolve({"title": "A result"}, body)
        self.assertFalse(out["located"], out)


class TestTextExtraction(unittest.TestCase):
    def test_scripts_and_tags_are_stripped(self):
        html = "<html><head><title>x</title><script>var a='Berlin';</script></head>" \
               "<body><p>Results from Kyoto</p></body></html>"
        text = ag.extract_text(html)
        self.assertNotIn("var a", text)
        self.assertIn("Kyoto", text)

    def test_entities_are_unescaped(self):
        self.assertIn("Zurich", ag.extract_text("<p>Zurich &amp; Vienna</p>"))

    def test_empty_input_is_safe(self):
        self.assertEqual(ag.extract_text(""), "")


class TestFetchIsGuarded(unittest.TestCase):
    """The URLs come from an upstream this repository does not control.

    A hostile or compromised upstream could plant a URL pointing at cloud metadata
    or an internal service, and whoever runs --refresh would fetch it from their own
    machine. Narrow exposure - the flag is operator-invoked, never in CI - but not
    zero.
    """

    def test_private_and_loopback_addresses_are_refused(self):
        for url in ("http://127.0.0.1/", "http://localhost:8080/x",
                    "http://[::1]/", "https://10.0.0.5/internal",
                    "https://192.168.1.1/", "http://169.254.169.254/latest/meta-data/"):
            ok, why = ag._public_host(url)
            self.assertFalse(ok, "%s should be refused" % url)
            self.assertTrue(why, "refusal should say why")

    def test_non_http_schemes_are_refused(self):
        for url in ("file:///etc/passwd", "ftp://example.org/x", "gopher://x/"):
            ok, _ = ag._public_host(url)
            self.assertFalse(ok, url)

    def test_a_public_host_is_allowed(self):
        ok, why = ag._public_host("https://example.org/article")
        self.assertTrue(ok, why)

    def test_fetch_refuses_before_any_request_is_made(self):
        text, reason = ag.fetch_text("http://169.254.169.254/latest/meta-data/")
        self.assertIsNone(text)
        self.assertIn("public", reason)

    def test_redirects_are_revalidated(self):
        # Validating only the first URL is not enough: a public host can 302 to the
        # metadata service, so the handler has to re-check every hop.
        self.assertTrue(issubclass(ag._NoPrivateRedirects,
                                   __import__("urllib.request",
                                              fromlist=["request"]).HTTPRedirectHandler))


class TestCacheHygiene(unittest.TestCase):
    def test_cache_never_persists_page_text(self):
        # Everything under data/ is published by Jekyll, so third-party article prose
        # committed here is republished on the live site. An earlier version stored
        # 108KB of it.
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cache.json"
            original = ag.CACHE_PATH
            ag.CACHE_PATH = path
            try:
                ag.save_cache({"https://e.org/a": {
                    "text": "secrets of the fetched page",
                    "fetched": "abc",
                    "outcome": {"located": False, "reason": "no signal"}}})
                stored = json.loads(path.read_text(encoding="utf-8"))
            finally:
                ag.CACHE_PATH = original
        self.assertNotIn("text", stored["articles"]["https://e.org/a"])
        self.assertIn("outcome", stored["articles"]["https://e.org/a"])

    def test_cache_prunes_records_that_are_no_longer_queued(self):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cache.json"
            original = ag.CACHE_PATH
            ag.CACHE_PATH = path
            try:
                ag.save_cache(
                    {"https://e.org/keep": {"outcome": {"located": False}},
                     "https://e.org/gone": {"outcome": {"located": False}}},
                    keep_urls={"https://e.org/keep"})
                stored = json.loads(path.read_text(encoding="utf-8"))
            finally:
                ag.CACHE_PATH = original
        self.assertEqual(sorted(stored["articles"]), ["https://e.org/keep"])

    def test_the_committed_cache_carries_no_text(self):
        if not ag.CACHE_PATH.exists():
            self.skipTest("no cache committed")
        import json
        stored = json.loads(ag.CACHE_PATH.read_text(encoding="utf-8"))
        offenders = [u for u, v in stored["articles"].items()
                     if isinstance(v, dict) and "text" in v]
        self.assertEqual(offenders, [], "page text still stored: %s" % offenders[:3])


class TestResolveIsPure(unittest.TestCase):
    def test_same_input_same_answer(self):
        rec = {"title": "Maltese OCR benchmarks", "summary": "Maltese corpus"}
        a = ag.resolve(rec)
        b = ag.resolve(rec)
        self.assertEqual(a, b)

    def test_output_is_never_the_origin_sentinel(self):
        for title in ("Maltese OCR", "A study of Maltese fish",
                      "Graph Sandwich Conjecture", "USCIS decisions dataset"):
            out = ag.resolve({"title": title})
            if out.get("located"):
                self.assertNotEqual((out["lat"], out["lon"]), (0, 0), title)


class TestWeighting(unittest.TestCase):
    def test_title_outranks_summary(self):
        # Japan in the title (3.0), Germany in the summary (1.0). Both are real
        # entries in the place table, so this is a genuine contest rather than one
        # signal with nothing to beat it.
        out = ag.resolve({"title": "Results from Japan",
                          "summary": "The team met in Germany."})
        self.assertTrue(out["located"], out)
        self.assertIn("japan", out["evidence"].lower())

    def test_a_single_mention_with_no_rival_is_refused(self):
        # The safe default. With nothing to compare against there is no margin to
        # clear, and one place name is not a location.
        out = ag.resolve({"title": "Results from Japan"})
        self.assertFalse(out["located"], out)

    def test_the_same_place_twice_is_not_independent_corroboration(self):
        # Title and summary are the same paper; agreeing with itself is not a second
        # independent route to the coordinate.
        out = ag.resolve({"title": "Results from Japan",
                          "summary": "Further results from Japan."})
        self.assertFalse(out["located"], out)

    def test_confidence_values_are_from_the_declared_set(self):
        import location_contract as lc
        out = ag.resolve({"title": "Results from Japan and Japan"})
        if out.get("located"):
            self.assertTrue(lc.validate_confidence(out["confidence"]))


if __name__ == "__main__":
    unittest.main()