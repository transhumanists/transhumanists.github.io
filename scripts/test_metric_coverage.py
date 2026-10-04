#!/usr/bin/env python3
"""Tests for metric_coverage.py — the comparability report and its gate.

The gate is the load-bearing part. A gate that cannot fail is worthless and a
gate that always fails is ignored, so both directions are pinned here: the
accepted state stays green, and every kind of drift away from it turns red.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import metric_coverage as mc


def _rec(**over):
    r = {
        "id": "ms-1",
        "category": "Quantum Physics",
        "subcategory": "quantum_supremacy",
        "title": "A machine did a thing",
        "date": "2025-01-01",
        "value": "1,000",
        "unit": "qubits",
    }
    r.update(over)
    return r


def _write(tmp: Path, records, name="milestones.json"):
    payload = {"version": "1.0.0", "categories": {"x": {"milestones": records}}}
    (tmp / name).write_text(json.dumps(payload), encoding="utf-8")


class TestNumericValue(unittest.TestCase):
    def test_reads_plain_and_grouped_numbers(self):
        self.assertEqual(mc.numeric_value("1000"), 1000.0)
        self.assertEqual(mc.numeric_value("1,234,567"), 1234567.0)
        self.assertEqual(mc.numeric_value("12.5"), 12.5)
        self.assertEqual(mc.numeric_value("5 GPa"), 5.0)
        self.assertEqual(mc.numeric_value("~3.5x"), 3.5)

    def test_prose_is_not_a_metric(self):
        # The shape upstream falls back to: the title as the value.
        self.assertIsNone(mc.numeric_value("Google DeepMind announced Willow"))
        self.assertIsNone(mc.numeric_value(""))
        self.assertIsNone(mc.numeric_value(None))

    def test_a_bare_year_is_not_a_metric(self):
        # Treating every 4-digit integer as a measurement would report full
        # coverage on a dataset that has none.
        self.assertIsNone(mc.numeric_value("2026"))
        self.assertIsNone(mc.numeric_value("1999"))


class TestMetricShape(unittest.TestCase):
    def test_number_plus_unit_is_comparable(self):
        self.assertEqual(mc.metric_shape(_rec()), "numeric")

    def test_number_without_unit_is_kept_but_flagged(self):
        self.assertEqual(mc.metric_shape(_rec(unit="")), "unitless")

    def test_prose_is_prose(self):
        self.assertEqual(mc.metric_shape(_rec(value="DeepMind announced Willow", unit="")), "prose")


class TestUnitCoherence(unittest.TestCase):
    def test_cosmetic_spelling_variants_collapse(self):
        # Same quantity, two spellings. Coherence must not blame a regression
        # for this.
        self.assertEqual(
            mc.comparable_unit(_rec(unit="%")), mc.comparable_unit(_rec(unit="Percent"))
        )
        self.assertEqual(
            mc.comparable_unit(_rec(unit="m/s")), mc.comparable_unit(_rec(unit="m/s."))
        )

    def test_qualifiers_stay_distinct(self):
        # Physical and logical qubits are different quantities. Collapsing these
        # would rank two unrelated numbers against each other.
        self.assertNotEqual(
            mc.comparable_unit(_rec(unit="physical qubits")),
            mc.comparable_unit(_rec(unit="logical qubits")),
        )
        self.assertNotEqual(
            mc.comparable_unit(_rec(unit="qubits")), mc.comparable_unit(_rec(unit="qv"))
        )

    def test_report_flags_incoherent_group(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            _write(tmp, [_rec(id="a"), _rec(id="b", unit="qv")])
            report = mc.build_report(tmp)
        g = report["groups"][0]
        self.assertTrue(g["incoherent"])
        self.assertAlmostEqual(g["unit_coherence"], 0.5)
        self.assertEqual(g["numeric"], 2)


class TestReport(unittest.TestCase):
    def test_record_in_both_files_counted_once(self):
        # The live feed and the archive overlap. Counting a shared record twice
        # would halve every rate in the report.
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            recs = [_rec(id="a"), _rec(id="b", unit="qv")]
            _write(tmp, recs)
            _write(tmp, recs, name="milestones_history.json")
            report = mc.build_report(tmp)
        self.assertEqual(report["overall"]["records"], 2)
        self.assertEqual(report["groups"][0]["records"], 2)

    def test_subcategory_defaults_to_general(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            _write(tmp, [_rec(id="a", subcategory="")])
            report = mc.build_report(tmp)
        self.assertEqual(report["groups"][0]["subcategory"], "general")

    def test_uncategorised_records_still_reported(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            _write(tmp, [_rec(id="a", category="")])
            report = mc.build_report(tmp)
        self.assertEqual(report["groups"][0]["category"], "(uncategorised)")

    def test_overall_rate_is_numeric_share(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            _write(
                tmp,
                [
                    _rec(id="a"),
                    _rec(id="b", unit=""),
                    _rec(id="c", value="Something happened", unit=""),
                ],
            )
            o = mc.build_report(tmp)["overall"]
        self.assertEqual(o["records"], 3)
        self.assertEqual(o["numeric"], 1)
        self.assertEqual(o["unitless"], 1)
        self.assertEqual(o["prose"], 1)
        self.assertAlmostEqual(o["comparable_rate"], 1 / 3, places=3)


class TestGate(unittest.TestCase):
    """The gate must be green on the accepted state and red on every drift."""

    def _report(self, records):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            _write(tmp, records)
            return mc.build_report(tmp)

    def test_green_when_unchanged(self):
        recs = [_rec(id="a"), _rec(id="b"), _rec(id="c")]
        baseline = mc.build_baseline(self._report(recs))["groups"]
        self.assertEqual(mc.evaluate_gate(self._report(recs), baseline, 0.25), [])

    def test_green_when_records_are_only_added(self):
        # More milestones is progress. It must never fail the gate.
        base_recs = [_rec(id="a"), _rec(id="b")]
        report = self._report(base_recs)
        baseline = mc.build_baseline(report)["groups"]
        grown = base_recs + [_rec(id="c"), _rec(id="d")]
        self.assertEqual(mc.evaluate_gate(self._report(grown), baseline, 0.25), [])

    def test_red_when_a_metric_disappears(self):
        # The exact regression this exists to catch: a record that had a metric
        # is republished as prose.
        with_metric = [_rec(id="a"), _rec(id="b")]
        baseline = mc.build_baseline(self._report(with_metric))["groups"]
        regressed = [_rec(id="a"), _rec(id="b", value="Something happened", unit="")]
        problems = mc.evaluate_gate(self._report(regressed), baseline, 0.25)
        self.assertTrue(problems)
        self.assertIn("comparable rate fell", problems[0])

    def test_red_when_a_new_incoherent_group_appears(self):
        baseline = mc.build_baseline(self._report([_rec(id="a")]))["groups"]
        # A different subcategory, absent from the baseline, holding two
        # different units - incoherent, and not yet accounted for.
        report = self._report(
            [
                _rec(id="a"),
                _rec(id="b", subcategory="other", unit="qubits"),
                _rec(id="c", subcategory="other", unit="qv"),
            ]
        )
        problems = mc.evaluate_gate(report, baseline, 0.25)
        self.assertTrue(problems)
        self.assertTrue(any("not in the baseline" in p for p in problems))

    def test_red_when_coherence_drops_further(self):
        # Already incoherent, and now worse. The baseline knows it was bad at
        # 0.50; 0.33 is a new drop.
        recs = [_rec(id="a"), _rec(id="b", unit="qv"), _rec(id="c", unit="g")]
        report = self._report(recs)
        baseline = mc.build_baseline(report)["groups"]
        worse = [
            _rec(id="a"),
            _rec(id="b", unit="qv"),
            _rec(id="c", unit="g"),
            _rec(id="d", unit="s"),
        ]
        problems = mc.evaluate_gate(self._report(worse), baseline, 0.25)
        self.assertTrue(problems)
        self.assertTrue(any("unit coherence fell" in p for p in problems))

    def test_known_inecoherence_alone_is_not_a_failure(self):
        # Debt already recorded in the baseline is reported, not enforced.
        recs = [_rec(id="a"), _rec(id="b", unit="qv")]
        report = self._report(recs)
        self.assertTrue(report["groups"][0]["incoherent"])
        baseline = mc.build_baseline(report)["groups"]
        self.assertEqual(mc.evaluate_gate(report, baseline, 0.25), [])

    def test_empty_baseline_holds_new_groups_to_the_floor(self):
        # No baseline yet: anything incoherent or below the floor is a finding,
        # which is the behaviour before --update-baseline has ever run.
        problems = mc.evaluate_gate(self._report([_rec(id="a"), _rec(id="b", unit="qv")]), {}, 0.25)
        self.assertTrue(problems)


class TestCli(unittest.TestCase):
    def _run(self, tmp: Path, *args):
        return subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts" / "metric_coverage.py"),
                "--data-dir",
                str(tmp),
                *args,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

    def test_update_baseline_then_gate_is_green(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            _write(tmp, [_rec(id="a"), _rec(id="b", unit="qv")])
            first = self._run(tmp, "--update-baseline")
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertTrue((tmp / "metric_coverage_baseline.json").exists())
            second = self._run(tmp, "--gate")
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            self.assertIn("metric gate: OK", second.stdout)

    def test_gate_exits_nonzero_on_regression(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            _write(tmp, [_rec(id="a")])
            self._run(tmp, "--update-baseline")
            _write(tmp, [_rec(id="a", value="Something happened", unit="")])
            failed = self._run(tmp, "--gate")
            self.assertEqual(failed.returncode, 1)
            self.assertIn("metric gate FAILED", failed.stdout)

    def test_json_output_parses(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            _write(tmp, [_rec(id="a")])
            out = self._run(tmp, "--json")
            self.assertEqual(out.returncode, 0, out.stderr)
            payload = json.loads(out.stdout)
            self.assertEqual(payload["overall"]["records"], 1)


class TestShippedData(unittest.TestCase):
    """The shipped dataset must pass its own gate."""

    def test_shipped_data_passes_its_baseline(self):
        report = mc.build_report(ROOT / "data")
        self.assertGreater(report["overall"]["records"], 0)
        self.assertLess(
            report["overall"]["comparable_rate"],
            1.0,
            "comparable rate hit 100%; the classification is probably broken",
        )
        baseline = mc.load_baseline(ROOT / "data")
        if not baseline:
            self.skipTest("no baseline committed yet")
        problems = mc.evaluate_gate(report, baseline, 0.25)
        self.assertEqual(problems, [], "metric comparability regressed:\n" + "\n".join(problems))


if __name__ == "__main__":
    unittest.main()
