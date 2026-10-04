#!/usr/bin/env python3
"""Self-tests for scripts/fetch_crisis_zones.py (stdlib only, offline).

The build/inference functions are pure (no network); this suite focuses on the
geo-location guards that protect the map from "Null Island" (0,0) entries, the
dedupe/cap contract shared by the sourced and static paths, and the RSS parser.
"""

from __future__ import annotations

import json
import ssl
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fetch_crisis_zones as fz


class _FakeResp:
    def __init__(self, body: bytes, encoding: str = ""):
        self._body = body
        self.headers = {"Content-Encoding": encoding}

    def read(self, n: int = -1) -> bytes:
        if n < 0:
            return self._body
        return self._body[:n]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class TestInferLocation(unittest.TestCase):
    def test_known_countries_resolve(self):
        cases = {
            "sudan": ((13.0, 24.5, "East Africa")),
            "chad": ((15.45, 18.73, "Central Africa")),
            "cabo delgado": ((-12.5, 40.5, "Southern Africa")),
            "red sea": ((19.0, 38.0, "Middle East")),
            "sahel": ((13.0, 2.0, "West Africa")),
        }
        for text, expected in cases.items():
            self.assertEqual(fz.infer_location(f"Crisis in {text}"), expected, text)

    def test_unknown_returns_null_island_marker(self):
        self.assertEqual(fz.infer_location("Some completely unknown place"), (0.0, 0.0, "Unknown"))

    def test_infer_region(self):
        self.assertEqual(fz.infer_region("Boumba-et-Nkam chad flood"), "Central Africa")


class TestBuildCrisisZones(unittest.TestCase):
    def _item(self, title: str, country: str = "", desc: str = ""):
        return {
            "title": title,
            "link": "https://example.org",
            "description": desc,
            "country": country,
        }

    def test_null_island_items_are_dropped(self):
        # Un-locatable items never become zones; a fully-empty sourcing result
        # triggers the curated static fallback instead (see next test).
        items = [
            self._item("Some unknown emergency without a location"),
            self._item("Sudan famine emergency"),
        ]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertEqual([z["id"] for z in zones], ["crisis-sudan-darfur-famine"])

    def test_all_unlocatable_falls_back_to_static(self):
        items = [self._item("Some unknown emergency without a location")]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertEqual(zones, fz._finalize_crisis_zones(fz.STATIC_CRISIS_ZONES))

    def test_geolocatable_items_survive(self):
        items = [self._item("Sudan famine emergency")]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0]["lat"], 13.0)
        self.assertEqual(zones[0]["lon"], 24.5)
        self.assertTrue(zones[0]["id"].startswith("crisis-"))

    def test_country_field_geolocates_otherwise_opaque_titles(self):
        items = [self._item("Cyclone damage and hunger", country="Mozambique")]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0]["lat"], -18.67)

    def test_dedupes_identical_titles_across_sources(self):
        a = [self._item("Haiti quake aftermath")]
        b = [self._item("Haiti quake aftermath")]
        zones = fz.build_crisis_zones_from_sources(a, b, [], [], [], [], [])
        self.assertEqual(len(zones), 1)

    def test_dedupes_slug_collisions(self):
        # Same slug after punctuation is stripped -> same id -> second is dropped.
        a = [self._item("Sudan! Emergency")]
        b = [self._item("Sudan ? Emergency")]
        zones = fz.build_crisis_zones_from_sources(a, b, [], [], [], [], [])
        self.assertEqual(len(zones), 1)

    def test_respects_fifteen_zone_cap(self):
        # Distinct places, so keyword-dedupe does not collapse them; the
        # 15-zone cap must still apply across the merged source lists.
        places = [
            "cabo delgado",
            "afghanistan",
            "syria",
            "ukraine",
            "mozambique",
            "nigeria",
            "niger",
            "somalia",
            "sudan",
            "darfur",
            "yemen",
            "myanmar",
            "rohingya",
            "ethiopia",
            "tigray",
            "palestine",
            "gaza",
            "haiti",
            "chad",
            "mali",
        ]
        items = [
            self._item(f"Situation report {i} for {p}", country=p) for i, p in enumerate(places)
        ]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertEqual(len(zones), 15)

    def test_priority_order_reliefweb_first(self):
        relief = [self._item("Yemen cholera emergency")]
        who = [self._item("Yemen cholera emergency")]
        zones = fz.build_crisis_zones_from_sources([], who, relief, [], [], [], [])
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0]["url"], "https://example.org")

    def test_curated_labels_replace_dataset_titles(self):
        # A raw HDX-style title must not leak onto the map; the place resolves
        # to its curated, specific-name crisis instead.
        items = [
            self._item(
                "Chad: Humanitarian Needs",
                desc="This dataset was compiled by the United Nations...",
            )
        ]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0]["name"], "Chad · Displacement crisis")
        self.assertEqual(zones[0]["note"], "Hundreds of thousands displaced from Darfur")
        self.assertEqual(zones[0]["source"], "UNHCR")
        self.assertEqual(zones[0]["id"], "crisis-chad-displacement-crisis")

    def test_same_place_collapses_to_one_zone(self):
        # Two different generic datasets about one place become a single zone.
        a = [self._item("South Sudan: Humanitarian Needs")]
        b = [self._item("South Sudan: Humanitarian Access")]
        zones = fz.build_crisis_zones_from_sources([], [], a, [], [], [], b)
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0]["name"], "South Sudan · Conflict & flooding")

    def test_zone_order_is_deterministic_across_source_ordering(self):
        # Feeds may reorder their item lists between runs; the committed zone
        # order must not change, or every cron run would churn a diff.
        chad = [self._item("Chad: Humanitarian Needs")]
        red_sea = [self._item("Red Sea: Maritime passage disruption")]
        direct = fz.build_crisis_zones_from_sources([], [], [], [], [], [], chad + red_sea)
        reversed_src = fz.build_crisis_zones_from_sources([], [], [], [], [], [], red_sea + chad)
        self.assertEqual(len(direct), 2)
        self.assertEqual([z["id"] for z in direct], [z["id"] for z in reversed_src])
        self.assertEqual(
            [z["id"] for z in direct], sorted(z["id"] for z in direct)
        )  # id-sorted contract

    def test_keyword_without_label_falls_back_to_cleaned_title(self):
        # "suez" is a known place but has no curated label: the raw dataset
        # suffix is stripped so the map still shows readable text.
        items = [self._item("Suez: Humanitarian Needs")]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0]["name"], "Suez · Humanitarian crisis")
        self.assertIn("live humanitarian situation", zones[0]["note"])

    def test_fallback_strips_dash_and_endash_suffixes(self):
        # Feed titles may glue the generic suffix with -, – or — ; all three
        # must be stripped (and stray separators trimmed) identically.
        for title, expected in (
            ("Suez - Humanitarian Access", "Suez · Humanitarian crisis"),
            ("Suez \u2013 Humanitarian Snapshot", "Suez · Humanitarian crisis"),
            ("Suez \u2014 Humanitarian Assessment", "Suez · Humanitarian crisis"),
        ):
            zones = fz.build_crisis_zones_from_sources([self._item(title)], [], [], [], [], [], [])
            self.assertEqual(zones[0]["name"], expected, f"title {title!r}")

    def test_curated_label_zone_carries_start_date(self):
        # Red Sea's curated label has a coarse onset (Oct 2023); the built zone
        # must carry it so the timeline slider hides the zone before 2023.
        items = [self._item("Red Sea: Maritime passage disruption")]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0]["start_date"], "2023-01-01")
        self.assertEqual(zones[0]["status"], "active")

    def test_curated_label_zone_carries_amplified_radius(self):
        # Label-driven zones must get the impact-proportional ring, not the
        # old uniform 4.0 (Chad's base 3.5 -> 2.7).
        items = [self._item("Chad: Humanitarian Needs")]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0]["radiusDeg"], fz.crisisRadiusDeg("Chad · Displacement crisis"))
        self.assertEqual(zones[0]["radiusDeg"], 2.7)

    def test_curated_chad_label_start_date(self):
        items = [self._item("Chad: Humanitarian Needs")]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertEqual(zones[0]["start_date"], "2021-01-01")

    def test_curated_conclusion_survives_feed_mentions(self):
        # Feed builds hardcode "active"; a concluded crisis (Ethiopia/Tigray) must
        # stay concluded with its end_date when a feed mentions it, so it keeps
        # its dim ring and drops off the timeline after 2022.
        items = [self._item("Tigray emergency conditions persist")]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0]["status"], "concluded")
        self.assertEqual(zones[0]["end_date"], "2022-11-02")

    def test_curated_conclusion_is_noop_for_other_zones(self):
        items = [self._item("Chad: Humanitarian Needs")]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertEqual(zones[0]["status"], "active")

    def test_fallback_zone_has_no_start_date(self):
        # "suez" has no curated label, so its onset is unknown; the zone stays
        # dateless and visible on every timeline year (backwards-compatible).
        items = [self._item("Suez: Humanitarian Needs")]
        zones = fz.build_crisis_zones_from_sources(items, [], [], [], [], [], [])
        self.assertNotIn("start_date", zones[0])

    def test_all_label_start_years_are_sane(self):
        now_year = datetime.now().year
        for name, _, _, year in fz.CRISIS_LABELS.values():
            self.assertIsInstance(year, int, name)
            self.assertGreaterEqual(year, 1990, name)
            self.assertLessEqual(year, now_year, name)

    def test_specific_keyword_wins_over_short_prefix(self):
        # "South Sudan" must geolocate to South Sudan, not be swallowed by
        # the shorter "sudan" keyword.
        self.assertEqual(
            fz.infer_location("South Sudan conflict"),
            (7.86, 30.2, "East Africa"),
        )


class TestFinalizeCrisisZones(unittest.TestCase):
    def test_dedupes_ids_without_mutating_input(self):
        source = [
            {"id": "crisis-x", "name": "X", "lat": 1, "lon": 1},
            {"id": "crisis-x", "name": "X again", "lat": 1, "lon": 1},
            {"id": "crisis-y", "name": "Y", "lat": 2, "lon": 2},
        ]
        out = fz._finalize_crisis_zones(source)
        self.assertEqual([z["id"] for z in out], ["crisis-x", "crisis-y"])
        self.assertEqual(len(source), 3)  # caller's list untouched

    def test_clamps_to_cap(self):
        source = [{"id": f"crisis-{i}", "lat": 0, "lon": 0} for i in range(30)]
        out = fz._finalize_crisis_zones(source)
        self.assertLessEqual(len(out), 15)

    def test_skips_malformed_entries(self):
        out = fz._finalize_crisis_zones(
            [{"lat": 1}, "junk", {"id": "", "lat": 1}, {"id": "crisis-ok", "lat": 2, "lon": 2}]
        )
        self.assertEqual([z["id"] for z in out], ["crisis-ok"])


class TestStaticFallback(unittest.TestCase):
    def test_static_list_has_unique_ids_and_no_null_island(self):
        ids = [z["id"] for z in fz.STATIC_CRISIS_ZONES]
        self.assertEqual(len(ids), len(set(ids)))
        for z in fz.STATIC_CRISIS_ZONES:
            self.assertFalse(z["lat"] == 0.0 and z["lon"] == 0.0, z["id"])
            self.assertIn(
                z["status"], {"active", "ongoing", "concluded", "inactive", "ended", "resolved"}
            )

    def test_static_caps_at_fifteen(self):
        out = fz._finalize_crisis_zones(fz.STATIC_CRISIS_ZONES)
        self.assertLessEqual(len(out), 15)

    def test_static_zones_carry_start_dates(self):
        for z in fz.STATIC_CRISIS_ZONES:
            sd = z.get("start_date")
            self.assertIsNotNone(sd, z["id"])
            year, rest = sd.split("-", 1)
            self.assertTrue(year.isdigit() and len(year) == 4, z["id"])
            self.assertEqual(rest, "01-01", z["id"])
            self.assertGreaterEqual(year, "1990")
            self.assertLessEqual(year, str(datetime.now().year))

    def test_static_start_dates_agree_with_label_year(self):
        # Static fallback twins of curated labels must share the same coarse
        # onset year, so the timeline behaves identically in both paths.
        name_to_year = {label[0]: label[3] for label in fz.CRISIS_LABELS.values()}
        for z in fz.STATIC_CRISIS_ZONES:
            if z["name"] in name_to_year:
                self.assertEqual(z["start_date"], f"{name_to_year[z['name']]}-01-01", z["id"])

    def test_static_concluded_entry_carries_end_date(self):
        # Ethiopia/Tigray is concluded (Pretoria ceasefire); the static fallback
        # and the finalized output must both say so, never "active".
        eth = next(z for z in fz.STATIC_CRISIS_ZONES if z["id"] == "crisis-ethiopia")
        self.assertEqual(eth["status"], "concluded")
        self.assertEqual(eth["end_date"], "2022-11-02")
        out = fz._finalize_crisis_zones(fz.STATIC_CRISIS_ZONES)
        eth_out = next(z for z in out if z["id"] == "crisis-ethiopia")
        self.assertEqual(eth_out["status"], "concluded")
        self.assertEqual(eth_out["end_date"], "2022-11-02")


class TestCrisisRadius(unittest.TestCase):
    """Impact-proportional ring sizes: smaller crises shrink, the largest keeps
    the 6.0 cap, and nothing ever renders bigger than CRISIS_MAX_RADIUS_DEG."""

    def test_every_label_and_static_name_has_a_base(self):
        names = [label[0] for label in fz.CRISIS_LABELS.values()]
        names += [z["name"] for z in fz.STATIC_CRISIS_ZONES]
        for name in names:
            self.assertIn(name, fz.CRISIS_RADIUS_BASE, name)

    def test_amplified_values_match_spec(self):
        cases = {
            "Sahel · Conflict & hunger": 6.0,
            "Afghanistan · Winter hunger crisis": 4.6,
            "DRC · Conflict & displacement": 4.6,
            "DRC · Conflict & Ebola": 4.6,
            "Sudan · Darfur famine": 3.9,
            "South Sudan · Conflict & flooding": 3.9,
            "Ukraine · War & civilian needs": 3.9,
            "Nigeria · Insurgency & hunger": 3.9,
            "Syria · Humanitarian crisis": 3.3,
            "Ethiopia · Tigray conflict": 3.3,
            "Somalia · Drought & famine": 3.3,
            "Mali · Displacement crisis": 3.3,
            "Yemen · Cholera & famine": 3.0,
            "Gaza · Humanitarian emergency": 2.7,
            "Haiti · Gang violence & hunger": 2.7,
            "Chad · Displacement crisis": 2.7,
            "Niger · Conflict & hunger": 2.7,
            "Mozambique · Cabo Delgado insurgency": 2.7,
            "Myanmar · Rohingya displacement": 2.1,
            "Kenya · Floods & displacement": 2.1,
            "Bangladesh · Floods & displacement": 2.1,
            "Red Sea · Shipping disruption": 2.1,
        }
        for name, expected in cases.items():
            self.assertEqual(fz.crisisRadiusDeg(name), expected, name)

    def test_no_zone_outgrows_the_cap(self):
        names = [label[0] for label in fz.CRISIS_LABELS.values()]
        names += [z["name"] for z in fz.STATIC_CRISIS_ZONES]
        for name in names:
            self.assertLessEqual(fz.crisisRadiusDeg(name), fz.CRISIS_MAX_RADIUS_DEG, name)

    def test_smaller_base_never_renders_bigger(self):
        # Monotonic in the base radius: a smaller crisis must not render larger.
        pairs = sorted((base, name) for name, base in fz.CRISIS_RADIUS_BASE.items())
        rendered = [fz.crisisRadiusDeg(name) for _, name in pairs]
        self.assertEqual(rendered, sorted(rendered))
        # ...and the literal sanity: max stays exactly at the cap.
        self.assertEqual(fz.crisisRadiusDeg("Sahel · Conflict & hunger"), fz.CRISIS_MAX_RADIUS_DEG)

    def test_unknown_names_fall_back_to_default(self):
        expected = round(
            fz.CRISIS_MAX_RADIUS_DEG
            * (fz.CRISIS_DEFAULT_RADIUS_BASE / fz.CRISIS_MAX_RADIUS_DEG) ** fz.CRISIS_RADIUS_EXP,
            1,
        )
        self.assertEqual(fz.crisisRadiusDeg("Suez · Humanitarian crisis"), expected)

    def test_static_radii_match_amplified_bases(self):
        # The committed fallback list must carry exactly what crisisRadiusDeg
        # would amplify, so both the sourced and static paths render identically.
        for z in fz.STATIC_CRISIS_ZONES:
            self.assertEqual(z["radiusDeg"], fz.crisisRadiusDeg(z["name"]), z["id"])


class TestParseOchaRss(unittest.TestCase):
    def _rss(self, *titles: str) -> str:
        items = "".join(
            f"<item><title><![CDATA[{t}]]></title><link>https://e.example/{i}</link></item>"
            for i, t in enumerate(titles)
        )
        return f"<rss><channel>{items}</channel></rss>"

    def test_parses_crisis_mentions(self):
        rss = self._rss("Sudan: famine warning issued", "World Cup 2026 finals")
        crises = fz.parse_ocha_rss(rss)
        self.assertEqual(len(crises), 1)
        self.assertIn("Sudan", crises[0]["title"])
        self.assertEqual(crises[0]["link"], "https://e.example/0")

    def test_no_items_yields_empty(self):
        self.assertEqual(fz.parse_ocha_rss("<rss></rss>"), [])


class TestSchemaVersion(unittest.TestCase):
    def test_schema_version_parity_with_schema_file(self):
        # The deployed contract version must come from the schema (the single
        # source of truth), not a hand-maintained literal.
        schema = json.loads(Path("schema/worldmap-data.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(fz.SCHEMA_VERSION, schema["files"]["world_layers.json"]["version"])


class TestFetchUrl(unittest.TestCase):
    def setUp(self):
        self._saved_hosts = set(fz._UNVERIFIED_TLS_HOSTS)

    def tearDown(self):
        fz._UNVERIFIED_TLS_HOSTS.clear()
        fz._UNVERIFIED_TLS_HOSTS.update(self._saved_hosts)

    def test_rejects_non_https(self):
        with self.assertRaises(ValueError):
            fz.fetch_url("http://example.org/feed.xml")

    def test_verified_context_by_default(self):
        ctx = fz._tls_context("example.org")
        self.assertEqual(ctx.check_hostname, True)
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)

    def test_cert_failure_retries_verified_then_unverified(self):
        # First open fails certificate verification -> host is opted into
        # unverified TLS -> the retry succeeds under CERT_NONE.
        ctx_modes = []

        def fake_open(req, timeout, context):
            ctx_modes.append(context.verify_mode)
            if len(ctx_modes) < 2:
                raise urllib.error.URLError(
                    ssl.SSLCertVerificationError("certificate verify failed")
                )
            return _FakeResp(b"<ok/>\n")

        orig = fz.urllib.request.urlopen
        try:
            fz.urllib.request.urlopen = fake_open
            out = fz.fetch_url("https://example.org/feed.xml")
        finally:
            fz.urllib.request.urlopen = orig
        self.assertEqual(out, "<ok/>\n")
        self.assertEqual(ctx_modes, [ssl.CERT_REQUIRED, ssl.CERT_NONE])
        self.assertIn("example.org", fz._UNVERIFIED_TLS_HOSTS)

    def test_opts_host_in_once_and_only_once(self):
        self.assertTrue(fz._mark_unverified_host("bad.host"))
        self.assertFalse(fz._mark_unverified_host("bad.host"))
        self.assertEqual(fz._UNVERIFIED_TLS_HOSTS, {"bad.host"})

    def test_http_error_retries_then_gives_up(self):
        calls = {"n": 0}

        def fake_open(req, timeout, context):
            calls["n"] += 1
            raise urllib.error.HTTPError("https://e.org/x", 403, "Forbidden", {}, None)

        orig = fz.urllib.request.urlopen
        try:
            fz.urllib.request.urlopen = fake_open
            out = fz.fetch_url("https://e.org/x")
        finally:
            fz.urllib.request.urlopen = orig
        self.assertIsNone(out)
        self.assertEqual(calls["n"], 3)
        self.assertEqual(fz._UNVERIFIED_TLS_HOSTS, set())

    def test_reliefweb_malformed_shape_falls_through(self):
        # A non-list "data" payload (odd API shape) must not crash the daily
        # run: fall through v2 to v1 and ultimately return [].
        calls = {"n": 0}

        def fake_open(req, timeout, context):
            calls["n"] += 1
            return _FakeResp(b'{"data": {"some": "non-list"}}')

        orig = fz.urllib.request.urlopen
        try:
            fz.urllib.request.urlopen = fake_open
            out = fz.fetch_reliefweb_crises()
        finally:
            fz.urllib.request.urlopen = orig
        self.assertEqual(out, [])
        self.assertEqual(calls["n"], 2)  # v2 then v1 fallback

    def test_decode_plain_text(self):
        self.assertEqual(fz._decode_body(_FakeResp(b"hello")), "hello")

    def test_decode_gzip(self):
        import gzip

        body = gzip.compress(b"Sudan emergency")
        self.assertEqual(fz._decode_body(_FakeResp(body, "gzip")), "Sudan emergency")

    def test_decode_zlib_deflate(self):
        import zlib

        body = zlib.compress(b"Yemen cholera")
        self.assertEqual(fz._decode_body(_FakeResp(body, "deflate")), "Yemen cholera")

    def test_decode_raw_deflate(self):
        import zlib

        co = zlib.compressobj(wbits=-zlib.MAX_WBITS)
        body = co.compress(b"raw deflate") + co.flush()
        self.assertEqual(fz._decode_body(_FakeResp(body, "deflate")), "raw deflate")

    def test_decode_truncated_by_read_cap(self):
        # A body at/over the safety cap must fail loudly, not parse garbage.
        oversized = b"x" * (fz._MAX_HTTP_BODY + 1)
        with self.assertRaises(ValueError):
            fz._decode_body(_FakeResp(oversized))

    def test_decode_decompression_bomb_rejected(self):
        # A tiny compressed stream that inflates past the cap is bounded too.
        import zlib

        bomb = zlib.compress(b"\x00" * (fz._MAX_HTTP_BODY + 1))
        with self.assertRaises(ValueError):
            fz._decode_body(_FakeResp(bomb, "deflate"))


class TestLoadWorldLayers(unittest.TestCase):
    def test_missing_file_bootstraps_empty_shell(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "world_layers.json"
            out = fz.load_world_layers(path)
            self.assertIsNotNone(out)
            self.assertEqual(out["conflict_zones"], [])
            self.assertEqual(out["crisis_zones"], [])
            self.assertEqual(out["version"], fz.SCHEMA_VERSION)

    def test_unparseable_file_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "world_layers.json"
            path.write_text("{not json", encoding="utf-8")
            self.assertIsNone(fz.load_world_layers(path))

    def test_missing_conflict_zones_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "world_layers.json"
            path.write_text(
                json.dumps({"version": "1.1.0", "last_update": "2026-09-25T00:00:00+00:00"}),
                encoding="utf-8",
            )
            self.assertIsNone(fz.load_world_layers(path))

    def test_valid_file_is_returned(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "world_layers.json"
            payload = {
                "version": "1.1.0",
                "last_update": "x",
                "conflict_zones": [{"id": "a"}],
                "crisis_zones": [],
            }
            path.write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(fz.load_world_layers(path), payload)

    def test_main_refuses_to_overwrite_corrupt_file(self):
        # A corrupt world_layers.json must abort the run (exit 1) and leave the
        # file untouched, never write an empty-shell that loses layer data.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "world_layers.json"
            corrupt = "{not json"
            path.write_text(corrupt, encoding="utf-8")
            orig_fetch = fz.fetch_url
            orig_argv = sys.argv
            fz.fetch_url = lambda url, timeout=30: None  # empty feeds, full flow
            sys.argv = ["fetch_crisis_zones.py", "--output", str(path)]
            try:
                rc = fz.main()
            finally:
                fz.fetch_url = orig_fetch
                sys.argv = orig_argv
            self.assertEqual(rc, 1)
            self.assertEqual(path.read_text(encoding="utf-8"), corrupt)


if __name__ == "__main__":
    unittest.main()
