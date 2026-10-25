path = r'C:\Users\Wout\AppData\Local\Temp\opencode\transhumanists.github.io\index.md'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()
start = c.find('    <script>')
end = c.find('    </script>', start)
if start >= 0 and end >= 0:
    # Keep closing div/section tags, drop script content
    c = c[:start] + '  </div>\n</section>\n\n<!-- WORLD MAP -->' + c[end + len('    </script>'):]
with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print('Script removed from banner')
