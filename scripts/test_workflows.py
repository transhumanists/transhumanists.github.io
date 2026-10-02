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


def _bunx_tools(run: str):
    """Tool names launched through `bunx` in a run block."""
    out = set()
    for raw in run.replace("\\\n", " ").splitlines():
        for m in re.finditer(r"\bbunx\s+([\w@/.-]+)", raw):
            name = m.group(1).rsplit("/", 1)[-1]
            out.add(name.lstrip("@"))
    return out


def _node_dev_dependencies():
    """Names in package.json that a `bun install` step puts on disk.

    `bunx playwright` resolves the locally installed @playwright/test rather than
    fetching from the network, so it counts as installed - provided the job also runs
    `bun install`, which the token audit below enforces separately.
    """
    import json
    import pathlib

    pkg = pathlib.Path(__file__).resolve().parents[1] / "package.json"
    if not pkg.is_file():
        return set()
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
    except ValueError:
        return set()
    names = set()
    for key in ("dependencies", "devDependencies"):
        for dep in (data.get(key) or {}):
            names.add(dep.split("@")[0] if not dep.startswith("@") else dep.split("@")[1])
    return names


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

                # Per job, not per line: a `bun install` step makes every bunx tool
                # used anywhere in that job resolvable. Matching the tool inside the
                # install line itself finds nothing, because that line never names a
                # tool - which is how the previous version passed while checking
                # nothing.
                installed = set(PREINSTALLED) | _node_dev_dependencies()
                has_node_install = False
                bunx_tools = set()
                for step in steps:
                    run = step.get("run") or ""
                    if "pip install" in run:
                        installed |= _pip_packages(run)
                    if "bun install" in run:
                        installed.add("bun")
                        has_node_install = True
                    if "bun" in (step.get("uses") or ""):
                        installed.add("bun")
                    bunx_tools |= _bunx_tools(run)
                if has_node_install:
                    installed |= {"bunx:" + t for t in bunx_tools}
                    installed.add("bunx")

                for step in steps:
                    run = step.get("run") or ""
                    for token in _commands(run):
                        if token == "bunx":
                            # Report the tool, not just the launcher, so a failure
                            # says what was unresolvable.
                            for tool in _bunx_tools(run):
                                if "bunx:" + tool not in installed:
                                    problems.append(
                                        f"{path.name}:{job_name} runs "
                                        f"`bunx {tool}` with no install step")
                            continue
                        if token not in installed:
                            problems.append(
                                f"{path.name}:{job_name} runs {token!r} "
                                f"with no install step")

                if bunx_tools and not has_node_install:
                    problems.append(
                        f"{path.name}:{job_name} uses bunx "
                        f"({', '.join(sorted(bunx_tools))}) with no `bun install`")

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




class TestLockfileMatchesThePinnedToolchain(unittest.TestCase):
    """bun.lock must be readable by the Bun that CI installs.

    This bit once already: running `bun install` under a newer Bun rewrote the lockfile
    in the newer text format, CI's Bun 1.2.14 could not parse it, and every job in the
    browser-layout workflow failed at "Install deps" before running a single check. The
    failure was loud but far from the cause.
    """

    def _lockfile_version(self):
        import pathlib

        lock = pathlib.Path(__file__).resolve().parents[1] / "bun.lock"
        self.assertTrue(lock.is_file(), "bun.lock is missing")
        raw = lock.read_text(encoding="utf-8").strip()
        self.assertTrue(
            raw.startswith("{"),
            "bun.lock is not JSON; a newer Bun wrote it in its text format, which the "
            "Bun version CI pins cannot parse. Regenerate it with that version: "
            "`bun install` under the pinned Bun.")
        # Not json.loads: Bun emits trailing commas, so the file is JSON5-ish and a
        # strict parse fails on exactly the line after the version.
        import re

        m = re.search(r'"lockfileVersion"\s*:\s*(\d+)', raw)
        self.assertIsNotNone(m, "bun.lock has no lockfileVersion")
        return int(m.group(1))

    def test_lockfile_is_the_version_ci_can_read(self):
        import re
        import pathlib

        root = pathlib.Path(__file__).resolve().parents[1]
        ci = (root / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        pinned = set(re.findall(r'bun-version:\s*"([\d.]+)"', ci))
        self.assertTrue(pinned, "CI no longer pins a bun-version")
        # Bun 1.2.x writes lockfileVersion 1; the text format arrived later.
        oldest = min(pinned, key=lambda v: [int(p) for p in v.split(".")])
        major_minor = [int(p) for p in oldest.split(".")[:2]]
        expected = 1 if major_minor <= [1, 2] else None
        self.assertIsNotNone(expected, "unexpected pinned Bun %s" % oldest)
        self.assertEqual(self._lockfile_version(), expected)

    def test_the_bunx_audit_is_not_vacuous(self):
        # The audit trusts that `bun install` makes a bunx tool available. If
        # _bunx_tools stopped finding anything the audit would pass on every job
        # that uses bunx, so it gets its own guard.
        self.assertEqual(_bunx_tools("bunx playwright test"),
                         {"playwright"})
        self.assertEqual(_bunx_tools("bun x playwright install"), set())
        self.assertEqual(_bunx_tools("bun install --frozen-lockfile"), set())

    def test_the_version_file_matches_every_ci_pin(self):
        # .bun-version exists so a contributor does not have to go and read the
        # workflow to learn the expected toolchain. It is only useful if it agrees
        # with automation, so that is what is asserted.
        import pathlib

        import verify_release

        root = pathlib.Path(__file__).resolve().parents[1]
        f = root / ".bun-version"
        self.assertTrue(f.is_file(), ".bun-version is missing")
        pinned = f.read_text(encoding="utf-8").strip()
        self.assertEqual(pinned, verify_release.CI_BUN_VERSION)

        ci = (root / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        import re as _re

        in_ci = set(_re.findall(r'bun-version:\s*"([\d.]+)"', ci))
        self.assertEqual(len(in_ci), 1, "CI pins more than one bun version: %s" % in_ci)
        self.assertEqual(pinned, in_ci.pop())

    def test_the_browser_job_pins_bun_explicitly(self):
        # It has to install dependencies, so a lockfile it cannot read is fatal there.
        import pathlib

        root = pathlib.Path(__file__).resolve().parents[1]
        ci = (root / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertIn("browser-layout:", ci)
        job = ci.split("browser-layout:", 1)[1].split("\n  data-check:", 1)[0]
        self.assertIn("bun-version", job)
        self.assertIn("--frozen-lockfile", job)

    def test_package_json_exists_for_the_lockfile_to_belong_to(self):
        # bun.lock already referenced @playwright/test while package.json was absent,
        # which is why the install step had nothing to resolve against.
        import json
        import pathlib

        root = pathlib.Path(__file__).resolve().parents[1]
        pkg = root / "package.json"
        self.assertTrue(pkg.is_file(), "package.json is missing")
        data = json.loads(pkg.read_text(encoding="utf-8"))
        self.assertIn("@playwright/test",
                      (data.get("devDependencies") or {}))


class TestVerifyReleaseBrowserStep(unittest.TestCase):
    """The browser step must be decided before it runs, not inferred afterwards.

    The first version ran `bun x playwright test` and treated a "Cannot find
    package" message as "not installed". `bun x` does not emit that: it resolves and
    downloads the package. So the skip could never fire, and a verification run
    silently mutated node_modules and rewrote the lockfile while claiming to only
    check things.
    """

    def _verify(self):
        import pathlib
        import sys

        root = pathlib.Path(__file__).resolve().parents[1]
        sys.path.insert(0, str(root / "scripts"))
        import verify_release

        return verify_release

    def test_detection_is_a_filesystem_check(self):
        vr = self._verify()
        self.assertTrue(callable(vr._playwright_installed))
        # It reads node_modules rather than shelling out, so it cannot install.
        import inspect

        src = inspect.getsource(vr._playwright_installed)
        self.assertNotIn("subprocess", src)
        self.assertIn("node_modules", src)

    def test_it_reports_the_current_machine_correctly(self):
        vr = self._verify()
        installed = vr._playwright_installed()
        self.assertIsInstance(installed, bool)
        self.assertEqual(installed, (vr.ROOT / "node_modules" / "@playwright" / "test").is_dir())

    def test_the_browser_step_is_omitted_when_not_installed(self):
        vr = self._verify()
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            labels = [label for label, _ in
                      vr._build_steps("bun", tmpdir, True, False)]
            if vr._playwright_installed():
                self.assertIn("Browser layout checks", labels)
            else:
                self.assertNotIn("Browser layout checks", labels)

    def test_skip_browser_always_omits_it(self):
        vr = self._verify()
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            labels = [label for label, _ in
                      vr._build_steps("bun", Path(tmp), True, True)]
            self.assertNotIn("Browser layout checks", labels)

    def test_it_uses_the_local_binary_not_a_fetch(self):
        # `bun x` without a leading path can still resolve from the registry when the
        # package is absent; naming the binary does not change that, so the guarantee
        # comes from the up-front check instead. This asserts the step is only built
        # when the dependency is present.
        vr = self._verify()
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            argv = dict(vr._build_steps("bun", Path(tmp), True, False))
            if "Browser layout checks" in argv:
                self.assertEqual(argv["Browser layout checks"],
                                 ["bun", "x", "playwright", "test"])


class TestVerifyReleaseCoversCI(unittest.TestCase):
    """scripts/verify_release.py is the local mirror of CI.

    It only pays off if it keeps running what CI runs. Two pushes this session passed
    locally and went red in CI, so a check that exists in one place and not the other
    is the failure mode worth guarding against.
    """

    def _ci(self):
        import pathlib

        return pathlib.Path(__file__).resolve().parents[1] / ".github" / "workflows" / "ci.yml"

    def test_script_exists_and_is_executable_by_python(self):
        import pathlib
        import subprocess
        import sys

        script = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "verify_release.py"
        self.assertTrue(script.is_file())
        # --help must not need any third-party package.
        proc = subprocess.run([sys.executable, str(script), "--help"],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    # Shell plumbing rather than a check: not something the local mirror has to run.
    # `pip install` is dependency setup - the check that follows it is the one that
    # has to be mirrored.
    _SHELL_NOISE = ("set ", "export ", "mkdir", "cp ", "rm ", "test ", "grep ",
                    "echo ", "#", "-", "env:", "if ", "fi", "done", "pip ")

    def _ci_commands(self):
        """Every real command CI runs, as (program, line) pairs.

        Parsed generically rather than against a fixed list of known commands, so a
        genuinely new CI step - a linter, a bundler, anything - shows up as uncovered
        instead of being quietly ignored.
        """
        import pathlib
        import re

        root = pathlib.Path(__file__).resolve().parents[1]
        ci = (root / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

        commands = []
        for m in re.finditer(r"run:\s*(?:\|\s*)?([^\n]+)", ci):
            line = m.group(1).strip().strip("|").strip()
            if not line or line.startswith(self._SHELL_NOISE):
                continue
            program = line.split()[0].rsplit("/", 1)[-1]
            commands.append((program, line))
        return commands

    def test_ci_was_actually_parsed(self):
        cmds = self._ci_commands()
        self.assertGreaterEqual(len(cmds), 6,
                                "expected to parse the CI steps, got %r" % cmds)
        programs = {p for p, _ in cmds}
        self.assertTrue({"python", "bun"} <= programs | {"python3"},
                        "unexpected CI programs: %s" % sorted(programs))

    def test_every_ci_command_is_covered(self):
        """Each command CI runs must be reachable from verify_release.py.

        A python step that runs a ``scripts/test_*.py`` module counts as covered by
        the script's single ``pytest scripts/`` run - CI invokes those individually
        only so its summary shows which area failed. Anything else has to appear in
        the script by name.
        """
        import pathlib
        import re

        root = pathlib.Path(__file__).resolve().parents[1]
        script_src = (root / "scripts" / "verify_release.py").read_text(encoding="utf-8")

        uncovered = []
        for program, line in self._ci_commands():
            prog = program.lower()
            if prog in ("python", "python3"):
                if "-m pytest" in line or "pytest" in line:
                    continue
                mod = re.search(r"scripts/(\w+\.py)", line)
                if not mod:
                    uncovered.append(line)
                    continue
                name = mod.group(1)
                if name.startswith("test_") or name in script_src:
                    continue
                uncovered.append(line)
            elif prog in ("bun", "bunx"):
                # `bun install` and `bunx <tool> install` are dependency and browser
                # provisioning, the same category as `pip install`.
                if " install" in line:
                    continue
                if "test" in line or "build" in line:
                    # Both bun invocations the script makes; assert the payload below.
                    continue
                uncovered.append(line)
            else:
                # A tool CI uses that the local mirror has never heard of.
                uncovered.append(line)

        self.assertEqual(uncovered, [], "CI runs commands verify_release.py "
                                         "does not: %s" % uncovered)

    def test_the_script_actually_runs_the_js_steps_ci_runs(self):
        import pathlib

        root = pathlib.Path(__file__).resolve().parents[1]
        script_src = (root / "scripts" / "verify_release.py").read_text(encoding="utf-8")
        self.assertIn('"test", "test/"', script_src)
        self.assertIn("worldmap.js", script_src)
        self.assertIn("check_data.py", script_src)
        self.assertIn("determinism_gate.py", script_src)
        self.assertIn("sync_milestones.py", script_src)

    def test_the_unit_test_modules_are_all_discoverable_by_pytest(self):
        """The claim above only holds if pytest actually collects them."""
        import pathlib
        import subprocess
        import sys

        root = pathlib.Path(__file__).resolve().parents[1]
        proc = subprocess.run(
            [sys.executable, "-m", "pytest", "scripts/", "-q", "--collect-only"],
            cwd=str(root), capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stdout[-800:])
        for name in ("test_sync.py", "test_sync_layers.py",
                     "test_fetch_crisis_zones.py", "test_fetch_human_rights.py",
                     "test_determinism_gate.py", "test_geo_hints.py",
                     "test_workflows.py", "test_check_data.py"):
            self.assertIn(name, proc.stdout,
                          "%s is not collected by the pytest step" % name)

    def test_it_reports_the_pinned_bun_version(self):
        import pathlib

        import verify_release

        root = pathlib.Path(__file__).resolve().parents[1]
        ci = (root / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertIn(verify_release.CI_BUN_VERSION, ci,
                      "CI_BUN_VERSION no longer matches the workflow pin")

    def test_determinism_day_matches_ci(self):
        import pathlib

        import verify_release

        root = pathlib.Path(__file__).resolve().parents[1]
        ci = (root / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertIn(verify_release.DETERMINISM_TODAY, ci,
                      "DETERMINISM_TODAY no longer matches the workflow")

    def test_it_uses_only_the_standard_library(self):
        import ast
        import pathlib
        import sys

        stdlib = set(getattr(sys, "stdlib_module_names", ()))
        script = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "verify_release.py"
        tree = ast.parse(script.read_text(encoding="utf-8"))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(a.name.split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                imported.add(node.module.split(".")[0])
        third_party = imported - stdlib - {"verify_release"}
        self.assertEqual(third_party, set(),
                         "verify_release.py must run with no pip install")




if __name__ == "__main__":
    unittest.main(verbosity=2)
