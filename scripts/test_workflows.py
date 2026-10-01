"""Static checks on the GitHub Actions workflows.

A workflow is only exercised when it runs, and a scheduled one may not run for
hours after a mistake lands. The human-rights workflow shipped with a step
invoking pytest in a job that never installed it - a guaranteed red run that
nobody would have seen until the schedule fired. These tests read the workflow
files instead of executing them, so the mistake is caught at commit time.

This is a deliberately conservative approximation: it audits the leading token of
each shell command, not full shell semantics.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW_DIR = ROOT / ".github" / "workflows"

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

# Tools present on a GitHub runner without an explicit install.
PREINSTALLED = {
    "python", "python3", "pip", "pip3", "bash", "sh", "git", "node", "npm",
    "npx", "wc", "grep", "sed", "awk", "curl", "date", "mkdir", "cp", "test",
}

# Shell keywords that begin a control structure rather than a command.
SHELL_KEYWORDS = {
    "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while",
    "case", "esac", "function", "echo", "exit", "set", "export", "cd", "true",
    "false", "return", "local", "readonly", "declare", "source",
}

_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_VERSION_SPEC = re.compile(r"[=<>~!\[;]")


def _workflows() -> list[Path]:
    return sorted(WORKFLOW_DIR.glob("*.yml"))


def _commands(run: str) -> list[str]:
    """Leading token of each logical command in a run block."""
    joined = run.replace("\\\n", " ")
    out = []
    for raw in joined.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        for sep in ("&&", "||", ";", "|"):
            line = line.replace(sep, "\n")
        for part in line.split("\n"):
            part = part.strip()
            if not part or part.startswith("#"):
                continue
            if _ASSIGNMENT.match(part):
                continue
            token = part.split()[0].strip("'\"")
            if not token or token.startswith("$"):
                continue
            base = token.split("/")[-1]
            if base in SHELL_KEYWORDS or base in PREINSTALLED:
                continue
            if token.endswith("="):
                continue
            out.append(base)
    return out


def _pip_packages(run: str) -> set:
    pkgs = set()
    for line in run.splitlines():
        line = line.strip()
        if not line.startswith("pip install"):
            continue
        for tok in line.split()[2:]:
            tok = tok.strip("'\"")
            if tok and not tok.startswith("-"):
                pkgs.add(_VERSION_SPEC.split(tok)[0].strip())
    return pkgs


class TestWorkflowDependencies(unittest.TestCase):
    """Any tool a step runs must have been installed by that job."""

    def test_no_step_runs_an_uninstalled_tool(self):
        if yaml is None:
            self.skipTest("pyyaml not available")
        problems = []
        for path in _workflows():
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
            for job_name, job in (data.get("jobs") or {}).items():
                steps = job.get("steps") or []
                installed = set(PREINSTALLED)
                for step in steps:
                    run = step.get("run") or ""
                    if "pip install" in run:
                        installed |= _pip_packages(run)
                    if "bun" in (step.get("uses") or ""):
                        installed.add("bun")
                for step in steps:
                    for token in _commands(step.get("run") or ""):
                        if token not in installed:
                            problems.append(
                                f"{path.name}:{job_name} runs {token!r} "
                                f"with no install step")
        self.assertEqual(problems, [], "\n".join(problems))

    def test_python_dash_m_modules_are_installed(self):
        # The check that would have caught the original bug. `python -m pytest`
        # has the leading token `python`, which is always present, so a
        # command-level audit sees nothing wrong - the missing thing is the
        # pytest *package*. Flag the module itself.
        import sys
        if yaml is None:
            self.skipTest("pyyaml not available")
        stdlib = set(sys.stdlib_module_names)
        problems = []
        for path in _workflows():
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
            for job_name, job in (data.get("jobs") or {}).items():
                steps = job.get("steps") or []
                installed = set()
                for step in steps:
                    run = step.get("run") or ""
                    if "pip install" in run:
                        installed |= _pip_packages(run)
                for step in steps:
                    run = (step.get("run") or "").replace("\\\n", " ")
                    for match in re.finditer(r"python3?\s+-m\s+([A-Za-z_][\w.]*)", run):
                        module = match.group(1).split(".")[0]
                        if module in stdlib or module in installed:
                            continue
                        problems.append(
                            f"{path.name}:{job_name} runs 'python -m {module}' "
                            f"with no pip install")
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_audit_is_not_vacuous(self):
        # Guards the parser above: if _commands stopped finding anything, this
        # test would still pass and the real check would be meaningless.
        sample = "set -euo pipefail\nif git diff --quiet; then\n  echo no\nfi\nts=$(date)\npytest -q\n"
        self.assertIn("pytest", _commands(sample))
        self.assertNotIn("ts=$(date", _commands(sample))
        self.assertNotIn("set", _commands(sample))
        self.assertNotIn("if", _commands(sample))


class TestFetchWorkflowsAreDataOnly(unittest.TestCase):
    """Fetch jobs gate on data validity; unit tests belong to CI."""

    FETCH_WORKFLOWS = ("human-rights-fetch.yml", "crisis-zone-fetch.yml")

    def _runs(self, name):
        data = yaml.safe_load((WORKFLOW_DIR / name).read_text(encoding="utf-8"))
        return "\n".join((s.get("run") or "")
                         for job in (data.get("jobs") or {}).values()
                         for s in (job.get("steps") or []))

    def test_fetch_jobs_validate_the_data_they_publish(self):
        if yaml is None:
            self.skipTest("pyyaml not available")
        for name in self.FETCH_WORKFLOWS:
            if not (WORKFLOW_DIR / name).exists():
                continue
            with self.subTest(workflow=name):
                self.assertIn("check_data.py", self._runs(name),
                              "a fetch job must validate the file it is about to commit")

    def test_fetch_jobs_do_not_run_unit_tests(self):
        # CI runs the test modules on every push; re-running them at fetch time
        # duplicates that and lets a test regression block a data refresh.
        if yaml is None:
            self.skipTest("pyyaml not available")
        for name in self.FETCH_WORKFLOWS:
            if not (WORKFLOW_DIR / name).exists():
                continue
            with self.subTest(workflow=name):
                text = (WORKFLOW_DIR / name).read_text(encoding="utf-8")
                self.assertNotIn("pytest", text)
                self.assertNotIn("unittest", text)


class TestDataWriterCoordination(unittest.TestCase):
    """Jobs that write world_layers.json must not collide."""

    WRITERS = ("crisis-zone-fetch.yml", "human-rights-fetch.yml")

    def _runs_all(self, name):
        data = yaml.safe_load((WORKFLOW_DIR / name).read_text(encoding="utf-8"))
        return "\n".join((s.get("run") or "")
                         for job in (data.get("jobs") or {}).values()
                         for s in (job.get("steps") or []))

    def test_world_layer_writers_share_one_concurrency_group(self):
        if yaml is None:
            self.skipTest("pyyaml not available")
        groups = {}
        for name in self.WRITERS:
            path = WORKFLOW_DIR / name
            if not path.exists():
                continue
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
            groups[name] = (data.get("concurrency") or {}).get("group")
        present = {k: v for k, v in groups.items() if v}
        if len(present) < 2:
            self.skipTest("fewer than two world_layers writers present")
        self.assertEqual(len(set(present.values())), 1,
                         f"world_layers.json writers use different concurrency groups: {present}")

    def test_data_writers_never_cancel_an_in_flight_write(self):
        # Cancelling mid-write truncates a data file. CI is allowed to cancel
        # superseded runs, so this is deliberately scoped to the writers only.
        if yaml is None:
            self.skipTest("pyyaml not available")
        for name in self.WRITERS:
            path = WORKFLOW_DIR / name
            if not path.exists():
                continue
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
            conc = data.get("concurrency") or {}
            if not conc:
                continue
            with self.subTest(workflow=name):
                self.assertIn(conc.get("cancel-in-progress"), (False, None))

    def test_writers_rebase_before_a_rejected_push(self):
        # A scheduled run races any manual push. Without a rebase-and-retry the
        # refresh is silently dropped, and the log still says it succeeded.
        if yaml is None:
            self.skipTest("pyyaml not available")
        for name in self.WRITERS:
            path = WORKFLOW_DIR / name
            if not path.exists():
                continue
            runs = self._runs_all(name)
            with self.subTest(workflow=name):
                self.assertIn("git pull --rebase", runs)


if __name__ == "__main__":
    unittest.main(verbosity=2)