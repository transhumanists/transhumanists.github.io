path1 = r'C:\Users\Wout\AppData\Local\Temp\opencode\transhumanists.github.io\assets\js\dashboard.js'
with open(path1, 'r', encoding='utf-8') as f:
    c = f.read()
old = "        if (m.geolocation && typeof m.geolocation.lat === 'number' && typeof m.geolocation.lon === 'number') {\n          const geoSpan = createEl('span', '', ` · 📍 ${m.geolocation.lat.toFixed(2)}, ${m.geolocation.lon.toFixed(2)}`);\n          meta.appendChild(geoSpan);\n        }"
new = "        if (m.geolocation && typeof m.geolocation.lat === 'number' && typeof m.geolocation.lon === 'number') {\n          var geoText = ' · 📍 ' + m.geolocation.lat.toFixed(2) + ', ' + m.geolocation.lon.toFixed(2);\n          if (m.geolocation.country || m.geolocation.city || m.country || m.city) {\n            geoText += ' (' + (m.geolocation.country || m.country || '') + (m.geolocation.country || m.country ? ', ' : '') + (m.geolocation.city || m.city || '') + ')';\n          }\n          const geoSpan = createEl('span', '', geoText);\n          meta.appendChild(geoSpan);\n        }"
c = c.replace(old, new)
with open(path1, 'w', encoding='utf-8') as f:
    f.write(c)
print('dashboard geo fixed')
