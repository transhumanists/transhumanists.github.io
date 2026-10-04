/**
 * Isolated worldmap page (map.html) tests.
 * Runs under `bun test` (no external deps).
 *
 * map.html exists because a cross-origin frame cannot be trimmed from the client
 * side: the Weebly page embeds it instead of the dashboard so the map renders
 * without the site chrome around it. The price of that isolation is a copied
 * block of markup - worldmap.js dereferences the map's element ids without
 * checking, so a rename on the dashboard alone renders a blank plate here. These
 * tests make that copy self-enforcing instead of a comment nobody reads:
 *
 *   1. the copied block must stay identical to index.md's WORLD MAP block
 *   2. every id worldmap.js reads but does not create must exist in map.html
 *   3. map.html must stay free of the layout's chrome (nav, footer, auth dock)
 *   4. map.html must keep serving the map's data fetches from this origin
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAP_PAGE = join(ROOT, 'map.html');
const read = (p) => readFileSync(p, 'utf8');

/**
 * The map block, as an array of lines with trailing whitespace removed and
 * blank lines dropped.
 *
 * Blank-line dropping is deliberate: it lets the block be reindented or
 * respaced without failing this test, while any change to an element, an id or
 * the nesting still fails. The noscript block is removed first because it is the
 * one thing map.html adds inside the copied region.
 */
function extractMapBlock(source) {
  const withoutNoscript = source.replace(/<noscript>[\s\S]*?<\/noscript>/g, '');
  const lines = withoutNoscript.split('\n').map((l) => l.trimEnd());
  const start = lines.findIndex((l) => l.trim() === '<div id="world-map">');
  expect(start).toBeGreaterThan(-1);

  const tooltip = lines.findIndex(
    (l, i) => i > start && l.includes('id="map-tooltip"'),
  );
  expect(tooltip).toBeGreaterThan(start);

  // The block closes on the first </div> at the opening tag's indentation after
  // the tooltip line; the tooltip is the last child of #world-map.
  const indent = lines[start].length - lines[start].trimStart().length;
  const end = lines.findIndex(
    (l, i) => i > tooltip && l.trim() === '</div>' && l.length - l.trimStart().length === indent,
  );
  expect(end).toBeGreaterThan(tooltip);

  return lines
    .slice(start, end + 1)
    .filter((l) => l.trim() !== '');
}

describe('map.html', () => {
  test('is published as a static file, not through the site layout', () => {
    const page = read(MAP_PAGE);
    // Front matter would make Jekyll process the file through _layouts/default.html,
    // which is precisely the chrome this page exists to avoid.
    expect(page.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(page).not.toContain('---\nlayout:');
    expect(page).not.toContain('{%');
  });

  test('keeps the WORLD MAP block identical to the dashboard', () => {
    const dashboard = extractMapBlock(read(join(ROOT, 'index.md')));
    const isolated = extractMapBlock(read(MAP_PAGE));

    const onlyOnDashboard = dashboard.filter((l) => !isolated.includes(l));
    const onlyOnIsolated = isolated.filter((l) => !dashboard.includes(l));

    // Reported as set differences rather than one equality assert so a failure
    // names the line that drifted instead of dumping both blocks.
    expect({ onlyOnDashboard, onlyOnIsolated }).toEqual({
      onlyOnDashboard: [],
      onlyOnIsolated: [],
    });
  });

  test('provides every id the dashboard block provides', () => {
    const script = read(join(ROOT, 'assets', 'js', 'worldmap.js'));
    const dashboard = read(join(ROOT, 'index.md'));
    const page = read(MAP_PAGE);

    // Literal single-quoted lookups only: anything built from a template
    // variable cannot be checked statically and is left to the browser. Ids the
    // script creates for itself (the legend, the terminator toggle) are excluded.
    const readIds = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
    const createdIds = new Set(
      [...script.matchAll(/\.id\s*=\s*'([^']+)'/g)].map((m) => m[1]),
    );

    // The invariant is parity with the dashboard, not completeness: zoom-in,
    // zoom-out and reset-view are read at worldmap.js:4095-4097 and exist on
    // neither page. Demanding them here would demand a change to the dashboard's
    // map, and satisfying them here alone would fork the two.
    const required = [...new Set(readIds)].filter(
      (id) => !createdIds.has(id) && dashboard.includes(`id="${id}"`),
    );
    const absent = required.filter((id) => !page.includes(`id="${id}"`));

    expect({ count: required.length, absent }).toEqual({ count: required.length, absent: [] });
  });

  test('loads only the map stylesheet and script', () => {
    // Comments are prose about those very files, so they are stripped before the
    // scan - otherwise documenting why the layout is excluded fails the check.
    const markup = read(MAP_PAGE).replace(/<!--[\s\S]*?-->/g, '');

    expect(markup).toContain('<link rel="stylesheet" href="/assets/css/main.css">');
    expect(markup).toContain('<script src="/assets/js/worldmap.js"></script>');

    // Assets the layout would drag in. Any of these here means the frame grows
    // nav, a footer, the ecosystem directory or the assistant dock.
    const forbidden = [
      'auth-bar',
      'network-ux',
      'ecosystem-network',
      'return-bar',
      'counter-widget',
      'milestone-detail',
      'assets/js/dashboard.js',
      'assets/js/main.js',
      '_includes/',
      '_layouts/',
    ];
    const present = forbidden.filter((needle) => markup.includes(needle));
    expect(present).toEqual([]);
  });

  test('serves the map data fetches from its own origin', () => {
    const script = read(join(ROOT, 'assets', 'js', 'worldmap.js'));
    const page = read(MAP_PAGE);

    // worldmap.js holds its data paths in constants and hands them to fetch(), so
    // they are matched as literals rather than at the call site. They are
    // root-relative: if map.html were ever served from another origin they would
    // resolve against that origin and 404, which is why the asset URLs here have
    // to stay root-relative too and never protocol-relative.
    const rootRelativeData = [...script.matchAll(/'(\/data\/[^']+)'/g)].map((m) => m[1]);
    expect(rootRelativeData.length).toBeGreaterThan(0);
    expect(page).not.toMatch(/(src|href)="\/\//);
  });

  test('fills the frame instead of letterboxing inside it', () => {
    const page = read(MAP_PAGE);

    // main.css sizes #world-map by the map plate's own ratio. Correct for a
    // section on a scrolling page, wrong in a frame of a fixed height, so the
    // page has to keep overriding it.
    const override = page.match(/#world-map\s*\{[^}]*\}/g)?.join(' ') ?? '';
    expect(override).toMatch(/height:\s*100dvh/);
    expect(override).toMatch(/aspect-ratio:\s*auto/);
  });

  test('stays frameable', () => {
    const page = read(MAP_PAGE);

    // frame-ancestors in a meta element is ignored by browsers, and GitHub Pages
    // sends no X-Frame-Options and no CSP header (verified against /live.html),
    // so embedding works - but a CSP meta added here would look like protection
    // while silently doing nothing.
    expect(page).not.toMatch(/http-equiv="Content-Security-Policy"/i);
    expect(page).not.toMatch(/http-equiv="X-Frame-Options"/i);
    expect(page).toMatch(/<meta name="robots" content="noindex/);
  });
});

/**
 * Preview mode: the obscured, self-cycling poster the Weebly site embeds.
 *
 * These are contract tests on the page source rather than behavioural ones,
 * because the decision is a policy about who sees what, and a policy test that
 * needed a DOM would mostly be testing the fake DOM. What they exist to stop:
 * the blur escaping its class and degrading the real map for everyone, and the
 * embed allowlist quietly widening.
 */
describe('map.html preview mode', () => {
  const page = () => read(MAP_PAGE);
  const script = () => page().match(/<script>([\s\S]*?)<\/script>/)[1];
  const styles = () => page().match(/<style>([\s\S]*?)<\/style>/)[1];

  test('only the Weebly embed is allowlisted', () => {
    const origins = script().match(/EMBED_ORIGINS\s*=\s*\[([^\]]*)\]/)[1];
    expect(origins.replace(/'/g, '').split(',').map((s) => s.trim()).filter(Boolean))
      .toEqual(['https://transhumanists.weebly.com']);
  });

  test('a direct visit is never given the preview', () => {
    // The order matters and is the whole policy: framed first, allowlist second.
    const body = script();
    const framedCheck = body.indexOf('if(!framed) return false;');
    const referrerCheck = body.indexOf('isKnownEmbed(referrer)');

    expect(framedCheck).toBeGreaterThan(-1);
    expect(referrerCheck).toBeGreaterThan(framedCheck);
    // A frame from somewhere else resolves to the full map, never the reverse.
    expect(body).toMatch(/return referrer === '' \|\| isKnownEmbed\(referrer\);/);
  });

  test('an explicit override wins, so the preview is testable', () => {
    expect(script()).toMatch(/flag === '1'\) return true;/);
    expect(script()).toMatch(/flag === '0'\) return false;/);
  });

  test('the blur is scoped to the preview class and cannot reach the real map', () => {
    const css = styles();
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
      selector: sel.trim(),
      body,
    }));

    // A property declaration cannot leak on its own; only a selector can. The
    // one selector that may carry the blur without naming the class is a
    // @keyframes step, which is only ever reached through an animation, so
    // those are checked by who applies the animation instead.
    const isKeyframeStep = (sel) => /^(from|to|\d+%)$/.test(sel);
    const unscoped = rules
      .filter((r) => r.body.includes('blur(') && !r.selector.includes('wm-teaser') && !isKeyframeStep(r.selector))
      .map((r) => r.selector);
    expect({ unscoped }).toEqual({ unscoped: [] });

    const blurredKeyframes = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\s*\}/g)]
      .filter(([, , body]) => body.includes('blur('))
      .map(([, name]) => name);
    expect(blurredKeyframes.length).toBeGreaterThan(0);

    const appliers = rules
      .filter((r) => blurredKeyframes.some((name) => r.body.includes(name)))
      .map((r) => r.selector);
    const leaky = appliers.filter((sel) => !sel.includes('wm-teaser'));
    expect({ leaky }.leaky).toEqual([]);
  });

  test('the preview says it is blurred and links to the real thing', () => {
    const p = page();
    // A teaser that looked like the finished article would misrepresent the page.
    expect(p).toMatch(/Blurred preview/);
    expect(p).toMatch(/id="wm-teaser"[\s\S]*?href="https:\/\/transhumanists\.github\.io\/#world-map"/);
    // ...and the CTA is never the fuzzy target itself.
    expect(p).not.toMatch(/id="wm-teaser"[\s\S]{0,600}href="[^"]*map\.html\?preview/);
  });

  test('the teaser chrome lives outside the block copied from the dashboard', () => {
    const block = extractMapBlock(page()).join('\n');
    expect(block).not.toContain('wm-teaser');
    expect(page()).toContain('id="wm-teaser"');
  });

  test('reduced motion keeps the blur but drops the cycling', () => {
    const body = script();
    const guard = body.indexOf('prefers-reduced-motion');
    const cycler = body.indexOf('function advance()');

    expect(guard).toBeGreaterThan(-1);
    // The class is applied before the guard, so the poster stays a poster.
    expect(body.indexOf("map.classList.add('wm-teaser')")).toBeLessThan(guard);
    expect(guard).toBeLessThan(cycler);
  });

  test('the cycler yields to a visitor who uses the legend', () => {
    const body = script();
    expect(body).toMatch(/closest\('#map-legend'\)\)\{\s*stopped = true;/);
  });

  test('layer state is read from the row, never assumed', () => {
    const body = script();
    // Layer visibility persists in localStorage, so a remembered "on" layer
    // clicked blindly would be switched off. aria-pressed is what the rows set
    // from real state (worldmap.js:3748).
    expect(body).toMatch(/getAttribute\('aria-pressed'\) === 'true'\) !== on/);
  });

  test('the cycler walks the legend in its own order and then stops', () => {
    const body = script();
    expect(body).toMatch(/DWELL_MS = \d{3,5}/);
    expect(body).toMatch(/if\(step >= keys\.length\) return;/);
  });
});