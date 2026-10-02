import json
d = json.load(open('data/milestones.json', encoding='utf-8'))
print(f'Categories: {list(d["categories"].keys())}')
total = sum(len(c["milestones"]) for c in d["categories"].values())
print(f'Total milestones: {total}')
from collections import Counter
urls = [m.get("url") for c in d["categories"].values() for m in c["milestones"]]
print('URL schemes:', Counter(u.split(":",1)[0].lower() if isinstance(u,str) and ":" in u else "(none)" for u in urls))
# Check for non-http(s)
bad = [u for u in urls if isinstance(u,str) and not u.startswith(("http://","https://")) and u.strip()]
print(f"Non-http(s) URLs: {bad[:5]}")