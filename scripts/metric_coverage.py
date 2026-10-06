#!/usr/bin/env python3
"""Metric coverage: are the published milestones still comparable to each other?

Why this exists
---------------
The scrapers got much better at FINDING milestones. They got worse at finding
the *metric* inside one. A record whose `value` is its own title renders on the
dashboard as a number-shaped blank: it counts, it appears, and it can never be
compared against anything. That regression is invisible in every existing check,
because `check_data.py` validates the SHAPE of a metric (present, right types) and
not whether it is a metric at all - and because widening the source list makes the
raw count go up, which reads as progress.

Two questions this answers per (category, subcategory):

1. **Comparability rate** - what share of records carry a numeric value with a
   unit? That is the share which can be plotted on the metric timeline, ranked
   against its siblings, and superseded when beaten.
2. **Unit coherence** - do all the records in a subcategory quote the same unit?
   This is the subtler half of "comparable", and it is the one that actually
   breaks the dashboard: `qubit_count` records in "qubits" and "physical qubits"
   are both numeric, still cannot be ranked against each other, and look fine to
   every shape check.

Usage
-----
    python scripts/metric_coverage.py            # human report
    python scripts/metric_coverage.py --json     # machine-readable
    python scripts/metric_coverage.py --gate     # exit 1 on regression

`--gate` is the part CI runs. It fails when a subcategory that was previously
comparable stops being comparable, when unit incoherence appears, or when a
subcategory's comparability drops below `--floor`. Read-only: it never fails on a
record being *added*, only on the published set getting harder to compare.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"

# A number with optional magnitude prefix and optional thousands separators.
# Deliberately strict about what counts as a value: a bare "2026" is a year, not a
# measurement, and treating every 4-digit integer as a metric would report full
# coverage on a dataset that has none.
NUMBER_RE = re.compile(
    r"^[\s~(]*[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?[\s~)]*$"  # 1,234,567
    r"|^[\s~(]*[-+]?\d+(?:\.\d+)?\s*[a-zA-Zµμ°%]*[\s~)]*$"  # 1234, 12.5, 5 GPa
)

# A year on its own, or a bare date fragment. Never a metric on its own.
_YEAR_RE = re.compile(r"^(1[89]\d{2}|20\d{2})$")


def _clean(value: object) -> str:
    return "" if value is None else str(value).strip()


def numeric_value(value: object) -> float | None:
    """The number a `value` field represents, or None when it is not one.

    Returns None for prose, for a bare year, and for anything with a unit glued
    onto the end that is not a plain magnitude. Callers that want the magnitude
    with its unit should read both fields.
    """
    s = _clean(value)
    if not s:
        return None
    if _YEAR_RE.match(s.replace(",", "")):
        return None
    if not NUMBER_RE.match(s):
        return None
    # Strip grouping separators, then the sign/magnitude wrappers the regex
    # deliberately allowed through.
    core = s.replace(",", "").strip("~() \t")
    core = re.sub(r"\s*[a-zA-Zµμ°%]+$", "", core).strip()
    try:
        return float(core)
    except ValueError:
        return None


def metric_shape(record: dict) -> str:
    """`numeric`, `unitless` or `prose`.

    `numeric`   - a number AND a unit. Comparable, plottable, supersedable.
    `unitless`  - a number but no unit. Rankable within the subcategory only if
                  its siblings are equally unitless; still not comparable to a
                  record that has one.
    `prose`     - no number at all. Upstream publishes the title as the value for
                  a milestone with no metric, which is the honest fallback and
                  the thing this report exists to make visible.
    """
    value = _clean(record.get("value"))
    unit = _clean(record.get("unit"))
    number = numeric_value(value)
    if number is None:
        return "prose"
    return "numeric" if unit else "unitless"


def unit_key(record: dict) -> str:
    """Normalised unit for comparison: 'm/s' and 'm/s.' are one unit."""
    u = _clean(record.get("unit")).lower().strip(" .")
    return u


# Units that mean the same physical thing. Comparability is about the quantity,
# so 1 GPa and 1 GPa are one unit, and "MW" and "MW (thermal)" are not - the
# second is a different quantity wearing the same letters.
UNIT_ALIASES = {
    "m/s": "metres_per_second",
    "kmh": "kilometres_per_hour",
    "km/h": "kilometres_per_hour",
    "mw": "megawatt",
    "gw": "gigawatt",
    "kw": "kilowatt",
    "kwh": "kilowatt_hour",
    "qubits": "qubits",
    "logical qubits": "logical_qubits",
    "physical qubits": "physical_qubits",
    "years": "years",
    "days": "days",
    # The same quantity, spelled two ways. Collapsing these raises coherence for
    # free and stops the gate blaming a real regression for a cosmetic split.
    "%": "percent",
    "pct": "percent",
    "per cent": "percent",
    "usd": "usd",
    "$": "usd",
}


def comparable_unit(record: dict) -> str:
    """The unit, normalised just enough to compare two spellings of one unit.

    Conservative on purpose. Case, whitespace and trailing punctuation are noise.
    A parenthetical qualifier is NOT noise: "physical qubits" and "logical qubits"
    are different quantities that must never be ranked against each other, so
    those stay distinct and stay flagged.
    """
    u = unit_key(record)
    if not u:
        return ""
    return UNIT_ALIASES.get(u, u)


def group_key(g: dict) -> str:
    return f"{g['category']}/{g['subcategory']}"


def iter_records(data_dir: Path):
    """Every published milestone, from the live feed and the archive.

    Both files, because the archive is the per-metric timeline the dashboard
    ranks against: a subcategory whose only numeric records are historical has not
    lost comparability, it has stopped producing new comparisons.
    """
    seen: set[str] = set()
    for name in ("milestones.json", "milestones_history.json"):
        path = data_dir / name
        if not path.exists():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        records: list[dict] = []
        if isinstance(payload, list):
            records = [r for r in payload if isinstance(r, dict)]
        elif isinstance(payload, dict):
            for cat in (payload.get("categories") or {}).values():
                if isinstance(cat, dict):
                    records.extend(r for r in (cat.get("milestones") or []) if isinstance(r, dict))
        for rec in records:
            ident = _clean(rec.get("id"))
            # The live feed and the archive overlap; a record counted twice would
            # halve every rate below.
            key = ident or (_clean(rec.get("title")) + "|" + _clean(rec.get("date")))
            if key in seen:
                continue
            seen.add(key)
            yield rec


def build_report(data_dir: Path) -> dict:
    buckets: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for rec in iter_records(data_dir):
        cat = _clean(rec.get("category")) or "(uncategorised)"
        sub = _clean(rec.get("subcategory")) or "general"
        buckets[(cat, sub)].append(rec)

    groups = []
    for (cat, sub), records in sorted(buckets.items()):
        shapes = [metric_shape(r) for r in records]
        total = len(records)
        numeric = shapes.count("numeric")
        unitless = shapes.count("unitless")
        prose = shapes.count("prose")
        units = defaultdict(int)
        for r in records:
            if metric_shape(r) != "prose":
                units[comparable_unit(r) or "(no unit)"] += 1
        ranked = sorted(units.items(), key=lambda kv: (-kv[1], kv[0]))
        # Unit coherence: the largest share of this subcategory's units. Below one
        # means the numbers are not comparable to each other, however many there
        # are.
        coherence = (ranked[0][1] / sum(units.values())) if units else 0.0
        groups.append(
            {
                "category": cat,
                "subcategory": sub,
                "records": total,
                "numeric": numeric,
                "unitless": unitless,
                "prose": prose,
                "comparable_rate": round(numeric / total, 3) if total else 0.0,
                "units": dict(ranked),
                "unit_coherence": round(coherence, 3),
                "incoherent": bool(units) and coherence < 1.0,
                "newest": max((_clean(r.get("date")) for r in records), default=""),
            }
        )

    overall = {
        "records": sum(g["records"] for g in groups),
        "numeric": sum(g["numeric"] for g in groups),
        "unitless": sum(g["unitless"] for g in groups),
        "prose": sum(g["prose"] for g in groups),
    }
    overall["comparable_rate"] = (
        round(overall["numeric"] / overall["records"], 3) if overall["records"] else 0.0
    )
    return {
        "generated": date.today().isoformat(),
        "overall": overall,
        "groups": groups,
    }


def format_report(report: dict) -> str:
    o = report["overall"]
    lines = [
        "metric coverage — how much of the published set can be compared",
        "",
        "  %-28s %-22s %5s %6s %8s  %s"
        % ("category", "subcategory", "recs", "cmp", "coherence", "units"),
    ]
    for g in sorted(report["groups"], key=lambda g: (g["category"], g["subcategory"])):
        units = ", ".join(f"{k}x{v}" for k, v in list(g["units"].items())[:3]) or "-"
        if len(g["units"]) > 3:
            units += f", +{len(g['units']) - 3} more"
        flag = ""
        if g["incoherent"]:
            flag = "  <-- mixed units"
        elif g["comparable_rate"] < 0.5 and g["records"] >= 3:
            flag = "  <-- mostly prose"
        lines.append(
            "  %-28s %-22s %5d %6d %8.2f  %s%s"
            % (
                g["category"][:28],
                g["subcategory"][:22],
                g["records"],
                g["numeric"],
                g["unit_coherence"],
                units,
                flag,
            )
        )
    lines += [
        "",
        "  total %d records · %d comparable (%.1f%%) · %d unitless · %d prose"
        % (o["records"], o["numeric"], 100 * o["comparable_rate"], o["unitless"], o["prose"]),
        "",
        "  'cmp' is the count of records carrying a number AND a unit.",
        "  'coherence' is the largest share of any one unit in the subcategory:",
        "  below 1.00 means the numbers there cannot be ranked against each other.",
    ]
    return "\n".join(lines)


def _baseline_path(data_dir: Path) -> Path:
    return data_dir / "metric_coverage_baseline.json"


def load_baseline(data_dir: Path) -> dict:
    path = _baseline_path(data_dir)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    groups = payload.get("groups")
    return groups if isinstance(groups, dict) else {}


def build_baseline(report: dict) -> dict:
    """Accept today's state as the reference, so the gate catches drift from here.

    Deliberately records the debt rather than pretending it is absent: every
    incoherent subcategory is listed, at its current coherence. Nothing here
    claims the dataset is fine.
    """
    return {
        "_comment": (
            "Accepted state of metric comparability, written by "
            "scripts/metric_coverage.py --update-baseline. The gate fails only when a "
            "subcategory gets LESS comparable than recorded here, so this file is a "
            "ratchet: improve it deliberately, never let it drift downward silently."
        ),
        "generated": report["generated"],
        "groups": {
            group_key(g): {
                "coherence": g["unit_coherence"],
                "comparable_rate": g["comparable_rate"],
                "records": g["records"],
            }
            for g in report["groups"]
        },
    }


def evaluate_gate(report: dict, baseline: dict, floor: float) -> list[str]:
    """Reasons the gate fails. Empty list means green.

    The baseline is what makes this gate useful. Comparability is currently poor
    across most subcategories - that is real, existing debt - and a gate that
    fails on all of it from day one is a gate nobody reads. So:

      * incoherence already recorded in the baseline is a known issue, not a
        failure, UNLESS its coherence has dropped further;
      * a subcategory that is incoherent and absent from the baseline IS a
        failure, because that is a new problem introduced since the baseline;
      * comparable_rate falling below the baseline value is a failure;
      * comparable_rate below `floor` is only a failure for a subcategory the
        baseline shows should be doing better.

    Adding records never fails. Adding a *metric-less* record to a subcategory
    whose rate is already low does not fail either - only the rate going down
    from where it was does.
    """
    problems: list[str] = []
    for g in report["groups"]:
        name = group_key(g)
        known = baseline.get(name)

        if g["incoherent"]:
            units = ", ".join(sorted(g["units"]))
            if known is None:
                problems.append(
                    f"{name}: metrics are not comparable to each other and this "
                    f"subcategory is not in the baseline "
                    f"(coherence {g['unit_coherence']:.2f}; units: {units})"
                )
            elif g["unit_coherence"] < known.get("coherence", 1.0) - 1e-9:
                problems.append(
                    f"{name}: unit coherence fell from {known['coherence']:.2f} to "
                    f"{g['unit_coherence']:.2f} (units: {units})"
                )

        if known is None:
            # Brand new subcategory. Only hold it to the floor if it has enough
            # records to mean something.
            if g["records"] >= 3 and g["comparable_rate"] < floor:
                problems.append(
                    f"{name}: new subcategory with comparable rate "
                    f"{g['comparable_rate']:.2f} below floor {floor:.2f} "
                    f"({g['numeric']}/{g['records']})"
                )
            continue

        if g["comparable_rate"] < known.get("comparable_rate", 0.0) - 1e-9:
            problems.append(
                f"{name}: comparable rate fell from "
                f"{known['comparable_rate']:.2f} to {g['comparable_rate']:.2f} "
                f"({g['numeric']}/{g['records']} records)"
            )
    return problems


def main(argv: list[str] | None = None) -> int:
    # Pin stdout/stderr to UTF-8 before anything prints.
    #
    # The tables carry U+00B7 middle dots, and Python encodes to the *locale*
    # encoding when a stream is attached to a console -- cp1252 on a stock
    # Windows host, where 0x97 is the middle dot. A caller that reads the output
    # as UTF-8 (every other script in this repo, and the test suite) then gets a
    # UnicodeDecodeError and, with capture_output, an empty stdout rather than a
    # traceback -- so the failure surfaces as "metric gate FAILED" missing from
    # an empty string, which names neither the encoding nor the script.
    #
    # errors="replace" rather than "strict" so a character with no cp1252
    # equivalent degrades to "?" instead of raising mid-report, which would
    # leave a half-printed table and a traceback instead of a readable one.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):  # not a TextIOWrapper, or detached
            pass

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--data-dir", default=str(DATA_DIR), help="directory containing data/ (default: the repo's)"
    )
    ap.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    ap.add_argument(
        "--gate",
        action="store_true",
        help="exit non-zero when comparability regresses from the baseline",
    )
    ap.add_argument(
        "--floor",
        type=float,
        default=0.25,
        help="minimum comparable rate for a new subcategory of 3+ records",
    )
    ap.add_argument(
        "--update-baseline",
        action="store_true",
        help="record the current state as the accepted baseline",
    )
    args = ap.parse_args(argv)

    data_dir = Path(args.data_dir)
    report = build_report(data_dir)

    if args.update_baseline:
        path = _baseline_path(data_dir)
        path.write_text(
            json.dumps(build_baseline(report), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print("baseline written: %s (%d subcategories)" % (path.name, len(report["groups"])))
        return 0

    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(format_report(report))

    if args.gate:
        baseline = load_baseline(data_dir)
        problems = evaluate_gate(report, baseline, args.floor)
        if problems:
            print("\nmetric gate FAILED:")
            for p in problems:
                print("  - " + p)
            return 1
        if not args.json:
            print("\nmetric gate: OK (%d subcategories within baseline)" % len(report["groups"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
