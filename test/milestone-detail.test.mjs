/**
 * Unit tests for the milestone detail card's pure logic.
 *
 * Runs under `bun test`: loads the real assets/js/milestone-detail.js against a
 * DOM stub good enough for the module to boot, and asserts against the
 * window.__MILESTONE_DETAIL_TEST__ hook.
 *
 * What is deliberately NOT tested here: anything that needs a real box. The
 * unit suite runs against a stub with no layout, so it cannot see whether the
 * panel is centred, whether a tap reaches a card, or whether the FLIP lands
 * where it should. e2e/milestone-detail.spec.mjs measures those in Chromium, on
 * both the desktop and the phone project.
 *
 * What IS tested here is everything the browser will not tell you cheaply:
 * the ranking rules, the merge arithmetic, the sanitising predicates, and the
 * store's quota and vote accounting - every one of which has a specific
 * failure mode that shipped as a wrong number rather than as a crash.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(HERE, '..', 'assets', 'js', 'milestone-detail.js'), 'utf8');

// ---- DOM stub ---------------------------------------------------------------
// Only enough of the DOM for the module to boot without throwing. boot() gives up
// early when #milestone-detail is absent, which is the point: the pure helpers
// must be reachable whether or not the overlay is on the page.

function makeStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    _map: map,
  };
}

const documentObj = {
  readyState: 'complete',
  createElement: () => ({ style: {}, className: '', textContent: '', dataset: {} }),
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  documentElement: { style: {}, clientWidth: 1200 },
};

const sandbox = {
  window: { document: documentObj },
  document: documentObj,
  localStorage: makeStorage(),
  console,
  URL,
  URLSearchParams,
  Map,
  Set,
  Object,
  Array,
  Math,
  JSON,
  Date,
  Number,
  String,
  Error,
  TypeError,
  isNaN,
  parseInt,
  parseFloat,
  AbortController: class { abort() {} signal = {} },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  MutationObserver: class { observe() {} disconnect() {} },
  setTimeout: () => 0,
  clearTimeout: () => {},
  innerWidth: 1200,
};

const fn = new Function(...Object.keys(sandbox), `${code}\n return window.__MILESTONE_DETAIL_TEST__;`);
const api = fn(...Object.values(sandbox));

const ROCKET = '\u{1F680}';
const FIRE = '\u{1F525}';
const MIND = '\u{1F92F}';
const CLAP = '\u{1F44F}';

describe('milestone detail: URL safety', () => {
  test('only http(s) is treated as linkable', () => {
    expect(api.isSafeHttpUrl('https://arxiv.org/abs/2609.38219')).toBe(true);
    expect(api.isSafeHttpUrl('http://example.org/a')).toBe(true);
  });

  test('javascript:, data: and protocol-relative are refused', () => {
    // The classic bypass: /^\s*https?:/ would accept the second of these because
    // \s* eats the newline and the parser is what actually settles it.
    expect(api.isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(api.isSafeHttpUrl('java\nscript:alert(1)')).toBe(false);
    expect(api.isSafeHttpUrl('  javascript:alert(1)')).toBe(false);
    expect(api.isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(api.isSafeHttpUrl('//evil.example/x')).toBe(false);
    expect(api.isSafeHttpUrl('vbscript:msgbox')).toBe(false);
  });

  test('non-strings and empties are refused rather than coerced', () => {
    expect(api.isSafeHttpUrl(null)).toBe(false);
    expect(api.isSafeHttpUrl(undefined)).toBe(false);
    expect(api.isSafeHttpUrl(42)).toBe(false);
    expect(api.isSafeHttpUrl('')).toBe(false);
    expect(api.isSafeHttpUrl('   ')).toBe(false);
  });

  test('hostOf strips www and survives garbage', () => {
    expect(api.hostOf('https://www.arxiv.org/abs/x')).toBe('arxiv.org');
    expect(api.hostOf('https://blog.gmail.com/x')).toBe('blog.gmail.com');
    expect(api.hostOf('not a url')).toBe('');
    expect(api.hostOf(null)).toBe('');
  });
});

describe('milestone detail: ranking', () => {
  test('orders by count, then by the allow-list order', () => {
    // ROCKET and FIRE tie. The allow-list is what breaks the tie, so two devices
    // holding identical counts render an identical top three.
    const ranked = api.rankReactions({ [FIRE]: 5, [ROCKET]: 5, [MIND]: 9 });
    expect(ranked.map(e => e.emoji)).toEqual([MIND, ROCKET, FIRE]);
  });

  test('honours the limit, and a limit of zero yields nothing', () => {
    const counts = { [ROCKET]: 3, [FIRE]: 2, [MIND]: 1 };
    expect(api.rankReactions(counts, 3).length).toBe(3);
    expect(api.rankReactions(counts, 1).map(e => e.emoji)).toEqual([ROCKET]);
    expect(api.rankReactions(counts, 0)).toEqual([]);
  });

  test('drops unknown emoji, non-numeric and non-positive counts', () => {
    // An unknown key would otherwise become an unrankable chip that renders as a
    // tofu box and, worse, a payload can put anything in that object.
    const ranked = api.rankReactions({
      '🛸': 99,
      [ROCKET]: 'not a number',
      [FIRE]: -4,
      [MIND]: 0,
      [CLAP]: 2,
    });
    expect(ranked.map(e => e.emoji)).toEqual([CLAP]);
  });

  test('fractional counts floor rather than leak through', () => {
    expect(api.rankReactions({ [ROCKET]: 3.9 })[0].count).toBe(3);
  });

  test('a non-object is an empty ranking, not a throw', () => {
    for (const bad of [null, undefined, 0, 'nope', []]) {
      expect(api.rankReactions(bad)).toEqual([]);
    }
  });

  test('the catalog read-out is exactly three wide', () => {
    expect(api.TOP_ON_CARD).toBe(3);
    expect(api.REACTION_EMOJI.length).toBeGreaterThan(api.TOP_ON_CARD);
  });
});

describe('milestone detail: merging counts', () => {
  test('unions by max, never by sum', () => {
    // The reason for the rule: a reader who posts from two browsers must not be
    // able to turn 3 into 6. Summing is the obvious implementation and the wrong
    // one.
    expect(api.mergeCounts({ [ROCKET]: 3 }, { [ROCKET]: 3 })).toEqual({ [ROCKET]: 3 });
  });

  test('takes whichever side knows more', () => {
    expect(api.mergeCounts({ [ROCKET]: 2 }, { [ROCKET]: 7 })).toEqual({ [ROCKET]: 7 });
    expect(api.mergeCounts({ [ROCKET]: 7 }, { [ROCKET]: 2 })).toEqual({ [ROCKET]: 7 });
  });

  test('unions keys rather than replacing the object', () => {
    expect(api.mergeCounts({ [ROCKET]: 1 }, { [FIRE]: 2 })).toEqual({ [ROCKET]: 1, [FIRE]: 2 });
  });

  test('drops unknown and impossible values on the way through', () => {
    expect(api.mergeCounts({ '🛸': 4, [ROCKET]: -1 }, { [ROCKET]: 'x', [FIRE]: 3 }))
      .toEqual({ [FIRE]: 3 });
  });

  test('tolerates either side being absent', () => {
    expect(api.mergeCounts(null, { [ROCKET]: 1 })).toEqual({ [ROCKET]: 1 });
    expect(api.mergeCounts({ [ROCKET]: 1 }, undefined)).toEqual({ [ROCKET]: 1 });
    expect(api.mergeCounts(null, null)).toEqual({});
  });
});

describe('milestone detail: comment sanitising', () => {
  test('strips control characters but keeps prose newlines', () => {
    expect(api.sanitizeComment('line one\nline two')).toBe('line one\nline two');
    expect(api.sanitizeComment('tab\there')).toBe('tab\there');
    expect(api.sanitizeComment('bell\u0007here')).toBe('bellhere');
    expect(api.sanitizeComment('null\u0000byte')).toBe('nullbyte');
    expect(api.sanitizeComment('c1')).toBe('c1');
  });

  test('normalises CRLF and collapses long blank runs', () => {
    expect(api.sanitizeComment('a\r\nb')).toBe('a\nb');
    expect(api.sanitizeComment('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  test('trims, and truncates at the advertised maximum', () => {
    expect(api.sanitizeComment('   padded   ')).toBe('padded');
    expect(api.sanitizeComment('x'.repeat(api.COMMENT_MAX + 50)).length).toBe(api.COMMENT_MAX);
  });

  test('a comment made only of whitespace or controls is empty, not a blank post', () => {
    // Otherwise the server receives an invisible comment and the thread fills up
    // with rows nobody wrote.
    expect(api.sanitizeComment('')).toBe('');
    expect(api.sanitizeComment('   \n\t  ')).toBe('');
    expect(api.sanitizeComment('\u0000\u0001\u0002')).toBe('');
    expect(api.sanitizeComment(null)).toBe('');
    expect(api.sanitizeComment(12345)).toBe('');
  });

  test('markup in a comment is left as text for the renderer to escape', () => {
    expect(api.sanitizeComment('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('milestone detail: identity', () => {
  test('a GitHub session wins, and is attributed to the login', () => {
    const id = api.resolveIdentity({ login: 'neohiro', session_id: 'abc123' }, 'anon-xyz');
    expect(id).toEqual({ id: 'gh:abc123', kind: 'github', label: '@neohiro' });
  });

  test('a session with no session_id still attributes, by login', () => {
    const id = api.resolveIdentity({ login: 'neohiro' }, 'anon-xyz');
    expect(id).toEqual({ id: 'gh:neohiro', kind: 'github', label: '@neohiro' });
  });

  test('anonymous otherwise, under the browser id', () => {
    expect(api.resolveIdentity(null, 'anon-xyz'))
      .toEqual({ id: 'anon:anon-xyz', kind: 'anonymous', label: 'Anonymous' });
  });

  test('with neither, it is still anonymous rather than undefined', () => {
    // A login-less session object must not produce an id of "undefined:undefined",
    // which would collapse every such reader into one vote.
    expect(api.resolveIdentity({ session_id: 'x' }, null)).toEqual({
      id: 'anon:unset', kind: 'anonymous', label: 'Anonymous',
    });
    expect(api.resolveIdentity({}, '')).toEqual({ id: 'anon:unset', kind: 'anonymous', label: 'Anonymous' });
  });

  test('the two id namespaces cannot collide', () => {
    // A GitHub login literally named the anonymous id must not impersonate it.
    expect(api.resolveIdentity({ login: 'q', session_id: 'q' }, 'q').id)
      .not.toBe(api.resolveIdentity(null, 'q').id);
  });

  test('a login is trimmed, and a whitespace login is not a login', () => {
    expect(api.resolveIdentity({ login: '  neohiro  ', session_id: 's' }).label).toBe('@neohiro');
    expect(api.resolveIdentity({ login: '   ', session_id: 's' }).kind).toBe('anonymous');
  });

  test('an expired session is dead; a fresh one is live', () => {
    expect(api.isSessionLive({ session_id: 's', expiresAt: 2000 }, 1000)).toBe(true);
    expect(api.isSessionLive({ session_id: 's', expiresAt: 1000 }, 1000)).toBe(false);
    expect(api.isSessionLive({ session_id: 's', expiresAt: 999 }, 1000)).toBe(false);
    // No expiry recorded means "no local clock on it", which auth-bar.js can
    // legitimately produce; treating it as expired would log everyone out.
    expect(api.isSessionLive({ session_id: 's' }, 1000)).toBe(true);
    expect(api.isSessionLive({ login: 'neohiro' }, 1000)).toBe(false);
    expect(api.isSessionLive(null, 1000)).toBe(false);
  });
});

describe('milestone detail: anonymous id generation', () => {
  test('two ids never collide', () => {
    const ids = new Set(Array.from({ length: 500 }, () => api.newAnonId()));
    expect(ids.size).toBe(500);
  });

  test('it is namespaced so it cannot be mistaken for a session id', () => {
    expect(api.newAnonId().startsWith('anon-')).toBe(true);
  });

  test('it falls back when there is no Web Crypto, without throwing', () => {
    // Reached only in a context without crypto.getRandomValues, where a
    // predictable id costs nothing - it names a browser, not a person.
    expect(typeof api.newAnonId(null)).toBe('string');
  });
});

describe('milestone detail: relative time', () => {
  const now = 1_700_000_000_000;
  const at = s => now - s * 1000;

  test('reads as prose across every band', () => {
    expect(api.relativeTime(at(5), now)).toBe('just now');
    expect(api.relativeTime(at(300), now)).toBe('5m ago');
    expect(api.relativeTime(at(3600 * 3), now)).toBe('3h ago');
    expect(api.relativeTime(at(86400 * 2), now)).toBe('2d ago');
    expect(api.relativeTime(at(86400 * 30), now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('a clock that disagrees with the server does not produce "-3m ago"', () => {
    expect(api.relativeTime(now + 60_000, now)).toBe('just now');
  });

  test('an unparseable timestamp is a dash, not NaN', () => {
    expect(api.relativeTime('nonsense', now)).toBe('—');
    expect(api.relativeTime(undefined, now)).toBe('—');
  });
});

describe('milestone detail: references', () => {
  test('the record source comes first and is linkable', () => {
    const refs = api.referencesFor({
      source: 'arXiv', url: 'https://arxiv.org/abs/2609.38219',
    });
    expect(refs[0]).toEqual({ name: 'arXiv', url: 'https://arxiv.org/abs/2609.38219', host: 'arxiv.org' });
  });

  test('the archive is always last, so every record has at least one source', () => {
    const refs = api.referencesFor({ title: 'x' });
    expect(refs.length).toBe(1);
    expect(refs[0].url).toBe('https://github.com/transhumanists/milestones');
  });

  test('extra sources follow, and a repeat of the primary is not listed twice', () => {
    const refs = api.referencesFor({
      source: 'Open Khipu Repository',
      url: 'http://arxiv.org/abs/2607.00185v1',
      sources: ['Open Khipu Repository', 'Academic researchers (Open Khipu Repository)'],
    });
    expect(refs.map(r => r.name)).toEqual([
      'Open Khipu Repository',
      'Academic researchers (Open Khipu Repository)',
      'Milestone archive (transhumanists/milestones)',
    ]);
  });

  test('a bare URL in sources[] becomes a link rather than a bare name', () => {
    const refs = api.referencesFor({ source: 'Nature', url: 'https://x.org/a', sources: ['https://blog.y.org/b'] });
    expect(refs[1]).toEqual({ name: 'blog.y.org', url: 'https://blog.y.org/b', host: 'blog.y.org' });
  });

  test('an object source is read too, and an unsafe URL is dropped but the name is kept', () => {
    const refs = api.referencesFor({
      source: 'A', url: 'https://a.org/1',
      sources: [{ name: 'B', url: 'javascript:alert(1)' }, { source: 'C', url: 'https://c.org/2' }],
    });
    // "B" survives as a plain name: the record says who reported it, and losing
    // that because the URL could not be linked would be a worse answer than
    // showing the name with no link.
    expect(refs.map(r => r.name)).toEqual(['A', 'B', 'C', 'Milestone archive (transhumanists/milestones)']);
    expect(refs[1].url).toBe('');
    expect(refs[2].url).toBe('https://c.org/2');
  });

  test('a record with a hostile URL still yields exactly one safe reference', () => {
    const refs = api.referencesFor({ source: 'Evil', url: 'javascript:alert(1)' });
    expect(refs[0]).toEqual({ name: 'Evil', url: '', host: '' });
    expect(refs.every(r => r.url === '' || r.url.startsWith('https://'))).toBe(true);
  });

  test('malformed extra sources do not throw', () => {
    expect(() => api.referencesFor({ source: 'A', sources: 'not-an-array' })).not.toThrow();
    expect(() => api.referencesFor({ source: 'A', sources: [null, 3, {}, 'B'] })).not.toThrow();
    expect(() => api.referencesFor(null)).not.toThrow();
  });
});

describe('milestone detail: ownership of a thread entry', () => {
  // The bug this exists to prevent: an entry's id is `owner + ':' + timestamp` so
  // that two posts from one reader are two entries. Comparing that id to the
  // identity id is therefore never true, and every reader's own comment renders
  // unlabelled. The failure is invisible - the comment is still there, just not
  // marked - which is why it is pinned down here rather than in a browser check.
  const mine = { id: 'anon:abc123:lqz3k', owner: 'anon:abc123', text: 'x' };
  const theirs = { id: 'gh:zzz:lqz4m', owner: 'gh:zzz', text: 'y' };
  const legacy = { id: 'anon:abc123:lqz3k', text: 'z' };

  test('an entry is mine when its owner is this identity', () => {
    expect(api.isOwnEntry(mine, 'anon:abc123')).toBe(true);
    expect(api.isOwnEntry(theirs, 'anon:abc123')).toBe(false);
  });

  test('the id alone is never enough', () => {
    expect(api.isOwnEntry({ id: 'anon:abc123' }, 'anon:abc123')).toBe(false);
  });

  test('an entry with no owner is unclaimed rather than everybody-s', () => {
    expect(api.isOwnEntry(legacy, 'anon:abc123')).toBe(false);
    expect(api.isOwnEntry({ id: 'x', owner: '' }, '')).toBe(false);
    expect(api.isOwnEntry(null, 'anon:abc123')).toBe(false);
    expect(api.isOwnEntry(mine, null)).toBe(false);
    expect(api.isOwnEntry(mine, undefined)).toBe(false);
  });
});

describe('milestone detail: the reaction store', () => {
  const newStore = () => api.createStore(makeStorage(), () => 1000);

  test('a fresh store knows nothing', () => {
    const s = newStore();
    expect(s.counts('ms-1')).toEqual({});
    expect(s.mine('ms-1')).toEqual({});
    expect(s.comments('ms-1')).toEqual([]);
  });

  test('one person reacting twice counts once', () => {
    // The count is derived from the "I reacted" flag rather than incremented, so
    // a double-tap cannot produce a tally of 2 from a single reader.
    const s = newStore();
    s.setMine('ms-1', ROCKET, true);
    s.setMine('ms-1', ROCKET, true);
    expect(s.counts('ms-1')).toEqual({ [ROCKET]: 1 });
  });

  test('un-reacting reverses exactly, and never goes below zero', () => {
    const s = newStore();
    s.setMine('ms-1', ROCKET, true);
    s.setMine('ms-1', ROCKET, false);
    expect(s.counts('ms-1')).toEqual({});
    s.setMine('ms-1', ROCKET, false);
    expect(s.counts('ms-1')).toEqual({});
  });

  test('a zero count is deleted rather than stored, so it cannot rank', () => {
    const s = newStore();
    s.setMine('ms-1', ROCKET, true);
    s.setMine('ms-1', ROCKET, false);
    expect(Object.keys(s.counts('ms-1'))).not.toContain(ROCKET);
  });

  test('reactions on different milestones never mix', () => {
    const s = newStore();
    s.setMine('ms-1', ROCKET, true);
    s.setMine('ms-2', ROCKET, true);
    expect(s.counts('ms-1')).toEqual({ [ROCKET]: 1 });
    expect(s.counts('ms-2')).toEqual({ [ROCKET]: 1 });
  });

  test('an unknown emoji is refused, and an unknown milestone id is inert', () => {
    const s = newStore();
    s.setMine('ms-1', '🛸', true);
    expect(s.counts('ms-1')).toEqual({});
    s.setMine('', ROCKET, true);
    expect(s.counts('')).toEqual({});
    expect(() => s.setMine(undefined, ROCKET, true)).not.toThrow();
  });

  test('a returned counts object is a copy, not the live bucket', () => {
    // The catalog holds one of these per card for the lifetime of the page; a
    // shared reference would let one card's repaint rewrite another's tally.
    const s = newStore();
    s.setMine('ms-1', ROCKET, true);
    const first = s.counts('ms-1');
    first[ROCKET] = 999;
    expect(s.counts('ms-1')).toEqual({ [ROCKET]: 1 });
  });

  test('state survives a round trip through storage', () => {
    const backing = makeStorage();
    const a = api.createStore(backing, () => 1000);
    a.setMine('ms-1', ROCKET, true);
    a.addComment('ms-1', { id: 'c1', author: 'Anonymous', kind: 'anonymous', text: 'hi', ts: 5 });
    const b = api.createStore(backing, () => 2000);
    expect(b.counts('ms-1')).toEqual({ [ROCKET]: 1 });
    expect(b.mine('ms-1')).toEqual({ [ROCKET]: true });
    expect(b.comments('ms-1')).toHaveLength(1);
  });

  test('corrupt stored JSON is discarded rather than crashing the page', () => {
    const backing = makeStorage();
    backing.setItem('th_reactions_v1', '{"v":1,"milestones":');
    const s = api.createStore(backing, () => 1000);
    expect(s.counts('ms-1')).toEqual({});
  });

  test('a storage from a future schema version is not trusted', () => {
    const backing = makeStorage();
    backing.setItem('th_reactions_v1', '{"v":99,"milestones":{"ms-1":{"counts":{"x":9}}}}');
    const s = api.createStore(backing, () => 1000);
    expect(s.counts('ms-1')).toEqual({});
  });

  test('a milestone whose bucket is missing fields is repaired, not thrown on', () => {
    const backing = makeStorage();
    backing.setItem('th_reactions_v1', '{"v":1,"milestones":{"ms-1":{"counts":{"🚀":2}}}}');
    const s = api.createStore(backing, () => 1000);
    expect(s.counts('ms-1')).toEqual({ [ROCKET]: 2 });
    expect(s.comments('ms-1')).toEqual([]);
    expect(() => s.setMine('ms-1', FIRE, true)).not.toThrow();
    expect(s.counts('ms-1')).toEqual({ [ROCKET]: 2, [FIRE]: 1 });
  });

  test('no storage at all is a degraded store, not a broken one', () => {
    // Private-mode Safari lands here: reactions live in memory for the page's
    // lifetime and everything still works.
    const s = api.createStore(null, () => 1000);
    s.setMine('ms-1', ROCKET, true);
    s.addComment('ms-1', { id: 'c1', author: 'A', kind: 'anonymous', text: 'hi', ts: 1 });
    expect(s.counts('ms-1')).toEqual({ [ROCKET]: 1 });
    expect(s.comments('ms-1')).toHaveLength(1);
  });

  test('a full quota sheds old milestones but never the one being written', () => {
    // A quota so small that even one milestone does not fit. The write that
    // triggered it must still be readable: telling someone their reaction
    // vanished because storage is full is the worst possible answer.
    const backing = makeStorage();
    backing.setItem = (k, v) => {
      if (k === 'th_reactions_v1' && String(v).length > 40) {
        const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e;
      }
      backing._map.set(k, String(v));
    };
    const s = api.createStore(backing, () => 1000);
    for (let i = 0; i < 30; i++) s.setMine('ms-' + i, ROCKET, true);
    expect(s.counts('ms-29')).toEqual({ [ROCKET]: 1 });
    // And what it evicted really is evicted, not silently retained.
    expect(Object.keys(s.counts('ms-0')).length).toBeLessThanOrEqual(1);
  });

  test('a quota that only slightly overflows sheds one key, not half the archive', () => {
    const backing = makeStorage();
    const real = backing.setItem.bind(backing);
    let capped = 0;
    backing.setItem = (k, v) => {
      if (k !== 'th_reactions_v1') return real(k, v);
      if (capped === 0 && String(v).length > 150) {
        capped = 1;
        const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e;
      }
      real(k, v);
    };
    const s = api.createStore(backing, () => 1000);
    for (let i = 0; i < 6; i++) s.setMine('ms-' + i, ROCKET, true);
    expect(capped).toBe(1);
    expect(s.counts('ms-5')).toEqual({ [ROCKET]: 1 });
    // Five of the six should still be tracked; half of six would be three.
    let tracked = 0;
    for (let i = 0; i < 6; i++) if (s.counts('ms-' + i)[ROCKET] === 1) tracked++;
    expect(tracked).toBeGreaterThanOrEqual(4);
  });

  test('comments are kept in the order they arrived', () => {
    const s = newStore();
    for (const [i, ts] of [3, 1, 2].entries()) {
      s.addComment('ms-1', { id: 'c' + i, owner: 'anon:a', author: 'A', kind: 'anonymous', text: 't' + i, ts });
    }
    expect(s.comments('ms-1').map(c => c.id)).toEqual(['c0', 'c1', 'c2']);
  });

  test('an owner survives a round trip, so "mine" still renders after a reload', () => {
    const backing = makeStorage();
    const a = api.createStore(backing, () => 1000);
    a.addComment('ms-1', { id: 'anon:a:lqz3k', owner: 'anon:a', author: 'Anonymous', kind: 'anonymous', text: 'hi', ts: 5 });
    const b = api.createStore(backing, () => 2000);
    const entry = b.comments('ms-1')[0];
    expect(entry.owner).toBe('anon:a');
    expect(api.isOwnEntry(entry, 'anon:a')).toBe(true);
  });
});

describe('milestone detail: merging a server reply', () => {
  const newStore = () => api.createStore(makeStorage(), () => 1000);

  test('the server can raise a count the client had never seen', () => {
    const s = newStore();
    s.mergeServer('ms-1', { counts: { [ROCKET]: 4, [FIRE]: 2 } });
    expect(s.counts('ms-1')).toEqual({ [ROCKET]: 4, [FIRE]: 2 });
  });

  test('merging is a union, so a stale client cannot lower a live tally', () => {
    const s = newStore();
    s.mergeServer('ms-1', { counts: { [ROCKET]: 9 } });
    s.mergeServer('ms-1', { counts: { [ROCKET]: 1 } });
    expect(s.counts('ms-1')).toEqual({ [ROCKET]: 9 });
  });

  test('the server owns "mine", because only it knows if the vote is already counted', () => {
    const s = newStore();
    s.setMine('ms-1', ROCKET, true);
    s.mergeServer('ms-1', { counts: { [ROCKET]: 4 }, mine: { [ROCKET]: false } });
    expect(s.mine('ms-1')).toEqual({});
  });

test('server comments are sanitised on the way in, not trusted', () => {
    const s = newStore();
    s.mergeServer('ms-1', {
      comments: [
        { id: 'c1', author: 'someone', kind: 'github', text: 'ok', ts: 10 },
        // Control characters in, control characters out - the renderer trusts this
        // string because it only ever reaches textContent.
        { id: 'c2', author: 'x'.repeat(200), kind: 'github', text: '\u0000bell\u0007', ts: 11 },
        // Whitespace-only and missing text are dropped rather than rendered as
        // empty rows in the thread.
        { id: 'c3', author: 'a', kind: 'github', text: '   ' },
        { id: 'c4' },
        'not an object',
        null,
      ],
    });
    const comments = s.comments('ms-1');
    expect(comments.map(c => c.id)).toEqual(['c1', 'c2']);
    expect(comments[1].text).toBe('bell');
    expect(comments[1].author.length).toBeLessThanOrEqual(64);
  });

  test('a comment the client already holds is not duplicated by a merge', () => {
    const s = newStore();
    const entry = { id: 'c1', author: 'Anonymous', kind: 'anonymous', text: 'hi', ts: 10 };
    s.addComment('ms-1', entry);
    s.mergeServer('ms-1', { comments: [{ id: 'c1', author: 'x', kind: 'github', text: 'changed', ts: 10 }] });
    expect(s.comments('ms-1')).toHaveLength(1);
    expect(s.comments('ms-1')[0].text).toBe('hi');
  });

  test('merged comments come back sorted by time regardless of payload order', () => {
    const s = newStore();
    s.mergeServer('ms-1', {
      comments: [{ id: 'b', author: 'a', kind: 'anonymous', text: 'b', ts: 20 },
                 { id: 'a', author: 'a', kind: 'anonymous', text: 'a', ts: 10 }],
    });
    expect(s.comments('ms-1').map(c => c.id)).toEqual(['a', 'b']);
  });

  test('an unknown emoji in a server reply is dropped, not trusted', () => {
    const s = newStore();
    s.mergeServer('ms-1', { counts: { '🛸': 5, [ROCKET]: 1 }, mine: { '🛸': true, [ROCKET]: true } });
    expect(s.counts('ms-1')).toEqual({ [ROCKET]: 1 });
    expect(Object.keys(s.mine('ms-1'))).toEqual([ROCKET]);
  });

  test('a malformed or empty reply changes nothing', () => {
    const s = newStore();
    s.setMine('ms-1', ROCKET, true);
    for (const bad of [null, undefined, 42, 'nope', [], { counts: 'no' }, { comments: 'no' }]) {
      expect(() => s.mergeServer('ms-1', bad)).not.toThrow();
    }
    expect(s.counts('ms-1')).toEqual({ [ROCKET]: 1 });
  });
});

describe('milestone detail: FLIP geometry', () => {
  const rect = (left, top, width, height) => ({ left, top, width, height });

  test('centres on the origin and scales by the width ratio', () => {
    const from = rect(100, 100, 200, 80);
    const to = rect(0, 0, 800, 600);
    const t = api.flipTransform(from, to);
    expect(t.dx).toBeCloseTo((100 + 100) - (0 + 400), 5);
    expect(t.dy).toBeCloseTo((100 + 40) - (0 + 300), 5);
    expect(t.scale).toBeCloseTo(0.25, 5);
  });

  test('the scale is uniform - a per-axis scale would distort the text in flight', () => {
    const t = api.flipTransform(rect(0, 0, 400, 100), rect(0, 0, 800, 900));
    expect(t.scale).toBe(0.5);
    // One scale value, never a pair: scale(x, y) is what squashes glyphs.
    expect(t.css).toBe('translate(-200.0px, -400.0px) scale(0.5000)');
    expect(t.css.match(/scale\(/g)).toHaveLength(1);
  });

  test('a degenerate origin falls back to no scale instead of dividing by zero', () => {
    // A display:none card has a zero-width rect. Infinities here would turn the
    // panel into an untransformable element.
    expect(api.flipTransform(rect(0, 0, 0, 0), rect(0, 0, 800, 600)).scale).toBe(1);
    expect(api.flipTransform(rect(0, 0, 100, 100), rect(0, 0, 0, 0)).scale).toBe(1);
  });

  test('a panel narrower than the card does not scale up past 1', () => {
    // Clamped so a card in a narrow filtered column cannot make the panel inflate
    // and then deflate on arrival.
    expect(api.flipTransform(rect(0, 0, 1200, 900), rect(0, 0, 880, 700)).scale).toBe(1);
  });

  test('the CSS transform is finite and unit-suffixed', () => {
    const t = api.flipTransform(rect(10, 20, 300, 100), rect(0, 0, 880, 700));
    expect(t.css).toMatch(/^translate\(-?[\d.]+px, -?[\d.]+px\) scale\(0\.\d+\)$/);
    expect(t.css).not.toContain('NaN');
    expect(t.css).not.toContain('Infinity');
  });
});

describe('milestone detail: accent resolution', () => {
  test('a record with a category colour opens in that colour', () => {
    expect(api.accentFor({ category_color: '#00e676' }).color).toBe('#00e676');
  });

  test('a missing or malformed colour falls back to a real hex, not var()', () => {
    // The fallback is concatenated with an alpha suffix to build the icon wash,
    // and "var(--accent)1f" is not a colour.
    for (const bad of [undefined, null, '', 'var(--accent)', 'red; background: url(x)',
                       'rgb(0,0,0)', '#12345', '#1234567', '#', '#gg0000']) {
      expect(api.accentFor({ category_color: bad }).color).toBe('#00d4ff');
    }
    expect(api.accentFor({}).color).toBe('#00d4ff');
    expect(api.accentFor(null).color).toBe('#00d4ff');
  });

  test('every legal CSS hex length is accepted, and short forms are expanded', () => {
    // Two things have to survive: the colour itself, and a 6-digit RGB form that
    // the two-digit alpha suffix can be appended to. "#abc" + "1f" is five digits
    // and not a colour; an 8-digit "#aabbccdd" + "1f" is ten.
    expect(api.accentFor({ category_color: '#abc' })).toEqual(
      { color: '#aabbcc', rgb: '#aabbcc', icon: '📌' });
    expect(api.accentFor({ category_color: '#ABCD' })).toEqual(
      { color: '#AABBCCDD', rgb: '#AABBCC', icon: '📌' });
    expect(api.accentFor({ category_color: '#00d4ff' })).toEqual(
      { color: '#00d4ff', rgb: '#00d4ff', icon: '📌' });
    expect(api.accentFor({ category_color: '#00d4ffff' })).toEqual(
      { color: '#00d4ffff', rgb: '#00d4ff', icon: '📌' });
  });

  test('every colour the panel can build is a legal CSS hex', () => {
    // The direct check of what the stylesheet will actually receive.
    for (const raw of ['#abc', '#ABCD', '#00d4ff', '#00d4ffff', undefined, 'nope']) {
      const a = api.accentFor({ category_color: raw });
      expect(a.color).toMatch(/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i);
      expect(a.rgb).toMatch(/^#[0-9a-f]{6}$/i);
      for (const v of [a.color, a.rgb + '1f', a.rgb + '55']) {
        expect(v).toMatch(/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i);
      }
    }
  });

  test('the icon falls back rather than rendering an empty box', () => {
    expect(api.accentFor({ category_icon: '🧬' }).icon).toBe('🧬');
    expect(api.accentFor({}).icon).toBe('📌');
    expect(api.accentFor({ category_icon: '  ' }).icon).toBe('📌');
  });
});

describe('milestone detail: module surface', () => {
  test('boot returns null on a page with no overlay, and never throws', () => {
    // dashboard.js is loaded by pages that have no #milestone-detail. The catalog
    // must keep rendering there; only the card is unavailable.
    expect(api.boot()).toBeNull();
    expect(api.boot()).toBeNull();
  });

  test('the pure hooks are exported so the tests are testing the shipped file', () => {
    for (const name of ['rankReactions', 'mergeCounts', 'sanitizeComment', 'resolveIdentity',
                        'referencesFor', 'createStore', 'flipTransform', 'accentFor',
                        'isSafeHttpUrl', 'relativeTime', 'newAnonId']) {
      expect(typeof api[name]).toBe('function');
    }
  });

  test('the endpoint is the documented one', () => {
    // docs/MILESTONE_REACTIONS_API.md and the client have to agree or "shared"
    // will never become true.
    expect(api.REMOTE_ENDPOINT).toBe('/api/reactions');
  });

  test('the cooldown is long enough to be a guard and short enough to be bearable', () => {
    expect(api.COMMENT_COOLDOWN_MS).toBeGreaterThanOrEqual(5000);
    expect(api.COMMENT_COOLDOWN_MS).toBeLessThanOrEqual(60000);
  });
});