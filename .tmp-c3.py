import sys
import pathlib
import re

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

p = pathlib.Path("scripts/coverage_report.py")
s = p.read_text(encoding="utf-8")

old = '''ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCES = ("data/milestones.json", "data/milestones_history.json",
                   "data/historical_milestones.json")'''
assert old in s
new = '''ROOT = Path(__file__).resolve().parent.parent

# Where the data files live, overridable so a caller can point the audit at a
# staging directory. Without this the script can only ever describe this checkout,
# which makes it impossible to test the failure path - the one that matters - and
# impossible to audit a candidate data set before committing it.
DATA_DIR = Path(os.environ.get("WORLDMAP_DATA_DIR") or (ROOT / "data"))'''
s = s.replace(old, new, 1)

s = s.replace("    path = ROOT / rel\n    if not path.exists():",
              "    path = DATA_DIR / rel\n    if not path.exists():", 1)

# DEFAULT_SOURCES are now bare filenames resolved against DATA_DIR.
s = s.replace('''DEFAULT_SOURCES = ("data/milestones.json", "data/milestones_history.json",
                   "data/historical_milestones.json")''', "", 1)

old_main = '''    r = build(args.min_year, args.max_year, DEFAULT_SOURCES)'''
assert old_main in s
s = s.replace(old_main, '''    r = build(args.min_year, args.max_year,
              tuple(p.name for p in (DATA_DIR, DATA_DIR) for p in [DATA_DIR])
              if False else DEFAULT_FILES)''', 1)

s = s.replace('''def main() -> int:''', '''DEFAULT_FILES = ("milestones.json", "milestones_history.json",
                 "historical_milestones.json")


def main() -> int:''', 1)

if "\nimport os" not in s:
    s = s.replace("import json\nimport sys", "import json\nimport os\nimport sys", 1)
p.write_text(s, encoding="utf-8")
print("coverage_report.py: DATA_DIR overridable, sources are filenames")
print(s[:1200])