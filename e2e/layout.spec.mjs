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
  const failedRequests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
  });

  await page.goto('/e2e/fixture.html');

  // Fail fast, and say what went wrong. The legend is built from the layer and
  // event fetches, so a 404 on data/*.json leaves it empty - and the default wait is
  // 30s of silence repeated for every test in the file, naming none of the cause.
  try {
    await page.waitForFunction(() => {
      const el = document.getElementById('map-legend');
      return !!el && el.querySelectorAll('.map-legend-row').length > 0;
    }, null, { timeout: 10_000 });
  } catch (err) {
    const detail = failedRequests.length
      ? `; requests failed: ${failedRequests.join(', ')}`
      : '';
    const seen = errors.length ? `; page errors: ${errors.join(' | ')}` : '';
    throw new Error(
      'the map legend never rendered - the fixture did not load its data' +
      detail + seen, { cause: err });
  }

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

test('the pinned legend header is opaque, so rows do not ghost through it',
  async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone',
              'the header only pins while the frame scrolls');
    // At 0.94 the remaining 6% was enough to bleed the rows through, leaving the
    // caption sitting on a smear of the labels it was meant to head. Measured rather
    // than eyeballed: the resolved background has to be fully opaque.
    const alpha = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.map-legend-head'));
      const m = (cs.backgroundColor || '').match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1].split(',').map((v) => parseFloat(v));
      return parts.length === 4 ? parts[3] : 1;
    });
    expect(alpha).not.toBe(null);
    expect(alpha, 'pinned header background alpha').toBe(1);

    // And it actually pins, rather than scrolling away with the rows.
    const legend = page.locator('#map-legend');
    await legend.evaluate((el) => { el.scrollTop = 90; });
    await page.waitForTimeout(200);
    const headTop = await page.locator('.map-legend-head').evaluate(
      (el) => el.getBoundingClientRect().top);
    const frameTop = await legend.evaluate(
      (el) => el.getBoundingClientRect().top);
    expect(Math.abs(headTop - frameTop)).toBeLessThan(12);
  });

test('the legend reaches every row without being clipped away', async ({ page }) => {
  // 9 categories + 5 operational-layer rows: zones, deployments, crises, human
  // rights, and the alliance/deal seals nested under deployments. The sublayer
  // is a row of its own (that is what makes it read as part of the deployments
  // datalayer rather than as an unrelated layer), so it counts here.
  await expect(page.locator('#map-legend .map-legend-row')).toHaveCount(14);
  const clipped = await page.evaluate(() => {
    const el = document.getElementById('map-legend');
    // Scrollable is fine; scrolled-out-of-reach is not.
    const style = getComputedStyle(el);
    return style.overflowY === 'visible' &&
      el.getBoundingClientRect().height < el.scrollHeight;
  });
  expect(clipped).toBe(false);
});

test('the eye wears the CATEGORIES colours and sits just smaller than the word',
  async ({ page }) => {
    const eye = page.locator('#map-legend-bulk-visibility');
    await expect(eye).toBeVisible();

    // Same colour as the caption, so they read as one piece of chrome. currentColor
    // carries it into the SVG's strokes.
    const titleColour = await page.locator('.map-legend-title')
      .evaluate((el) => getComputedStyle(el).color);
    const eyeColour = await eye.evaluate((el) => getComputedStyle(el).color);
    expect(eyeColour).toBe(titleColour);
    const lid = await page.locator('#map-legend-bulk-visibility .eye-lid')
      .getAttribute('stroke');
    expect(lid).toBe('currentColor');

    // Smaller than the word in BOTH states.
    const glyph = page.locator('#map-legend-bulk-visibility svg');
    const titleBox = await page.locator('.map-legend-title').boundingBox();
    for (const pressed of ['false', 'true']) {
      await eye.evaluate((el, v) => el.setAttribute('aria-pressed', v), pressed);
      const g = await glyph.boundingBox();
      expect(g.height, 'glyph vs caption when aria-pressed=' + pressed)
        .toBeLessThan(titleBox.height);
    }
    await eye.evaluate((el) => el.setAttribute('aria-pressed', 'false'));

    // Vertically centred on the word, and on the right of it.
    const g = await glyph.boundingBox();
    expect(Math.abs((g.y + g.height / 2) - (titleBox.y + titleBox.height / 2)))
      .toBeLessThan(2);
    expect(g.x).toBeGreaterThan(titleBox.x);
  });

test('CATEGORIES is bigger than the eye and folds from the whole header row',
  async ({ page }) => {
    const head = page.locator('.map-legend-head');
    const title = page.locator('.map-legend-title');
    const eye = page.locator('#map-legend-bulk-visibility');

    // Every click re-measures. Folding rebuilds the legend, which moves the header,
    // so coordinates captured up front go stale after the first toggle - and a stale
    // coordinate silently lands on the frame background and does nothing.
    const box = async (loc) => loc.boundingBox();

    const clickHeadTop = async () => {
      const b = await box(head);
      await page.mouse.click(b.x + 6, b.y + 1);
    };
    const clickHeadBottom = async () => {
      const b = await box(head);
      await page.mouse.click(b.x + 6, b.y + b.height - 1);
    };
    const clickInFrontOfWord = async () => {
      const h = await box(head);
      const t = await box(title);
      const x = t.x + t.width + 4;
      expect(x, 'there is whitespace between the word and the eye')
        .toBeLessThan(h.x + h.width);
      await page.mouse.click(x, t.y + t.height / 2);
    };
    const clickWord = async () => {
      const t = await box(title);
      await page.mouse.click(t.x + 4, t.y + t.height / 2);
    };
    const clickEye = async () => {
      const e = await box(eye);
      await page.mouse.click(e.x + e.width / 2, e.y + e.height / 2);
    };

    // Collapse state is read from the inline max-height, which is assigned at once,
    // rather than from the wrapper's box, which is mid-transition for 150ms after a
    // click and would race the animation.
    const folded = () => page.evaluate(() =>
      document.querySelector('.map-legend-categories').style.maxHeight);

    const t0 = await box(title);
    const h0 = await box(head);
    const eyeGlyph = await page.locator('#map-legend-bulk-visibility svg').boundingBox();
    // CATEGORIES is the bigger of the two - expressed as a relationship, because a
    // fixed pixel threshold would just be a font-size assertion that breaks the first
    // time a breakpoint scales it.
    expect(t0.height).toBeGreaterThan(eyeGlyph.height);
    // The click target is the row, not the word: strictly taller, so there is
    // whitespace above and below to aim at.
    expect(h0.height).toBeGreaterThan(t0.height + 3);

    await expect(title).toHaveAttribute('aria-pressed', 'false');

    await clickHeadTop();
    await expect(title).toHaveAttribute('aria-pressed', 'true');
    expect(await folded()).toBe('0px');

    await clickHeadBottom();
    await expect(title).toHaveAttribute('aria-pressed', 'false');
    expect(await folded()).not.toBe('0px');

    await clickInFrontOfWord();
    await expect(title).toHaveAttribute('aria-pressed', 'true');
    await clickInFrontOfWord();
    await expect(title).toHaveAttribute('aria-pressed', 'false');

    await clickWord();
    await expect(title).toHaveAttribute('aria-pressed', 'true');

    // The eye must NOT fold the list: it has its own job.
    await clickEye();
    await expect(title).toHaveAttribute('aria-pressed', 'true');
    await expect(eye).toHaveAttribute('aria-pressed', 'true');
  });

test('the fold keeps keyboard focus so it can be toggled twice', async ({ page }) => {
  // renderLegend() rebuilds the whole frame, so without an explicit restore the
  // focused element is destroyed and focus lands on <body>. A keyboard user then
  // presses Enter a second time and nothing happens, which reads as a broken
  // control rather than as a lost focus ring.
  const title = page.locator('.map-legend-title');
  await title.focus();
  await expect(title).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(title).toHaveAttribute('aria-pressed', 'true');
  await expect(title).toBeFocused();

  // Second press really does toggle again, which is the whole point.
  await page.keyboard.press('Enter');
  await expect(title).toHaveAttribute('aria-pressed', 'false');
  await expect(title).toBeFocused();

  // Space works the same way.
  await page.keyboard.press(' ');
  await expect(title).toHaveAttribute('aria-pressed', 'true');
  await expect(title).toBeFocused();
});

test('the fold target is reachable by keyboard without the mouse',
  async ({ page }) => {
    const title = page.locator('.map-legend-title');
    await expect(title).toHaveAttribute('role', 'button');
    await expect(title).toHaveAttribute('tabindex', '0');
    await expect(title).toHaveAttribute('aria-label',
      'Toggle categories visibility');
  });

test('every legend label sits on one line', async ({ page }) => {
    const rows = await page.locator('#map-legend .map-legend-row').evaluateAll(
      (els) => els.map((e) => {
        const label = e.querySelector('.map-legend-label');
        if (!label) return null;
        const cs = getComputedStyle(label);
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
        return {
          text: label.textContent.trim(),
          height: label.getBoundingClientRect().height,
          truncated: label.scrollWidth > label.clientWidth + 1,
          lines: Math.round(label.getBoundingClientRect().height / lh),
        };
      }),
    );
const labels = rows.filter(Boolean);
  // One label per legend row, so this tracks the row count above (14). Asserted
  // as an exact number rather than "> 0" because a label that silently stops
  // rendering is exactly the regression this test exists to catch.
  expect(labels.length).toBe(14);
    for (const l of labels) {
      expect(l.lines, l.text + ' wrapped onto ' + l.lines + ' lines').toBe(1);
      expect(l.truncated, l.text + ' was ellipsised').toBe(false);
    }
    // The longest labels really are in there, so this is not passing on short rows.
    // Named explicitly rather than derived: if a label is renamed this fails
    // loudly and gets updated on purpose, instead of the guard quietly
    // weakening to whatever happens to be rendered.
    expect(labels.some((l) => l.text.includes('Biotechnology & Biohacking'))).toBe(true);
    expect(labels.some((l) => l.text.includes('Ground & Fleet Deployments'))).toBe(true);
    const longest = labels.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    expect(longest.text.length,
      'the longest legend label is short enough that wrapping could not happen')
      .toBeGreaterThanOrEqual(24);
  });

test('the widened frame still clears South America', async ({ page }, testInfo) => {
    // Equirectangular: lon -60 is where South America starts, about a third across.
    // Only meaningful on a wide map - on a 358px phone the legend is most of the frame
    // by necessity, and there is no map underneath it to cover.
    test.skip(testInfo.project.name !== 'desktop',
              'the South America constraint applies to the wide layout');
    const legend = await page.locator('#map-legend').boundingBox();
    const map = await page.locator('#world-map').boundingBox();
    const fraction = (legend.x + legend.width - map.x) / map.width;
    expect(fraction, 'legend right edge as a fraction of the map')
      .toBeLessThan((-60 + 180) / 360);
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

  // Operational layers are untouched. Five rows carry data-layer: the four
  // operational layers plus the nested alliance/seal sublayer under deployments.
  // The bulk eye must not reach any of them - it owns the nine category rows only.
  const layers = page.locator('#map-legend .map-legend-row[data-layer]');
  await expect(layers).toHaveCount(5);

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

test('the timeline keeps the legend frame and its contrast at every width',
  async ({ page }) => {
    // The timeline is meant to share the legend's frame language: same dark plate,
    // same blur, same border, same radius. It also has to keep its contrast at every
    // breakpoint - the responsive block used to thin the track to 3px and then 2px on
    // a phone, and a 2px line at 0.32 alpha over a 0.58 plate reads as washed out.
    const legend = page.locator('#map-legend');
    const plate = page.locator('.map-timeline');

    // Same plate treatment as the legend frame.
    const styles = await page.evaluate(() => {
      const g = (sel, props) => {
        const el = document.querySelector(sel);
        const cs = getComputedStyle(el);
        return Object.fromEntries(props.map((p) => [p, cs[p]]));
      };
      return {
        legend: g('.map-legend', ['backgroundColor', 'backdropFilter', 'borderRadius']),
        timeline: g('.map-timeline', ['backgroundColor', 'backdropFilter', 'borderRadius']),
      };
    });
    expect(styles.timeline.backdropFilter).toBe(styles.legend.backdropFilter);
    expect(styles.timeline.borderRadius).toBe(styles.legend.borderRadius);

    // Track and handle never shrink below the redesign's dimensions.
    const sizes = await page.evaluate(() => {
      const r = (sel) => {
        const el = document.querySelector(sel);
        return el.getBoundingClientRect();
      };
      return {
        track: r('.map-timeline-track').height,
        handle: r('.map-timeline-handle').height,
        trackColour: getComputedStyle(document.querySelector('.map-timeline-track'))
          .backgroundColor,
        handleColour: getComputedStyle(document.querySelector('.map-timeline-handle'))
          .backgroundColor,
      };
    });
    expect(sizes.track, 'track height').toBeGreaterThanOrEqual(4);
    expect(sizes.handle, 'handle height').toBeGreaterThanOrEqual(14);
    // The handle is opaque white; the track is the redesign's translucent white.
    expect(sizes.handleColour).toBe('rgb(255, 255, 255)');
    expect(sizes.trackColour).toBe('rgba(255, 255, 255, 0.32)');
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