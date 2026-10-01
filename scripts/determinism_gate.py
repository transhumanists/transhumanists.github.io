"""The determinism gate that CI runs, as an executable, testable module.

The check lives in .github/workflows/ci.yml, where a logic error is invisible
until a workflow run fails - and the first version of it did exactly that: it
compared bytes, every output carries a fresh `last_update` stamp, so it failed on
every run. Having the comparison here means the rule can be tested directly
against real outputs instead of being discovered through a red build.

Mirrored into the workflow deliberately; scripts/test_determinism_gate.py fails if
the two drift.
"""

from __future__ import annotations

import json
from pathlib import Path

# Wall-clock stamps differ between any two runs by construction, so they are not
# evidence of nondeterminism.
VOLATILE_KEYS = {"last_update"}

# Only the files this pipeline produces. world_layers.json comes from
# sync_layers.py / the fetchers and is not regenerated here.
COMPARED_FILES = ("events.json", "milestones.json")


def load_stable(path: Path | str) -> dict:
    """Load a generated data file with volatile keys removed."""
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return {k: v for k, v in data.items() if k not in VOLATILE_KEYS}


def first_difference(a, b, path: str = "") -> str | None:
    """Human-readable path to the first structural difference, or None if equal.

    Diffing two 40KB JSON files in a CI log tells nobody anything; naming the
    exact field does.
    """
    if type(a) is not type(b):
        return f"{path}: type {type(a).__name__} vs {type(b).__name__}"
    if isinstance(a, dict):
        for key in sorted(set(a) | set(b)):
            if key not in a or key not in b:
                return f"{path}.{key}: present in only one run"
            diff = first_difference(a[key], b[key], f"{path}.{key}")
            if diff:
                return diff
        return None
    if isinstance(a, list):
        if len(a) != len(b):
            return f"{path}: length {len(a)} vs {len(b)}"
        for i, (ai, bi) in enumerate(zip(a, b)):
            diff = first_difference(ai, bi, f"{path}[{i}]")
            if diff:
                return diff
        return None
    return None if a == b else f"{path}: {a!r} vs {b!r}"


def compare_runs(dir_a: Path | str, dir_b: Path | str) -> list[str]:
    """Compare two generation output directories. Returns a list of failures."""
    dir_a, dir_b = Path(dir_a), Path(dir_b)
    failures = []
    for name in COMPARED_FILES:
        # The pipeline writes to <output-dir>/data/.
        a_path, b_path = dir_a / "data" / name, dir_b / "data" / name
        if not a_path.exists() or not b_path.exists():
            failures.append(f"{name}: missing from one or both runs "
                            f"({a_path.exists=}, {b_path.exists=})")
            continue
        a, b = load_stable(a_path), load_stable(b_path)
        if a != b:
            failures.append(f"{name}: {first_difference(a, b)}")
    return failures


def assert_deterministic(dir_a: Path | str, dir_b: Path | str) -> None:
    failures = compare_runs(dir_a, dir_b)
    if failures:
        raise AssertionError(
            "Regeneration is not deterministic:\n  " + "\n  ".join(failures))