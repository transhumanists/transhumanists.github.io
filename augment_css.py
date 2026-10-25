# Tighten up spacing around the recent milestones banner and catalogue so the gap
# above the worldmap is not huge, and slim the banner section itself.
with open(r'C:\Users\Wout\AppData\Local\Temp\opencode\transhumanists.github.io\assets\css\main.css', 'r', encoding='utf-8') as f:
    c = f.read()

extra = '''
/* Compact the recent-milestones banner */
.recent-milestones-nav-group { margin-bottom: 10px; }

/* Make the shared banner cards tight, no top padding bleed from the section. */
.section#recent-milestones { padding-top: 24px; padding-bottom: 16px; }

.recent-milestones-card__icon { font-size: 1.6rem; line-height: 1; margin-bottom: 6px; }
.recent-milestones-card__category {
  font-family: var(--font-mono); font-size: 0.6rem; font-weight: 700; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--accent); margin-bottom: 6px;
}
.recent-milestones-card__title { font-size: 0.92rem; font-weight: 600; color: var(--fg); line-height: 1.3; margin-bottom: 8px; }
.recent-milestones-card__metric { display: flex; align-items: baseline; gap: 6px; margin-bottom: 6px; }
.recent-milestones-card__value { font-family: var(--font-mono); font-size: 1.25rem; font-weight: 700; color: var(--accent); }
.recent-milestones-card__unit { font-family: var(--font-mono); font-size: 0.7rem; color: var(--fg-muted); }
.recent-milestones-card__meta { font-family: var(--font-mono); font-size: 0.66rem; color: var(--fg-subtle); }
'''
# Only append once (the block already starts with .recent-milestones-banner)
marker = '.recent-milestones-banner {\n  position: relative;'
assert marker in c, 'marker not found'
c = c.replace(marker, marker + '\n' + extra, 1)
with open(r'C:\Users\Wout\AppData\Local\Temp\opencode\transhumanists.github.io\assets\css\main.css', 'w', encoding='utf-8') as f:
    f.write(c)
print('Added compact card styling')
