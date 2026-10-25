path = r'C:\Users\Wout\AppData\Local\Temp\opencode\transhumanists.github.io\assets\css\main.css'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

bad = ".map-overlay {\n  position: absolute;\n  top: 8px; bottom: 8px; left: 14px; right: 14px;\n  display: flex; flex-direction: column; justify-content: flex-end; align-items: stretch; gap: 6px;\n  pointer-events: none; z-index: 5;\n}\n#world-map-canvas {\n  width: 100%;\n  height: 100%;\n  cursor: grab;\n  display: block;\n}"
content = content.replace(bad, '')

old = ".map-overlay {\n  position: absolute;\n  /* Tucked into the top-left corner: the overlay sits over the map, and Canadian\n     milestones cluster in the north so a taller stack here was covering them. */\n  top: 6px;\n  left: 6px;"
new = ".map-overlay {\n  position: absolute;\n  /* More space at top / left so northern Canada markers don't collide */\n  top: 12px; left: 12px;"
content = content.replace(old, new)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('Cleaned overlay / canvas duplicates; top space increased')
