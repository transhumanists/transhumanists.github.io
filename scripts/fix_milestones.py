#!/usr/bin/env python3
import json

with open('data/milestones.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

# Categories to remove
categories_to_remove = ['quantum_gravity', 'mathematics', 'computational_archaeology']

# Reclassify milestones from removed categories
reclassifications = {
    'ms-f9883157aeba': 'quantum',  # Quantum Gravity -> Quantum Physics
    'ms-2457b1872a8c': 'computing_agi',  # Mathematics -> Computing & AGI
    'his-1976-07-01-four-color-theorem': 'computing_agi',  # Mathematics -> Computing & AGI
    'ms-10f19d45d95b': 'computing_agi',  # Computational Archaeology -> Computing & AGI
    'ms-fb74b2202f85': 'computing_agi',  # Computational Archaeology -> Computing & AGI
}

# Process each category to remove
for cat_key in categories_to_remove:
    if cat_key in data['categories']:
        cat_data = data['categories'][cat_key]
        # Move milestones to new categories
        for milestone in cat_data.get('milestones', []):
            mid = milestone.get('id')
            if mid in reclassifications:
                new_cat = reclassifications[mid]
                if new_cat in data['categories']:
                    # Update milestone fields
                    milestone['category'] = data['categories'][new_cat]['name']
                    milestone['category_key'] = new_cat
                    # Add to new category
                    data['categories'][new_cat]['milestones'].append(milestone)
                    # Add subcategory if not present
                    subcat = milestone.get('subcategory')
                    if subcat and subcat not in data['categories'][new_cat].get('subcategories', []):
                        data['categories'][new_cat].setdefault('subcategories', []).append(subcat)
        # Remove the old category
        del data['categories'][cat_key]

# Add new subcategories to computing_agi if not present
new_subcats = ['pattern_mining', 'ml_structural_analysis', 'graph_theory', 'holographic_principle']
for subcat in new_subcats:
    if subcat not in data['categories']['computing_agi'].get('subcategories', []):
        data['categories']['computing_agi'].setdefault('subcategories', []).append(subcat)

# Add holographic_principle to quantum
if 'holographic_principle' not in data['categories']['quantum'].get('subcategories', []):
    data['categories']['quantum'].setdefault('subcategories', []).append('holographic_principle')

# Write back
with open('data/milestones.json', 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)

print("Fixed milestones.json")
print(f"Categories now: {list(data['categories'].keys())}")