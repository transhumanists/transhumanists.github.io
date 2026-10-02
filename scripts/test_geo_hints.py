"""Tests for scripts/geo_hints.py, the shared place-name table.

Two callers geocode from this table (the milestone pipeline and the human-rights
fetcher). Its first copy carried five duplicate dict keys, which Python silently
collapsed - the kind of defect that survives review and never shows up in
production. The duplicate check below exists so that cannot happen again.
"""

from __future__ import annotations

import ast
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

import geo_hints


class TestTableIntegrity(unittest.TestCase):
    """Structural guarantees about the table itself."""

    def _place_dict_node(self):
        tree = ast.parse((ROOT / "scripts" / "geo_hints.py").read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            # PLACE_COORDS is an annotated assignment, but tolerate a plain one.
            if isinstance(node, ast.AnnAssign):
                if getattr(node.target, "id", None) == "PLACE_COORDS":
                    return node.value
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if getattr(target, "id", None) == "PLACE_COORDS":
                        return node.value
        self.fail("PLACE_COORDS assignment not found")

    def test_no_duplicate_keys(self):
        # A repeated key is silently dropped by Python, so the two copies could
        # disagree about a country's coordinates with no error anywhere.
        node = self._place_dict_node()
        keys = [k.value for k in node.keys
                if isinstance(k, ast.Constant) and isinstance(k.value, str)]
        duplicates = {k for k in keys if keys.count(k) > 1}
        self.assertEqual(duplicates, set(), f"duplicate place keys: {sorted(duplicates)}")

    def test_no_entry_is_null_island(self):
        # (0,0) is the project's no-location marker; a hint returning it would
        # publish a dot in the Gulf of Guinea.
        for name, (lat, lon, _region) in geo_hints.PLACE_COORDS.items():
            with self.subTest(name=name):
                self.assertFalse(lat == 0.0 and lon == 0.0)

    def test_coordinates_are_in_range(self):
        for name, (lat, lon, _region) in geo_hints.PLACE_COORDS.items():
            with self.subTest(name=name):
                self.assertTrue(-90 <= lat <= 90, name)
                self.assertTrue(-180 <= lon <= 180, name)

    def test_every_entry_has_a_region(self):
        for name, (_lat, _lon, region) in geo_hints.PLACE_COORDS.items():
            with self.subTest(name=name):
                self.assertIsInstance(region, str)
                self.assertTrue(region.strip())

    def test_keys_are_normalised_for_case_insensitive_matching(self):
        for name in geo_hints.PLACE_COORDS:
            with self.subTest(name=name):
                self.assertEqual(name, name.lower())
                self.assertEqual(name, name.strip())

    def test_table_is_not_trivially_small(self):
        self.assertGreater(len(geo_hints.PLACE_COORDS), 100)


class TestMatchPlace(unittest.TestCase):
    def test_matches_a_country(self):
        self.assertEqual(geo_hints.match_place("a result from Japan")[0], "japan")

    def test_is_case_insensitive(self):
        self.assertEqual(geo_hints.match_place("A RESULT FROM JAPAN")[0], "japan")

    def test_longest_name_wins(self):
        # "democratic republic of the congo" must beat the "congo" prefix.
        self.assertEqual(
            geo_hints.match_place("report from the democratic republic of the congo")[0],
            "democratic republic of the congo")

    def test_word_boundaries_prevent_substring_false_positives(self):
        # "india" inside "reimagining" is the failure mode that put an LLM
        # benchmark in Mumbai when the geocoder matched the bare word "in".
        for text in ("reimagining the pipeline", "indiana dunes study",
                     "the kindling of interest"):
            with self.subTest(text=text):
                self.assertIsNone(geo_hints.match_place(text))

    def test_handles_hyphens_and_underscores(self):
        self.assertIsNotNone(geo_hints.match_place("a united-kingdom trial"))
        self.assertIsNotNone(geo_hints.match_place("a united_kingdom trial"))

    def test_empty_and_non_string_input_is_safe(self):
        for value in ("", None, 42, []):
            with self.subTest(value=value):
                self.assertIsNone(geo_hints.match_place(value))

    def test_no_match_returns_none(self):
        self.assertIsNone(geo_hints.match_place("an entirely unlocatable result"))

    def test_returns_name_and_triple(self):
        hit = geo_hints.match_place("a result from Malta")
        self.assertIsNotNone(hit)
        name, (lat, lon, region) = hit
        self.assertEqual(name, "malta")
        self.assertAlmostEqual(lat, 35.9, places=1)
        self.assertAlmostEqual(lon, 14.5, places=1)
        self.assertTrue(region)


class TestCompiledMatchers(unittest.TestCase):
    """The precompiled table must stay equivalent to PLACE_COORDS.

    match_place used to rebuild every pattern on each call, which cost ~380us per
    invocation because the pipeline calls it several times per milestone. The
    patterns are now compiled once at import - but a cached table can silently
    fall out of step with the dict it was built from, so it is checked here.
    """

    def test_every_eligible_key_has_a_matcher(self):
        eligible = {k for k in geo_hints.PLACE_COORDS if len(k) >= 4}
        self.assertEqual({name for name, _p, _c in geo_hints._MATCHERS}, eligible)

    def test_matcher_count_matches_the_table(self):
        self.assertEqual(len(geo_hints._MATCHERS),
                         len([k for k in geo_hints.PLACE_COORDS if len(k) >= 4]))

    def test_each_matcher_carries_its_own_coordinates(self):
        for name, _pattern, coords in geo_hints._MATCHERS:
            with self.subTest(name=name):
                self.assertEqual(coords, geo_hints.PLACE_COORDS[name])

    def test_each_matcher_matches_its_own_name(self):
        for name, pattern, _coords in geo_hints._MATCHERS:
            with self.subTest(name=name):
                self.assertIsNotNone(pattern.search(name.lower()),
                                     f"compiled pattern does not match its own key {name!r}")

    def test_short_keys_are_excluded(self):
        for name, _pattern, _coords in geo_hints._MATCHERS:
            with self.subTest(name=name):
                self.assertGreaterEqual(len(name), 4)

    def test_matching_is_still_longest_name_first(self):
        # Order in _MATCHERS is the specificity guarantee; rebuilding it unsorted
        # would silently let a short name shadow a longer one.
        lengths = [len(name) for name, _p, _c in geo_hints._MATCHERS]
        self.assertEqual(lengths, sorted(lengths, reverse=True))
        self.assertEqual(geo_hints.match_place("the democratic republic of the congo")[0],
                         "democratic republic of the congo")


class TestConvenienceAccessors(unittest.TestCase):
    def test_place_coords_returns_a_pair(self):
        self.assertEqual(geo_hints.place_coords("a study from Malta"), (35.9, 14.5))

    def test_place_coords_none_when_unmatched(self):
        self.assertIsNone(geo_hints.place_coords("nowhere in particular"))

    def test_place_region_returns_the_label(self):
        self.assertEqual(geo_hints.place_region("a study from Malta"), "Southern Europe")

    def test_accessors_agree_with_match_place(self):
        text = "results from Sudan and Kenya"
        hit = geo_hints.match_place(text)
        self.assertEqual(geo_hints.place_coords(text), (hit[1][0], hit[1][1]))
        self.assertEqual(geo_hints.place_region(text), hit[1][2])

    def test_ordered_names_are_longest_first(self):
        # match_place relies on this ordering; if it were rebuilt unsorted the
        # specificity guarantee would silently disappear.
        lengths = [len(n) for n in geo_hints._ORDERED_PLACE_NAMES]
        self.assertEqual(lengths, sorted(lengths, reverse=True))


class TestSharedByBothCallers(unittest.TestCase):
    """The two geocoders must not each keep a private copy again."""

    def test_milestone_pipeline_uses_the_shared_module(self):
        import sync_milestones

        src = (ROOT / "scripts" / "sync_milestones.py").read_text(encoding="utf-8")
        self.assertIn("import geo_hints", src)
        self.assertIn("geo_hints.place_coords", src)
        self.assertNotIn("LOCATION_HINTS = {", src)
        self.assertIs(sync_milestones.geo_hints, geo_hints)

    def test_human_rights_fetcher_uses_the_shared_module(self):
        import fetch_human_rights

        src = (ROOT / "scripts" / "fetch_human_rights.py").read_text(encoding="utf-8")
        self.assertIn("import geo_hints", src)
        self.assertIn("geo_hints.match_place", src)
        self.assertNotIn("LOCATION_HINTS = {", src)
        self.assertIs(fetch_human_rights.geo_hints, geo_hints)


if __name__ == "__main__":
    unittest.main(verbosity=2)