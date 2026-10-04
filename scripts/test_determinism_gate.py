"""Tests for the CI determinism gate, plus the gate's own self-check.

The gate is the thing that would have caught the ordering regression, so it is
worth testing that it (a) passes on genuinely reproducible output, (b) still fails
on a real difference, and (c) does not simply ignore everything.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

import determinism_gate as gate

# Volatile stamps must be stripped from the workflow copy too, or the workflow
# silently diverges from the module that is actually tested.
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"


class TestFirstDifference(unittest.TestCase):
    def test_identical_structures_have_no_difference(self):
        self.assertIsNone(gate.first_difference({"a": [1, 2]}, {"a": [1, 2]}))

    def test_reports_the_exact_field(self):
        diff = gate.first_difference({"a": {"b": 1}}, {"a": {"b": 2}})
        self.assertEqual(diff, ".a.b: 1 vs 2")

    def test_reports_a_missing_key(self):
        diff = gate.first_difference({"a": 1}, {"a": 1, "b": 2})
        self.assertEqual(diff, ".b: present in only one run")

    def test_reports_a_length_mismatch(self):
        diff = gate.first_difference([1, 2, 3], [1, 2])
        self.assertEqual(diff, ": length 3 vs 2")

    def test_reports_a_type_mismatch(self):
        diff = gate.first_difference({"a": 1}, {"a": "1"})
        self.assertIsNotNone(diff)
        self.assertIn("type", diff)

    def test_reports_the_index_of_a_list_difference(self):
        diff = gate.first_difference([{"x": 1}, {"y": 2}], [{"x": 1}, {"y": 3}])
        self.assertEqual(diff, "[1].y: 2 vs 3")


class TestLoadStable(unittest.TestCase):
    def test_last_update_is_stripped(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "events.json"
            path.write_text(
                json.dumps({"last_update": "2026-10-01T00:00:00Z", "events": [1, 2]}),
                encoding="utf-8",
            )
            loaded = gate.load_stable(path)
        self.assertNotIn("last_update", loaded)
        self.assertEqual(loaded["events"], [1, 2])

    def test_two_runs_differing_only_in_last_update_are_equal(self):
        # This is the exact case the first version of the gate got wrong.
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "a.json").write_text(
                json.dumps({"last_update": "2026-10-01T00:00:00Z", "events": [1]}), encoding="utf-8"
            )
            (base / "b.json").write_text(
                json.dumps({"last_update": "2026-10-01T00:00:01Z", "events": [1]}), encoding="utf-8"
            )
            self.assertEqual(gate.load_stable(base / "a.json"), gate.load_stable(base / "b.json"))


class TestCompareRuns(unittest.TestCase):
    def _make_run(self, root: Path, name: str, events, milestones=None) -> Path:
        run = root / name
        data = run / "data"
        data.mkdir(parents=True)
        (data / "events.json").write_text(
            json.dumps({"last_update": "x", "events": events}), encoding="utf-8"
        )
        (data / "milestones.json").write_text(
            json.dumps(
                milestones if milestones is not None else {"last_update": "x", "categories": {}}
            ),
            encoding="utf-8",
        )
        return run

    def test_identical_runs_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self._make_run(root, "a", [{"id": "e1"}])
            b = self._make_run(root, "b", [{"id": "e1"}])
            self.assertEqual(gate.compare_runs(a, b), [])

    def test_a_real_difference_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self._make_run(root, "a", [{"id": "e1", "title": "One"}])
            b = self._make_run(root, "b", [{"id": "e1", "title": "Two"}])
            failures = gate.compare_runs(a, b)
            self.assertEqual(len(failures), 1)
            self.assertIn("One", failures[0])
            self.assertIn("Two", failures[0])

    def test_a_missing_file_fails_loudly(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self._make_run(root, "a", [{"id": "e1"}])
            b = self._make_run(root, "b", [{"id": "e1"}])
            (b / "data" / "events.json").unlink()
            failures = gate.compare_runs(a, b)
            self.assertTrue(any("missing" in f for f in failures))

    def test_assert_deterministic_raises_on_difference(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self._make_run(root, "a", [{"id": "e1", "title": "One"}])
            b = self._make_run(root, "b", [{"id": "e1", "title": "Two"}])
            with self.assertRaises(AssertionError):
                gate.assert_deterministic(a, b)


class TestIdempotence(unittest.TestCase):
    """The unifier must be a fixed point.

    It runs over data that already contains its own merged records. If it found
    fresh duplicates on every pass, each scheduled run would shave a few records
    off the published feed - a slow, silent loss of history that no per-record
    check would ever catch.
    """

    def _run(self, root: Path, name: str, count: int) -> Path:
        run = root / name
        data = run / "data"
        data.mkdir(parents=True)
        (data / "milestones.json").write_text(
            json.dumps(
                {
                    "last_update": "x",
                    "categories": {
                        "quantum": {"milestones": [{"id": f"m{i}"} for i in range(count)]}
                    },
                }
            ),
            encoding="utf-8",
        )
        return run

    def test_milestone_count_sums_categories(self):
        data = {"categories": {"a": {"milestones": [1, 2]}, "b": {"milestones": [3]}}}
        self.assertEqual(gate.milestone_count(data), 3)

    def test_milestone_count_tolerates_missing_milestones(self):
        self.assertEqual(gate.milestone_count({"categories": {"a": {}}}), 0)

    def test_equal_counts_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = self._run(root, "a", 5)
            remerged = run / "data-remerged"
            remerged.mkdir()
            (remerged / "milestones.json").write_text(
                json.dumps(
                    {
                        "last_update": "y",
                        "categories": {
                            "quantum": {"milestones": [{"id": f"m{i}"} for i in range(5)]}
                        },
                    }
                ),
                encoding="utf-8",
            )
            gate.assert_idempotent(run)

    def test_a_shrinking_feed_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = self._run(root, "a", 5)
            remerged = run / "data-remerged"
            remerged.mkdir()
            (remerged / "milestones.json").write_text(
                json.dumps(
                    {
                        "last_update": "y",
                        "categories": {
                            "quantum": {"milestones": [{"id": f"m{i}"} for i in range(3)]}
                        },
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaises(AssertionError) as ctx:
                gate.assert_idempotent(run)
            self.assertIn("not idempotent", str(ctx.exception))


class TestWorkflowMirror(unittest.TestCase):
    """The workflow must invoke the tested module, not a private copy.

    An inline copy is exactly how the first version of this gate went wrong: the
    logic was visible only by watching a build fail.
    """

    def test_workflow_strips_last_update(self):
        if not WORKFLOW.exists():
            self.skipTest("ci.yml not present")
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("last_update", text)
        self.assertIn("last_update", "".join(sorted(gate.VOLATILE_KEYS)))

    def test_workflow_uses_the_tested_module(self):
        if not WORKFLOW.exists():
            self.skipTest("ci.yml not present")
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("determinism_gate", text)

    def test_workflow_checks_idempotence_through_the_module(self):
        # The idempotence step was an inline heredoc; move it back and it stops
        # being testable.
        if not WORKFLOW.exists():
            self.skipTest("ci.yml not present")
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("--idempotent", text)

    def test_workflow_does_not_compare_bytes(self):
        # The original version diffed raw files and failed on every run because
        # of the timestamp. Guard against that regression coming back.
        if not WORKFLOW.exists():
            self.skipTest("ci.yml not present")
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertNotIn("diff -q", text)


class TestRealRegeneration(unittest.TestCase):
    """End-to-end: two real runs of the pipeline over the committed feed.

    Skipped when regeneration is not reproducible offline (e.g. geocoding needs
    the network), so it never turns CI red for an unrelated reason.
    """

    def test_two_real_runs_agree(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, STALE_ERROR_DAYS="99")
            for name in ("gen-a", "gen-b"):
                proc = subprocess.run(
                    [
                        sys.executable,
                        str(ROOT / "scripts" / "sync_milestones.py"),
                        "--output-dir",
                        str(Path(tmp) / name),
                        "--upstream",
                        str(ROOT / "data" / "milestones.json"),
                        "--today",
                        "2026-10-01",
                    ],
                    capture_output=True,
                    text=True,
                    env=env,
                    cwd=str(ROOT),
                )
                if proc.returncode != 0:
                    self.skipTest(f"regeneration unavailable offline: {proc.stderr[:200]}")
            failures = gate.compare_runs(Path(tmp) / "gen-a", Path(tmp) / "gen-b")
            self.assertEqual(failures, [], f"regeneration is not deterministic: {failures}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
