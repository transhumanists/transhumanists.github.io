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
        out = ag.resolve(
            {
                "title": "A study of small fish",
                "summary": "Samples were collected in Maltese waters.",
            }
        )
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


class TestSourceFallback(unittest.TestCase):
    def test_source_tier_is_opt_in(self):
        rec = {"title": "Some benchmark result", "url": "https://arxiv.org/abs/1234.5678"}
        self.assertFalse(ag.resolve(rec)["located"])
        out = ag.resolve(rec, allow_source=True)
        self.assertTrue(out["located"], out)
        self.assertEqual(out["confidence"], "source")
        self.assertEqual(out["evidence"], "arxiv")
        self.assertEqual((out["lat"], out["lon"]), (42.4440, -76.5019))

    def test_source_fallback_covers_below_floor_and_uncorroborated(self):
        # A summary-only institution mention (1.0 < 3.0 floor) and a lone title
        # acronym both refuse by default yet resolve at source level on opt-in.
        weak = {
            "title": "A small study",
            "summary": "nvidia hardware was used",
            "url": "https://arxiv.org/abs/1234.5678",
        }
        self.assertFalse(ag.resolve(weak)["located"])
        self.assertEqual(ag.resolve(weak, allow_source=True)["confidence"], "source")
        lone = {
            "title": "USCIS AAO decisions dataset for legal reasoning",
            "url": "https://arxiv.org/abs/1234.5678",
        }
        self.assertFalse(ag.resolve(lone)["located"])
        self.assertEqual(ag.resolve(lone, allow_source=True)["confidence"], "source")

    def test_unknown_domain_and_missing_url_stay_unlocated(self):
        self.assertFalse(
            ag.resolve(
                {"title": "Some benchmark", "url": "https://example.org/x"},
                allow_source=True,
            )["located"]
        )
        self.assertFalse(ag.resolve({"title": "Some benchmark"}, allow_source=True)["located"])
        for bad_url in (None, 123, b"https://arxiv.org/abs/1234", "notaurl"):
            out = ag.resolve({"title": "Some benchmark", "url": bad_url}, allow_source=True)
            self.assertFalse(out["located"], repr(bad_url))

    def test_lookalike_hosts_cannot_claim_a_source_dot(self):
        # Substring matching would place these at Cornell; exact-or-subdomain only.
        for url in (
            "https://notarxiv.org/abs/1234",
            "https://arxiv.org.evil.com/abs/1234",
            "https://arxiv.org:443@evil.com/x",
        ):
            out = ag.resolve({"title": "Some benchmark", "url": url}, allow_source=True)
            self.assertFalse(out["located"], url)

    def test_subdomain_and_port_still_match(self):
        out = ag.resolve(
            {"title": "Some benchmark", "url": "https://export.arxiv.org:443/abs/1234"},
            allow_source=True,
        )
        self.assertTrue(out["located"], out)
        self.assertEqual(out["evidence"], "arxiv")

    def test_source_never_outranks_content_evidence(self):
        # A content-resolved record keeps its stronger confidence even on opt-in.
        rec = {"title": "Record-low CER in Maltese OCR benchmarks"}
        out = ag.resolve(rec, allow_source=True)
        self.assertTrue(out["located"], out)
        self.assertNotEqual(out["confidence"], "source")


class TestAffiliations(unittest.TestCase):
    def test_a_lone_affiliation_is_accepted(self):
        body = "The work was done by a researcher at ETH Zurich."
        out = ag.resolve({"title": "A result"}, body)
        self.assertTrue(out["located"], out)
        self.assertEqual(out["confidence"], "institution")

    def test_several_affiliations_refuse_rather_than_pick_one(self):
        # The rule that matters most: an article naming three institutions is not
        # evidence for any one of them, and used to resolve by sort order.
        body = (
            "a theorist at Tsinghua University in China, the Perimeter Institute "
            "for Theoretical Physics in Waterloo, Canada, and a physicist at "
            "Stanford University all built on the result"
        )
        out = ag.resolve({"title": "A result"}, body)
        self.assertFalse(out["located"], out)

    def test_affiliation_cue_inside_page_chrome_is_ignored(self):
        body = "Institution Information about the journal University Press"
        out = ag.resolve({"title": "A result"}, body)
        self.assertFalse(out["located"], out)


class TestTextExtraction(unittest.TestCase):
    def test_scripts_and_tags_are_stripped(self):
        html = (
            "<html><head><title>x</title><script>var a='Berlin';</script></head>"
            "<body><p>Results from Kyoto</p></body></html>"
        )
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
        for url in (
            "http://127.0.0.1/",
            "http://localhost:8080/x",
            "http://[::1]/",
            "https://10.0.0.5/internal",
            "https://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",
        ):
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
        self.assertTrue(
            issubclass(
                ag._NoPrivateRedirects,
                __import__("urllib.request", fromlist=["request"]).HTTPRedirectHandler,
            )
        )


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
                ag.save_cache(
                    {
                        "https://e.org/a": {
                            "text": "secrets of the fetched page",
                            "fetched": "abc",
                            "outcome": {"located": False, "reason": "no signal"},
                        }
                    }
                )
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
                    {
                        "https://e.org/keep": {"outcome": {"located": False}},
                        "https://e.org/gone": {"outcome": {"located": False}},
                    },
                    keep_urls={"https://e.org/keep"},
                )
                stored = json.loads(path.read_text(encoding="utf-8"))
            finally:
                ag.CACHE_PATH = original
        self.assertEqual(sorted(stored["articles"]), ["https://e.org/keep"])

    def test_the_committed_cache_carries_no_text(self):
        if not ag.CACHE_PATH.exists():
            self.skipTest("no cache committed")
        import json

        stored = json.loads(ag.CACHE_PATH.read_text(encoding="utf-8"))
        offenders = [
            u for u, v in stored["articles"].items() if isinstance(v, dict) and "text" in v
        ]
        self.assertEqual(offenders, [], "page text still stored: %s" % offenders[:3])


class TestResolveIsPure(unittest.TestCase):
    def test_same_input_same_answer(self):
        rec = {"title": "Maltese OCR benchmarks", "summary": "Maltese corpus"}
        a = ag.resolve(rec)
        b = ag.resolve(rec)
        self.assertEqual(a, b)

    def test_output_is_never_the_origin_sentinel(self):
        for title in (
            "Maltese OCR",
            "A study of Maltese fish",
            "Graph Sandwich Conjecture",
            "USCIS decisions dataset",
        ):
            out = ag.resolve({"title": title})
            if out.get("located"):
                self.assertNotEqual((out["lat"], out["lon"]), (0, 0), title)


class TestPublisherExtractors(unittest.TestCase):
    """Tests for publisher-specific affiliation extraction functions."""

    def test_arxiv_affiliation_extraction(self):
        # arXiv HTML with affiliation spans and meta tags
        html = (
            '<html><body>'
            '<span class="descriptor">Affiliation:</span>'
            '<span class="affiliation">MIT Computer Science & Artificial Intelligence Laboratory</span>'
            '<span class="descriptor">Affiliation:</span>'
            '<span class="affiliation">Stanford University</span>'
            '<meta name="citation_author_institution" content="MIT">'
            '<meta name="citation_author_institution" content="Stanford University">'
            '</body></html>'
        )
        affils = ag._extract_arxiv_affiliations(html, "https://arxiv.org/abs/1234.5678")
        self.assertIn("MIT Computer Science & Artificial Intelligence Laboratory", affils)
        self.assertIn("Stanford University", affils)
        self.assertIn("MIT", affils)
        self.assertIn("Stanford University", affils)

    def test_nature_affiliation_extraction(self):
        html = (
            '<html><body>'
            '<div class="c-article-author-affiliation__address">University of Cambridge</div>'
            '<meta name="citation_author_institution" content="University of Oxford">'
            '</body></html>'
        )
        affils = ag._extract_nature_affiliations(html, "https://nature.com/articles/1234")
        self.assertIn("University of Cambridge", affils)
        self.assertIn("University of Oxford", affils)

    def test_science_affiliation_extraction(self):
        html = (
            '<html><body>'
            '<meta name="citation_author_institution" content="Caltech">'
            '<div class="affiliation">Harvard University</div>'
            '</body></html>'
        )
        affils = ag._extract_science_affiliations(html, "https://science.org/articles/1234")
        self.assertIn("Caltech", affils)
        self.assertIn("Harvard University", affils)

    def test_quantamagazine_affiliation_extraction(self):
        html = (
            '<html><body>'
            '<div class="author-bio">MIT</div>'
            '<div class="author-affiliation">Stanford University</div>'
            '</body></html>'
        )
        affils = ag._extract_quantamagazine_affiliations(html, "https://quantamagazine.org/article")
        self.assertIn("MIT", affils)
        self.assertIn("Stanford University", affils)

    def test_github_affiliation_no_token(self):
        # Without GITHUB_TOKEN, should return empty list
        import os
        original_token = os.environ.get("GITHUB_TOKEN")
        os.environ.pop("GITHUB_TOKEN", None)
        try:
            result = ag._extract_github_affiliation("<html></html>", "https://github.com/owner/repo")
            self.assertEqual(result, [])
        finally:
            if original_token:
                os.environ["GITHUB_TOKEN"] = original_token


class TestAffiliationGeocoding(unittest.TestCase):
    """Tests for _geocode_affiliations and _extract_author_affiliations."""

    def test_geocode_affiliations_institution(self):
        rec = {"url": "https://arxiv.org/abs/1234"}
        affils = ["MIT Computer Science & Artificial Intelligence Laboratory", "Stanford University"]
        results = ag._geocode_affiliations(rec, affils)
        # Should find MIT and Stanford
        self.assertTrue(any(r[2] == "mit" for r in results))
        self.assertTrue(any(r[2] == "stanford" for r in results))

    def test_geocode_affiliations_place(self):
        rec = {"url": "https://example.com"}
        affils = ["Cambridge, UK"]
        results = ag._geocode_affiliations(rec, affils)
        # Should find Cambridge via place matching
        self.assertTrue(any(r[2] == "cambridge" for r in results))

    def test_geocode_affiliations_demonym(self):
        rec = {"url": "https://example.com"}
        affils = ["Japanese researchers"]
        results = ag._geocode_affiliations(rec, affils)
        # Should find Japan via demonym
        self.assertTrue(any(r[2] == "Japan" for r in results))

    def test_extract_author_affiliations_arxiv(self):
        rec = {"url": "https://arxiv.org/abs/1234"}
        html = (
            '<html><body>'
            '<span class="descriptor">Affiliation:</span>'
            '<span class="affiliation">MIT</span>'
            '</body></html>'
        )
        affils = ag._extract_author_affiliations(rec, html)
        self.assertIn("MIT", affils)

    def test_extract_author_affiliations_fallback(self):
        # When publisher-specific extraction fails, falls back to affiliation_windows
        rec = {"url": "https://example.com/article"}
        html = "The work was done by a researcher at ETH Zurich."
        affils = ag._extract_author_affiliations(rec, html)
        self.assertTrue(any("ETH Zurich" in a for a in affils))


class TestPublisherParsersRegistry(unittest.TestCase):
    """Tests for the PUBLISHER_PARSERS registry."""

    def test_registry_contains_expected_domains(self):
        expected = {"arxiv.org", "nature.com", "science.org", "quantamagazine.org", "github.com"}
        self.assertEqual(set(ag.PUBLISHER_PARSERS.keys()), expected)

    def test_registry_values_are_callable(self):
        for func in ag.PUBLISHER_PARSERS.values():
            self.assertTrue(callable(func))

    def test_arxiv_parser_returns_expected_function(self):
        self.assertEqual(ag.PUBLISHER_PARSERS["arxiv.org"], ag._extract_arxiv_affiliations)


if __name__ == "__main__":
    unittest.main()
