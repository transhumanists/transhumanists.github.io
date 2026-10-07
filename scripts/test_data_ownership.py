"""Tests for the generated-data ownership check.

The check has one job and one easy way to be useless: if it fails on history nobody
can delete, it gets switched off. So the interesting behaviour is that it is scoped,
that it exempts the bot, and that it actually catches a hand edit.
"""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import data_ownership as own


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True,
                          cwd=str(ROOT)).stdout.strip()


class TestGeneratedSet(unittest.TestCase):
    def test_every_data_file_is_listed(self):
        # If the set drifts from the directory, the check guards the wrong thing.
        on_disk = {"data/" + p.name for p in (ROOT / "data").glob("*.json")}
        on_disk |= {"data/" + p.name for p in (ROOT / "data").glob(".*")
                    if p.name == ".sync_fingerprint"}
        missing = on_disk - set(own.GENERATED)
        self.assertEqual(missing, set(), "not covered by the ownership check: %s" % missing)

    def test_the_bot_is_exempt(self):
        self.assertTrue(any("github-actions" in m for m in own.BOT_IDENTITIES))

    def test_this_branch_does_not_hand_edit_generated_data(self):
        offenders = own.offending_commits("origin/main..HEAD")
        self.assertEqual([(s[:9], f) for s, f in offenders], [])

    def test_the_check_would_catch_a_hand_edit(self):
        # Positive control. Without it a check that silently stopped examining
        # anything would still pass every other test above.
        self.assertEqual(
            own.touched_generated_from_tree(["data/milestones.json"]),
            ["data/milestones.json"])
        self.assertEqual(own.touched_generated_from_tree(["scripts/x.py"]), [])
        self.assertEqual(
            own.touched_generated_from_tree(
                ["scripts/x.py", "data/events.json", "README.md"]),
            ["data/events.json"])

    def test_a_bot_commit_would_be_exempt(self):
        # Found from real history rather than assumed to be HEAD, which stops being a
        # bot commit the moment anyone commits on the branch. Asserting a real cron
        # commit is exempt proves the exemption fires on a real commit rather than a
        # fixture - the alternative is the cron refreshing and CI rejecting its own
        # refresh.
        log = git("log", "--format=%H|%an|%ae", "HEAD")
        bot = [row.split("|")[0] for row in log.split("\n")
               if "github-actions[bot]" in row]
        self.assertTrue(bot, "expected bot commits in history")
        self.assertTrue(own.commit_is_from_bot(bot[0]))

    def test_a_human_commit_is_not_exempt(self):
        log = git("log", "--format=%H|%an|%ae", "HEAD")
        human = [row.split("|")[0] for row in log.split("\n")
                 if row.strip() and "github-actions[bot]" not in row]
        self.assertTrue(human, "expected human commits in history")
        self.assertFalse(own.commit_is_from_bot(human[0]))
class TestScope(unittest.TestCase):
    def test_default_scope_is_branch_new_commits_only(self):
        # Scanning all history flags ~40 commits, including legitimate repairs.
        src = (ROOT / "scripts" / "data_ownership.py").read_text(encoding="utf-8")
        self.assertIn('"origin/main..HEAD"', src)

    def test_the_bot_exemption_matches_real_bot_commits(self):
        # The cron commits are the legitimate writers of data/. If the bot identity
        # stopped matching them, every refresh would start failing CI and the check
        # would get switched off within a day.
        #
        # One git log rather than two calls per commit: the previous version asked git
        # about each of 332 commits separately and dominated this suite's runtime.
        log = git("log", "--format=%H|%an|%ae|%s", "HEAD")
        bot_rows = [row for row in log.split("\n")
                    if "github-actions[bot]" in row]
        self.assertTrue(bot_rows, "expected bot commits in history")
        offenders = own.offending_commits("HEAD")
        # Every offender must be a human commit: a bot commit in the offender list
        # would mean the cron's own refresh is being rejected.
        for sha, _files in offenders:
            row = next((r for r in log.split("\n") if r.startswith(sha)), "")
            self.assertNotIn("github-actions[bot]", row,
                             "bot commit %s was not exempted" % sha[:9])


class TestAnUnresolvableBaseIsAnError(unittest.TestCase):
    """A check that cannot run must not report success.

    `git rev-list` against a missing ref exits 0 and prints nothing, so the obvious
    implementation reads a shallow clone - which has no origin/main - as "no
    offending commits". The check would pass having examined nothing, which is the
    exact failure mode it exists to prevent.
    """

    def test_base_ref_existence_is_reported(self):
        ok, why = own.base_ref_exists("origin/definitely-not-a-ref..HEAD")
        self.assertFalse(ok)
        self.assertIn("origin/definitely-not-a-ref", why)

    def test_a_real_base_is_found(self):
        ok, _ = own.base_ref_exists("origin/main..HEAD")
        self.assertTrue(ok)

    def test_asking_for_a_missing_range_raises(self):
        with self.assertRaises(own.UnknownBase):
            own.offending_commits("origin/definitely-not-a-ref..HEAD")

    def test_the_cli_exits_nonzero_rather_than_passing(self):
        import subprocess
        proc = subprocess.run(
            [sys.executable, "scripts/data_ownership.py",
             "--rev-list", "origin/definitely-not-a-ref..HEAD"],
            capture_output=True, text=True, cwd=str(ROOT))
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn("could not run", proc.stderr)


class TestScanCost(unittest.TestCase):
    def test_it_is_one_git_call_not_three_per_commit(self):
        # 332 commits x 2 subprocesses was most of this suite's wall clock for a
        # check that should be instant.
        import subprocess
        calls = []
        real = subprocess.run

        def counting(args, **kwargs):
            calls.append(args)
            return real(args, **kwargs)

        subprocess.run = counting
        try:
            own.offending_commits("HEAD")
        finally:
            subprocess.run = real
        self.assertLessEqual(len(calls), 3,
                             "expected a single git log plus rev-parse, got %d calls"
                             % len(calls))


class TestTheCheckItselfRuns(unittest.TestCase):
    def test_it_exits_zero_on_a_clean_range(self):
        proc = subprocess.run([sys.executable, "scripts/data_ownership.py"],
                              capture_output=True, text=True, cwd=str(ROOT))
        self.assertEqual(proc.returncode, 0, proc.stdout[-300:])

    def test_list_mode_prints_the_set(self):
        proc = subprocess.run([sys.executable, "scripts/data_ownership.py", "--list"],
                              capture_output=True, text=True, cwd=str(ROOT))
        self.assertEqual(proc.returncode, 0)
        self.assertIn("data/milestones.json", proc.stdout)


if __name__ == "__main__":
    unittest.main()
