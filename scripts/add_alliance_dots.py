"""One-shot: add the alliance_dots sublayer to data/world_layers.json.

Curated political/defence facts, so they are written once here rather than
fetched: every entry names the primary institutional source in `url`, which
check_data.py validates as http(s), and every date is the date that source
states. The client treats `last_news_year` as a recency signal and falls back to
`start_date`, which is what makes a 2024 accession glow and a 2017 one fade.

Also removes the two NATO-integration entries from `deployments`: they are
accessions, not movements, and the seal replaces the arrow rather than stacking
on top of it. The client still suppresses an arrow whose id matches a seal, so a
future upstream re-add is a no-op rather than a double mark.
"""

from __future__ import annotations

import json
from collections import OrderedDict
from pathlib import Path

TARGET = Path(__file__).resolve().parents[1] / "data" / "world_layers.json"

PROMOTED_IDS = {"inf-finland-2023-nato", "inf-sweden-2024-nato"}

# kind: accession | posture | mandate | industrial | capability
ALLIANCE_DOTS = [
    {
        "id": "alliance-finland-nato-2023",
        "name": "Finland accedes to NATO as 31st Ally",
        "region": "Northern Europe",
        "country": "Finland",
        "actor": "NATO",
        "kind": "accession",
        "lat": 60.1699,
        "lon": 24.9384,
        "status": "active",
        "start_date": "2023-04-04",
        "end_date": "",
        "note": "Instrument of accession deposited in Brussels, ending decades of Finnish military non-alignment.",
        "source": "NATO",
        "url": "https://www.nato.int/en/news-and-events/articles/news/2023/04/04/finland-joins-nato-as-31st-ally",
    },
    {
        "id": "alliance-sweden-nato-2024",
        "name": "Sweden accedes to NATO as 32nd Ally",
        "region": "Northern Europe",
        "country": "Sweden",
        "actor": "NATO",
        "kind": "accession",
        "lat": 59.3293,
        "lon": 18.0686,
        "status": "active",
        "start_date": "2024-03-07",
        "end_date": "",
        "note": "Ratified by Türkiye in January 2024 and Hungary in February 2024, then acceded.",
        "source": "NATO",
        "url": "https://www.nato.int/en/news-and-events/articles/news/2024/03/07/sweden-officially-joins-nato",
    },
    {
        "id": "alliance-north-macedonia-nato-2020",
        "name": "North Macedonia accedes to NATO as 30th Ally",
        "region": "Southeastern Europe",
        "country": "North Macedonia",
        "actor": "NATO",
        "kind": "accession",
        "lat": 41.9981,
        "lon": 21.4254,
        "status": "active",
        "start_date": "2020-03-27",
        "end_date": "",
        "note": "First enlargement since Albania and Croatia joined in April 2009.",
        "source": "NATO",
        "url": "https://www.nato.int/en/news-and-events/articles/news/2020/03/27/north-macedonia-joins-nato-as-30th-ally",
    },
    {
        "id": "alliance-montenegro-nato-2017",
        "name": "Montenegro accedes to NATO as 29th Ally",
        "region": "Western Balkans",
        "country": "Montenegro",
        "actor": "NATO",
        "kind": "accession",
        "lat": 42.4304,
        "lon": 19.2594,
        "status": "active",
        "start_date": "2017-06-05",
        "end_date": "",
        "note": "Accession Protocol signed May 2016, ratified by all 28 member parliaments.",
        "source": "NATO",
        "url": "https://www.nato.int/en/news-and-events/articles/news/2017/06/05/montenegro-joins-nato-as-29th-ally",
    },
    {
        "id": "alliance-nato-hague-2025",
        "name": "NATO Hague Declaration commits Allies to 5% of GDP by 2035",
        "region": "Western Europe",
        "country": "Netherlands",
        "actor": "NATO",
        "kind": "mandate",
        "lat": 52.0705,
        "lon": 4.3007,
        "status": "active",
        "start_date": "2025-06-25",
        "end_date": "",
        "note": "3.5% of GDP on core defence plus 1.5% on defence- and security-related spending, replacing the 2% benchmark; also sets new capability targets including a fivefold increase in air defence.",
        "source": "NATO",
        "url": "https://www.nato.int/en/about-us/official-texts-and-resources/official-texts/2025/06/25/the-hague-summit-declaration",
    },
    {
        "id": "alliance-aukus-2021",
        "name": "AUKUS established (Australia, United Kingdom, United States)",
        "region": "Oceania",
        "country": "Australia",
        "actor": "AUKUS",
        "kind": "mandate",
        "lat": -35.2809,
        "lon": 149.13,
        "status": "active",
        "start_date": "2021-09-15",
        "end_date": "",
        "note": "Trilateral security partnership for Indo-Pacific defence, announced jointly in Washington, Canberra and London.",
        "source": "Australian Department of Foreign Affairs and Trade",
        "url": "https://www.defence.gov.au/geo/aukus",
    },
    {
        "id": "alliance-eu-safe-2025",
        "name": "EU adopts SAFE instrument for defence-industry loans",
        "region": "Western Europe",
        "country": "Belgium",
        "actor": "European Union",
        "kind": "industrial",
        "lat": 50.8503,
        "lon": 4.3517,
        "status": "active",
        "start_date": "2025-05-27",
        "end_date": "",
        "note": "Council Regulation (EU) 2025/1106, the Security Action for Europe, layered on the EDIRPA common-procurement instrument of October 2023.",
        "source": "EUR-Lex",
        "url": "https://eur-lex.europa.eu/eli/reg/2025/1106/oj",
    },
    {
        "id": "alliance-eu-edirpa-2023",
        "name": "EU adopts EDIRPA common defence-procurement instrument",
        "region": "Western Europe",
        "country": "Belgium",
        "actor": "European Union",
        "kind": "industrial",
        "lat": 50.8503,
        "lon": 4.3517,
        "status": "active",
        "start_date": "2023-10-18",
        "end_date": "",
        "note": "Regulation (EU) 2023/2418, adopted jointly by Council and Parliament; the instrument SAFE later builds on.",
        "source": "EUR-Lex",
        "url": "https://eur-lex.europa.eu/eli/reg/2023/2418/oj",
    },
    {
        "id": "alliance-eu-strategic-compass-2022",
        "name": "EU adopts the Strategic Compass for security and defence",
        "region": "Western Europe",
        "country": "Belgium",
        "actor": "European Union",
        "kind": "posture",
        "lat": 50.8503,
        "lon": 4.3517,
        "status": "active",
        "start_date": "2022-03-10",
        "end_date": "",
        "note": "Council conclusions setting a blueprint for EU defence and resilience policy up to 2030.",
        "source": "Council of the European Union",
        "url": "https://www.consilium.europa.eu/en/press/press-releases/2022/03/10/strategic-compass-for-security-and-defense-council-adopts-conclusions/",
    },
    {
        "id": "alliance-germany-zeuhlatt-2022",
        "name": "Germany triggers the Bundeswehr special fund (Zeuhlatt)",
        "region": "Western Europe",
        "country": "Germany",
        "actor": "Germany",
        "kind": "posture",
        "lat": 52.52,
        "lon": 13.405,
        "status": "active",
        "start_date": "2022-06-03",
        "end_date": "",
        "note": "Bundestag vote unlocking a EUR 100bn defence fund on the day of the first announced delivery of IRIS-T to Ukraine.",
        "source": "Bundesministerium der Verteidigung",
        "url": "https://www.bundeswehr.de/en/organization/bundeswehr-special-fund",
    },
    {
        "id": "alliance-japan-nss-2022",
        "name": "Japan adopts National Security Strategy with counter-strike posture",
        "region": "East Asia",
        "country": "Japan",
        "actor": "Japan",
        "kind": "posture",
        "lat": 35.6762,
        "lon": 139.6503,
        "status": "active",
        "start_date": "2022-12-16",
        "end_date": "",
        "note": "First strategic-level defence document since 2015; adds strike capability and resilience requirements, paired with the National Defence Strategy.",
        "source": "Ministry of Foreign Affairs of Japan",
        "url": "https://www.mofa.go.jp/policy/security_research/nss/",
    },
]


def main() -> int:
    raw = json.loads(TARGET.read_text(encoding="utf-8"), object_pairs_hook=OrderedDict)

    deployments = [d for d in raw.get("deployments", []) if d.get("id") not in PROMOTED_IDS]
    removed = len(raw.get("deployments", [])) - len(deployments)
    raw["deployments"] = deployments
    raw["alliance_dots"] = ALLIANCE_DOTS

    # Keep the published key order stable so a regen produces a clean diff.
    order = [
        "version",
        "last_update",
        "conflict_zones",
        "deployments",
        "alliance_dots",
        "crisis_zones",
        "human_rights_violations",
    ]
    ordered = OrderedDict()
    for key in order:
        if key in raw:
            ordered[key] = raw[key]
    for key in raw:
        if key not in ordered:
            ordered[key] = raw[key]

    TARGET.write_text(json.dumps(ordered, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[ok] wrote {TARGET} ({len(ALLIANCE_DOTS)} alliance dots, {removed} promotions)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
