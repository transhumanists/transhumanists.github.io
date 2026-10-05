/* Milestone detail card + reactions.
 *
 * One module owns three things that have to agree with each other, which is why
 * they live together instead of being spread across the catalog renderer:
 *
 *   1. the overlay - opened from a catalog card, closed by Escape / scrim / the
 *      close button, and animated with a FLIP so the panel grows out of the card
 *      the reader actually touched rather than appearing in the middle of nowhere;
 *   2. the reaction strip rendered on every catalog card, so a reader can see
 *      whether other people cared before deciding to open it;
 *   3. the reaction + comment thread, which is reachable only with a card open.
 *
 * Identity and persistence
 * ------------------------
 * Posting is free and open to everyone. A reader signed in through the shared
 * GitHub OAuth dock (auth-bar.js) is attributed to their login; everyone else
 * posts anonymously under a random id kept in localStorage. No email, no
 * fingerprint, no tracking - an anonymous id that cannot be resolved back to a
 * person is the whole point of offering anonymous posting.
 *
 * Reads and writes go to localStorage FIRST, and to `/api/reactions` when that
 * endpoint exists. This site is static GitHub Pages, so on the deployed host the
 * endpoint does not exist yet; rather than pretending otherwise, the composer
 * says reactions are kept in this browser until a write actually succeeds against
 * a real endpoint. docs/MILESTONE_REACTIONS_API.md is the contract a backend has
 * to satisfy to change that line.
 *
 * Everything user-supplied reaches the DOM through textContent or a URL that has
 * been parsed and scheme-checked. There is no innerHTML in this file and there
 * must not be one added.
 */
(function () {
  'use strict';

  // ----------------------------------------------------------------- config --

  // A fixed allow-list, not free text. Two reasons: a payload cannot grow an
  // unbounded key space, and the ranking is stable - an unknown emoji can never
  // displace a known one, so the top three on a card mean the same thing on every
  // device that renders it.
  const REACTION_EMOJI = [
    { emoji: '\u{1F680}', label: 'Breakthrough' },
    { emoji: '\u{1F525}', label: 'Historic' },
    { emoji: '\u{1F92F}', label: 'Mind-blowing' },
    { emoji: '\u{1F44F}', label: 'Impressive' },
    { emoji: '\u{1F4A1}', label: 'Insightful' },
    { emoji: '\u{1F9E0}', label: 'Deep / technical' },
    { emoji: '\u{1F9EC}', label: 'Bio' },
    { emoji: '\u{26A1}', label: 'Energy' },
    { emoji: '\u{1F510}', label: 'Security' },
    { emoji: '\u{1F6F0}\u{FE0F}', label: 'Space' },
    { emoji: '\u{2764}\u{FE0F}', label: 'Love this' },
    { emoji: '\u{2753}', label: 'Needs a better source' }
  ];

  const EMOJI_BY_CHAR = new Map(REACTION_EMOJI.map(e => [e.emoji, e.label]));
  const EMOJI_ORDER = new Map(REACTION_EMOJI.map((e, i) => [e.emoji, i]));

  // How many reactions the catalog grid shows. Three fits a 360px card without
  // wrapping and reads as "what people felt" rather than as a full picker.
  const TOP_ON_CARD = 3;

  const STORAGE_KEY = 'th_reactions_v1';
  const ANON_KEY = 'th_anon_id_v1';
  // Written by assets/js/auth-bar.js. Read defensively: that script owns the
  // format, this one only borrows an identity out of it.
  const SESSION_KEY = 'neohiro_session_v1';

  const REMOTE_ENDPOINT = '/api/reactions';
  const REMOTE_TIMEOUT_MS = 6000;
  // Comment spam guard. Local and per-identity, so it is an honesty measure
  // rather than a security control - a determined poster clears it by waiting.
  const COMMENT_COOLDOWN_MS = 15000;
  const COMMENT_MAX = 280;
  const THREAD_RENDER_LIMIT = 60;
  const MAX_TRACKED_MILESTONES = 400;

  // Resolved rather than var(--accent): this value is concatenated with an alpha
  // suffix to build the icon wash, and "var(--accent)1f" is not a colour.
  const FALLBACK_ACCENT = '#00d4ff';
  const FALLBACK_ICON = '\u{1F4CC}';

  // Upstream archive the catalog is generated from. A real URL: the same
  // repository the "Open Repositories" section of the page already links to, and
  // the one scripts/sync_milestones.py mirrors (MILESTONES_REPO).
  const ARCHIVE_URL = 'https://github.com/transhumanists/milestones';

  // --------------------------------------------------------------- helpers --

  // Parsed, not regex-matched alone: `javascript:` with an embedded newline gets
  // past /^\s*https?:/ after \s*, and only the parser is sure what the scheme is.
  function isSafeHttpUrl(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    let url;
    try {
      url = new URL(trimmed);
    } catch (_) {
      return false;
    }
    return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname;
  }

  function hostOf(value) {
    try {
      return new URL(String(value)).hostname.replace(/^www\./, '');
    } catch (_) {
      return '';
    }
  }

  function makeEl(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setHidden(node, hidden) {
    if (!node) return;
    if (hidden) node.setAttribute('hidden', '');
    else node.removeAttribute('hidden');
  }

  // Ties break on the allow-list order, never on object key order, so two devices
  // holding identical counts show an identical top three.
  function rankReactions(counts, limit) {
    const entries = [];
    if (counts && typeof counts === 'object') {
      for (const key of Object.keys(counts)) {
        if (!EMOJI_ORDER.has(key)) continue;
        const n = Number(counts[key]);
        if (!Number.isFinite(n) || n <= 0) continue;
        entries.push({ emoji: key, count: Math.floor(n), label: EMOJI_BY_CHAR.get(key) });
      }
    }
    entries.sort((a, b) => (b.count - a.count) || (EMOJI_ORDER.get(a.emoji) - EMOJI_ORDER.get(b.emoji)));
    return limit === undefined ? entries : entries.slice(0, Math.max(0, limit));
  }

  // Union, never sum. Two devices that each know about 3 of the same emoji still
  // mean 3, and summing would let a reader inflate a milestone by posting from a
  // second browser - which is precisely what a tally exists to prevent.
  function mergeCounts(a, b) {
    const out = {};
    for (const source of [a, b]) {
      if (!source || typeof source !== 'object') continue;
      for (const key of Object.keys(source)) {
        if (!EMOJI_ORDER.has(key)) continue;
        const n = Math.floor(Number(source[key]));
        if (!Number.isFinite(n) || n < 0) continue;
        out[key] = Math.max(out[key] || 0, n);
      }
    }
    return out;
  }

  function sanitizeComment(raw) {
    if (typeof raw !== 'string') return '';
    // Strip C0/C1 controls except newline and tab: a comment is prose, and control
    // characters in one are always a copy-paste artefact or an attempt at layout
    // games. Also strip Unicode line separators (U+2028, U+2029) which are valid
    // in JavaScript strings but render inconsistently in HTML. Runs of blank
    // lines collapse to a single break.
    return raw
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, COMMENT_MAX);
  }

  function newAnonId(crypto) {
    const c = crypto || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    if (c && typeof c.randomUUID === 'function') return 'anon-' + c.randomUUID();
    if (c && typeof c.getRandomValues === 'function') {
      const bytes = c.getRandomValues(new Uint8Array(16));
      let hex = '';
      for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
      return 'anon-' + hex;
    }
    // Last resort, reached only in a context with no Web Crypto at all, where a
    // predictable id costs nothing: it identifies a browser, not a person.
    return 'anon-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  }

  // Who a post is attributed to, without touching storage. Split out from the
  // storage read so the precedence rule - a live GitHub session beats anonymous -
  // is testable on its own.
  function resolveIdentity(session, anonId) {
    if (session && typeof session.login === 'string' && session.login.trim()) {
      const login = session.login.trim();
      const id = typeof session.session_id === 'string' && session.session_id.trim()
        ? session.session_id.trim()
        : login;
      return { id: 'gh:' + id, kind: 'github', label: '@' + login };
    }
    if (anonId && String(anonId).trim()) {
      return { id: 'anon:' + String(anonId).trim(), kind: 'anonymous', label: 'Anonymous' };
    }
    return { id: 'anon:unset', kind: 'anonymous', label: 'Anonymous' };
  }

  function isSessionLive(session, nowMs) {
    if (!session || !session.session_id) return false;
    return !Number.isFinite(session.expiresAt) || session.expiresAt > nowMs;
  }

function relativeTime(ts, nowMs) {
    const then = Number(ts);
    if (!Number.isFinite(then)) return '—';
    const delta = Math.round((nowMs - then) / 1000);
    if (delta < 45) return 'just now';
    const mins = Math.round(delta / 60);
    if (mins < 60) return mins + 'm ago';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.round(hours / 24);
    if (days < 7) return days + 'd ago';
    return new Date(then).toISOString().slice(0, 10);
  }

  // Whether a thread entry was written by the reader looking at it.
  //
  // This is its own function because the obvious version is wrong and fails
  // silently: an entry's `id` is `owner + ':' + timestamp` so that two posts from
  // the same person are distinct, which means comparing `entry.id` to the identity
  // id is never true and nobody's own comment is ever marked as theirs. `owner` is
  // carried separately for exactly this comparison.
  function isOwnEntry(entry, identityId) {
    return !!entry && !!entry.owner && !!identityId && entry.owner === identityId;
  }

  // The reference list for the card, in citation order: the record's own source
  // first, then anything else the record names, then the archive the catalog is
  // generated from. A name that carries its own URL becomes a link; a bare name
  // is listed plainly rather than being guessed at.
  function referencesFor(milestone) {
    const refs = [];
    const seenNames = new Set();
    const seenUrls = new Set();

    const push = (rawName, rawUrl) => {
      const name = typeof rawName === 'string' ? rawName.trim() : '';
      const url = isSafeHttpUrl(rawUrl) ? rawUrl.trim() : '';
      if (!name && !url) return;
      const nameKey = name.toLowerCase();
      const urlKey = url.toLowerCase();
      if ((nameKey && seenNames.has(nameKey)) || (urlKey && seenUrls.has(urlKey))) return;
      if (nameKey) seenNames.add(nameKey);
      if (urlKey) seenUrls.add(urlKey);
      refs.push({ name: name || hostOf(url) || 'Source', url, host: url ? hostOf(url) : '' });
    };

    if (milestone && typeof milestone === 'object') {
      push(milestone.source, milestone.url);
      const extra = Array.isArray(milestone.sources) ? milestone.sources : [];
      for (const entry of extra) {
        if (typeof entry === 'string') {
          // Some records name the source as a bare URL.
          if (isSafeHttpUrl(entry)) push(hostOf(entry), entry);
          else push(entry, '');
        } else if (entry && typeof entry === 'object') {
          push(entry.name || entry.source, entry.url);
        }
      }
    }

    push('Milestone archive (transhumanists/milestones)', ARCHIVE_URL);
    return refs;
  }

  // --------------------------------------------------------------- storage --

  // Returns a usable Web Storage, or null. Private-mode Safari and an exhausted
  // quota both land in the catch; reactions then live in memory for the lifetime
  // of the page, which is a degraded experience rather than a broken one.
  function safeStorage() {
    try {
      const store = globalThis.localStorage;
      const probe = '__th_probe__';
      store.setItem(probe, '1');
      store.removeItem(probe);
      return store;
    } catch (_) {
      return null;
    }
  }

  function createStore(storage, now) {
    const clock = typeof now === 'function' ? now : () => Date.now();
    let state = { v: 1, milestones: {} };

    function load() {
      if (!storage) return;
      try {
        const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
        if (parsed && parsed.v === 1 && parsed.milestones && typeof parsed.milestones === 'object') {
          state = parsed;
        }
      } catch (_) {
        state = { v: 1, milestones: {} };
      }
    }

    // On a quota error the oldest milestones are shed, oldest-first, until the
    // payload fits. `protectId` is the milestone currently being written: it must
    // never be the thing that gets evicted, because the reader just reacted and
    // being told their reaction vanished is worse than losing a tally they
    // scrolled past weeks ago.
    function save(protectId) {
      if (!storage) return;
      const payload = () => JSON.stringify(state);
      try {
        storage.setItem(STORAGE_KEY, payload());
        return;
      } catch (_) {
        // Evict in halves, retrying after each, so a payload that is only slightly
        // over the quota sheds one key rather than half the archive. The batch
        // size is subtracted from what is left rather than recomputed from a
        // floor of 1, which is what would make this loop never end.
        const keys = Object.keys(state.milestones).filter(k => k !== String(protectId || ''));
        let remaining = keys.length;
        while (remaining > 0) {
          const batch = Math.max(1, Math.floor(remaining / 2));
          keys.slice(0, batch).forEach(k => delete state.milestones[k]);
          remaining -= batch;
          try {
            storage.setItem(STORAGE_KEY, payload());
            return;
          } catch (_) { /* shed some more */ }
        }
        // Nothing left to shed and it still does not fit. The reader keeps the
        // in-memory state for this page load; the next one starts clean.
      }
    }

    function bucket(milestoneId) {
      const id = String(milestoneId || '');
      if (!id) return null;
      if (!state.milestones[id]) {
        state.milestones[id] = { counts: {}, mine: {}, comments: [] };
        const keys = Object.keys(state.milestones);
        if (keys.length > MAX_TRACKED_MILESTONES) {
          // Insertion order is oldest-first, so this evicts the milestones that
          // have sat untouched longest rather than an arbitrary half.
          keys.slice(0, keys.length - MAX_TRACKED_MILESTONES).forEach(k => delete state.milestones[k]);
        }
      }
      const b = state.milestones[id];
      if (!b.counts || typeof b.counts !== 'object') b.counts = {};
      if (!b.mine || typeof b.mine !== 'object') b.mine = {};
      if (!Array.isArray(b.comments)) b.comments = [];
      return b;
    }

    function counts(milestoneId) {
      const b = bucket(milestoneId);
      return b ? Object.assign({}, b.counts) : {};
    }

    function mine(milestoneId) {
      const b = bucket(milestoneId);
      return b ? Object.assign({}, b.mine) : {};
    }

    function comments(milestoneId) {
      const b = bucket(milestoneId);
      return b ? b.comments.slice() : [];
    }

    // A reaction is stored as "I reacted", and the count is derived from that, so
    // one person double-tapping cannot produce a tally of 2.
    function setMine(milestoneId, emoji, hasReacted) {
      const b = bucket(milestoneId);
      if (!b || !EMOJI_ORDER.has(emoji)) return counts(milestoneId);
      const already = Boolean(b.mine[emoji]);
      if (hasReacted === already) return Object.assign({}, b.counts);
      const current = Math.floor(Number(b.counts[emoji])) || 0;
      const next = current + (hasReacted ? 1 : -1);
      if (next > 0) b.counts[emoji] = next;
      else delete b.counts[emoji];
      if (hasReacted) b.mine[emoji] = true;
      else delete b.mine[emoji];
      save(milestoneId);
      return Object.assign({}, b.counts);
    }

    function addComment(milestoneId, entry) {
      const b = bucket(milestoneId);
      if (!b) return [];
      b.comments.push(entry);
      if (b.comments.length > THREAD_RENDER_LIMIT * 2) {
        b.comments = b.comments.slice(-THREAD_RENDER_LIMIT * 2);
      }
      save(milestoneId);
      return b.comments.slice();
    }

    // Server-authoritative merge. `mine` is taken from the server when it reports
    // one, because only the server knows whether this identity's vote is already
    // counted there; locally it is whatever this device last toggled.
    function mergeServer(milestoneId, payload) {
      const b = bucket(milestoneId);
      if (!b || !payload || typeof payload !== 'object') return counts(milestoneId);

      if (payload.counts && typeof payload.counts === 'object') {
        b.counts = mergeCounts(b.counts, payload.counts);
      }
      if (payload.mine && typeof payload.mine === 'object') {
        for (const key of Object.keys(payload.mine)) {
          if (!EMOJI_ORDER.has(key)) continue;
          if (payload.mine[key]) b.mine[key] = true;
          else delete b.mine[key];
        }
      }
      if (Array.isArray(payload.comments)) {
        const byId = new Map(b.comments.map(c => [c.id, c]));
        for (const c of payload.comments) {
          if (!c || typeof c !== 'object' || typeof c.id !== 'string') continue;
          const text = sanitizeComment(c.text);
          if (!text || byId.has(c.id)) continue;
          byId.set(c.id, {
            id: c.id,
            // Absent in older or foreign records, which leaves the entry unmarked
            // rather than mislabelled as somebody's own.
            owner: typeof c.owner === 'string' && c.owner ? c.owner : '',
            author: typeof c.author === 'string' && c.author.trim()
              ? c.author.trim().slice(0, 64)
              : 'Anonymous',
            kind: c.kind === 'github' ? 'github' : 'anonymous',
            text,
            ts: Number.isFinite(Number(c.ts)) ? Number(c.ts) : clock()
          });
        }
        b.comments = Array.from(byId.values()).sort((x, y) => x.ts - y.ts);
      }
      save(milestoneId);
      return Object.assign({}, b.counts);
    }

    load();
    return { counts, mine, comments, setMine, addComment, mergeServer };
  }

  // -------------------------------------------------------------- identity --

  function currentIdentity(storage, nowMs) {
    let session = null;
    try {
      const raw = storage && storage.getItem(SESSION_KEY);
      if (raw) session = JSON.parse(raw);
    } catch (_) {
      session = null;
    }
    if (!isSessionLive(session, nowMs)) session = null;

    let anonId = null;
    if (!session && storage) {
      try {
        anonId = storage.getItem(ANON_KEY);
        if (!anonId) {
          anonId = newAnonId();
          storage.setItem(ANON_KEY, anonId);
        }
      } catch (_) {
        anonId = null;
      }
    }
    return resolveIdentity(session, anonId);
  }

  // ------------------------------------------------------------------- view --

  function createView(doc) {
    const root = doc.getElementById('milestone-detail');
    if (!root) return null;
    const el = id => doc.getElementById(id);

    const view = {
      root,
      panel: el('ms-detail-panel'),
      scrim: el('ms-detail-scrim'),
      close: el('ms-detail-close'),
      icon: el('ms-detail-icon'),
      category: el('ms-detail-category'),
      title: el('ms-detail-title'),
      metric: el('ms-detail-metric'),
      value: el('ms-detail-value'),
      unit: el('ms-detail-unit'),
      date: el('ms-detail-date'),
      record: el('ms-detail-record'),
      badges: el('ms-detail-badges'),
      summarySection: el('ms-detail-summary-section'),
      summary: el('ms-detail-summary'),
      locationSection: el('ms-detail-location-section'),
      location: el('ms-detail-location'),
      locationNote: el('ms-detail-location-note'),
      supersededSection: el('ms-detail-superseded-section'),
      superseded: el('ms-detail-superseded'),
      refsSection: el('ms-detail-refs') ? el('ms-detail-refs').closest('section') : null,
      refs: el('ms-detail-refs'),
      identity: el('ms-detail-identity'),
      reactionBar: el('ms-detail-reaction-bar'),
      composer: el('ms-detail-composer'),
      comment: el('ms-detail-comment'),
      commentCount: el('ms-detail-comment-count'),
      commentSubmit: el('ms-detail-comment-submit'),
      commentNote: el('ms-detail-composer-note'),
      thread: el('ms-detail-thread')
    };

    if (!view.panel || !view.reactionBar) return null;

    // The one node this module creates rather than ships: the "N reactions from
    // readers" line only has something to say once a card is open.
    view.reactionSummary = makeEl(doc, 'p', 'ms-detail__reaction-summary');
    if (view.reactionBar.parentNode) {
      view.reactionBar.parentNode.insertBefore(view.reactionSummary, view.reactionBar.nextSibling);
    }

    return view;
  }

  // ----------------------------------------------------------------- render --

  // The read-out on every catalog card: the top three reactions. Tapping one is a
  // deliberate act with a visible count, so it posts - which is why the handler
  // stops the click from reaching the card's own open handler.
  function paintCardStrip(doc, card, milestone, store) {
    let strip = card.querySelector('.catalog-card__reactions');
    if (!strip) {
      strip = makeEl(doc, 'div', 'catalog-card__reactions');
      card.appendChild(strip);
    }
    strip.replaceChildren();

    const counts = store.counts(milestone.id);
    const mine = store.mine(milestone.id);
    const all = rankReactions(counts);
    const top = all.slice(0, TOP_ON_CARD);

    if (!top.length) {
      // Nothing to report yet. The hint is what makes the feature discoverable: a
      // reader cannot react to a strip that has never been drawn.
      strip.appendChild(makeEl(doc, 'span', 'catalog-card__reactions-empty',
        'No reactions yet \u2014 open to add one'));
      return;
    }

    for (const entry of top) {
      const chip = makeEl(doc, 'button', 'catalog-card__reaction');
      chip.type = 'button';
      chip.dataset.emoji = entry.emoji;
      chip.title = entry.label;
      chip.setAttribute('aria-pressed', mine[entry.emoji] ? 'true' : 'false');
      chip.setAttribute('aria-label',
        entry.label + ' reaction, ' + entry.count + (entry.count === 1 ? ' reaction' : ' reactions'));
      chip.appendChild(makeEl(doc, 'span', 'catalog-card__reaction-emoji', entry.emoji));
      chip.appendChild(makeEl(doc, 'span', 'catalog-card__reaction-count', String(entry.count)));
      strip.appendChild(chip);
    }

    if (all.length > top.length) {
      strip.appendChild(makeEl(doc, 'span', 'catalog-card__reactions-empty',
        '+' + (all.length - top.length) + ' more inside'));
    }
  }

  function paintIdentity(view, identity, shared) {
    if (!view.identity) return;
    view.identity.dataset.kind = identity.kind;
    view.identity.textContent = identity.kind === 'github'
      ? identity.label + ' \u00B7 signed in'
      : identity.label + ' \u00B7 this device';
    view.identity.title = shared
      ? 'Posts are shared with everyone who opens this milestone.'
      : 'Posts are stored in this browser only \u2014 no shared backend is configured yet.';
  }

  function paintReactionBar(doc, view, milestone, store) {
    const bar = view.reactionBar;
    bar.replaceChildren();
    const counts = store.counts(milestone.id);
    const mine = store.mine(milestone.id);

    for (const spec of REACTION_EMOJI) {
      const count = Math.floor(Number(counts[spec.emoji])) || 0;
      const btn = makeEl(doc, 'button', 'ms-detail__react');
      btn.type = 'button';
      btn.dataset.emoji = spec.emoji;
      btn.setAttribute('aria-pressed', mine[spec.emoji] ? 'true' : 'false');
      btn.setAttribute('aria-label', spec.label + (count
        ? ', ' + count + (count === 1 ? ' reaction' : ' reactions')
        : ', no reactions yet'));
      btn.appendChild(makeEl(doc, 'span', 'ms-detail__react-emoji', spec.emoji));
      btn.appendChild(makeEl(doc, 'span', 'ms-detail__react-count', String(count)));
      btn.appendChild(makeEl(doc, 'span', 'ms-detail__react-label', spec.label));
      bar.appendChild(btn);
    }

    if (view.reactionSummary) {
      const total = rankReactions(counts).reduce((sum, e) => sum + e.count, 0);
      view.reactionSummary.textContent = total
        ? total + (total === 1 ? ' reaction' : ' reactions') + ' from readers'
        : 'No reactions yet. Be the first.';
    }
  }

  function paintThread(doc, view, milestone, store, identity, nowMs) {
    const list = view.thread;
    if (!list) return;
    list.replaceChildren();

    const comments = store.comments(milestone.id).slice(-THREAD_RENDER_LIMIT);
    if (!comments.length) {
      list.appendChild(makeEl(doc, 'li', 'ms-detail__entry-empty',
        'No comments on this milestone yet.'));
      return;
    }

    for (const entry of comments) {
      const li = makeEl(doc, 'li', 'ms-detail__entry');
      if (isOwnEntry(entry, identity.id)) li.dataset.mine = 'true';
      const body = makeEl(doc, 'div', 'ms-detail__entry-body');
      const head = makeEl(doc, 'div', 'ms-detail__entry-head');
      head.appendChild(makeEl(doc, 'span', 'ms-detail__entry-author', entry.author));
      head.appendChild(makeEl(doc, 'span', 'ms-detail__entry-time', relativeTime(entry.ts, nowMs)));
      body.appendChild(head);
      body.appendChild(makeEl(doc, 'p', 'ms-detail__entry-text', entry.text));
      li.appendChild(makeEl(doc, 'span', 'ms-detail__entry-avatar',
        entry.kind === 'github' ? '@' : '\u00B7'));
      li.appendChild(body);
      list.appendChild(li);
    }
  }

  function paintReferences(doc, view, milestone) {
    const list = view.refs;
    if (!list) return;
    list.replaceChildren();

    const refs = referencesFor(milestone);
    refs.forEach((ref, i) => {
      const li = makeEl(doc, 'li',
        'ms-detail__ref' + (ref.url ? '' : ' ms-detail__ref--plain'));
      li.appendChild(makeEl(doc, 'span', 'ms-detail__ref-index', '[' + (i + 1) + ']'));

      const body = makeEl(doc, 'div', 'ms-detail__ref-body');
      const name = makeEl(doc, 'span', 'ms-detail__ref-name');
      if (ref.url) {
        const a = makeEl(doc, 'a', '', ref.name);
        a.href = ref.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.referrerPolicy = 'no-referrer';
        name.appendChild(a);
      } else {
        name.textContent = ref.name;
      }
      body.appendChild(name);
      if (ref.url) body.appendChild(makeEl(doc, 'span', 'ms-detail__ref-url', ref.url));
      li.appendChild(body);
      if (ref.host) li.appendChild(makeEl(doc, 'span', 'ms-detail__ref-host', ref.host));
      list.appendChild(li);
    });
  }

  // CSS hex, and only the four legal lengths. "red; background: url(x)" is a
  // custom-property injection waiting to happen.
  const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

  // Two things have to come out of a category colour: the colour itself, and a
  // 6-digit RGB form that a two-digit alpha suffix can be appended to. Both
  // matter - "#abc" + "1f" is "#abc1f", five digits and not a colour, and an
  // 8-digit "#aabbccdd" + "1f" is ten. So short forms are expanded (#abc ->
  // #aabbcc, #abcd -> #aabbccdd) and any alpha the source carried is dropped from
  // the RGB form: the panel decides its own opacity.
  function accentFor(milestone) {
    const raw = milestone && typeof milestone.category_color === 'string'
      ? milestone.category_color.trim()
      : '';
    const icon = milestone && typeof milestone.category_icon === 'string' && milestone.category_icon.trim()
      ? milestone.category_icon.trim()
      : FALLBACK_ICON;

    let color = FALLBACK_ACCENT;
    let rgb = FALLBACK_ACCENT;
    if (HEX_COLOR.test(raw)) {
      const digits = raw.slice(1);
      const expanded = (digits.length === 3 || digits.length === 4)
        ? Array.from(digits).map(c => c + c).join('')
        : digits;
      color = '#' + expanded;
      rgb = '#' + expanded.slice(0, 6);
    }
    return { color, rgb, icon };
  }

  function paintDetails(doc, view, milestone, accent) {
    view.title.textContent = milestone.title || 'Untitled milestone';
    view.icon.textContent = accent.icon;
    view.category.textContent = [milestone.category, milestone.subcategory]
      .filter(Boolean)
      .join(' \u00B7 ')
      .replace(/_/g, ' ');

    // The accent is carried through from the card that was clicked, so the panel
    // opens in exactly the colour the reader chose.
    view.root.style.setProperty('--ms-detail-accent', accent.color);
    view.root.style.setProperty('--ms-detail-accent-soft', accent.rgb + '1f');
    view.root.style.setProperty('--ms-detail-accent-line', accent.rgb + '55');

    const value = (milestone.value === null || milestone.value === undefined) ? '' : String(milestone.value);
    const unit = milestone.unit ? String(milestone.unit) : '';
    setHidden(view.metric, !value && !unit && !milestone.date);
    view.value.textContent = value;
    view.unit.textContent = unit;
    view.date.textContent = milestone.date || '\u2014';
    setHidden(view.record, !milestone.id);
    view.record.textContent = milestone.id ? 'record ' + milestone.id : '';

    view.badges.replaceChildren();
    if (milestone.is_new) {
      view.badges.appendChild(makeEl(doc, 'span', 'ms-detail__badge ms-detail__badge--new', 'New this week'));
    }
    if (milestone.is_record) {
      view.badges.appendChild(makeEl(doc, 'span', 'ms-detail__badge ms-detail__badge--record', 'Record'));
    }
    if (milestone.is_breakthrough) {
      view.badges.appendChild(makeEl(doc, 'span', 'ms-detail__badge ms-detail__badge--breakthrough', 'Breakthrough'));
    }

    const summary = typeof milestone.summary === 'string' ? milestone.summary.trim() : '';
    setHidden(view.summarySection, !summary);
    view.summary.textContent = summary;

    const geo = milestone.geolocation;
    const hasGeo = !!geo && typeof geo === 'object'
      && Number.isFinite(geo.lat) && Number.isFinite(geo.lon);
    setHidden(view.locationSection, !hasGeo);
    if (hasGeo) {
      view.location.textContent = '\u{1F4CD} ' + geo.lat.toFixed(4) + ', ' + geo.lon.toFixed(4);
      view.locationNote.textContent = milestone.location_confidence
        ? 'Confidence: ' + String(milestone.location_confidence).replace(/_/g, ' ')
        : '';
    }

    // The catalog carries the id of a superseded record, not the record itself,
    // so this stays hidden unless a caller filled in what beat it.
    setHidden(view.supersededSection, !view.superseded.hasChildNodes());

    // Stagger, written as a custom property so that hiding a section cannot leave
    // a nth-child ladder counting a node that is not on screen.
    let i = 0;
    for (const node of [view.summarySection, view.locationSection, view.supersededSection, view.refsSection]) {
      if (!node || node.hasAttribute('hidden')) continue;
      node.style.setProperty('--ms-detail-delay', (70 + i * 55) + 'ms');
      i++;
    }
  }

  // --------------------------------------------------------------- motion --

  // Uniform scale, never per-axis: a non-axis-aligned scale distorts the text
  // while it travels, and the text is the entire reason the reader is looking at
  // it. The width ratio reads as "this card grew into this panel"; the height is
  // left to the layout so the body does not squash on the way in.
  function flipTransform(from, to) {
    const scale = from.width > 0 && to.width > 0
      ? Math.min(from.width / to.width, 1)
      : 1;
    const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
    const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
    return {
      dx,
      dy,
      scale,
      css: 'translate(' + dx.toFixed(1) + 'px, ' + dy.toFixed(1) + 'px) scale(' + scale.toFixed(4) + ')'
    };
  }

  // Padding for the scrollbar that overflow:hidden removes. Without it the whole
  // page jumps sideways by its width on the opening frame, which is the single
  // most noticeable way an overlay can fail to feel fluent.
  function lockScroll(doc) {
    const root = doc.documentElement;
    if (root.__msDetailLocked) return;
    root.__msDetailLocked = true;
    root.__msDetailPrevOverflow = root.style.overflow;
    root.__msDetailPrevPadding = root.style.paddingRight;
    const gutter = (globalThis.innerWidth || 0) - root.clientWidth;
    root.style.overflow = 'hidden';
    if (gutter > 0) root.style.paddingRight = gutter + 'px';
  }

  function unlockScroll(doc) {
    const root = doc.documentElement;
    if (!root.__msDetailLocked) return;
    root.__msDetailLocked = false;
    root.style.overflow = root.__msDetailPrevOverflow || '';
    root.style.paddingRight = root.__msDetailPrevPadding || '';
  }

  // ------------------------------------------------------------ controller --

  function createController(win) {
    const doc = win.document;
    const view = createView(doc);
    if (!view) return null;

    const storage = safeStorage();
    const now = () => Date.now();
    const store = createStore(storage, now);

    let current = null;          // the milestone on screen
    let origin = null;           // the element that opened it, for the return trip
    let identity = currentIdentity(storage, now());
    let remoteState = 'unknown'; // 'unknown' | 'live' | 'offline'
    let lastPostAt = 0;
    let closeTimer = null;
    let closeGeneration = 0;
    // Whether the composer is currently showing a "Posted." confirmation. Tracked
    // separately from the text so a late write can tell a confirmation apart from
    // the resting policy line without string-matching either of them.
    let postedState = false;
    // Which milestone the in-flight post belongs to, captured at submit time.
    // Reading current.id in the .then() would attribute a late response to
    // whichever milestone happens to be open by then.
    let lastPostId = null;

    // ---- card registry ---------------------------------------------------
    // dashboard.js hands each rendered card to register() so this module knows
    // which record a given element is showing. Keyed by id as well as stored on
    // the element, because the observer can be handed a card that was re-created
    // by a filter change after the render call.
    const byId = new Map();

    function register(card, milestone) {
      if (!card || !milestone || !milestone.id) return;
      card.__milestone = milestone;
      card.dataset.milestoneId = milestone.id;
      byId.set(milestone.id, milestone);
      if (card.isConnected) paintCardStrip(doc, card, milestone, store);
    }

    function repaintStripFor(milestoneId) {
      if (!view.root || !milestoneId) return;
      if (origin && origin.__milestone && origin.__milestone.id === milestoneId) {
        paintCardStrip(doc, origin, origin.__milestone, store);
      }
      // Cards outside the current filter are gone from the DOM, so a selector
      // sweep is the only way to keep a strip honest if the grid ever holds more
      // than one view of the same milestone. Cheap: the grid is one screen.
      const grid = doc.getElementById('catalog-grid');
      if (!grid) return;
      for (const card of grid.querySelectorAll('.catalog-card[data-milestone-id]')) {
        if (card.dataset.milestoneId !== milestoneId) continue;
        if (origin && card === origin) continue;
        const milestone = byId.get(card.dataset.milestoneId) || card.__milestone;
        if (milestone) paintCardStrip(doc, card, milestone, store);
      }
    }

    function clearRegistry() {
      byId.clear();
    }

    // ---- remote ----------------------------------------------------------

    function note(message, tone) {
      if (!view.commentNote) return;
      view.commentNote.textContent = message || '';
      if (tone) view.commentNote.dataset.tone = tone;
      else view.commentNote.removeAttribute('data-tone');
    }

    // Where a post actually ends up. Split out of the note text because it is two
    // sentences, not one: what the reader is told when the card opens, and what
    // they are told when a write comes back. Conflating the two is what made
    // "Posted." appear for a few milliseconds and then get replaced by the policy
    // line before it could be read - so the confirmation and the policy are
    // composed together instead.
    function storagePolicy() {
      return remoteState === 'live'
        ? 'Shared with everyone who opens this milestone.'
        : 'Kept in this browser only \u2014 no shared backend yet.';
    }

    function storageNote() {
      postedState = false;
      note('Free to post, signed in or not. ' + storagePolicy());
    }

    function postedNote() {
      postedState = true;
      note('Posted. ' + storagePolicy(), 'ok');
    }

    // After a write resolves the confirmation is refreshed, not replaced: a
    // backend that turns out to be live upgrades what the reader was told without
    // ever yanking the "Posted." away mid-read.
    function refreshPostedNote() {
      if (postedState) postedNote();
    }

    async function remoteWrite(payload) {
      if (remoteState === 'offline') return null;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => controller && controller.abort(), REMOTE_TIMEOUT_MS);
      try {
        const res = await win.fetch(REMOTE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(Object.assign({
            identity: { id: identity.id, kind: identity.kind, label: identity.label }
          }, payload)),
          signal: controller ? controller.signal : undefined
        });
        if (!res.ok) {
          remoteState = 'offline';
          return null;
        }
        remoteState = 'live';
        const result = await res.json().catch(() => null);
        clearTimeout(timer);
        return result;
      } catch (_) {
        remoteState = 'offline';
        return null;
      } finally {
        clearTimeout(timer);
      }
    }

    // Best-effort hydration. Only attempted once a write has proved the endpoint
    // exists, so the deployed static host never pays for a request it cannot
    // answer.
    async function remoteRead(milestoneId) {
      if (remoteState !== 'live') return;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => controller && controller.abort(), REMOTE_TIMEOUT_MS);
      try {
        const res = await win.fetch(
          REMOTE_ENDPOINT + '?milestone_id=' + encodeURIComponent(milestoneId),
          { headers: { Accept: 'application/json' }, credentials: 'same-origin',
            signal: controller ? controller.signal : undefined }
        );
        if (!res.ok) {
          remoteState = 'offline';
          return;
        }
        const data = await res.json().catch(() => null);
        if (data && typeof data === 'object') store.mergeServer(milestoneId, data);
      } catch (_) {
        remoteState = 'offline';
      } finally {
        clearTimeout(timer);
      }
    }

    // ---- paint -----------------------------------------------------------

    function paintCurrent() {
      if (!current) return;
      paintReactionBar(doc, view, current, store);
      paintThread(doc, view, current, store, identity, now());
      paintIdentity(view, identity, remoteState === 'live');
    }

    // ---- open / close ----------------------------------------------------

    function focusables() {
      return Array.from(view.panel.querySelectorAll(
        'a[href], button:not([disabled]), textarea:not([disabled]), input, select, [tabindex]:not([tabindex="-1"])'
      )).filter(node => node.getClientRects().length > 0);
    }

    function onKeydown(e) {
      if (!view.root.classList.contains('is-open')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;

      const list = focusables();
      if (!list.length) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];

      // The panel itself is focusable (tabindex="-1") so it can take focus on
      // open; Shift+Tab from there must wrap to the end, not escape the dialog.
      if (!view.panel.contains(doc.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && (doc.activeElement === first || doc.activeElement === view.panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && doc.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    function open(milestone, sourceEl) {
      if (!milestone || typeof milestone !== 'object' || !milestone.id) return;

      current = milestone;
      origin = (sourceEl && sourceEl.isConnected) ? sourceEl : null;
      identity = currentIdentity(storage, now());
      if (origin) register(origin, milestone);

      // The composer is reset every time. A draft carried over from the last
      // milestone would otherwise be posted against the wrong record.
      if (view.comment) view.comment.value = '';
      if (view.commentCount) view.commentCount.textContent = '0 / ' + COMMENT_MAX;
      if (view.commentSubmit) view.commentSubmit.disabled = true;
      storageNote();

      paintDetails(doc, view, milestone, accentFor(milestone));
      paintReferences(doc, view, milestone);
      paintReactionBar(doc, view, milestone, store);
      paintThread(doc, view, milestone, store, identity, now());
      paintIdentity(view, identity, remoteState === 'live');

      // FLIP. The origin rect is taken while the dialog is still hidden, so the
      // panel never paints centred before it starts travelling.
      const from = origin ? origin.getBoundingClientRect() : null;
      view.root.hidden = false;
      // The panel transitions `transform` unconditionally, so writing the start
      // state below would immediately begin animating TOWARDS it - and the
      // browser would record the pre-FLIP value as the transition's start, which
      // makes the panel pop into place instead of travelling. Switching the
      // transition off for exactly these two writes is what makes the start
      // state a real start state; the reflow then commits it.
      view.panel.style.transition = 'none';
      view.panel.style.transform = 'none';
      view.panel.style.opacity = '';
      const to = view.panel.getBoundingClientRect();

      if (from && to.width > 0 && to.height > 0) {
        view.panel.style.transform = flipTransform(from, to).css;
      } else {
        // Opened from the keyboard, or from a card that has since been filtered
        // away: there is no meaningful origin, so the panel's own scale-up is the
        // whole motion.
        view.panel.style.transform = 'scale(0.92)';
      }
      void view.panel.offsetWidth; // flush the start state before the transition
      view.panel.style.transition = '';

      clearTimeout(closeTimer);
      closeGeneration++;
      view.root.classList.remove('is-closing');
      view.root.classList.add('is-open');
      view.root.setAttribute('aria-hidden', 'false');
      lockScroll(doc);
      doc.addEventListener('keydown', onKeydown, true);

      view.panel.style.transform = '';
      view.panel.focus({ preventScroll: true });
      repaintStripFor(milestone.id);

      remoteRead(milestone.id).then(() => {
        // Only repaint if this milestone is still the one on screen: a response
        // for a card the reader already closed must not reach into the DOM.
        if (current && current.id === milestone.id) {
          paintCurrent();
          repaintStripFor(milestone.id);
        }
      });
    }

    function finishClose() {
      clearTimeout(closeTimer);
      view.root.hidden = true;
      view.root.classList.remove('is-open', 'is-closing');
      view.root.setAttribute('aria-hidden', 'true');
      // `transition` is cleared too: open() disables it while it writes the FLIP
      // start state, and a close that lands in between would otherwise leave the
      // panel permanently un-animated.
      view.panel.style.transition = '';
      view.panel.style.transform = '';
      view.panel.style.opacity = '';
      unlockScroll(doc);
      doc.removeEventListener('keydown', onKeydown, true);
      current = null;
      const back = origin;
      origin = null;
      if (back && back.isConnected && typeof back.focus === 'function') {
        back.focus({ preventScroll: true });
      }
    }

    function close() {
      if (!view.root.classList.contains('is-open')) return;
      clearTimeout(closeTimer);

      const from = view.panel.getBoundingClientRect();
      const to = origin && origin.isConnected ? origin.getBoundingClientRect() : null;
      const onScreen = !!to && to.width > 0 && to.bottom > 0 && to.top < (globalThis.innerHeight || 0);

      view.root.classList.add('is-closing');

      if (onScreen) {
        // Reverse FLIP back to the card. Only attempted when the card is still on
        // screen: flying a panel off towards a card that scrolled away reads as a
        // jump, not as a return.
        view.panel.style.transform = flipTransform(to, from).css;
      }
      view.panel.style.opacity = '0';

      const generation = ++closeGeneration;
      const onDone = e => {
        if (generation !== closeGeneration) return;
        if (e.target !== view.panel || e.propertyName !== 'transform') return;
        view.panel.removeEventListener('transitionend', onDone);
        finishClose();
      };
      view.panel.addEventListener('transitionend', onDone);

      // Backstop, not the mechanism: transitionend never fires if the panel is
      // display:none'd mid-flight, and a dialog that cannot be dismissed is the
      // one failure this code must not have.
      closeTimer = setTimeout(() => {
        if (generation === closeGeneration) finishClose();
      }, 480);
    }

    // ---- reactions -------------------------------------------------------

    function applyReaction(milestone, emoji, sourceCard) {
      if (!milestone || !EMOJI_ORDER.has(emoji)) return;
      identity = currentIdentity(storage, now());
      const hasReacted = !store.mine(milestone.id)[emoji];
      store.setMine(milestone.id, emoji, hasReacted);

      if (current && current.id === milestone.id) paintCurrent();
      if (sourceCard) paintCardStrip(doc, sourceCard, milestone, store);
      repaintStripFor(milestone.id);

      remoteWrite({ milestone_id: milestone.id, reaction: { emoji, reacted: hasReacted } })
        .then(payload => {
          if (!payload || !current || current.id !== milestone.id) return;
          store.mergeServer(milestone.id, payload);
          paintCurrent();
          repaintStripFor(milestone.id);
          refreshPostedNote();
        });
    }

    function popButton(btn) {
      if (!btn) return;
      btn.classList.remove('is-popping');
      void btn.offsetWidth;
      btn.classList.add('is-popping');
    }

    function submitComment(event) {
      if (event) event.preventDefault();
      if (!current) return;

      identity = currentIdentity(storage, now());
      const text = sanitizeComment(view.comment ? view.comment.value : '');
      if (!text) {
        note('Write something first.', 'warn');
        return;
      }
      const elapsed = now() - lastPostAt;
      if (lastPostAt && elapsed < COMMENT_COOLDOWN_MS) {
        note('Give it ' + Math.ceil((COMMENT_COOLDOWN_MS - elapsed) / 1000) + 's before posting again.', 'warn');
        return;
      }

      const entry = {
        // Unique key. Suffixed with the clock so two posts from the same reader are
        // two entries; `owner` below is what identifies the reader.
        id: identity.id + ':' + now().toString(36),
        owner: identity.id,
        author: identity.label,
        kind: identity.kind,
        text,
        ts: now()
      };

      lastPostAt = now();
      lastPostId = current.id;
      store.addComment(current.id, entry);
      if (view.comment) view.comment.value = '';
      if (view.commentCount) view.commentCount.textContent = '0 / ' + COMMENT_MAX;
      if (view.commentSubmit) view.commentSubmit.disabled = true;
      paintThread(doc, view, current, store, identity, now());
      postedNote();

      remoteWrite({ milestone_id: current.id, comment: { text } })
        .then(payload => {
          if (!payload || !current || current.id !== lastPostId) return;
          store.mergeServer(current.id, payload);
          paintThread(doc, view, current, store, identity, now());
          paintIdentity(view, identity, remoteState === 'live');
          refreshPostedNote();
        });
    }

    // ---- wiring ----------------------------------------------------------

    view.close.addEventListener('click', close);
    view.scrim.addEventListener('click', close);

    view.reactionBar.addEventListener('click', e => {
      const btn = e.target.closest ? e.target.closest('.ms-detail__react') : null;
      if (!btn || !current) return;
      applyReaction(current, btn.dataset.emoji, null);
      popButton(btn);
    });

    view.composer.addEventListener('submit', submitComment);
    if (view.comment) {
      view.comment.addEventListener('input', () => {
        const len = view.comment.value.length;
        if (view.commentCount) view.commentCount.textContent = len + ' / ' + COMMENT_MAX;
        if (view.commentSubmit) view.commentSubmit.disabled = len === 0;
      });
    }

    // ---- catalog integration --------------------------------------------

    const grid = doc.getElementById('catalog-grid');

    if (grid) {
      // A chip lives inside the card, so a tap on one also lands on the card's own
      // open handler. Stopping it here is what keeps "react" and "inspect" from
      // being the same gesture.
      grid.addEventListener('click', e => {
        const chip = e.target.closest ? e.target.closest('.catalog-card__reaction') : null;
        if (!chip) return;
        e.preventDefault();
        e.stopPropagation();
        const card = chip.closest('.catalog-card');
        const milestone = (card && card.__milestone) || byId.get(chip.dataset.milestoneId);
        if (!milestone || !EMOJI_ORDER.has(chip.dataset.emoji)) return;
        applyReaction(milestone, chip.dataset.emoji, card);
        popButton(chip);
      }, true);

      // Cards are re-created on every filter change and on "Load more", so the
      // observer keeps strips in step with the grid without the catalog renderer
      // having to know this module exists at render time.
      let observer = null;
      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(mutations => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (!node || node.nodeType !== 1) continue;
              const cards = node.classList && node.classList.contains('catalog-card')
                ? [node]
                : Array.from(node.querySelectorAll ? node.querySelectorAll('.catalog-card') : []);
              for (const card of cards) {
                const milestone = card.__milestone || byId.get(card.dataset.milestoneId);
                if (milestone) paintCardStrip(doc, card, milestone, store);
              }
            }
          }
        });
        observer.observe(grid, { childList: true, subtree: true });
      }

      // Cards already on the page when this module boots still need their strip.
      const indexExisting = () => {
        for (const card of grid.querySelectorAll('.catalog-card')) {
          const milestone = card.__milestone || byId.get(card.dataset.milestoneId);
          if (milestone) paintCardStrip(doc, card, milestone, store);
        }
      };
      if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', indexExisting, { once: true });
      } else {
        indexExisting();
      }
    }

    return {
      open,
      close,
      register,
      isOpen: () => view.root.classList.contains('is-open'),
      view,
      store,
      destroy: () => {
        if (observer) observer.disconnect();
      }
    };
  }

  // ------------------------------------------------------------------- boot --

  let controller = null;

  function boot() {
    if (controller) return controller;
    controller = createController(window);
    if (controller) {
      // Exposed as a small surface rather than the whole controller: the catalog
      // renderer needs to open a card and hand over the record behind one, and
      // nothing else.
      window.MilestoneDetail = {
        open: (milestone, sourceEl) => controller.open(milestone, sourceEl),
        close: () => controller.close(),
        isOpen: () => controller.isOpen(),
        register: (card, milestone) => controller.register(card, milestone)
      };
    }
    return controller;
  }

  if (typeof window !== 'undefined') {
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
      } else {
        boot();
      }
    }

    // Pure helpers only. Exported so they can be pinned down by `bun test`
    // against a DOM stub, which cannot see a rendered card but can pin down the
    // ranking, the merge and the sanitising rules exactly.
    window.__MILESTONE_DETAIL_TEST__ = {
      REACTION_EMOJI,
      TOP_ON_CARD,
      COMMENT_MAX,
      COMMENT_COOLDOWN_MS,
      REMOTE_ENDPOINT,
      isSafeHttpUrl,
      hostOf,
      rankReactions,
      mergeCounts,
      sanitizeComment,
      resolveIdentity,
      isSessionLive,
      relativeTime,
      isOwnEntry,
      referencesFor,
      newAnonId,
      createStore,
      flipTransform,
      accentFor,
      boot
    };
  }
})();