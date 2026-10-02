path = r'C:\Users\skele\Documents\GitHub Manager\transhumanists.github.io\scripts\check_data.py'
with open(path, 'r') as f:
    content = f.read()

marker = '    return issues\n\n\ndef check_data'
new_func = '''return issues


def check_milestones(data: object) -> list[str]:
    """Validate the canonical milestones archive that feeds the dashboard,
    widgets, and the timeline slider's year clustering. Mirrors the shapes
    the front end expects in assets/js/neohiro-widgets.js and the timeline
    code in assets/js/worldmap.js."""
    issues: list[str] = []
    if not isinstance(data, dict):
        return ["top-level JSON must be an object"]
    header_issues = _check_header(data)
    if header_issues:
        issues.extend(header_issues)
    cats = data.get("categories")
    if not isinstance(cats, dict):
        issues.append("categories must be an object")
    else:
        for cat_key, cat in cats.items():
            if not isinstance(cat, dict):
                issues.append(f"categories[{cat_key}]: must be an object")
                continue
            milestones = cat.get("milestones")
            if not isinstance(milestones, list):
                issues.append(f"categories[{cat_key}].milestones: must be a list")
                continue
            for i, m in enumerate(milestones):
                if not isinstance(m, dict):
                    issues.append(f"categories[{cat_key}].milestones[{i}]: entry must be an object")
                    continue
                if not isinstance(m.get("id"), str):
                    issues.append(f"categories[{cat_key}].milestones[{i}].id: must be a string")
                if not isinstance(m.get("title"), str):
                    issues.append(f"categories[{cat_key}].milestones[{i}].title: must be a string")
                if not isinstance(m.get("category"), str):
                    issues.append(f"categories[{cat_key}].milestones[{i}].category: must be a string")
                if not isinstance(m.get("subcategory"), str):
                    issues.append(f"categories[{cat_key}].milestones[{i}].subcategory: must be a string")
                if not _valid_event_date(m.get("date")):
                    issues.append(f"categories[{cat_key}].milestones[{i}].date: must be a parseable date string")
                geo = m.get("geolocation")
                if not isinstance(geo, dict) or not _coord_ok(geo.get("lat"), geo.get("lon")):
                    issues.append(f"categories[{cat_key}].milestones[{i}].geolocation: must be a finite lat/lon pair in range")
                if not _valid_source_url(m.get("url")):
                    issues.append(
                        f"categories[{cat_key}].milestones[{i}].url: must be absent or an http(s) URL, got {m.get('url')!r}"
                    )
                for flag in ("is_record", "is_breakthrough", "is_new"):
                    if flag in m and not isinstance(m[flag], bool):
                        issues.append(f"categories[{cat_key}].milestones[{i}].{flag}: must be a boolean if present")
    return issues


def check_data'''

new_content = content.replace(marker, new_func)
with open(path, 'w') as f:
    f.write(new_content)
print('Done')