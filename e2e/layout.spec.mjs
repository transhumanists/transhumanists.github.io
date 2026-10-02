import { expect, test } from '@playwright/test';

// Real-browser layout checks.
//
// The unit suite runs against a hand-written DOM fake, which is fast but blind: it
// cannot tell you a frame is 53px too tall, and it cost this project two false-green
// releases before. These checks measure what a browser actually lays out.
//
// They assert measurements rather than pixel baselines on purpose. A baseline needs a
// human to approve the current appearance and then fails on every legitimate restyle,
// which trains people to re-record it without looking. Screenshots are still written
// so a human can look when they want to; CI publishes them as artifacts.

const MAP_RATIO = 360 / 142; // worldmap.js: 360 deg of longitude over a 142 deg window

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/test/browser/fixture.html');
  await page.waitForFunction(() => {
    const el = document.getElementById('map-legend');
    return !!el && el.querySelectorAll('.map-legend-row').length > 0;
  });
  page.__errors = errors;
});

test.afterEach(async ({ page }, testInfo) => {
  // Artifacts for a human, not an assertion.
  await testInfo.attach('map', {
    body: await page.locator('#world-map').screenshot(),
    contentType: 'image/png',
  });
  expect(page.__errors, 'the page logged errors').toEqual([]);
});

test('the frame is the map ratio, so the plate fills it with no letterbox', async ({ page }) => {
  // The reported regression: a fixed 580px height against a 2.54:1 map left a dead
  // band above and below that read as the map being zoomed out. Reset could not help,
  // because the fault was the frame rather than the camera.
  const box = await page.locator('#world-map').boundingBox();
  expect(box.height).toBeGreaterThan(0);
  const ratio = box.width / box.height;
  expect(Math.abs(ratio - MAP_RATIO)).toBeLessThan(0.05);
});

test('the canvas fills the frame content box', async ({ page }) => {
  // Measured against the map's CONTENT box, not its border box: the frame carries a
  // 1px border, so the canvas is legitimately 2px smaller in each axis. Comparing the
  // two boxes directly was the wrong assertion, and it hid the real checks below.
  const delta = await page.evaluate(() => {
    const map = document.getElementById('world-map');
    const canvas = document.getElementById('world-map-canvas');
    const cs = getComputedStyle(map);
    const bw = map.clientWidth, bh = map.clientHeight;
    const cb = canvas.getBoundingClientRect();
    return {
      dw: Math.abs(cb.width - bw),
      dh: Math.abs(cb.height - bh),
      border: parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderTopWidth),
    };
  });
  expect(delta.dw).toBeLessThan(1.5);
  expect(delta.dh).toBeLessThan(1.5);
  // ...and the frame is exactly 2px of border larger, i.e. nothing is missing.
  expect(delta.border).toBeCloseTo(2, 1);
});

test('the canvas actually painted something', async ({ page }) => {
  // Guards against a blank map reading as "fine" because nothing threw.
  const distinct = await page.evaluate(() => {
    const c = document.getElementById('world-map-canvas');
    const ctx = c.getContext('2d');
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4 * 97) {
      seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      if (seen.size > 8) break;
    }
    return seen.size;
  });
  expect(distinct).toBeGreaterThan(3);
});

test('the legend sits inside the map and does not overflow it', async ({ page }) => {
  const map = await page.locator('#world-map').boundingBox();
  const legend = await page.locator('#map-legend').boundingBox();
  expect(legend.x).toBeGreaterThanOrEqual(map.x - 1);
  expect(legend.y).toBeGreaterThanOrEqual(map.y - 1);
  expect(legend.x + legend.width).toBeLessThanOrEqual(map.x + map.width + 1);
  expect(legend.y + legend.height).toBeLessThanOrEqual(map.y + map.height + 1);
});

test('the legend reaches every row without being clipped away', async ({ page }) => {
  // 9 categories + 4 operational layers.
  await expect(page.locator('#map-legend .map-legend-row')).toHaveCount(13);
  const clipped = await page.evaluate(() => {
    const el = document.getElementById('map-legend');
    // Scrollable is fine; scrolled-out-of-reach is not.
    const style = getComputedStyle(el);
    return style.overflowY === 'visible' &&
      el.getBoundingClientRect().height < el.scrollHeight;
  });
  expect(clipped).toBe(false);
});

test('the eye is present, white, and level with the CATEGORIES label', async ({ page }) => {
  const eye = page.locator('#map-legend-bulk-visibility');
  await expect(eye).toBeVisible();

  // The brief was an eye of the same height as the word CATEGORIES, so it is the
  // GLYPH that gets measured, not the button: the button is deliberately larger so
  // the control stays a comfortable tap target.
  const glyph = await page.locator('#map-legend-bulk-visibility svg').boundingBox();
  const titleBox = await page.locator('.map-legend-title').boundingBox();
  expect(Math.abs(glyph.height - titleBox.height)).toBeLessThan(2);

  // Vertically centred on the word it sits beside.
  const glyphMid = glyph.y + glyph.height / 2;
  const titleMid = titleBox.y + titleBox.height / 2;
  expect(Math.abs(glyphMid - titleMid)).toBeLessThan(2);

  // On the right of the header.
  expect(glyph.x).toBeGreaterThan(titleBox.x);

  // And the button is still a hit target rather than a hairline.
  const eyeBox = await eye.boundingBox();
  expect(eyeBox.height).toBeGreaterThanOrEqual(glyph.height);

  const stroke = await page.locator('#map-legend-bulk-visibility .eye-lid')
    .getAttribute('stroke');
  expect(stroke.toLowerCase()).toBe('#fff');
});

test('the eye opens and closes the whole category set, and nothing else', async ({ page }) => {
  const eye = page.locator('#map-legend-bulk-visibility');
  await expect(eye).toHaveAttribute('aria-pressed', 'false');

  await eye.click();
  await expect(eye).toHaveAttribute('aria-pressed', 'true');
  await expect(eye).toHaveAttribute('aria-label', 'Show all milestone categories');

  const rows = page.locator('#map-legend .map-legend-row:not([data-layer])');
  await expect(rows).toHaveCount(9);
  for (const pressed of await rows.evaluateAll(
    (els) => els.map((e) => e.getAttribute('aria-pressed')))) {
    expect(pressed).toBe('false');
  }

  // Operational layers are untouched.
  const layers = page.locator('#map-legend .map-legend-row[data-layer]');
  await expect(layers).toHaveCount(4);

  await eye.click();
  await expect(eye).toHaveAttribute('aria-pressed', 'false');
});

test('hiding categories one at a time closes the eye by itself', async ({ page }) => {
  const rows = page.locator('#map-legend .map-legend-row:not([data-layer])');
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    await rows.nth(i).click();
  }
  await expect(page.locator('#map-legend-bulk-visibility'))
    .toHaveAttribute('aria-pressed', 'true');

  // Re-selecting one reopens it.
  await rows.nth(0).click();
  await expect(page.locator('#map-legend-bulk-visibility'))
    .toHaveAttribute('aria-pressed', 'false');
});

test('the dropdowns are readable rather than transparent', async ({ page }) => {
  // The original complaint: the closed control looked fine, the opened list did not,
  // because option elements are drawn by the user agent.
  const select = page.locator('#catalog-category-filter');
  const info = await select.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      appearance: cs.appearance || cs.webkitAppearance,
      background: cs.backgroundColor,
      color: cs.color,
      colorScheme: cs.colorScheme,
    };
  });
  expect(info.appearance).toBe('none');
  expect(info.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(info.color).not.toBe(info.background);
  // Declaring a colour scheme is what tells the UA which palette to draw the popup
  // with, so this is load-bearing rather than decoration.
  expect(info.colorScheme).not.toBe('normal');
});

test('the stepper and its select read as one control', async ({ page }) => {
  const prev = await page.locator('#catalog-year-prev').boundingBox();
  const select = await page.locator('#catalog-year-filter').boundingBox();
  // Same plate and border, so the three read as a single widget.
  expect(Math.abs(prev.height - select.height)).toBeLessThan(3);
  expect(prev.y).toBeGreaterThanOrEqual(select.y - 1);
});

test('legend rows are big enough to tap', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'touch target rule only matters here');
  const heights = await page.locator('#map-legend .map-legend-row')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  for (const h of heights) {
    expect(h).toBeGreaterThanOrEqual(24);
  }
});

test('nothing overflows the document horizontally', async ({ page }) => {
  // A sideways scrollbar on a map is the classic mobile failure.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});