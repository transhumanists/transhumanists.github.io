import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/* Milestone detail card: real-browser checks.
 *
 * The unit suite (test/milestone-detail.test.mjs) pins the ranking, the merge and
 * the sanitising rules against a DOM stub. It cannot see a single pixel, and the
 * three things most likely to be wrong here are all invisible to it:
 *
 *   * whether a tap on a card reaches it at all - the reported bug was a modal
 *     whose markup no page contained, so every tap did nothing and no unit test
 *     failed;
 *   * whether the panel is actually centred and actually bigger than the card;
 *   * whether the reaction strip and the thread are on the page in the right
 *     place, or somewhere that merely exists.
 *
 * So these assert measurements and states, not screenshots: a baseline needs a
 * human to approve it and then fails on every legitimate restyle. Every test here
 * runs on both the desktop and the phone project, and the ones about touch use
 * real taps rather than synthesised clicks.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const detailSource = readFileSync(join(ROOT, 'assets', 'js', 'milestone-detail.js'), 'utf8');
const detailInclude = readFileSync(join(ROOT, '_includes', 'milestone-detail.html'), 'utf8');
const fixtureHtml = readFileSync(join(HERE, 'milestone-detail.fixture.html'), 'utf8');

const IDS = ['ms-fixture-a', 'ms-fixture-b', 'ms-fixture-c'];
const ROCKET = '\u{1F680}';

/**
 * Stand in for the reactions backend.
 *
 * The default is an endpoint that exists and has nothing to add: a 200 carrying
 * an empty canonical reply. That is the only shape that is both silent to the
 * browser and behaviourally a no-op, so the other checks can assert on reactions
 * without every one of them having to reason about whether the backend answered.
 * The block that cares about a missing backend replaces this.
 */
const liveBackend = (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ counts: {}, mine: {}, comments: [] }),
});

const card = (page, id) => page.locator(`.catalog-card[data-milestone-id="${id}"]`);
const detail = (page) => page.locator('#milestone-detail');
const panel = (page) => page.locator('#ms-detail-panel');

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // A rejected request to the reactions endpoint is the documented state of the
    // deployed static host, not a defect: there is no backend there yet. Chrome
    // logs it as a resource-load failure and it would otherwise mask every real
    // script error in this file. The network response itself is asserted in the
    // "without a shared backend" block instead of being ignored.
    if (m.location()?.url?.includes('/api/reactions')) return;
    errors.push(m.text());
  });
  // Registered before navigation so nothing can slip past the stub during load.
  await page.route('**/api/reactions', liveBackend);
  // Cleared once per tab, not once per navigation: an init script re-runs on every
  // load, so an unconditional clear would wipe the very state the persistence
  // check is trying to observe on its reload. sessionStorage survives a reload in
  // the same tab, which is what makes this a once-per-tab latch.
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('__detail_spec_cleared__')) {
        sessionStorage.setItem('__detail_spec_cleared__', '1');
        localStorage.clear();
      }
    } catch (_) {}
  });

  await page.goto('/e2e/milestone-detail.fixture.html');
  await page.waitForFunction(
    (ids) => ids.every((id) =>
      document.querySelector(`.catalog-card[data-milestone-id="${id}"] .catalog-card__reactions`)),
    IDS,
    { timeout: 10_000 }
  );
  page.__errors = errors;
});

test.afterEach(async ({ page }, testInfo) => {
  // Artifacts for a human, not an assertion. Only while the card is open:
  // screenshotting a hidden panel waits for it to become visible and burns the
  // whole per-test timeout on every test that ends with the card closed.
  if (await detail(page).evaluate((el) => el.classList.contains('is-open')).catch(() => false)) {
    await testInfo.attach('milestone-card', {
      body: await panel(page).screenshot({ timeout: 5000 }).catch(() => Buffer.alloc(0)),
      contentType: 'image/png',
    });
  }
  expect(page.__errors, 'the page logged errors').toEqual([]);
});

/** Real tap on touch-capable contexts, click everywhere else. */
async function activate(locator, page) {
  if (await page.evaluate(() => 'ontouchstart' in window)) {
    await locator.tap();
  } else {
    await locator.click();
  }
}

/**
 * Wait for the panel's entrance to finish.
 *
 * Every geometry assertion needs this. A FLIP is a `transform`, and a transform
 * changes the reported rect of everything inside the panel - so measuring while
 * the panel is in flight measures the animation, not the layout. That is not a
 * theoretical worry: it reported the panel 320px off-centre and the reaction
 * buttons 22px tall, which are both just the animation sampled early.
 */
async function settled(page) {
  await expect.poll(() => page.evaluate(() => {
    const t = getComputedStyle(document.getElementById('ms-detail-panel')).transform;
    // `none` is what a reduced-motion browser reports, and DOMMatrixReadOnly
    // throws on it, so an empty string (identity) stands in.
    const m = new DOMMatrixReadOnly(t && t !== 'none' ? t : '');
    return Math.abs(m.a - 1) < 0.005 && Math.abs(m.e) < 0.5 && Math.abs(m.f) < 0.5;
  }), { timeout: 8000 }).toBe(true);
}

async function openCard(page, id) {
  await activate(card(page, id), page);
  await expect(detail(page)).toHaveClass(/is-open/);
  await settled(page);
}

async function closeCard(page) {
  await expect(detail(page)).not.toHaveClass(/is-open/);
}

// ---------------------------------------------------------------- selection --

test.describe('every milestone is individually selectable', () => {
  for (const id of IDS) {
    test(`${id} opens its own record`, async ({ page }) => {
      await openCard(page, id);
      await expect(page.locator('#ms-detail-title'))
        .toHaveText(await page.evaluate(m => window.__FIXTURE_MILESTONES__[m].title, id));
    });
  }

  test('opening one card never shows another card\'s data', async ({ page }) => {
    // The regression this whole feature is about: a shared, never-repopulated
    // detail panel. Opening them in order and reading the title each time is the
    // only way to tell a real per-card population apart from a constant.
    const titles = await page.evaluate(() =>
      Object.values(window.__FIXTURE_MILESTONES__).map(m => m.title));
    for (let i = 0; i < IDS.length; i++) {
      await openCard(page, IDS[i]);
      await expect(page.locator('#ms-detail-title')).toHaveText(titles[i]);
      await page.locator('#ms-detail-close').click();
      await closeCard(page);
    }
  });

  test('opening the same card twice in a row is idempotent', async ({ page }) => {
    await openCard(page, IDS[1]);
    await page.locator('#ms-detail-close').click();
    await closeCard(page);
    await openCard(page, IDS[1]);
    // A second open must not stack a second panel or a second focus trap.
    await expect(page.locator('#ms-detail-panel')).toHaveCount(1);
    await expect(page.locator('#milestone-detail')).toHaveCount(1);
  });

  test('the keyboard opens a card too', async ({ page }) => {
    await card(page, IDS[0]).focus();
    await page.keyboard.press('Enter');
    await expect(detail(page)).toHaveClass(/is-open/);
    await expect(page.locator('#ms-detail-title')).toHaveText(
      await page.evaluate(() => window.__FIXTURE_MILESTONES__['ms-fixture-a'].title));
  });
});

// ------------------------------------------------------------------ geometry --

test('the panel is centred in the viewport', async ({ page }) => {
  await openCard(page, IDS[0]);
  const viewport = page.viewportSize();
  const box = await panel(page).boundingBox();
  const centreX = box.x + box.width / 2;
  const centreY = box.y + box.height / 2;
  expect(Math.abs(centreX - viewport.width / 2)).toBeLessThanOrEqual(2);
  // Vertically the panel may sit high or low when it is taller than the fold, but
  // it must not be pushed off screen in either direction.
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
});

test('the panel is meaningfully bigger than the card it came from', async ({ page }) => {
  const cardBox = await card(page, IDS[0]).boundingBox();
  await openCard(page, IDS[0]);
  const panelBox = await panel(page).boundingBox();
  expect(panelBox.width).toBeGreaterThan(cardBox.width);
  expect(panelBox.width).toBeGreaterThan(cardBox.height);
  expect(panelBox.height).toBeGreaterThan(cardBox.height);
});

test('the panel fits inside the viewport width on a phone', async ({ page }) => {
  await openCard(page, IDS[0]);
  const viewport = page.viewportSize();
  const box = await panel(page).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
});

test('the panel travels out of the card it was opened from, and settles centred', async ({ page }) => {
  // Headless Chrome reports `prefers-reduced-motion: reduce` by default, and this
  // page honours it - which is correct, and means the animation is switched off
  // unless the test asks for it. Ask.
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  const cardBox = await card(page, IDS[0]).boundingBox();
  const viewport = page.viewportSize();

  // Sampled every frame from before the click. Reading the transform after an
  // await only ever catches the settled value, and "settled" is the one state
  // that proves nothing about the animation - what has to be checked is that the
  // panel is somewhere ELSE on the way there.
  await page.evaluate(() => {
    window.__samples = [];
    const el = document.getElementById('ms-detail-panel');
    const tick = () => {
      const t = getComputedStyle(el).transform;
      if (t && t !== 'none') {
        const m = new DOMMatrixReadOnly(t);
        window.__samples.push({ x: m.e, y: m.f, s: m.a });
      }
      window.__raf = requestAnimationFrame(tick);
    };
    tick();
  });

  await openCard(page, IDS[0]);
  await expect.poll(() => page.evaluate(() => {
    const m = new DOMMatrixReadOnly(getComputedStyle(document.getElementById('ms-detail-panel')).transform);
    return Math.abs(m.a - 1) < 0.02;
  }), { timeout: 8000 }).toBe(true);

  const samples = await page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    return window.__samples;
  });
  expect(samples.length, 'no frames were sampled at all').toBeGreaterThan(3);

  // Settled: centred, full size.
  const last = samples[samples.length - 1];
  expect(Math.abs(last.x)).toBeLessThan(1.5);
  expect(Math.abs(last.y)).toBeLessThan(1.5);
  expect(Math.abs(last.s - 1)).toBeLessThan(0.02);

  // It travelled: several frames offset from the destination...
  const moved = samples.filter(s => Math.abs(s.x) > 4 || Math.abs(s.y) > 4);
  expect(moved.length, 'the panel never left its final position').toBeGreaterThan(2);
  // ...and it was smaller than it ended up. The margin is deliberately loose: the
  // scale is the card-to-panel width ratio, and on a phone the panel is full-bleed
  // and the card is nearly as wide, so a correct FLIP there starts at ~0.92. The
  // claim being tested is "it grew", not "it grew a lot".
  expect(Math.min(...samples.map(s => s.s)), 'the panel never scaled up on the way').toBeLessThan(0.97);

  // And it came FROM the card, on whichever axis the geometry actually differs.
  //
  // Not hard-coded to a horizontal check: the grid is three columns on a desktop
  // and one on a phone, so on the phone every card is as wide as the viewport and
  // the panel too - the horizontal travel is genuinely zero there and the FLIP
  // correctly travels vertically instead. Asserting a fixed axis made this fail on
  // the phone for doing exactly the right thing.
  const panelBox = await panel(page).boundingBox();
  const toCard = {
    x: (cardBox.x + cardBox.width / 2) - (panelBox.x + panelBox.width / 2),
    y: (cardBox.y + cardBox.height / 2) - (panelBox.y + panelBox.height / 2),
  };
  const axis = Math.abs(toCard.x) >= Math.abs(toCard.y) ? 'x' : 'y';
  expect(Math.abs(toCard[axis]), 'the card and the panel overlap exactly').toBeGreaterThan(20);
  expect(Math.sign(moved[0][axis]), 'the panel moved away from the card it came from')
    .toBe(Math.sign(toCard[axis]));
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the card still opens and closes - it just arrives', async ({ page }) => {
    // A dialog that refuses to open is not an accessible dialog. Honouring the
    // preference has to mean "no travel", never "no feature".
    await page.evaluate(() => {
      window.__samples = [];
      const el = document.getElementById('ms-detail-panel');
      const tick = () => {
        const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
        window.__samples.push({ x: m.e, y: m.f, s: m.a });
        window.__raf = requestAnimationFrame(tick);
      };
      tick();
    });

    await openCard(page, IDS[0]);
    // Legible while open: the entrance animation that normally fades the sections
    // in must not be what is making them visible.
    await expect(page.locator('#ms-detail-title')).toBeVisible();
    await expect(page.locator('#ms-detail-summary')).toBeVisible();

    await page.keyboard.press('Escape');
    await closeCard(page);

    const samples = await page.evaluate(() => {
      cancelAnimationFrame(window.__raf);
      return window.__samples;
    });
    // No offset at any point: the panel is never anywhere but the centre.
    for (const s of samples) {
      expect(Math.abs(s.x)).toBeLessThan(0.5);
      expect(Math.abs(s.y)).toBeLessThan(0.5);
    }
  });
});

test('opening does not shift the page sideways when the scrollbar goes', async ({ page }) => {
  // overflow:hidden on the document removes the scrollbar; without the compensating
  // padding the whole layout jumps by its width on the opening frame.
  await page.evaluate(() => { document.body.style.minHeight = '3000px'; });
  const before = await page.evaluate(() => document.documentElement.clientWidth);
  await openCard(page, IDS[0]);
  const after = await page.evaluate(() => document.documentElement.clientWidth);
  expect(after).toBe(before);
});

// ------------------------------------------------------------------- content --

test('the card shows the metric, summary and location the record carries', async ({ page }) => {
  await openCard(page, IDS[0]);
  await expect(page.locator('#ms-detail-value')).toHaveText('137');
  await expect(page.locator('#ms-detail-unit')).toHaveText('hours of audio');
  await expect(page.locator('#ms-detail-date')).toHaveText('2026-10-02');
  await expect(page.locator('#ms-detail-summary')).toContainText('corpus');
  await expect(page.locator('#ms-detail-location')).toContainText('31.7917');
  await expect(page.locator('#ms-detail-location-note')).toContainText('approximate');
  await expect(page.locator('.ms-detail__badge--record')).toHaveCount(1);
  await expect(page.locator('.ms-detail__badge--new')).toHaveCount(1);
});

test('a record with no metric shows its date and no empty value', async ({ page }) => {
  // Not a hidden block: the date is real information and belongs on screen. What
  // must not happen is an empty "0" or a stray unit, which is how a missing
  // metric usually announces itself.
  await openCard(page, IDS[1]);
  await expect(page.locator('#ms-detail-metric')).toBeVisible();
  await expect(page.locator('#ms-detail-value')).toHaveText('');
  await expect(page.locator('#ms-detail-unit')).toHaveText('');
  await expect(page.locator('#ms-detail-date')).toHaveText('2026-06-30');
  // And the sections that have nothing to say stay out of the way.
  await expect(page.locator('#ms-detail-summary-section')).toBeHidden();
  await expect(page.locator('#ms-detail-location-section')).toBeHidden();
  await expect(page.locator('#ms-detail-superseded-section')).toBeHidden();
});

test('references are links, and every one is safe to follow', async ({ page }) => {
  for (const id of IDS) {
    await openCard(page, id);
    const links = panel(page).locator('.ms-detail__ref a');
    const count = await links.count();
    expect(count, `${id} has at least one source`).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const link = links.nth(i);
      const href = await link.getAttribute('href');
      // The scheme check matters: a record's `url` is scraped content, and
      // javascript: in an href is a stored XSS on the one page that displays
      // scraped URLs with a link on them.
      expect(href, `${id} ref ${i} is http(s)`).toMatch(/^https?:\/\//);
      expect(await link.getAttribute('target')).toBe('_blank');
      expect(await link.getAttribute('rel')).toContain('noopener');
      expect(await link.getAttribute('referrerpolicy')).toBe('no-referrer');
    }
    await page.locator('#ms-detail-close').click();
    await closeCard(page);
  }
});

test('a hostile record URL is rendered as a name with no link', async ({ page }) => {
  // ms-fixture-b carries source "ETH Zurich" with no URL, plus a bare
  // javascript: URL in `sources`. Neither may become an href.
  await openCard(page, IDS[1]);
  const hrefs = await panel(page).locator('.ms-detail__ref a').evaluateAll(
    els => els.map(e => e.getAttribute('href')));
  expect(hrefs.every(h => /^https?:\/\//.test(h))).toBe(true);
  expect(await panel(page).locator('.ms-detail__ref').filter({ hasText: 'ETH Zurich' }).count())
    .toBeGreaterThan(0);
});

test('the title is set as text, never as markup', async ({ page }) => {
  const title = await page.evaluate(() => {
    const m = window.__FIXTURE_MILESTONES__['ms-fixture-a'];
    m.title = '<img src=x onerror=window.__pwned=true>';
    document.querySelector('.catalog-card[data-milestone-id="ms-fixture-a"]').click();
    return document.getElementById('ms-detail-title').innerHTML;
  });
  await expect(detail(page)).toHaveClass(/is-open/);
  expect(title).toContain('&lt;img');
  expect(await page.evaluate(() => window.__pwned === true)).toBe(false);
});

// ----------------------------------------------------------------- reactions --

test.describe('reactions', () => {
  test('the grid shows a strip on every card before anything is opened', async ({ page }) => {
    for (const id of IDS) {
      await expect(card(page, id).locator('.catalog-card__reactions')).toHaveCount(1);
      await expect(card(page, id).locator('.catalog-card__reactions-empty'))
        .toContainText('No reactions yet');
    }
  });

  test('the posting thread does not exist until a card is open', async ({ page }) => {
    // The stated design: the grid carries the top three reactions, everything
    // else lives inside the card. So before opening, there is no thread and no
    // composer anywhere on the page.
    await expect(page.locator('#ms-detail-thread')).toBeHidden();
    await expect(page.locator('#ms-detail-composer')).toBeHidden();
    await openCard(page, IDS[0]);
    await expect(page.locator('#ms-detail-thread')).toBeVisible();
    await expect(page.locator('#ms-detail-composer')).toBeVisible();
  });

  test('reacting from inside the card updates the grid strip', async ({ page }) => {
    await openCard(page, IDS[0]);
    await panel(page).locator('.ms-detail__react').filter({ hasText: ROCKET }).click();
    await expect(panel(page).locator('.ms-detail__react').filter({ hasText: ROCKET }))
      .toHaveAttribute('aria-pressed', 'true');
    const chip = card(page, IDS[0]).locator('.catalog-card__reaction').filter({ hasText: ROCKET });
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(chip.locator('.catalog-card__reaction-count')).toHaveText('1');
  });

  test('tapping a strip chip posts without opening the card', async ({ page }) => {
    // Nothing is on the strip yet, so there is nothing to tap. React first, from
    // inside the card, then come back to the grid.
    await openCard(page, IDS[0]);
    await panel(page).locator('.ms-detail__react').filter({ hasText: ROCKET }).click();
    await page.locator('#ms-detail-close').click();
    await closeCard(page);

    const strip = card(page, IDS[0]).locator('.catalog-card__reactions');
    await expect(strip.locator('.catalog-card__reaction')).toHaveCount(1);

    await activate(strip.locator('.catalog-card__reaction').filter({ hasText: ROCKET }), page);

    // The chip un-reacts, so the tally goes back to nothing and the chip goes with
    // it - a strip that still showed "1" would mean the tap opened the card instead.
    await expect(strip.locator('.catalog-card__reaction')).toHaveCount(0);
    await expect(strip.locator('.catalog-card__reactions-empty')).toContainText('No reactions yet');
    await expect(detail(page)).not.toHaveClass(/is-open/);

    // And the grid state agrees with what the card would have shown.
    await openCard(page, IDS[0]);
    await expect(panel(page).locator('.ms-detail__react').filter({ hasText: ROCKET }))
      .toHaveAttribute('aria-pressed', 'false');
  });

  test('a reaction never leaks from one milestone to another', async ({ page }) => {
    await openCard(page, IDS[0]);
    await panel(page).locator('.ms-detail__react').filter({ hasText: ROCKET }).click();
    await page.locator('#ms-detail-close').click();
    await closeCard(page);

    await expect(card(page, IDS[0]).locator('.catalog-card__reaction')).toHaveCount(1);
    await expect(card(page, IDS[1]).locator('.catalog-card__reaction')).toHaveCount(0);
    await expect(card(page, IDS[2]).locator('.catalog-card__reaction')).toHaveCount(0);
  });

  test('the grid shows at most the top three, and says how many it hid', async ({ page }) => {
    // Seed four reactions through the same public surface a reader would use.
    await page.evaluate(() => {
      const m = window.__FIXTURE_MILESTONES__['ms-fixture-a'];
      const el = document.querySelector('.catalog-card[data-milestone-id="ms-fixture-a"]');
      window.MilestoneDetail.open(m, el);
    });
    await expect(detail(page)).toHaveClass(/is-open/);
    const emojis = ['\u{1F680}', '\u{1F525}', '\u{1F92F}', '\u{1F44F}'];
    for (const emoji of emojis) {
      await panel(page).locator('.ms-detail__react[data-emoji="' + emoji + '"]').click();
    }
    await page.locator('#ms-detail-close').click();
    await closeCard(page);

    const strip = card(page, IDS[0]).locator('.catalog-card__reactions');
    await expect(strip.locator('.catalog-card__reaction')).toHaveCount(3);
    await expect(strip.locator('.catalog-card__reactions-empty')).toContainText('+1 more inside');
    // All four count 1, so the tie breaks on the allow-list order: rocket, fire,
    // mind-blowing. Clap is the one that got hidden.
    await expect(strip.locator('.catalog-card__reaction').nth(0)).toContainText(ROCKET);
    await expect(strip.locator('.catalog-card__reaction').nth(1)).toContainText('\u{1F525}');
    await expect(strip.locator('.catalog-card__reaction').nth(2)).toContainText('\u{1F92F}');
  });

  test('an anonymous reader can post a comment, and it appears in the thread', async ({ page }) => {
    await openCard(page, IDS[2]);
    await expect(page.locator('#ms-detail-identity')).toHaveText(/Anonymous/);
    await page.locator('#ms-detail-comment').fill('The primary source is a preprint, not peer reviewed.');
    await page.locator('#ms-detail-comment-submit').click();

    const entries = page.locator('#ms-detail-thread .ms-detail__entry');
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText('preprint');
    await expect(entries.first()).toHaveAttribute('data-mine', 'true');
    // The composer is cleared, so the same text cannot be posted twice by accident.
    await expect(page.locator('#ms-detail-comment')).toHaveValue('');
    // The confirmation survives the write that follows it. It used to be replaced
    // by the storage-policy line milliseconds later, which made it unreadable.
    await expect(page.locator('#ms-detail-composer-note')).toContainText('Posted.');
    await expect(page.locator('#ms-detail-composer-note')).toContainText(/browser only|Shared with/);
  });

  test('a comment is rendered as text, never as markup', async ({ page }) => {
    await openCard(page, IDS[2]);
    await page.locator('#ms-detail-comment').fill('<img src=x onerror=window.__pwned2=true>');
    await page.locator('#ms-detail-comment-submit').click();
    await expect(page.locator('#ms-detail-thread .ms-detail__entry')).toHaveCount(1);
    await expect(page.locator('#ms-detail-thread img')).toHaveCount(0);
    expect(await page.evaluate(() => window.__pwned2 === true)).toBe(false);
  });

  test('an empty comment is refused with a reason, not posted as a blank row', async ({ page }) => {
    await openCard(page, IDS[2]);
    await page.locator('#ms-detail-comment').fill('    ');
    await page.locator('#ms-detail-comment-submit').click();
    await expect(page.locator('#ms-detail-composer-note')).toContainText('Write something first');
    await expect(page.locator('#ms-detail-thread .ms-detail__entry')).toHaveCount(0);
  });

  test('reactions and comments survive a reload', async ({ page }) => {
    await openCard(page, IDS[0]);
    await panel(page).locator('.ms-detail__react').filter({ hasText: ROCKET }).click();
    await page.locator('#ms-detail-comment').fill('persisted');
    await page.locator('#ms-detail-comment-submit').click();
    await expect(page.locator('#ms-detail-thread .ms-detail__entry')).toHaveCount(1);

    await page.reload();
    await page.waitForFunction(
      (id) => !!document.querySelector(`.catalog-card[data-milestone-id="${id}"] .catalog-card__reaction`),
      IDS[0], { timeout: 10_000 });

    const chip = card(page, IDS[0]).locator('.catalog-card__reaction').filter({ hasText: ROCKET });
    await expect(chip).toHaveCount(1);
    await expect(chip.locator('.catalog-card__reaction-count')).toHaveText('1');
    // Still marked as mine, which only works if the "I reacted" flag persisted
    // alongside the tally rather than being recomputed from it.
    await expect(chip).toHaveAttribute('aria-pressed', 'true');

    await openCard(page, IDS[0]);
    await expect(page.locator('#ms-detail-thread .ms-detail__entry')).toHaveCount(1);
    await expect(page.locator('#ms-detail-thread')).toContainText('persisted');
  });

  test('the composer states the posting terms rather than hiding them', async ({ page }) => {
    // No paywall and no account requirement, said out loud: the whole feature is
    // worthless if a reader has to guess whether they are allowed to use it.
    await openCard(page, IDS[0]);
    await expect(page.locator('#ms-detail-composer-note')).toContainText(/Free to post/);
  });

  test('the reaction buttons are big enough to hit with a thumb', async ({ page }) => {
    await openCard(page, IDS[0]);
    const heights = await panel(page).locator('.ms-detail__react')
      .evaluateAll(els => els.map(e => e.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(0);
    // 36px is the CSS floor for the picker; the composer submit button is 44px on a
    // phone. Below ~32px these stop being reliably tappable, which is the failure
    // this assertion exists to prevent.
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(32);
  });

  test('the card stops the page behind it from scrolling', async ({ page }) => {
    await page.evaluate(() => { document.body.style.minHeight = '3000px'; });
    await openCard(page, IDS[0]);
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('hidden');
    await page.locator('#ms-detail-close').click();
    await closeCard(page);
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('');
  });
});

// -------------------------------------------------------------- dismissal ----

test.describe('dismissing the card', () => {
  for (const how of ['escape', 'close button', 'scrim']) {
    test(`the ${how} closes it and gives focus back`, async ({ page }) => {
      await openCard(page, IDS[0]);
      if (how === 'escape') await page.keyboard.press('Escape');
      else if (how === 'close button') await page.locator('#ms-detail-close').click();
      else await page.locator('#ms-detail-scrim').click({ position: { x: 5, y: 5 } });
      await closeCard(page);
      // Returning focus is what lets a keyboard reader carry on down the grid.
      await expect(card(page, IDS[0])).toBeFocused();
      await expect(detail(page)).toBeHidden();
    });
  }

  test('Escape inside a textarea still closes, it does not just move the caret', async ({ page }) => {
    await openCard(page, IDS[0]);
    await page.locator('#ms-detail-comment').focus();
    await page.keyboard.press('Escape');
    await closeCard(page);
  });

  test('closing then reopening works', async ({ page }) => {
    await openCard(page, IDS[0]);
    await page.keyboard.press('Escape');
    await closeCard(page);
    await openCard(page, IDS[1]);
    await expect(page.locator('#ms-detail-title'))
      .toHaveText(await page.evaluate(() => window.__FIXTURE_MILESTONES__['ms-fixture-b'].title));
  });
});

// ------------------------------------------------------------ focus trap -----

test('Tab stays inside the card', async ({ page }) => {
  await openCard(page, IDS[0]);
  const inside = async () => page.evaluate(() =>
    document.getElementById('ms-detail-panel').contains(document.activeElement));

  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    expect(await inside(), `focus left the dialog after ${i + 1} tabs`).toBe(true);
  }
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await inside(), `Shift+Tab left the dialog after ${i + 1}`).toBe(true);
  }
});

// -------------------------------------------------- without a backend -------

test.describe('with no reactions backend, which is the deployed state today', () => {
  test('posting still works locally and the composer says so honestly', async ({ page }) => {
    // GitHub Pages is static, so /api/reactions does not exist on the live site.
    // The reader must not be met by an error, and must not be told their reaction
    // went somewhere shared when it did not.
    const seen = [];
    await page.route('**/api/reactions', (route) => {
      seen.push(route.request().method() + ' ' + new URL(route.request().url()).pathname);
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });

    await openCard(page, IDS[0]);
    await panel(page).locator('.ms-detail__react').filter({ hasText: ROCKET }).click();

    await expect(panel(page).locator('.ms-detail__react').filter({ hasText: ROCKET }))
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#ms-detail-identity')).toHaveAttribute('data-kind', 'anonymous');
    await expect(page.locator('#ms-detail-identity')).toHaveAttribute('title', /this browser only/);

    await page.locator('#ms-detail-comment').fill('still works offline');
    await page.locator('#ms-detail-comment-submit').click();
    await expect(page.locator('#ms-detail-thread .ms-detail__entry')).toHaveCount(1);
    await expect(page.locator('#ms-detail-thread')).toContainText('still works offline');

    // It really did try the endpoint, and the endpoint really did refuse.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(s => s.startsWith('POST /api/reactions'))).toBe(true);
  });

  test('a dead backend does not make the card unusable', async ({ page }) => {
    await page.route('**/api/reactions', (route) => route.abort('failed'));
    await openCard(page, IDS[2]);
    await expect(panel(page)).toBeVisible();
    await panel(page).locator('.ms-detail__react').first().click();
    await expect(panel(page).locator('.ms-detail__react').first())
      .toHaveAttribute('aria-pressed', 'true');
    // No unhandled rejection surfaced: the failure is absorbed into "local only".
    expect(page.__errors ?? []).toEqual([]);
  });
});

// -------------------------------------------------- fixture cannot drift -----

test('the overlay markup in the fixture and in the Jekyll include agree', async ({ page }) => {
  // Jekyll cannot run in this static-server fixture, so the overlay markup is
  // copied. A copy with no guard is a duplicate that rots on the next rename - and
  // the symptom would be a card that silently loses its close button. So the guard
  // is mechanical: every id milestone-detail.js looks up must exist in both.
  //
  // The ids are collected as string literals rather than by matching
  // getElementById(...), because createView() looks them up through a local
  // `el` alias and a regex for the call site would silently match nothing - and
  // an assertion that reads as meaningful while checking zero things is worse
  // than no assertion.
  const required = [...new Set(
    [...detailSource.matchAll(/'(ms-detail-[a-z-]+)'/g)].map((m) => m[1])
  )];
  expect(required.length, 'no ids found in milestone-detail.js - the guard is broken').toBeGreaterThan(15);
  for (const id of required) {
    expect(detailInclude, `_includes/milestone-detail.html is missing ${id}`).toContain(`id="${id}"`);
    expect(fixtureHtml, `e2e/milestone-detail.fixture.html is missing ${id}`).toContain(`id="${id}"`);
    // And it must actually be on the rendered page, or the whole feature is
    // inert again - which is exactly how it shipped once.
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
  const indexMd = readFileSync(join(ROOT, 'index.md'), 'utf8');
  expect(indexMd, 'index.md no longer includes the overlay').toContain('include milestone-detail.html');
});

test('the shipped stylesheet is linked by the page that needs it', () => {
  // The overlay was dead for one reason: nothing loaded the thing that opened it.
  // These assertions make that class of mistake fail loudly instead.
  const indexMd = readFileSync(join(ROOT, 'index.md'), 'utf8');
  expect(indexMd).toContain('/assets/css/milestone-detail.css');
  expect(indexMd).toContain('/assets/js/milestone-detail.js');

  // dashboard.js must delegate rather than carry its own modal implementation.
  const dashboard = readFileSync(join(ROOT, 'assets', 'js', 'dashboard.js'), 'utf8');
  expect(dashboard).toContain('window.MilestoneDetail.open');
  // A prose mention of the old modal in a comment is fine; a lookup is not.
  expect(dashboard).not.toContain("getElementById('milestone-modal");
  expect(dashboard).not.toContain('milestone-modal-content');
  // And the stylesheet for it must be gone from main.css, so there is only one
  // implementation of this view in the repository.
  const mainCss = readFileSync(join(ROOT, 'assets', 'css', 'main.css'), 'utf8');
  expect(mainCss).not.toContain('.milestone-modal {');
  expect(mainCss).not.toContain('.milestone-modal-content');
});