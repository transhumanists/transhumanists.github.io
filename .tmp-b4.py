import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
L = open("assets/js/worldmap.js", encoding="utf-8").read().split("\n")

print("=== requestDraw: is there an in-flight guard? ===")
for k in range(1897, 1915):
    print("%5d %s" % (k + 1, L[k][:112]))

print()
print("=== callers of dismissTooltipIfTargetHidden ===")
for i, l in enumerate(L):
    if "dismissTooltipIfTargetHidden()" in l and "function " not in l:
        print("%5d %s" % (i + 1, l.strip()[:112]))

print()
print("=== does draw() call it, and does draw() guard re-entry? ===")
seg = "\n".join(L[1234:1300])
print("  draw() calls dismissTooltipIfTargetHidden:", "dismissTooltipIfTargetHidden" in seg)
print(
    "  module-level 'drawing' guard present:",
    bool(re.search(r"\bdrawing\b|\binDraw\b|isDrawing", "\n".join(L))),
)
