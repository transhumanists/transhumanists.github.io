/* Interactive world map — projection + event plotting
 * No external dependencies. Equirectangular projection with smooth pan/zoom.
 * Includes day/night terminator overlay (sun position).
 */
(function() {
  'use strict';

  if (window.__WORLDMAP_INIT__) return;
  window.__WORLDMAP_INIT__ = true;

  const canvas = document.getElementById('world-map-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const tooltip = document.getElementById('map-tooltip');

  // ---- Constants ----
  const TERMINATOR_SAMPLES = 180;
  const TERMINATOR_UPDATE_MS = 60000;
  const DRAW_INTERVAL_MS = 100;
  const MIN_SCALE = 0.5;
  const MAX_SCALE = 8;
  const ZOOM_FACTOR = 1.1; // Used by zoomAt for keyboard/button zoom steps
  const HIT_RADIUS_BASE = 10;
  const CLICK_DRAG_THRESHOLD = 5;
// Default-view latitude window. The window is asymmetric on purpose: the land is
  // not symmetric about the equator, and a symmetric window leaves a wide empty
  // band of Southern Ocean below Antarctica while crowding the Arctic against the
  // top edge. +76 / -66 keeps every landmass in frame (the dataset's extremes are
  // 59.4N and 13.5S), trims the dead space underneath, and gives the northern
  // coastlines room. The span is also slightly smaller than the previous symmetric
  // +/-72, which zooms the geometry in a little as requested.
  const MAP_LAT_NORTH = 76;
  const MAP_LAT_SOUTH = -66;
  const MAP_LAT_SPAN = MAP_LAT_NORTH - MAP_LAT_SOUTH;
  // Terminator reach. Deliberately WIDER than the visible frame, so both the
  // boundary curves and the night fill extend past the top and bottom edges.
  //
  // Stopping inside the frame was the bug: the night band is a closed polygon, so
  // wherever it ended it left a straight horizontal seam across the full canvas
  // width. That seam was drawn over the Arctic landmass and read as a grey band
  // lying on top of the map rather than as part of the globe.
  //
  // Beyond ~66.6 degrees at the solstices the hour angle saturates and the
  // boundary longitude becomes constant, so the curve runs vertically off the
  // frame edge - which is exactly the "terminator curving off the globe" look,
  // and is also physically right: at high latitude a pole is either fully dark or
  // fully lit, so the night side spans a full 180 degrees of longitude there
  // instead of pinching to a point.
  const TERMINATOR_LAT_LIMIT = 84;
  const TOOLTIP_WIDTH = 260;
  const TOOLTIP_HEIGHT = 100;
  const TOOLTIP_OFFSET = 12;

  // Day/night palette. Deliberately disjoint from every CATEGORY_COLORS value
  // so the terminator never visually collides with a milestone category.
  const DAY_TINT = 'rgba(140, 200, 255, 0.07)';
  // The night shade. NIGHT_FILL_CLEAR and the RGB-triple indirection existed only
  // for the polar-cap gradient, which no longer exists: the band is now sampled
  // past both edges of the frame, so there is no seam to fade out.
  const NIGHT_FILL = 'rgba(2, 6, 14, 0.45)';
  const SUNSET_BOUNDARY = 'rgba(255, 222, 178, ALPHA)';
  const SUNRISE_BOUNDARY = 'rgba(176, 188, 255, ALPHA)';
  const SUN_ICON = '#fff3c4';
  const SUN_ICON_GLOW = '#fff3c4';
  const MOON_ICON = '#c9d0ff';
  const MOON_ICON_GLOW = '#c9d0ff';

  // Operational layers (conflict zones + tracked deployments).
  const ZONE_COLOR = '#ff6d8a';
  // Crisis zones (humanitarian): distinct purple to differentiate from conflict (red) and deployments (blue/amber)
  const CRISIS_COLOR = '#b388ff';
  // Ground deployments (mobilizations, troop movements): distinct amber/orange
  const GROUND_COLOR = '#ffb347';
  const FLEET_COLOR = '#4fc3f7';
// Human Rights Violations landmark. Deliberately outside the category palette so
// the layer can never be mistaken for a milestone category in the legend.
const HUMAN_RIGHTS_COLOR = '#ff7043';
// Alliance / defence-policy dots. A third, quieter step away from the amber of a
// ground arrow and the blue of a fleet arrow: this sublayer is about *who is
// aligned with whom*, not about a movement, so it borrows the mint that reads as
// "political/institutional" rather than another operational hue.
const ALLIANCE_DOT_COLOR = '#7de2d1';
// Tooltip headings per policy-change kind. An accession reads very differently
// from a mandate or an industrial decision, so the popup says which it is rather
// than labelling every one of them the same vague thing.
const ALLIANCE_DOT_HEADINGS = {
  accession: 'Alliance Accession',
  posture: 'Defence Posture',
  mandate: 'Mandate / Treaty',
  industrial: 'Defence Industrial',
  capability: 'Capability Build-up',
};
// Tracking reticle: the slowly rotating bracket that says "this zone is live
// right now". Declared with the other constants rather than next to its caller
// because ALLIANCE_DOT_HIT_RADIUS below is derived from it at module scope, and
// a `const` cannot be read before its own declaration runs.
const RETICLE_PERIOD_MS = 11000;
const RETICLE_SCALE = 1.34;
// One full swell-and-fade cycle for a landmark. Long enough to read as a
// breath rather than a flicker, short enough that the layer feels live.
const HUMAN_RIGHTS_PULSE_MS = 2400;

// ---- Responsible actor (nation / alliance / UN) ---------------------------
// Every operational entry answers "who is behind this?". That answer was buried
// in a `country` field that only infantry entries carry and in a `source` field
// that names a *publisher* (USNI, IISS, ISW) rather than an actor - so a fleet
// arrow could not say it was the US Navy, and a UN peacekeeping movement had no
// way to show it was the UN rather than whoever reported it.
//
// Resolution order, most trustworthy first:
//   1. an explicit `actor` on the record (the pipeline may assert one),
//   2. the record's `country`,
//   3. the record's own label/note text (ships and units name their navy),
//   4. `source`, which is a publisher - used only where it *is* an actor
//      (NATO, UN DPKO), never where it is an analyst.
//
// Country codes become real flags by turning the two-letter code into the
// regional-indicator pair, which is what a flag glyph is: 🇺🇸 for "US". Alliances
// and the UN have no flag, so they get a monogram chip instead of a glyph that
// would lie about who they are. Both forms are one element so the tooltip header
// only ever has to lay out one thing.
const ACTOR_KIND_NATION = 'nation';
const ACTOR_KIND_ALLIANCE = 'alliance';
const ACTOR_KIND_UN = 'un';

// flag: the emoji pair (nations) or the chip label (everything else).
// match: lowercase substrings tested against label + note + source, longest-first
// at lookup time so "royal navy" wins over "navy".
const ACTOR_TABLE = {
  // --- nations ---
  // `demonym` is optional and is matched alongside the name. It exists because
  // the payloads name actors adjectivally far more often than nominally:
  // "Russian Baltic Fleet" contains no standalone word "Russia", so a
  // name-only table resolves the Russian navy to nobody - which is precisely the
  // record where naming the actor matters most.
  'united states': { label: 'United States', flag: 'US', kind: ACTOR_KIND_NATION, demonym: 'american' },
  'usa': { label: 'United States', flag: 'US', kind: ACTOR_KIND_NATION },
  'usn': { label: 'United States', flag: 'US', kind: ACTOR_KIND_NATION },
  'us army': { label: 'United States', flag: 'US', kind: ACTOR_KIND_NATION },
  'usaf': { label: 'United States', flag: 'US', kind: ACTOR_KIND_NATION },
  'united kingdom': { label: 'United Kingdom', flag: 'GB', kind: ACTOR_KIND_NATION, demonym: 'british' },
  'royal navy': { label: 'United Kingdom', flag: 'GB', kind: ACTOR_KIND_NATION },
  'russia': { label: 'Russia', flag: 'RU', kind: ACTOR_KIND_NATION, demonym: 'russian' },
  'russian navy': { label: 'Russia', flag: 'RU', kind: ACTOR_KIND_NATION },
  'china': { label: 'China', flag: 'CN', kind: ACTOR_KIND_NATION, demonym: 'chinese' },
  'plan': { label: 'China', flag: 'CN', kind: ACTOR_KIND_NATION },
  'india': { label: 'India', flag: 'IN', kind: ACTOR_KIND_NATION, demonym: 'indian' },
  'indian navy': { label: 'India', flag: 'IN', kind: ACTOR_KIND_NATION },
  'ukraine': { label: 'Ukraine', flag: 'UA', kind: ACTOR_KIND_NATION, demonym: 'ukrainian' },
  'poland': { label: 'Poland', flag: 'PL', kind: ACTOR_KIND_NATION, demonym: 'polish' },
  'finland': { label: 'Finland', flag: 'FI', kind: ACTOR_KIND_NATION, demonym: 'finnish' },
  'sweden': { label: 'Sweden', flag: 'SE', kind: ACTOR_KIND_NATION, demonym: 'swedish' },
  'germany': { label: 'Germany', flag: 'DE', kind: ACTOR_KIND_NATION, demonym: 'german' },
  'france': { label: 'France', flag: 'FR', kind: ACTOR_KIND_NATION, demonym: 'french' },
  'turkey': { label: 'Türkiye', flag: 'TR', kind: ACTOR_KIND_NATION, demonym: 'turkish' },
  'south korea': { label: 'South Korea', flag: 'KR', kind: ACTOR_KIND_NATION, demonym: 'korean' },
  'japan': { label: 'Japan', flag: 'JP', kind: ACTOR_KIND_NATION, demonym: 'japanese' },
  'australia': { label: 'Australia', flag: 'AU', kind: ACTOR_KIND_NATION, demonym: 'australian' },
  'canada': { label: 'Canada', flag: 'CA', kind: ACTOR_KIND_NATION, demonym: 'canadian' },
  'netherlands': { label: 'Netherlands', flag: 'NL', kind: ACTOR_KIND_NATION, demonym: 'dutch' },
  'belgium': { label: 'Belgium', flag: 'BE', kind: ACTOR_KIND_NATION, demonym: 'belgian' },
  'norway': { label: 'Norway', flag: 'NO', kind: ACTOR_KIND_NATION, demonym: 'norwegian' },
  'denmark': { label: 'Denmark', flag: 'DK', kind: ACTOR_KIND_NATION, demonym: 'danish' },
  'estonia': { label: 'Estonia', flag: 'EE', kind: ACTOR_KIND_NATION, demonym: 'estonian' },
  'latvia': { label: 'Latvia', flag: 'LV', kind: ACTOR_KIND_NATION, demonym: 'latvian' },
  'lithuania': { label: 'Lithuania', flag: 'LT', kind: ACTOR_KIND_NATION, demonym: 'lithuanian' },
  'spain': { label: 'Spain', flag: 'ES', kind: ACTOR_KIND_NATION, demonym: 'spanish' },
  'italy': { label: 'Italy', flag: 'IT', kind: ACTOR_KIND_NATION, demonym: 'italian' },
  'brazil': { label: 'Brazil', flag: 'BR', kind: ACTOR_KIND_NATION, demonym: 'brazilian' },
  'egypt': { label: 'Egypt', flag: 'EG', kind: ACTOR_KIND_NATION, demonym: 'egyptian' },
  'israel': { label: 'Israel', flag: 'IL', kind: ACTOR_KIND_NATION, demonym: 'israeli' },
  'iran': { label: 'Iran', flag: 'IR', kind: ACTOR_KIND_NATION, demonym: 'iranian' },
  'pakistan': { label: 'Pakistan', flag: 'PK', kind: ACTOR_KIND_NATION, demonym: 'pakistani' },
  'saudi arabia': { label: 'Saudi Arabia', flag: 'SA', kind: ACTOR_KIND_NATION, demonym: 'saudi' },
  'greece': { label: 'Greece', flag: 'GR', kind: ACTOR_KIND_NATION, demonym: 'greek' },
  'portugal': { label: 'Portugal', flag: 'PT', kind: ACTOR_KIND_NATION, demonym: 'portuguese' },
  'switzerland': { label: 'Switzerland', flag: 'CH', kind: ACTOR_KIND_NATION, demonym: 'swiss' },
  'montenegro': { label: 'Montenegro', flag: 'ME', kind: ACTOR_KIND_NATION, demonym: 'montenegrin' },
  'north macedonia': { label: 'North Macedonia', flag: 'MK', kind: ACTOR_KIND_NATION, demonym: 'macedonian' },
  // --- alliances / intergovernmental ---
  'nato': { label: 'NATO', flag: 'NATO', kind: ACTOR_KIND_ALLIANCE },
  'north atlantic treaty organization': { label: 'NATO', flag: 'NATO', kind: ACTOR_KIND_ALLIANCE },
  'european union': { label: 'European Union', flag: 'EU', kind: ACTOR_KIND_ALLIANCE },
  'eu': { label: 'European Union', flag: 'EU', kind: ACTOR_KIND_ALLIANCE },
  'aukus': { label: 'AUKUS', flag: 'AUKUS', kind: ACTOR_KIND_ALLIANCE },
  'five eyes': { label: 'Five Eyes', flag: 'FVEY', kind: ACTOR_KIND_ALLIANCE },
  'un': { label: 'United Nations', flag: 'UN', kind: ACTOR_KIND_UN },
  'un dpko': { label: 'UN Peacekeeping', flag: 'UN', kind: ACTOR_KIND_UN },
  'un peacekeeping': { label: 'UN Peacekeeping', flag: 'UN', kind: ACTOR_KIND_UN },
  'united nations': { label: 'United Nations', flag: 'UN', kind: ACTOR_KIND_UN },
};

// Publishers. Listed explicitly so the text fallback can name an analyst's
// report as *not* being an actor: an entry sourced only from ISW must not be
// painted with a flag implying ISW did the thing.
const ACTOR_PUBLISHERS = new Set([
  'isw', 'iiss', 'usni', 'nyt', 'bbc', 'reuters', 'ap', 'afp',
  'understandingwar', 'front line defenders', 'human rights watch',
  'amnesty international', 'wikipedia', 'ocha', 'wfp', 'who', 'unhcr', 'fao',
]);

// Every term that can name an actor: the table key (which is often a shorthand
// alias like "usn" or "plan"), the display label, and the demonym. All three are
// matched, longest first, so "united kingdom" beats "un" and "russian navy"
// beats "russia".
//
// Word boundaries are load-bearing, not decoration. The table includes two-letter
// terms - "un", "eu" - and a bare `includes` test resolves "UN Peacekeeping"
// correctly while ALSO resolving it for "June", "Munich", "Function" and
// "Unnamed": every prose field in the layer payloads is free text written by hand,
// and a table that guesses the UN out of the word "June" is worse than no table
// at all because it is confidently wrong. `[^a-z0-9]` on both sides is the same
// guard INSTITUTION_PATTERNS uses a few hundred lines down, for the same reason.
const ACTOR_PATTERNS = (() => {
  const byTerm = new Map();
  for (const [key, entry] of Object.entries(ACTOR_TABLE)) {
    for (const term of [key, entry.label.toLowerCase(), entry.demonym]) {
      if (typeof term === 'string' && term && !byTerm.has(term)) byTerm.set(term, entry);
    }
  }
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...byTerm.entries()]
    .sort((a, b) => b[0].length - a[0].length)
    .map(([term, entry]) => ({
      term,
      entry,
      re: new RegExp(`(^|[^a-z0-9])${escapeRe(term)}([^a-z0-9]|$)`),
    }));
})();

  // Landmark geometry, in screen pixels, shared by the renderer and the hit test.
  //
  // These are deliberately one set of constants. The hit radius used to be a
  // hardcoded 12px while the pulsing glow reached 24px, so the visible halo was
  // twice as large as the clickable area and aiming at it did nothing. Deriving
  // the hit radius from the same numbers the renderer uses makes that
  // unrepresentable.
  const HUMAN_RIGHTS_CORE_MIN = 3;
  const HUMAN_RIGHTS_CORE_MAX = 8;
  const HUMAN_RIGHTS_CORE_ACTIVE = 5;   // nominal core radius, active entry
  const HUMAN_RIGHTS_CORE_DONE = 3.5;   // nominal core radius, concluded entry
  const HUMAN_RIGHTS_GLOW_INNER = 1.9;  // glow radius at the trough of the pulse
  const HUMAN_RIGHTS_GLOW_PULSE = 1.1; // extra glow radius at the peak
  // Widest the landmark ever paints itself, therefore the widest the pointer may
  // reasonably be from its centre and still count as "on" it.
  const HUMAN_RIGHTS_HIT_RADIUS =
    HUMAN_RIGHTS_CORE_MAX * (HUMAN_RIGHTS_GLOW_INNER + HUMAN_RIGHTS_GLOW_PULSE);
  // Very transparent arrow tail line (barely visible) — 8% opacity
  const ARROW_TAIL_OPACITY = 0.08;
  // Widest an alliance seal ever paints itself (glow + reticle), and therefore the
  // widest the pointer may be from its centre and still count as "on" it. Same
  // derivation rule as the human-rights landmark radius: the hit test is a
  // consequence of the renderer, never a second number that can disagree.
  const ALLIANCE_DOT_BASE_DEG = 0.9;
  const ALLIANCE_DOT_HIT_RADIUS =
    ALLIANCE_DOT_BASE_DEG * 2 * RETICLE_SCALE + 6;

  // Operational layer row labels, in one place.
//
// The old name - "Ground Deployments & Fleet Movements" - described the mark
// rather than the layer and was long enough that it wrapped out of the legend
// frame on a phone. It is also declared a second time in
// schema/worldmap-data.schema.json and a third in the README, so this constant
// plus the schema entry are the only two the label lives in.
const LAYER_LABELS = {
  zones: 'Conflict Zones',
  deployments: 'Ground & Fleet Deployments',
  alliance_dots: 'Alliance & Defence Policy',
  crises: 'Crisis Zones',
  human_rights: 'Human Rights Violations',
};

// ---- Layer lifecycle (active/concluded + duration) ----
  // Operational layers now carry an optional lifecycle: still-active zones,
  // crises and deployments are drawn with a distinct "fluo" glow, while
  // concluded ones render dim and expose their full duration in the tooltip.
  const STATUS_ACTIVE = 'active';
  const STATUS_CONCLUDED = 'concluded';

  // Timeline slider state, declared up here because layerCurrentYear() (below) and
  // the layer renderers all read it. It used to live ~2800 lines further down,
  // which worked only because nothing called those functions during module
  // evaluation — a fragile ordering dependency for a load-bearing value.
  // The floor is a deliberate UI/perf choice: a first-time visitor sees the full
  // set and the slider clusters within a recent window, so a layer concluded
  // wholly before TIMELINE_MIN_YEAR would never be reachable at any position.
  // 1945 covers the full historical milestone archive (Trinity test, ENIAC, etc.).
  let timelineYear = new Date().getFullYear(); // current year by default
  const TIMELINE_MIN_YEAR = 1945;
  function getTimelineMaxYear() { return new Date().getFullYear(); }

  const FLUO_GLOW_BLUR = 26;
  const FLUO_LINE_GLOW_BLUR = 9;
  const FLUO_PULSE_RADIUS = 10;
  // Passive-area ladder, deliberately a visible multi-step ladder rather than a
  // single "off" look: hot (full fluo glow) > quiet (no glow, desaturated, dark
  // fill) > cold (darkest, long-running background) > done (ghost outline only).
  // The stroke alpha matters more than the fill: it is what makes a ring legible
  // over the ocean. Keyed by the layerPaintTier() values so the three layer
  // renderers share one palette.
  const LAYER_TIER_PAINT = {
    // Active and recent: the only tier allowed to glow.
    hot: { fill: 0.34, stroke: 1.0, halo: 0.20, line: 3.2, desat: 0, glow: true, pulse: true },
    // Active but not current (or single-list sourced, or no recency signal).
    quiet: { fill: 0.10, stroke: 0.34, halo: 0, line: 1.4, desat: 0.62, glow: false, pulse: false },
    // Active and long-running background.
    cold: { fill: 0.05, stroke: 0.16, halo: 0, line: 1, desat: 0.82, glow: false, pulse: false },
    // Concluded: ghost only.
    done: { fill: 0.035, stroke: 0.13, halo: 0, line: 1, desat: 0.86, glow: false, pulse: false },
  };
  // Centre-marker alpha per tier, so a "hot" dot still reads as a live point
  // rather than a hole in the ring.
  const LAYER_TIER_CENTER_ALPHA = { hot: 1, quiet: 0.5, cold: 0.28, done: 0.22 };
  // Deployment arrows use their own alpha table rather than being derived from the
  // area-ring fill above. An arrow is a thin 1px line, not a filled disc, so it
  // needs a much higher alpha to read at all - deriving it from the ring's fill
  // (dividing by the hot value) meant retuning a ring silently retuned every
  // arrow on the map.
  const LAYER_TIER_ARROW = {
    hot: { tail: 1.0, head: 1.0, line: 2.4 },
    quiet: { tail: 0.38, head: 0.46, line: 1.4 },
    cold: { tail: 0.22, head: 0.26, line: 1.1 },
    done: { tail: 0.14, head: 0.17, line: 1.1 },
  };
  /**
   * Decimal places for coordinate rounding when clustering events into stacks.
   * 4 dp ≈ 11 m at the equator — tight enough to merge only truly co-located events.
   * @type {number}
   */
const STACK_ROUND_DIGITS = 4;
const STACK_FAN_DX = 3;
const STACK_FAN_DY = -3;

// Two-letter country code -> flag glyph. A regional-indicator pair IS a flag in
// Unicode ("US" -> 🇺🇸), so the emoji is computed rather than stored: the table
// stays two characters per nation instead of a four-byte pictograph per row, and
// a nation added later needs one line, not one glyph to copy.
function flagGlyph(code) {
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) return '';
  const base = 0x1F1E6; // REGIONAL INDICATOR SYMBOL LETTER A
  const hi = base + (code.charCodeAt(0) - 65);
  const lo = base + (code.charCodeAt(1) - 65);
  if (hi < base || hi > base + 25 || lo < base || lo > base + 25) return '';
  return String.fromCodePoint(hi) + String.fromCodePoint(lo);
}

// The actor behind a record, or null when the data genuinely does not say.
// Never throws on a missing field: every caller is a tooltip builder.
function resolveActor(item) {
  if (!item) return null;
  const lookup = (raw) => {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return null;
    for (const { entry, re } of ACTOR_PATTERNS) {
      if (re.test(s)) return entry;
    }
    return null;
  };
  // 1. An explicit assertion from the pipeline always wins.
  const explicit = lookup(item.actor);
  if (explicit) return explicit;
  // 2. The country the record names.
  const byCountry = lookup(item.country);
  if (byCountry) return byCountry;
  // 3. The record's own prose: units and ships name their navy, and an alliance
  //    posture names its bloc. Checked before `source` because it is the record's
  //    own claim rather than a publisher's.
  const prose = [item.label, item.name, item.note].filter(Boolean).join(' ');
  const byProse = lookup(prose);
  if (byProse) return byProse;
  // 4. `source` last, and only when it names an institution that acts rather
  //    than one that reports. Without this an ISW-sourced Russian fleet would be
  //    filed under ISW, which is exactly the confusion this table exists to stop.
  const src = String(item.source || '').trim().toLowerCase();
  if (src && !ACTOR_PUBLISHERS.has(src)) return lookup(src);
  return null;
}

// The tooltip's top-right corner: who is responsible for this movement.
// Returns the element so the caller owns placement, and null when no actor is
// known - a blank corner is more honest than a guessed flag.
function createActorBadge(item) {
  const actor = resolveActor(item);
  if (!actor) return null;
  const badge = document.createElement('div');
  badge.className = 'tt-actor tt-actor--' + actor.kind;
  const glyph = actor.kind === ACTOR_KIND_NATION ? flagGlyph(actor.flag) : '';
  if (glyph) {
    const flag = document.createElement('span');
    flag.className = 'tt-flag';
    flag.textContent = glyph;
    flag.setAttribute('aria-hidden', 'true');
    badge.appendChild(flag);
  } else {
    // Alliances and the UN have no flag. A monogram chip says who it is instead
    // of borrowing a member state's flag, which would misattribute the action.
    const chip = document.createElement('span');
    chip.className = 'tt-flag tt-flag--org';
    chip.textContent = actor.flag;
    chip.setAttribute('aria-hidden', 'true');
    badge.appendChild(chip);
  }
  const role = actor.kind === ACTOR_KIND_NATION ? 'Responsible nation'
    : actor.kind === ACTOR_KIND_UN ? 'Responsible body' : 'Responsible alliance';
  badge.title = role + ': ' + actor.label;
  badge.setAttribute('aria-label', role + ': ' + actor.label);
  return badge;
}

// The popup's root element. Named so a popup can be found and reasoned about by
// class rather than by "the element the tooltip happens to contain", which is how
// the header row and the flags ended up unaddressable from a test.
function createTooltipCard() {
    const el = document.createElement('div');
    el.className = 'tt-card';
    return el;
  }

  // Tooltip header: category label on the left, actor flags hard right on the same
  // baseline. One row so the flags can never drift onto the title line above or
  // below it, whatever the category label wraps to.
  function appendTooltipHeader(wrapper, categoryText, color, item) {
    const head = document.createElement('div');
    head.className = 'tt-head';
    const cat = document.createElement('div');
    cat.className = 'tt-category';
    cat.style.color = color;
    cat.textContent = categoryText;
    head.appendChild(cat);
    const badge = createActorBadge(item);
    if (badge) head.appendChild(badge);
    wrapper.appendChild(head);
    return wrapper;
  }

  // The shared "who reported this" line, linked when the payload carries a usable
  // URL. Three identical copies of this used to exist (zone / deployment / crisis
  // / landmark), and they had already drifted on the empty-source case.
  function appendSourceLine(wrapper, item) {
    const meta = document.createElement('div');
    meta.className = 'tt-meta';
    if (item.source && item.url && SOURCE_URL_RE.test(item.url)) {
      const link = document.createElement('a');
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.color = 'var(--accent)';
      link.textContent = item.source;
      meta.appendChild(link);
    } else {
      meta.textContent = item.source || 'Unknown source';
    }
    wrapper.appendChild(meta);
    return meta;
  }

  function appendNoteLine(wrapper, text) {
    if (!text) return null;
    const note = document.createElement('div');
    note.className = 'tt-note';
    note.textContent = text;
    wrapper.appendChild(note);
    return note;
  }

  // A short "Nation: X / Region: Y" style fact line, used by the movement and
  // policy popups. Omitted entirely when the record says nothing, so the popup
  // never shows a label with an em-dash where a value should be.
  function appendFactLine(wrapper, label, value) {
    if (value === undefined || value === null || value === '') return null;
    const line = document.createElement('div');
    line.className = 'tt-fact';
    const key = document.createElement('span');
    key.className = 'tt-fact-key';
    key.textContent = label;
    const val = document.createElement('span');
    val.className = 'tt-fact-val';
    val.textContent = String(value);
    line.append(key, val);
    wrapper.appendChild(line);
    return line;
  }

  function withOpacity(hexColor, opacity) {
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }

  function desaturateHex(hexColor, amount) {
    if (typeof hexColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hexColor)) {
      return '#808080'; // Safe fallback for invalid input
    }
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);
    const grey = Math.round((r + g + b) / 3);
    const mix = (c) => Math.round(c + (grey - c) * amount);
    const to2 = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
    return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`;
  }

  // Normalize a layer entry's lifecycle status. Missing/`active`/`ongoing`
  // mean the marker is still live (fluo glow); anything explicitly ended
  // (`concluded`, `inactive`, `ended`, `resolved`) maps to the dimmed state.
  function layerStatus(item) {
    const s = String(item && (item.status || '')).toLowerCase();
    return s === '' || s === 'active' || s === 'ongoing' ? STATUS_ACTIVE : STATUS_CONCLUDED;
  }

  function isLayerActive(item) {
    return layerStatus(item) === STATUS_ACTIVE;
  }

  // The year the layer is being judged against. `timelineYear` is the single
  // source of truth for the slider position; this used to read a `state.timelineYear`
  // that nothing ever assigned, so the field was permanently undefined and the
  // fallback silently won — staleness was judged against the wall clock even with
  // the slider parked in the past, marking layers stale that were fresh in the
  // year being displayed.
  function layerCurrentYear() {
    return timelineYear;
  }

  // ---- Layer recency tiers ----
  // How current a layer looks, judged against the year the map is displaying.
  //
  // `last_news_year` is a recency *proxy*, not a literal last-reported date: for
  // Wikipedia-derived layers sync_layers.py fills it from the conflict's start
  // column (recent start = current, 1948 start = long-running), and curated
  // news-derived layers carry their own value. Crises and most deployments ship no
  // `last_news_year` at all, so start_date is the only signal they have.
  //
  // Tiers, brightest to dimmest:
  //   hot   - active and recent. Neon glow + pulse. Reserved for this.
  //   quiet - active but not recent, or no recency signal, or single-list sourced.
  //   cold  - active and long-running. Dark and desaturated.
  //   done  - concluded. Ghost outline, no fill.
  // Absence of a recency signal is deliberately NOT treated as current: showing a
  // layer as "hot" because we know nothing about it would misrepresent it, and the
  // whole point of the ladder is that neon means "active and recent".
  const TIER_HOT = 'hot';
  const TIER_QUIET = 'quiet';
  const TIER_COLD = 'cold';
  const TIER_DONE = 'done';
  // Age (in years, vs the displayed year) at or below which an active layer is
  // still "hot". 3 keeps the 2024 deployments and 2022-23 conflicts lit while
  // pushing 2022-and-older material down a tier.
  const LAYER_FRESH_YEARS = 3;
  // Beyond this the layer reads as long-running background rather than news.
  const LAYER_STALE_YEARS = 15;

  // Wikipedia's "List of ongoing armed conflicts" is a single community-maintained
  // list. It is a reasonable catalogue of what is *listed*, not corroboration that
  // each entry is currently active, so a zone sourced only from it is never
  // rendered in the neon "hot" treatment - it is capped at `quiet` regardless of
  // how recent its start year looks. Zones that also carry a named authority
  // (UN OCHA, IMSC, ISW, ...) are unaffected.
  const WIKI_CONFLICT_SOURCE = 'wikipedia (list of ongoing armed conflicts)';
  function isSingleListSourced(item) {
    const s = String((item && item.source) || '').toLowerCase();
    return s.includes('wikipedia');
  }

  // The recency signal for a layer, in years, or null when it carries none.
  function layerRecencyYear(item) {
    const news = item && item.last_news_year;
    if (typeof news === 'number' && Number.isFinite(news)) return news;
    const start = normalizeLayerDate(layerStartDate(item));
    return start ? parseInt(start.slice(0, 4), 10) : null;
  }

  // Single source of truth for how a layer should be painted. drawZone,
  // drawCrisis and drawFleet all switch on this so the three layer types can
  // never drift into disagreeing about what "active" looks like.
  function layerTier(item) {
    if (!isLayerActive(item)) return TIER_DONE;
    const recency = layerRecencyYear(item);
    if (recency === null) return TIER_QUIET;          // no signal -> not "hot"
    const age = layerCurrentYear() - recency;
    // A recency marker *after* the displayed year means the signal lies outside
    // the window being viewed (the slider is parked before the layer's data). That
    // is not evidence the layer is current, so it must not reach the neon tier.
    if (age < 0) return TIER_QUIET;
    if (age > LAYER_STALE_YEARS) return TIER_COLD;
    if (age <= LAYER_FRESH_YEARS) return TIER_HOT;
    return TIER_QUIET;
  }

  // The tier actually painted, after the single-list-sourcing cap.
  function layerPaintTier(item) {
    const tier = layerTier(item);
    if (tier === TIER_HOT && isSingleListSourced(item)) return TIER_QUIET;
    return tier;
  }

  // Retained for callers that only need the old boolean. "Stale" now means
  // "anything that should not read as current", which is quiet or cold.
  function isStaleLayer(item) {
    const tier = layerPaintTier(item);
    return tier === TIER_QUIET || tier === TIER_COLD;
  }

  // Accept YYYY-MM-DD, YYYY-MM or just YYYY (the forms sync_layers.py writes)
  // and normalize to a comparable YYYY-MM-DD, or null when absent/unparsable.
  function normalizeLayerDate(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    if (!s) return null;
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) return isoMatch[0];
    const monthMatch = s.match(/^(\d{4})-(\d{2})$/);
    if (monthMatch) return `${monthMatch[1]}-${monthMatch[2]}-01`;
    const yearMatch = s.match(/^(\d{4})$/);
    if (yearMatch) return `${yearMatch[1]}-01-01`;
    return parseDateToISO(s);
  }

  function layerStartDate(item) { return item && (item.start_date || item.startDate); }
  function layerEndDate(item) { return item && (item.end_date || item.endDate); }

  // Humanized lifecycle line shown in layer tooltips: active markers say how
  // long they have been live; concluded ones show the complete duration span.
  function layerActivityLabel(item) {
    const start = normalizeLayerDate(layerStartDate(item));
    const end = normalizeLayerDate(layerEndDate(item));
    if (isLayerActive(item)) return start ? `Active since ${start}` : 'Active';
    if (start && end) {
      const days = Math.max(1, 1 + Math.round(
        (Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000
      ));
      return `Concluded · ${days} day${days === 1 ? '' : 's'} (${start} → ${end})`;
    }
    if (start) return `Concluded · ran from ${start}`;
    if (end) return `Concluded · ended ${end}`;
    return 'Concluded';
  }

  // Whether a layer entry was (or is) live during `year`. Active entries appear
  // from their start year onward (so a conflict begun in 2022 stays on the map
  // at 2025); concluded entries stay visible only inside their active window.
  // Entries without dates default to visible in every year (backwards-compatible).
  function layerVisibleInYear(item, year) {
    const start = normalizeLayerDate(layerStartDate(item));
    const end = normalizeLayerDate(layerEndDate(item));
    const startYear = start ? parseInt(start.slice(0, 4), 10) : null;
    const endYear = end ? parseInt(end.slice(0, 4), 10) : null;
    if (isLayerActive(item)) return startYear === null || year >= startYear;
    if (startYear !== null && endYear !== null) return year >= startYear && year <= endYear;
    if (startYear !== null) return year >= startYear;
    if (endYear !== null) return year <= endYear;
    return true;
  }

  // Smart pluralization helper
  function pluralize(count, singular, plural) {
    if (count === 1) return singular;
    return plural;
  }

  // Geocoding cache for intelligent fallback
  const GEOCODE_CACHE_KEY = 'worldmap_geocode_cache_v1';
  const GEOCODE_CACHE_MAX_SIZE = 500;
  // Ceiling on the serialized cache we will even attempt to parse. Each entry is
  // a short "source|title|category" key plus a 2-number object, so a full cache
  // is well under 100 kB; this is a cheap guard against a hand-edited or
  // hostile localStorage value forcing an unbounded JSON.parse on the main thread
  // during page load. The entry-count trim below is the real size control.
  const GEOCODE_CACHE_MAX_BYTES = 512 * 1024;

  // Upper bound on the persisted hidden-category list. Nine canonical names is a few
  // hundred bytes; anything past this is a hand-edited or hostile value.
  const HIDDEN_CATEGORIES_MAX_BYTES = 4 * 1024;

  // Single source of truth for the source-link URL scheme gate.
  // Every renderer (worldmap, dashboard, widgets) must test the raw string
  // against this before assigning to href. A mismatched gate would either
  // let a javascript: URL through or fail CI on data the browser accepts.
  const SOURCE_URL_RE = /^https?:\/\//i;

  // JSON.parse can succeed on the wrong type - the string "null" parses to null -
  // and every later geocodeCache[cacheKey] would then throw. loadEvents catches
  // that and falls back to sample data, so a corrupt cache entry would silently
  // replace the whole map with four sample events. Only a non-null object is
  // usable, so everything else starts from an empty cache.
  function parseGeocodeCache(raw) {
    // Length is checked before parsing, not after: the point is to never hand an
    // arbitrarily large string to JSON.parse on the load path.
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > GEOCODE_CACHE_MAX_BYTES) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      return (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  let geocodeCache = {};
  try {
    const cached = localStorage.getItem(GEOCODE_CACHE_KEY);
    if (cached) geocodeCache = parseGeocodeCache(cached);
    // Enforce max size on load in case the stored cache grew beyond the limit.
    const keys = Object.keys(geocodeCache);
    if (keys.length > GEOCODE_CACHE_MAX_SIZE) {
      const toRemove = keys.length - GEOCODE_CACHE_MAX_SIZE;
      keys.slice(0, toRemove).forEach(k => delete geocodeCache[k]);
    }
  } catch (_) {}

  let geocodeCacheDirty = false;
  let geocodeCacheIntervalId = null;
  function saveGeocodeCache() {
    if (!geocodeCacheDirty) return;
    try {
      localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(geocodeCache));
      geocodeCacheDirty = false;
    } catch (_) {}
  }
  // Flush and stop the periodic writer. Named (not an inline arrow) so cleanup()
  // can detach it: the listeners used to be anonymous, so a teardown that did not
  // happen to be a page unload left them attached to a dead interval. Idempotent,
  // because both beforeunload and pagehide fire on a normal navigation.
  function flushAndStopGeocodeCache() {
    saveGeocodeCache();
    if (geocodeCacheIntervalId) {
      clearInterval(geocodeCacheIntervalId);
      geocodeCacheIntervalId = null;
    }
  }
  // Persist cache periodically and on unload
  geocodeCacheIntervalId = setInterval(saveGeocodeCache, 30000);
  window.addEventListener('beforeunload', flushAndStopGeocodeCache);
  window.addEventListener('pagehide', flushAndStopGeocodeCache);

  // Known institution coordinates for intelligent geocoding fallback
  const INSTITUTION_COORDS = {
    'arxiv': { lat: 42.4440, lon: -76.5019 }, // Cornell University, Ithaca NY
    'cornell': { lat: 42.4440, lon: -76.5019 },
    'cornell university': { lat: 42.4440, lon: -76.5019 },
    'mit': { lat: 42.3601, lon: -71.0942 },
    'stanford': { lat: 37.4275, lon: -122.1697 },
    'harvard': { lat: 42.3770, lon: -71.1167 },
    'berkeley': { lat: 37.8719, lon: -122.2585 },
    'cmu': { lat: 40.4433, lon: -79.9438 },
    'caltech': { lat: 34.1377, lon: -118.1253 },
    'princeton': { lat: 40.3440, lon: -74.6514 },
    'yale': { lat: 41.3111, lon: -72.9267 },
    'columbia': { lat: 40.8075, lon: -73.9626 },
    'chicago': { lat: 41.7886, lon: -87.5987 },
    'ucla': { lat: 34.0689, lon: -118.4452 },
    'ucsd': { lat: 32.8801, lon: -117.2340 },
    'eth zurich': { lat: 47.3769, lon: 8.5417 },
    'epfl': { lat: 46.5197, lon: 6.5667 },
    'oxford': { lat: 51.7548, lon: -1.2544 },
    'cambridge': { lat: 52.2053, lon: 0.1218 },
    'deepmind': { lat: 51.5074, lon: -0.1278 },
    'google': { lat: 37.4220, lon: -122.0841 },
    'openai': { lat: 37.7749, lon: -122.4194 },
    'anthropic': { lat: 37.7749, lon: -122.4194 },
    'nvidia': { lat: 37.3688, lon: -122.0363 },
    'ibm': { lat: 41.0323, lon: -73.5543 },
    'microsoft': { lat: 47.6062, lon: -122.3321 },
    'meta': { lat: 37.4848, lon: -122.1484 },
    'apple': { lat: 37.3349, lon: -122.0090 },
    'amazon': { lat: 47.6062, lon: -122.3321 },
    'spacex': { lat: 28.5728, lon: -80.6490 },
    'nasa': { lat: 28.5237, lon: -80.6810 },
    'jaxa': { lat: 35.6762, lon: 139.6503 },
    'esa': { lat: 48.9219, lon: 2.3646 },
    'cern': { lat: 46.2333, lon: 6.0500 },
    'llnl': { lat: 37.6881, lon: -121.7045 },
    'nifs': { lat: 35.6762, lon: 139.6503 },
    'ipp': { lat: 54.0956, lon: 13.4725 },
    'quantinuum': { lat: 51.5074, lon: -0.1278 },
    'qutech': { lat: 52.0116, lon: 4.3571 },
    'broad': { lat: 42.3375, lon: -71.1061 },
    'neuralink': { lat: 37.4861, lon: -122.1519 },
    'dexcom': { lat: 32.8844, lon: -117.2340 },
    'thermofisher': { lat: 44.4268, lon: -123.0764 },
    'hms': { lat: 42.3375, lon: -71.1061 },
    'mpi-cbg': { lat: 51.0504, lon: 13.7373 },
    'sparktx': { lat: 39.9526, lon: -75.1652 },
    'jcvi': { lat: 32.7157, lon: -117.1611 },
    'quantumscape': { lat: 37.5485, lon: -122.0591 },
    'autogpt': { lat: 37.7749, lon: -122.4194 },
    'cncell': { lat: 31.2304, lon: 121.4737 },
    'intel': { lat: 45.5215, lon: -122.6774 },
    'amd': { lat: 37.4220, lon: -122.0841 },
    'tsmc': { lat: 24.7867, lon: 120.9969 },
    'asml': { lat: 51.5900, lon: 5.0500 },
    'samsung': { lat: 37.2636, lon: 127.0286 },
    'hzdr': { lat: 51.2323, lon: 13.6830 },
    'nist': { lat: 38.8951, lon: -77.0364 },
    'csrc': { lat: 38.8951, lon: -77.0364 },
    'cisa': { lat: 38.8951, lon: -77.0364 },
    'nvd': { lat: 38.8951, lon: -77.0364 },
    'usaf': { lat: 38.8951, lon: -77.0364 },
    'norad': { lat: 38.8951, lon: -77.0364 },
    'us navy': { lat: 36.8508, lon: -76.2995 },
    'rafael': { lat: 32.0853, lon: 34.7818 },
    'idf': { lat: 32.0853, lon: 34.7818 },
    'almaz-antey': { lat: 55.7558, lon: 37.6173 },
    'nato': { lat: 50.8609, lon: 4.3676 },
    'ismsc': { lat: 13.5, lon: 43.0 },
    'unocha': { lat: 31.3, lon: 34.3 },
    'isw': { lat: 48.0, lon: 37.8 },
    'usni': { lat: 38.8951, lon: -77.0364 },
    'rn': { lat: 50.8, lon: -1.1 },
    'iiss': { lat: 51.5074, lon: -0.1278 },
    'india': { lat: 19.0, lon: 72.8 },
    'plan': { lat: 26.7, lon: 114.0 },
    'iaea': { lat: 48.2082, lon: 16.3738 },
    'who_org': { lat: 46.2276, lon: 6.1424 },
    'un_org': { lat: 40.7580, lon: -73.9683 },
    'fda': { lat: 38.8951, lon: -77.0364 },
    'ncsc': { lat: 51.5074, lon: -0.1278 },
    'gchq': { lat: 51.5074, lon: -0.1278 },
    'mossad': { lat: 31.9686, lon: 35.5064 },
    'nsa': { lat: 38.8951, lon: -77.0364 },
    'plaff': { lat: 39.9042, lon: 116.4074 },
    'csir': { lat: 51.2323, lon: 13.6830 },
    'significant-gravitas': { lat: 37.7749, lon: -122.4194 },
    'github': { lat: 37.7749, lon: -122.4194 },
    // Additional entries for better geocoding coverage
    'quanta magazine': { lat: 40.7580, lon: -73.9683 }, // NYC
    'nature biotechnology': { lat: 51.5074, lon: -0.1278 }, // London (Nature Publishing)
    'nature': { lat: 51.5074, lon: -0.1278 },
    'fiercebiotech': { lat: 42.3601, lon: -71.0942 }, // Boston area
    'open khipu repository': { lat: -13.5, lon: -71.9 }, // Cusco, Peru (Inca region)
    'research team': { lat: 0.0, lon: 0.0 }, // Will not match - generic
    'research authors': { lat: 0.0, lon: 0.0 }, // Will not match - generic
    'academic researchers': { lat: 0.0, lon: 0.0 }, // Will not match - generic
    'international mathematics collaboration': { lat: 48.8566, lon: 2.3522 }, // Paris (IMU)
    'quantamagazine': { lat: 40.7580, lon: -73.9683 }, // NYC (Quanta Magazine)
    'ieee': { lat: 40.7580, lon: -73.9683 }, // NYC
    'acm': { lat: 40.7580, lon: -73.9683 }, // NYC
    'usenix': { lat: 37.7749, lon: -122.4194 }, // Berkeley/SF
    'siggraph': { lat: 34.0522, lon: -118.2437 }, // LA
    'neurips': { lat: 37.7749, lon: -122.4194 }, // Usually virtual/varied
    'icml': { lat: 37.7749, lon: -122.4194 },
    'aaai': { lat: 37.7749, lon: -122.4194 },
    'cvpr': { lat: 37.7749, lon: -122.4194 },
    'iclr': { lat: 37.7749, lon: -122.4194 },
    'ijcai': { lat: 37.7749, lon: -122.4194 },
  };

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const INSTITUTION_PATTERNS = Object.entries(INSTITUTION_COORDS).map(([key, coords]) => ({
    key,
    coords,
    pattern: new RegExp(`(^|[^a-z0-9])${escapeRe(key.toLowerCase())}([^a-z0-9]|$)`)
  }));

  function geocodeInstitution(source, title, category) {
    if (!source || source === 'Unknown' || source === 'unknown') return null;
    if (!title || title === 'Untitled' || title === 'untitled') return null;

    const cacheKey = `${source}|${title}|${category}`.toLowerCase();
    if (geocodeCache[cacheKey]) {
      return geocodeCache[cacheKey];
    }
    const text = `${source} ${title} ${category}`.toLowerCase();
    for (const { coords, pattern } of INSTITUTION_PATTERNS) {
      if (pattern.test(text)) {
        if (Object.keys(geocodeCache).length >= GEOCODE_CACHE_MAX_SIZE) {
          const firstKey = Object.keys(geocodeCache)[0];
          delete geocodeCache[firstKey];
        }
        geocodeCache[cacheKey] = coords;
        geocodeCacheDirty = true;
        return coords;
      }
    }
    return null;
  }

  // ---- State ----
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  
  // Persistence keys
  const STORAGE_KEY_FILTER_RECENT = 'worldmap_filter_recent';
  const STORAGE_KEY_FILTER_MILITARY = 'worldmap_filter_military';
  const STORAGE_KEY_FILTER_CRISIS = 'worldmap_filter_crisis';
  const STORAGE_KEY_SHOW_ZONES = 'worldmap_show_zones';
  const STORAGE_KEY_SHOW_FLEETS = 'worldmap_show_fleets';
  const STORAGE_KEY_SHOW_CRISES = 'worldmap_show_crises';
const STORAGE_KEY_SHOW_HUMAN_RIGHTS = 'worldmap_show_human_rights';
  const STORAGE_KEY_SHOW_ALLIANCE_DOTS = 'worldmap_show_alliance_dots';
const STORAGE_KEY_HIDDEN_CATEGORIES = 'worldmap_hidden_categories';

  // Load persisted preferences. Defaults are deliberately "show everything":
  // a brand-new visitor sees the full milestone set (filterRecent OFF), while
  // the operational layers (conflict zones / deployments / crises) stay hidden
  // until explicitly enabled. A returning visitor's saved choice wins.
  let filterRecentDefault = false;
  let filterMilitaryDefault = false;
  let filterCrisisDefault = false;
  let showZonesDefault = false;
  let showFleetsDefault = false;
  let showCrisesDefault = false;
  let showHumanRightsDefault = false;
  // The dot sublayer follows the parent datalayer: if the visitor has never
  // touched the key, it is visible whenever Ground & Fleet Deployments is on.
  // Anything else would hide dots the visitor never asked to hide.
  let showAllianceDotsDefault = true;
  try {
    const fr = localStorage.getItem(STORAGE_KEY_FILTER_RECENT);
    const fm = localStorage.getItem(STORAGE_KEY_FILTER_MILITARY);
    const fc = localStorage.getItem(STORAGE_KEY_FILTER_CRISIS);
    const sz = localStorage.getItem(STORAGE_KEY_SHOW_ZONES);
    const sf = localStorage.getItem(STORAGE_KEY_SHOW_FLEETS);
    const sc = localStorage.getItem(STORAGE_KEY_SHOW_CRISES);
    const sh = localStorage.getItem(STORAGE_KEY_SHOW_HUMAN_RIGHTS);
    const sa = localStorage.getItem(STORAGE_KEY_SHOW_ALLIANCE_DOTS);
    if (fr !== null) filterRecentDefault = fr === 'true';
    if (fm !== null) filterMilitaryDefault = fm === 'true';
    if (fc !== null) filterCrisisDefault = fc === 'true';
    if (sz !== null) showZonesDefault = sz === 'true';
    if (sf !== null) showFleetsDefault = sf === 'true';
    if (sc !== null) showCrisesDefault = sc === 'true';
    if (sh !== null) showHumanRightsDefault = sh === 'true';
    if (sa !== null) showAllianceDotsDefault = sa === 'true';
  } catch (_) {}

  const state = {
    width: 0,
    height: 0,
    dpr: window.devicePixelRatio || 1,
    transform: { scale: 1, tx: 0, ty: 0 },
    isDragging: false,
    hoveredEvent: null,
    hoveredType: null, // 'zone', 'deployment', 'event', 'crisis', 'alliance', 'human_rights'
    selectedEvent: null,
    tooltipHover: false,
    // The landmark a hover-anchored popup belongs to, and whether the popup has
    // been "taken over" by the pointer (i.e. the pointer travelled onto the
    // popup itself rather than away from the map).
    //
    // This is what makes a popup's links clickable without pinning it first:
    // pointer leaves the landmark -> travels onto the popup -> the popup is
    // still anchored to that landmark, so it must not be dismissed for being
    // "no longer hovered". Released again on the way out, so moving on to the
    // next landmark still hands over cleanly.
    hoverAnchor: null,
    hoverAnchorType: null,
    // Last pointer position in canvas space. A popup that changes subject while
    // the pointer is stationary still has to be placed, and the only place that
    // knows where the pointer is is the last mousemove.
    lastPointerX: 0,
    lastPointerY: 0,
    stackIndex: 0,
    pressX: null,
    pressY: null,
    events: [],
    showTerminator: true,
    // Test/demo override for the sun position (set via the __WORLDMAP_TEST__
    // hook so day/night rendering is deterministic in the test suite).
    sunPositionOverride: null,
    // Non-null when the milestone feed could not be loaded in production. Drives
    // the on-map notice so an empty map is explained rather than mysterious.
    dataLoadError: null,
    hiddenCategories: new Set(),
    selectedHumanRight: null,
    selectedLayer: null,
    selectedLayerType: null,
    _box: null, _boxW: -1, _boxH: -1,
    foldedCategories: false, // whether the entire categories section is folded
    zones: [],
    fleets: [],
    allianceDots: [],
    crises: [],
    humanRights: [],
    // Filter states
    filterRecent: filterRecentDefault, // breakthroughs this week only
    filterMilitary: filterMilitaryDefault, // conflict zones & deployments
    filterCrisis: filterCrisisDefault, // crisis zones
    // Layer visibility (persisted, default OFF)
    showZones: showZonesDefault,
    showFleets: showFleetsDefault,
    showCrises: showCrisesDefault,
    showHumanRights: showHumanRightsDefault,
    showAllianceDots: showAllianceDotsDefault,
    // Cached terminator data (geo-space: sun angle barely moves, but the
    // screen projection must be recomputed for every draw since pan/zoom
    // changes the transform).
    terminatorCache: {
      sunLon: null,
      sunLat: null,
      sunsetGeo: null,
      sunriseGeo: null,
      nightBand: null,
      computedAt: 0
    }
  };

  const CATEGORY_COLORS = {
    'Biotechnology & Biohacking': '#00e676',
    'Computing & AGI': '#448aff',
    'Quantum Physics': '#b388ff',
    'Renewable Energy': '#ffd740',
    'Mobility & Logistics': '#ff5c9a',
    'Cybersecurity': '#ff5252',
    'Robotics & Drones': '#6c7a89',
    'Spaceflight & Aeronautics': '#00d4ff',
    'Military & Defense': '#ff9100'
  };

  // Two-tone categories. The primary colour is the category colour above; a record
  // whose `tone` matches the secondary label renders in `secondary`, so one legend
  // row covers both (the row is drawn with splitColors, like Deployments).
  // Classified upstream by sync_milestones.classify_tone; the keyword list that
  // drives it lives in CATEGORY_SUBTONES there and is mirrored in
  // schema/worldmap-data.schema.json.
  const CATEGORY_SUBTONES = {
    'Biotechnology & Biohacking': {
      secondary: 'Biohacking',
      secondaryColor: '#00a651'
    }
  };

  function secondaryColorFor(cat, tone) {
    if (!tone) return null;
    const spec = CATEGORY_SUBTONES[canonicalCategory(cat)];
    if (!spec || spec.secondary !== tone) return null;
    return spec.secondaryColor;
  }

  // The colour a milestone landmark is actually drawn in: the category colour,
  // overridden by its sub-tone when it has one.
  function landmarkColorFor(cat, tone) {
    return secondaryColorFor(cat, tone) || CATEGORY_COLORS[canonicalCategory(cat)] || '#00d4ff';
  }

  const CATEGORY_STAT_MAP = {
    'Biotechnology & Biohacking': { statId: 'map-stat-active', label: 'breakthroughs this week' },
    'Cybersecurity': { statId: 'map-stat-conflicts', label: 'active conflict zones' },
    'Military & Defense': { statId: 'map-stat-fleets', label: 'fleet movements tracked' },
    'Renewable Energy': { statId: 'map-stat-active', label: 'breakthroughs this week' },
    'Mobility & Logistics': { statId: 'map-stat-active', label: 'breakthroughs this week' },
    'Robotics & Drones': { statId: 'map-stat-active', label: 'breakthroughs this week' },
    'Spaceflight & Aeronautics': { statId: 'map-stat-fleets', label: 'fleet movements tracked' },
    'Quantum Physics': { statId: 'map-stat-active', label: 'breakthroughs this week' },
    'Computing & AGI': { statId: 'map-stat-active', label: 'breakthroughs this week' }
  };

  // Map category names from any source (old short names or the canonical data names)
  // to the canonical names used by events.json, so colors/stats/legend always align.
  const CATEGORY_ALIASES = {
    'Quantum': 'Quantum Physics',
    'Energy': 'Renewable Energy',
    'Defense': 'Military & Defense',
    'Spaceflight': 'Spaceflight & Aeronautics',
    'Quantum Physics': 'Quantum Physics',
    'Renewable Energy': 'Renewable Energy',
    'Military & Defense': 'Military & Defense',
    'Spaceflight & Aeronautics': 'Spaceflight & Aeronautics',
    'Quantum Gravity': 'Quantum Physics',
    'Mathematics': 'Computing & AGI',
    'Computational Archaeology': 'Computing & AGI',
    'Computer Vision': 'Computing & AGI',
    'Legal AI': 'Computing & AGI',
    // Split / renamed categories. Legacy payloads and the dev sample data still
    // carry the old labels, so they fold into the canonical bucket.
    'Biotechnology': 'Biotechnology & Biohacking',
    'Biohacking': 'Biotechnology & Biohacking',
    'Biotech': 'Biotechnology & Biohacking',
    'Synthetic Biology': 'Biotechnology & Biohacking',
    'Logistics': 'Mobility & Logistics',
    'Transportation': 'Mobility & Logistics',
    'Transport': 'Mobility & Logistics',
    // Renamed to "Robotics & Drones" once drone flight-time, range and
    // payload records began being tracked under it. Both directions are
    // mapped, so a payload may carry either label and the old one keeps
    // validating instead of falling out of the canonical set.
    'Robotics': 'Robotics & Drones',
    'Robotics & Automation': 'Robotics & Drones',
    'Automation': 'Robotics & Drones',
    'Drones': 'Robotics & Drones',
    'Drone': 'Robotics & Drones',
    'UAV': 'Robotics & Drones',
  };

  // Canonical category order used by the legend (color, label). This is the
  // product's reading order: human-progress fields first, then infrastructure,
  // then the operational ones. Mirrors category_order in
  // schema/worldmap-data.schema.json; scripts/test_check_data.py enforces parity.
  const CATEGORY_LEGEND = [
    { key: 'Biotechnology & Biohacking', label: 'Biotechnology & Biohacking' },
    { key: 'Computing & AGI', label: 'Computing & AGI' },
    { key: 'Quantum Physics', label: 'Quantum Physics' },
    { key: 'Renewable Energy', label: 'Renewable Energy' },
    { key: 'Mobility & Logistics', label: 'Mobility & Logistics' },
    { key: 'Cybersecurity', label: 'Cybersecurity' },
    { key: 'Robotics & Drones', label: 'Robotics & Drones' },
    { key: 'Spaceflight & Aeronautics', label: 'Spaceflight & Aeronautics' },
    { key: 'Military & Defense', label: 'Military & Defense' }
  ];

  // Category visibility is persisted too; it used to reset on every reload, so
  // a visitor who switched a category off saw it return unprompted. Applied
  // here rather than in the preference block above because validating against
  // CATEGORY_LEGEND at that point would throw a TDZ ReferenceError that the
  // surrounding try/catch would swallow - silently discarding every saved
  // preference, not just this one.
  // Extracted so the load path's trust boundary is directly testable rather than
  // only reachable by mutating localStorage and reloading the module.
  //
  // Returns the canonical names to hide, or null when the stored value is absent or
  // unusable - in which case the caller's existing set is left alone.
  function parseHiddenCategories(raw) {
    // Length-checked before parsing, for the same reason parseGeocodeCache does it:
    // never hand an arbitrarily large user-writable string to JSON.parse. A real
    // payload is nine category names.
    if (typeof raw !== 'string' || raw.length === 0 ||
        raw.length > HIDDEN_CATEGORIES_MAX_BYTES) {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    // Filter to canonical names: localStorage is user-writable, and an unfiltered
    // value could push arbitrary strings into the legend.
    return parsed.filter(
      (name) => typeof name === 'string' &&
        CATEGORY_LEGEND.some((l) => l.key === name)
    );
  }

  try {
    const restored = parseHiddenCategories(
      localStorage.getItem(STORAGE_KEY_HIDDEN_CATEGORIES));
    if (restored) state.hiddenCategories = new Set(restored);
  } catch (_) {}

function canonicalCategory(cat) {
    return CATEGORY_ALIASES[cat] || cat;
  }

  function isCategoryVisible(cat) {
    const canonical = canonicalCategory(cat);
    return !state.hiddenCategories.has(canonical);
  }

  // Bulk visibility for milestone categories.
  //
  // Deliberately scoped to CATEGORY_LEGEND only: Conflict Zones, Ground
  // Deployments and Human Rights Violations are operational layers with their own
  // switches further down the same frame, and a "hide everything" control that
  // also switched those off would be lying about what it does.
  //
  // Derived, never stored. The eye has to agree with the per-row switches after
  // the user clicks them one at a time, and the only way to guarantee that is to
  // compute it from the same state the rows read.
  function areAllCategoriesHidden() {
    return CATEGORY_LEGEND.every(c => state.hiddenCategories.has(c.key));
  }

  function setAllCategoriesHidden(hidden) {
    if (hidden) {
      CATEGORY_LEGEND.forEach(c => state.hiddenCategories.add(c.key));
    } else {
      state.hiddenCategories.clear();
    }
    try {
      localStorage.setItem(STORAGE_KEY_HIDDEN_CATEGORIES,
        JSON.stringify(Array.from(state.hiddenCategories)));
    } catch (_) {}
    rebuildStackMap();
    dismissTooltip();
    renderLegend();
    draw();
  }

  function toggleAllCategories() {
    setAllCategoriesHidden(!areAllCategoriesHidden());
  }

  // Apply the derived state to a button node. Separate from the lookup below so a
  // freshly built button can be initialised while it is still in hand, instead of
  // depending on it being findable in the document a moment later.
  function applyBulkVisibilityState(btn) {
    if (!btn) return;
    const allHidden = areAllCategoriesHidden();
    btn.setAttribute('aria-pressed', String(allHidden));
    const label = allHidden
      ? 'Show all milestone categories'
      : 'Hide all milestone categories';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }

  // Keep the eye in step after an individual row click, without rebuilding the
  // whole legend (which would drop keyboard focus mid-interaction).
  function syncBulkVisibilityButton() {
    applyBulkVisibilityState(
      document.getElementById('map-legend-bulk-visibility'));
  }

  function toggleCategory(cat) {
    const canonical = canonicalCategory(cat);
    if (state.hiddenCategories.has(canonical)) {
      state.hiddenCategories.delete(canonical);
    } else {
      state.hiddenCategories.add(canonical);
    }
    // Persist the set so a category hidden before a reload stays hidden.
    try {
      localStorage.setItem(STORAGE_KEY_HIDDEN_CATEGORIES,
        JSON.stringify(Array.from(state.hiddenCategories)));
    } catch (_) {}
    // Category visibility is part of a stack's membership: hiding one member
    // can drop a location below the stacking threshold (and unhide can merge
    // locations that used to be lone dots).
    rebuildStackMap();
    // A popup can be pointing at a milestone that is no longer drawn.
    dismissTooltip();
    syncBulkVisibilityButton();
    draw();
    updateStatsDisplay();
    renderLegend();
  }

  // ---- Country outlines (simplified continent path) ----
  const CONTINENTS = [
    [[ -170, 70], [-150, 70], [-95, 60], [-80, 50], [-65, 25], [-80, 15], [-95, 18], [-105, 30], [-118, 35], [-125, 45], [-130, 55], [-165, 60]],
    [[ -80, 12], [-60, 5], [-50, -5], [-35, -10], [-40, -25], [-55, -35], [-70, -55], [-80, -45], [-82, -20], [-80, 0]],
    [[ -10, 60], [5, 65], [30, 70], [40, 60], [30, 45], [15, 38], [0, 40], [-10, 50]],
    [[ -15, 35], [10, 35], [30, 30], [40, 15], [50, -10], [40, -30], [20, -35], [10, -25], [0, -10], [-10, 10], [-15, 25]],
    [[ 40, 60], [80, 70], [120, 70], [140, 55], [130, 35], [110, 25], [95, 15], [75, 25], [55, 35], [45, 45]],
    [[ 115, -12], [140, -12], [152, -20], [148, -38], [120, -35], [115, -22]],
    [[ -180, -65], [180, -65], [180, -85], [-180, -85]]
  ];

  // ---- Projection ----
  // Longitude always spans the full 360deg across the canvas; latitude spans the
  // asymmetric MAP_LAT_NORTH..MAP_LAT_SOUTH window, so the canvas top/bottom edges
  // are the cropped polar edges.
  // The world is 360 degrees of longitude by MAP_LAT_SPAN of latitude, so it has a
  // fixed aspect ratio. Stretching it to fill the canvas instead - which is what
  // this used to do - squashed longitude and inflated latitude whenever the two
  // disagreed. On a phone that turned the map into an unreadable smear and the
  // coastlines stopped lining up with the graticule you were reading them against.
  //
  // The map is therefore fitted inside the canvas at its natural ratio and centred,
  // leaving a margin rather than distorting. CSS keeps the container close to 2:1
  // so that margin is only a few pixels on desktop and zero on mobile; this is the
  // guarantee that it can never become a distortion if the box is some other shape.
  const MAP_ASPECT = 360 / MAP_LAT_SPAN;

  function mapBox() {
    // Memoised on the canvas dimensions. project() calls this once per graticule
    // line, per continent vertex, per marker and per hit test - several thousand
    // calls per frame - and recomputing the fit each time was slow enough to push
    // the initial data load past the settling window the tests allow, which showed
    // up as an empty map rather than as a slow one.
    //
    // Keyed on width/height rather than invalidated from applyResize(), so a call
    // made before the first resize (or after a transform-only change) is still
    // correct instead of returning a stale box.
    if (state._box && state._boxW === state.width && state._boxH === state.height) {
      return state._box;
    }
    const cw = state.width;
    const ch = state.height;
    let h = ch;
    let w = h * MAP_ASPECT;
    if (w > cw) { w = cw; h = w / MAP_ASPECT; }
    state._box = { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
    state._boxW = cw;
    state._boxH = ch;
    return state._box;
  }

  // The map plate in screen space, i.e. mapBox() after the pan/zoom transform.
// Anything painted as geography has to be clipped to this: project() fits the world
// inside the canvas and centres it, so without a clip the vertical graticule lines
// and the terminator tint carry on into the letterbox margin where no coastline is
// drawn, which reads as a shaded border around the map rather than as map.
function mapScreenRect() {
    const b = mapBox();
    const t = state.transform;
    return {
      x: b.x * t.scale + t.tx,
      y: b.y * t.scale + t.ty,
      w: b.w * t.scale,
      h: b.h * t.scale,
    };
  }

  function project(lon, lat) {
    const b = mapBox();
    const x = b.x + (lon + 180) / 360 * b.w;
    const y = b.y + (MAP_LAT_NORTH - lat) / MAP_LAT_SPAN * b.h;
    return { x: x * state.transform.scale + state.transform.tx, y: y * state.transform.scale + state.transform.ty };
  }

  // Screen pixels per degree of latitude. Geographic layer radii (conflict and
  // crisis zones) are declared in degrees and drawn as circles, so they follow
  // this — the same scale project() uses for latitude.
  function latDegToPx() {
    return mapBox().h / MAP_LAT_SPAN;
  }

  // ---- Sample data (LOCAL DEV ONLY) ----
  // These entries are fabricated: the sources, figures and dates are invented so
  // the widget has something to draw while iterating on layout. They must never
  // reach a real visitor, because this site presents itself as a live tracker of
  // actual breakthroughs and an indistinguishable fake is worse than an empty
  // map. loadEvents() therefore only falls back to them on a local origin (see
  // isLocalDev) and otherwise shows an honest "data unavailable" state.
  // Dates sit within 7 days of a typical deploy so the "this week" filter works
  // during local development.
  const SAMPLE_EVENTS = [
    { lat: 37.7749, lon: -122.4194, title: 'CRISPR Cas-13b phase-3 trial cleared', category: 'Biotechnology', value: '50 patients', source: 'Stanford', date: '2026-09-22' },
    { lat: 47.3769, lon: 8.5417, title: 'ETH Zurich - 137 qubit entanglement', category: 'Quantum Physics', value: '137 qubits', source: 'ETH Zurich', date: '2026-09-21' },
    { lat: 35.6762, lon: 139.6503, title: 'JT-60SA sustained fusion: 100 MJ', category: 'Renewable Energy', value: '100 MJ', source: 'NIFS Japan', date: '2026-09-20' },
    { lat: 51.5074, lon: -0.1278, title: 'GCHQ cyber threat advisory - 9.8 CVSS', category: 'Cybersecurity', value: 'CVSS 9.8', source: 'NCSC UK', date: '2026-09-19' },
    { lat: 28.5728, lon: -80.6490, title: 'SpaceX Starship: 156t to LEO', category: 'Spaceflight & Aeronautics', value: '156 tonnes', source: 'SpaceX', date: '2026-09-18' },
    { lat: 50.4501, lon: 30.5234, title: 'NATO exercise - 12,000 troops', category: 'Military & Defense', value: '12k troops', source: 'NATO', date: '2026-09-17' },
    { lat: 39.9042, lon: 116.4074, title: 'Beijing hypersonic test: Mach 13', category: 'Military & Defense', value: 'Mach 13', source: 'PLASSF', date: '2026-09-16' },
    { lat: 31.9686, lon: 35.5064, title: 'Mossad joint cyber op with NSA', category: 'Cybersecurity', value: 'Tier-1', source: 'Mossad', date: '2026-09-15' },
    { lat: 52.5200, lon: 13.4050, title: 'Wendelstein 7-X - 6 min plasma record', category: 'Renewable Energy', value: '6 min', source: 'IPP', date: '2026-09-14' },
    { lat: 32.0853, lon: 34.7818, title: 'Tel Aviv biotech: in-vivo organoid', category: 'Biotechnology', value: 'patent-pending', source: 'Tel Aviv U', date: '2026-09-13' },
    { lat: -33.8688, lon: 151.2093, title: 'CSIRO solar cell: 33.2% efficiency', category: 'Renewable Energy', value: '33.2%', source: 'CSIRO', date: '2026-09-12' },
    { lat: 1.3521, lon: 103.8198, title: 'ST Engineering drone swarm test', category: 'Military & Defense', value: '1000 UAVs', source: 'CSA', date: '2026-09-11' }
  ];

  // ---- Terminator (Day/Night boundary) ----
  function getSunPosition() {
    if (state.sunPositionOverride) return state.sunPositionOverride;
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const day = now.getUTCDate();
    const hour = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;

    const startOfYear = Date.UTC(year, 0, 1);
    const dayOfYear = Math.floor((Date.UTC(year, month, day) - startOfYear) / 86400000);

    const declination = -23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
    const B = (360 / 365) * (dayOfYear - 81) * Math.PI / 180;
    const equationOfTime = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
    const solarTime = hour + equationOfTime / 60;
    const hourAngle = (solarTime - 12) * 15 * Math.PI / 180;

    const subSolarLat = declination;
    const subSolarLon = -hourAngle * 180 / Math.PI;

    return { lat: subSolarLat, lon: subSolarLon };
  }

  function normalizeLon(lon) {
    return ((lon + 180) % 360 + 360) % 360 - 180;
  }

  // Geo-space terminator: for each sample latitude the boundary longitude at a
  // given offset from the sub-solar point. Pure lon/lat data — independent of
  // the current pan/zoom transform.
  function buildTerminatorGeo(sunLat, sunLon, offsetLon) {
    const effLon = normalizeLon(sunLon + offsetLon);
    const geo = new Array(TERMINATOR_SAMPLES + 1);

    // Sampled across +/-TERMINATOR_LAT_LIMIT, not +/-90: the polar band above it
    // is left to the cap fade instead of being given a constant longitude.
    for (let i = 0; i <= TERMINATOR_SAMPLES; i++) {
      const lat = TERMINATOR_LAT_LIMIT - (i / TERMINATOR_SAMPLES) * (TERMINATOR_LAT_LIMIT * 2);
      const latRad = lat * Math.PI / 180;
      const declRad = sunLat * Math.PI / 180;

      const cosHourAngle = -Math.tan(latRad) * Math.tan(declRad);

      // cosHourAngle is now strictly inside (-1, 1) for every sample, but keep the
      // clamp so a future TERMINATOR_LAT_LIMIT change can never produce NaN.
      const hourAngle = Math.acos(Math.max(-1, Math.min(1, cosHourAngle)));
      geo[i] = { lon: normalizeLon(effLon + (hourAngle * 180 / Math.PI)), lat };
    }
    return geo;
  }

  function getCachedTerminatorGeo(sunLat, sunLon) {
    const now = Date.now();
    const cache = state.terminatorCache;

    // Recompute if sun position changed significantly (>0.01°) or cache expired (>1 min)
    const sunMoved = Math.abs(cache.sunLon - sunLon) > 0.01 || Math.abs(cache.sunLat - sunLat) > 0.01;
    const cacheExpired = now - cache.computedAt > TERMINATOR_UPDATE_MS;

    if (!cache.sunsetGeo || sunMoved || cacheExpired) {
      cache.sunsetGeo = buildTerminatorGeo(sunLat, sunLon, 0);
      cache.sunriseGeo = buildTerminatorGeo(sunLat, sunLon, 180);
      cache.nightBand = buildNightBand(cache.sunsetGeo);
      cache.sunLon = sunLon;
      cache.sunLat = sunLat;
      cache.computedAt = now;
    }
    return { sunset: cache.sunsetGeo, sunrise: cache.sunriseGeo, nightBand: cache.nightBand };
  }

  // Night-shade polygon spanning the whole night hemisphere (the region between
  // the evening terminator and the morning terminator). The sunrise terminator
  // is always exactly 180deg east of the sunset one at every latitude, so the
  // band is built purely from the (unwrapped) sunset longitudes — no dependence
  // on the sun's declination or the current pan/zoom transform. The result is a
  // closed strip from the north pole down the evening edge and back up the
  // morning edge; when painted in longitude-shifted copies (see drawTerminator)
  // the correct half of the map always falls dark, including at sun lon ~0 where
  // the older corner-sewn polygon painted the daylit side.
  function buildNightBand(sunset) {
    const n = sunset.length;
    const band = new Array(n * 2);

    // Unwrap the evening edge into a continuous lon curve (each step < 180deg).
    let offset = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const prev = sunset[i - 1].lon + offset;
        const cur = sunset[i].lon + offset;
        if (cur - prev > 180) offset -= 360;
        else if (cur - prev < -180) offset += 360;
      }
      band[i] = { lon: sunset[i].lon + offset, lat: sunset[i].lat };
    }

    // Morning edge mirrors the evening edge 180deg east, walked back up from
    // the south pole so the strip closes along both polar rows.
    for (let i = 0; i < n; i++) {
      band[n + i] = { lon: band[n - 1 - i].lon + 180, lat: band[n - 1 - i].lat };
    }
    return band;
  }

  // Draw one terminator boundary as a few stacked translucent passes (widest
  // first) so the day/night edge reads as a gentle, highly transparent gradient
  // band instead of a hard line. Both boundaries get identical treatment so they
  // blend into each other.
  function strokeSoftBoundary(geo, rgbaBase) {
    const passes = [
      { w: 7, a: 0.03 },
      { w: 4, a: 0.06 },
      { w: 1.6, a: 0.11 }
    ];
    for (const pass of passes) {
      ctx.beginPath();
      geo.forEach((pt, i) => {
        const p = project(pt.lon, pt.lat);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.strokeStyle = rgbaBase.replace('ALPHA', String(pass.a));
      ctx.lineWidth = pass.w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  function drawTerminator() {
    if (!state.showTerminator) return;

    const sun = getSunPosition();
    const w = state.width;
    const h = state.height;

    // Geo-space terminator (cached by sun angle), projected to screen now so
    // the boundary tracks every pan/zoom.
    const { sunset, sunrise, nightBand } = getCachedTerminatorGeo(sun.lat, sun.lon);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    // Brighten the sunlit side of the map beneath the night shade so daytime
    // hemispheres read clearly brighter than the night side.
    ctx.fillStyle = DAY_TINT;
    ctx.fillRect(0, 0, w, h);

    // ---- Night shading: region between the sunset and sunrise terminators ----
    // Painted as three longitude-shifted copies of the unwrapped band so the
    // night side covers the map correctly under any pan/zoom; project() is
    // linear, so shifted longitudes land off-canvas and clip away cleanly.
    const band = nightBand;
    ctx.fillStyle = NIGHT_FILL;
    for (const lonShift of [-360, 0, 360]) {
      ctx.beginPath();
      band.forEach((pt, i) => {
        const p = project(pt.lon + lonShift, pt.lat);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fill();
    }

    // ---- Day/night boundary lines: soft, blended and very transparent ----
    strokeSoftBoundary(sunset, SUNSET_BOUNDARY);
    strokeSoftBoundary(sunrise, SUNRISE_BOUNDARY);

    // No polar cap fade: the night band is sampled past both edges of the frame,
    // so there is no seam left to hide and nothing to soften. Fading here would
    // lighten the pole while the terminator runs off the side of the map.

    // ---- Sun position marker (small sun icon, no dot) ----
    const sunPos = project(sun.lon, sun.lat);
    if (sunPos.x >= -50 && sunPos.x <= w + 50 && sunPos.y >= -50 && sunPos.y <= h + 50) {
      ctx.save();
      ctx.font = '14px ui-monospace, SFMono-Regular, monospace';
      ctx.fillStyle = SUN_ICON;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = SUN_ICON_GLOW;
      ctx.shadowBlur = 14;
      ctx.fillText('☀', sunPos.x, sunPos.y);
      ctx.restore();
    }

    // ---- Anti-sun (sunrise) marker: small moon icon, no outline dot ----
    const antiSunLon = normalizeLon(sun.lon + 180);
    const antiSunLat = -sun.lat;
    const antiSunPos = project(antiSunLon, antiSunLat);
    if (antiSunPos.x >= -50 && antiSunPos.x <= w + 50 && antiSunPos.y >= -50 && antiSunPos.y <= h + 50) {
      ctx.save();
      ctx.font = '12px ui-monospace, SFMono-Regular, monospace';
      ctx.fillStyle = MOON_ICON;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = MOON_ICON_GLOW;
      ctx.shadowBlur = 10;
      ctx.fillText('☽', antiSunPos.x, antiSunPos.y);
      ctx.restore();
    }

    ctx.restore();
  }

  // ---- Resize ----
  let resizeTimeout = null;
  function applyResize() {
    const rect = canvas.getBoundingClientRect();
    // Refuse to resize into a zero-area canvas. That happens whenever the widget is
    // hidden or not laid out yet - a display:none ancestor, a collapsed panel, or the
    // first paint before the aspect-ratio box has a width. Adopting 0x0 clobbers the
    // backing store and collapses every projection onto the origin, painting a frame
    // full of dots stacked in one corner. Keeping the last good size means the next
    // resize event (which follows layout) simply draws correctly.
    if (!(rect.width > 0) || !(rect.height > 0)) return false;
    state.width = rect.width;
    state.height = rect.height;
    // Refresh DPR on every resize: the device scale can change (window moved to
    // another monitor, OS display zoom) and that alone fires a resize event.
    state.dpr = window.devicePixelRatio || 1;
    canvas.width = state.width * state.dpr;
    canvas.height = state.height * state.dpr;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    return true;
  }

  function resize() {
    applyResize();
    draw();
  }

  function scheduleResize() {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      applyResize();
      draw();
      resizeTimeout = null;
    }, 50);
  }

  // ---- Draw ----
  function draw() {
    const w = state.width;
    const h = state.height;

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#0a1424');
    grad.addColorStop(1, '#060b14');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Graticule, coastlines and terminator are all geography, so they are confined
    // to the map plate. Only the plate background fills the whole canvas, which is
    // what makes the margin read as surround. Clipping to the *transformed* rect
    // keeps the frame correct while panning and zoomed in.
    const plate = mapScreenRect();
    ctx.save();
    ctx.beginPath();
    ctx.rect(plate.x, plate.y, plate.w, plate.h);
    ctx.clip();

    ctx.strokeStyle = 'rgba(0, 212, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let lon = -180; lon <= 180; lon += 30) {
      const a = project(lon, 90);
      const b = project(lon, -90);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const a = project(-180, lat);
      const b = project(180, lat);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(0, 212, 255, 0.08)';
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.3)';
    ctx.lineWidth = 0.5;
    CONTINENTS.forEach(poly => {
      ctx.beginPath();
      poly.forEach((coord, i) => {
        const p = project(coord[0], coord[1]);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });

    ctx.restore();

    drawTerminator();

    // Milestones: draw each visible location once. A location holding several
    // milestones renders a single fan + count badge (or just the focused dot
    // when one of its members is pinned/hovered) instead of one copy per member.
    const todayISO = currentDayISO();
    // Re-group once per frame if the day rolled over. Doing it here rather than
    // relying on the loop below means a frame that filters out every milestone
    // still notices the new day instead of waiting for something to be visible.
    ensureStackMapFresh(todayISO);
    for (const ev of state.events) {
      if (ev._hiddenByTimeline) continue;
      if (state.filterRecent && !isInRolling7Days(ev.date, todayISO)) continue;
      const stackEvts = stackForEvent(ev, todayISO);
      if (stackEvts.length > 1) {
        // A focused member replaces the cluster so the pinned popup always has
        // its dot on screen; otherwise the first member draws it for everyone.
        const focused = stackEvts.find(m => m === state.selectedEvent || m === state.hoveredEvent);
        const lead = focused || stackEvts[0];
        if (lead !== ev) continue;
      }
      drawEvent(ev, stackEvts);
    }

    // Only draw military layers if filterMilitary is active
    if (state.filterMilitary) {
      if (state.showZones) {
        const visibleZones = state.zones.filter(z => !z._hiddenByTimeline);
        const zoneAutoScale = visibleZones.length > 20 ? Math.min(1, 20 / visibleZones.length) : 1;
        visibleZones.forEach(z => drawZone(z, zoneAutoScale));
      }
      if (state.showFleets) state.fleets.forEach(f => drawFleet(f));
      // Alliance & defence-policy dots: a sublayer of the same datalayer, so they
      // ride on the military filter exactly like the arrows do.
      if (state.showAllianceDots) state.allianceDots.forEach(d => drawAllianceDot(d));
    }

    // Only draw crisis zones if filterCrisis is active
    if (state.filterCrisis) {
      if (state.showCrises) {
        const visibleCrises = state.crises.filter(c => !c._hiddenByTimeline);
        const crisisAutoScale = visibleCrises.length > 20 ? Math.min(1, 20 / visibleCrises.length) : 1;
        visibleCrises.forEach(c => drawCrisis(c, crisisAutoScale));
      }
    }
    // Human Rights Violations: landmarks, not rings, and independent of the
    // military/crisis filters. Off by default like every operational layer.
    if (state.showHumanRights) {
      // Iterate clusters, not entries: one landmark per location, fanned when a
      // cluster holds more than one. Scaling is by distinct location, since that
      // is what determines how crowded the map looks.
      const rightsClusters = visibleHumanRightClusters();
      const rightsScale = rightsClusters.length > 30
        ? Math.min(1, 30 / rightsClusters.length) : 1;
      rightsClusters.forEach(group => drawHumanRightsLandmark(group[0], rightsScale, group));
    }
  }

  // Rounding to a fixed number of decimals is what makes two milestones a few
  // hundred metres apart count as "the same location" (campus/city clusters).
  // The coordinates never change after normalisation, so the key is memoised:
  // draw() runs ~10x/s and would otherwise re-round every event each frame.
  function stackKey(ev) {
    if (ev._stackKey === undefined) {
      const f = (n) => Number(n.toFixed(STACK_ROUND_DIGITS));
      ev._stackKey = `${f(ev.lat)},${f(ev.lon)}`;
    }
    return ev._stackKey;
  }

  function drawStack(px, py, count, color) {
    const r = 4;
    for (let i = 0; i < count; i++) {
      const ox = STACK_FAN_DX * (i - (count - 1) / 2);
      const oy = STACK_FAN_DY * (i - (count - 1) / 2);
      ctx.beginPath();
      ctx.arc(px + ox, py + oy, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    if (count > 1) {
      ctx.beginPath();
      ctx.arc(px, py, r + 1, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '7px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(count), px, py);
    }
  }

  let stackMap = null;
  let stackMapDay = null;

  // Group the milestones that share a location so they can be drawn as one
  // fanned marker with a count badge. Only milestones the visitor can actually
  // see belong in a group: hidden by the year slider, hidden by the category
  // legend, or outside the "this week" window are all excluded, which keeps the
  // badge, the pager and hit-testing in agreement with what is on screen.
  function rebuildStackMap(todayISO = currentDayISO()) {
    stackMap = new Map();
    stackMapDay = todayISO;
    for (const ev of state.events) {
      if (ev._hiddenByTimeline) continue;
      if (!isCategoryVisible(ev.category)) continue;
      if (state.filterRecent && !isInRolling7Days(ev.date, todayISO)) continue;
      const key = stackKey(ev);
      let group = stackMap.get(key);
      if (!group) { group = []; stackMap.set(key, group); }
      group.push(ev);
    }
  }

  // The "this week" window moves on its own, so the map has to notice the day
  // rolling over even when no filter is touched: a milestone that ages out must
  // leave its stack instead of lingering in the count badge and the pager, and
  // any popup pinned to it has to go with it. The explicit filter toggles and the
  // year slider already dismiss stale popups, but they never run on their own,
  // so the rollover is the only trigger that can leave a popup over empty canvas.
  // The caller may pass the day it already resolved this frame; recomputing it
  // here would allocate a Date per event per frame for a value we just built.
  function ensureStackMapFresh(todayISO = currentDayISO()) {
    if (stackMap && stackMapDay === todayISO) return;
    rebuildStackMap(todayISO);
    dismissTooltipIfTargetHidden();
  }

  function stackForEvent(ev, todayISO) {
    ensureStackMapFresh(todayISO);
    return stackMap.get(stackKey(ev)) || [];
  }

  // Draws one milestone marker. The caller has already decided which event owns
  // the location (see draw()), and passes that event's stack group along.
  function drawEvent(ev, stackEvts = stackForEvent(ev)) {
     // Skip if hidden by timeline filter
     if (ev._hiddenByTimeline) return;

     const isStackRepresentative = state.selectedEvent === ev || state.hoveredEvent === ev;

     if (stackEvts.length > 1 && !isStackRepresentative) {
       const p = project(ev.lon, ev.lat);
       const color = CATEGORY_COLORS[canonicalCategory(ev.category)] || '#00d4ff';
       ctx.save();
       ctx.globalAlpha = 0.8;
       drawStack(p.x, p.y, stackEvts.length, color);
       ctx.restore();
       ctx.save();
       ctx.globalAlpha = 0.5;
       ctx.strokeStyle = color + '80';
       ctx.lineWidth = 1.5;
       ctx.beginPath();
       // ev is the group's lead member, so its projection is the cluster centre.
       ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
       ctx.stroke();
       ctx.restore();
       return;
     }

     if (!isCategoryVisible(ev.category)) {
       const p = project(ev.lon, ev.lat);
       const color = CATEGORY_COLORS[canonicalCategory(ev.category)] || '#00d4ff';
       ctx.beginPath();
       ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
       ctx.fillStyle = color + '40';
       ctx.fill();
       return;
     }
     const p = project(ev.lon, ev.lat);
     const color = CATEGORY_COLORS[canonicalCategory(ev.category)] || '#00d4ff';
     const pulse = 0.5 + 0.5 * Math.sin((Date.now() / 1000 + ev.lon) * 2);
     const r = 4 + pulse * 2;

    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2, 0, Math.PI * 2);
    ctx.fillStyle = color + '20';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    if (state.hoveredEvent === ev || state.selectedEvent === ev) {
      const isSelected = state.selectedEvent === ev;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + (isSelected ? 5 : 4), 0, Math.PI * 2);
      ctx.strokeStyle = isSelected ? 'rgba(255,255,255,0.95)' : '#fff';
      ctx.lineWidth = isSelected ? 2 : 1.5;
      ctx.stroke();
    }
  }

  // A slowly rotating target reticle, drawn only around a `hot` zone (active and
  // recent). Four corner brackets plus a radial tick at each bracket's midpoint,
  // turning once every RETICLE_PERIOD_MS.
  //
  // Two decisions worth stating. It is drawn OUTSIDE the area ring, so it reads
  // as an instrument tracking the zone rather than as part of the zone's extent -
  // inside, a reticle would imply a radius the conflict does not have. And its
  // phase is offset by the zone's own longitude, so a map full of fresh zones
  // does not look like one machine sweeping in lockstep.
  function drawZoneReticle(p, radius, color, phaseOffset) {
    const r = Math.max(6, radius * RETICLE_SCALE);
    const angle = (Date.now() / RETICLE_PERIOD_MS) * Math.PI * 2 + phaseOffset;
    const bracket = Math.PI / 5;          // angular half-width of one bracket
    const inner = r * 0.82;               // bracket radial extent
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = withOpacity(color, 0.55);
    ctx.lineWidth = 1.1;
    ctx.lineCap = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 4;
    for (let i = 0; i < 4; i++) {
      const centre = angle + (i * Math.PI) / 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, centre - bracket, centre + bracket);
      ctx.stroke();
      // Radial tick at each bracket's midpoint, running back toward the ring.
      ctx.beginPath();
      ctx.moveTo(p.x + Math.cos(centre) * inner, p.y + Math.sin(centre) * inner);
      ctx.lineTo(p.x + Math.cos(centre) * r, p.y + Math.sin(centre) * r);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Area ring shared by conflict zones and crisis zones. Both were near-identical
  // ~90-line copies that had already drifted from each other (drawCrisis painted
  // its centre dot twice, and the two disagreed on the "stale" treatment), so the
  // tier ladder is applied here once and the callers only supply a colour.
  //
  // Only the `hot` tier glows. quiet / cold / done are progressively darker and
  // more desaturated, which is what makes an active-and-recent layer visually
  // distinct from a long-running or unverified one at a glance.
  function drawAreaRing(item, baseColor, autoScale) {
    const p = project(item.lon, item.lat);
    const degToPx = latDegToPx();
    const baseRadius = Math.max(4, (item.radiusDeg || 3) * degToPx * state.transform.scale * (autoScale || 1));
    const tier = layerPaintTier(item);
    const spec = LAYER_TIER_PAINT[tier];
    const color = spec.desat ? desaturateHex(baseColor, spec.desat) : baseColor;

    if (spec.glow) {
      // Neon halo, breathing. The only place 'lighter' compositing is used.
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 900 + item.lon);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = baseColor;
      ctx.shadowBlur = FLUO_GLOW_BLUR + FLUO_PULSE_RADIUS * pulse;
      ctx.beginPath();
      ctx.arc(p.x, p.y, baseRadius * 1.14, 0, Math.PI * 2);
      ctx.fillStyle = withOpacity(baseColor, spec.halo);
      ctx.fill();
      ctx.restore();
    }

    ctx.beginPath();
    ctx.arc(p.x, p.y, baseRadius, 0, Math.PI * 2);
    ctx.fillStyle = withOpacity(color, spec.fill);
    ctx.fill();

    ctx.save();
    if (spec.glow) {
      ctx.shadowColor = baseColor;
      ctx.shadowBlur = FLUO_LINE_GLOW_BLUR;
    }
    ctx.setLineDash([4, 3]);
    // Marching dash is the "live" cue, so it is reserved for the hot tier.
    if (spec.pulse) ctx.lineDashOffset = -Date.now() / 40;
    ctx.lineWidth = spec.line;
    ctx.strokeStyle = withOpacity(color, spec.stroke);
    ctx.beginPath();
    ctx.arc(p.x, p.y, baseRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Centre marker, sized down with the tier so a cold zone does not read as a
    // live point.
    const centerR = tier === TIER_HOT ? 3 : 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, centerR, 0, Math.PI * 2);
    ctx.fillStyle = tier === TIER_HOT ? color : withOpacity(color, LAYER_TIER_CENTER_ALPHA[tier]);
    ctx.fill();

    // Tracking reticle, last so it sits over the ring, and only for `hot`: the
    // reticle IS the "this is live right now" signal, so giving it to the dimmed
    // tiers would destroy the ladder it is supposed to reinforce.
    if (tier === TIER_HOT) {
      drawZoneReticle(p, baseRadius, baseColor, (item.lon || 0) * 0.21);
    }
  }

  // Conflict zone: area ring in the conflict palette (red/pink). Only zones
  // sourced from something stronger than Wikipedia's conflict list reach the neon
  // "hot" treatment - see isSingleListSourced().
  function drawZone(zone, zoneAutoScale) {
    if (!state.showZones) return;
    if (zone._hiddenByTimeline) return;
    drawAreaRing(zone, ZONE_COLOR, zoneAutoScale);
  }

  // Crisis zone (humanitarian): same ladder in the crisis palette (purple), which
  // is what separates it from conflict zones at a glance.
  function drawCrisis(crisis, crisisAutoScale) {
    if (!state.showCrises) return;
    if (crisis._hiddenByTimeline) return;
    drawAreaRing(crisis, CRISIS_COLOR, crisisAutoScale);
  }

  // A reported violation is a point occurrence, so these draw as landmarks rather
  // than an area ring: a ring would imply an affected extent we do not have.
  //
  // ---- Human Rights landmark clustering -------------------------------------
  // Two reports about the same country geocode to the same country centroid, so
  // the layer drew them on top of each other at one pixel and the legend count
  // disagreed with what was visible: five entries, four dots, one of them
  // invisible. Milestones already solve this with stackKey/drawStack, so the
  // landmarks now group the same way and fan apart instead of overplotting.
  //
  // Deliberately looser than STACK_ROUND_DIGITS (4): these coordinates are country
  // centroids reused verbatim from the fetcher's lookup table, so identical values
  // mean "same country", and the tolerance only needs to absorb float noise.
  const HUMAN_RIGHTS_STACK_DIGITS = 1;
  let humanRightStackMap = new Map();

  function humanRightStackKey(h) {
    if (h._hrStackKey) return h._hrStackKey;
    const f = (n) => Number(n.toFixed(HUMAN_RIGHTS_STACK_DIGITS));
    h._hrStackKey = f(h.lat) + ',' + f(h.lon);
    return h._hrStackKey;
  }

  function rebuildHumanRightStackMap() {
    humanRightStackMap = new Map();
    for (const h of state.humanRights) {
      const k = humanRightStackKey(h);
      const group = humanRightStackMap.get(k);
      if (group) group.push(h); else humanRightStackMap.set(k, [h]);
    }
    return humanRightStackMap;
  }

  function humanRightStackFor(h) {
    return humanRightStackMap.get(humanRightStackKey(h)) || [h];
  }

  // How many visible reports this landmark stands for. Several reports can share
  // one country centroid, in which case the marker is a fan and the tooltip has to
  // say so. Derived on demand rather than cached on the entry: findHumanRight used
  // to write this onto the object it returned, which meant the count was a property
  // of "the last hit" rather than of the landmark, and any caller that built a
  // tooltip from an entry the hit test had not just touched would show a stale
  // number.
  function humanRightClusterSize(h) {
    if (!h) return 0;
    return humanRightStackFor(h).filter(e => !e._hiddenByTimeline).length;
  }

  // Timeline-filtered clusters, so a cluster never mixes hidden and shown members.
  function visibleHumanRightClusters() {
    const out = [];
    for (const group of humanRightStackMap.values()) {
      const shown = group.filter(h => !h._hiddenByTimeline);
      if (shown.length) out.push(shown);
    }
    return out;
  }

  // Landmarks pulse with a soft glow so the layer reads as live rather than as
  // another set of static dots. The pulse is a function of wall-clock time only -
  // no per-entry state - so it cannot desynchronise, and it costs nothing when the
  // layer is off because drawHumanRightsLandmark returns immediately.
  function drawHumanRightsLandmark(entry, autoScale, cluster) {
    if (!state.showHumanRights) return;
    if (entry._hiddenByTimeline) return;
    const p = project(entry.lon, entry.lat);
    if (!p) return;
    const done = entry.status && entry.status !== 'active' && entry.status !== 'ongoing';
    const base = Math.max(
      HUMAN_RIGHTS_CORE_MIN,
      Math.min(HUMAN_RIGHTS_CORE_MAX, (done ? HUMAN_RIGHTS_CORE_DONE : HUMAN_RIGHTS_CORE_ACTIVE) * autoScale)
    );
    const alpha = done ? 0.35 : 0.85;

    // Ease the pulse with a raised cosine so it swells and fades rather than
    // stepping. Stagger by longitude so neighbouring landmarks do not breathe in
    // lockstep, which reads as a single blinking blob rather than several.
    const phase = (Date.now() / HUMAN_RIGHTS_PULSE_MS
                   + (entry.lon + 180) / 360) % 1;
    const pulse = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);

    // Painted as an orb in three passes - halo, breathing shell, core - which is the
    // language the milestone landmarks already use, so the two layers read as one
    // system instead of one being a plain dot and the other a smudge.
    //
    // Everything stays inside HUMAN_RIGHTS_CORE_MAX * (GLOW_INNER + GLOW_PULSE),
    // because that product is what HUMAN_RIGHTS_HIT_RADIUS is derived from: paint
    // outside it and the hit test no longer covers what is drawn.
    const maxR = HUMAN_RIGHTS_CORE_MAX * (HUMAN_RIGHTS_GLOW_INNER + HUMAN_RIGHTS_GLOW_PULSE);

    // 1. Halo. A wide, very soft wash that gives the orb a presence on the map
    //    without competing with the coastline underneath it.
    const haloR = base * (HUMAN_RIGHTS_GLOW_INNER + HUMAN_RIGHTS_GLOW_PULSE) * 0.55;
    const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(haloR, 1));
    halo.addColorStop(0, withOpacity(HUMAN_RIGHTS_COLOR,
      (done ? 0.16 : 0.42) * (1 - pulse * 0.45)));
    halo.addColorStop(0.55, withOpacity(HUMAN_RIGHTS_COLOR,
      (done ? 0.06 : 0.14) * (1 - pulse * 0.45)));
    halo.addColorStop(1, withOpacity(HUMAN_RIGHTS_COLOR, 0));
    ctx.beginPath();
    ctx.arc(p.x, p.y, haloR, 0, Math.PI * 2);
    ctx.fillStyle = halo;
    ctx.fill();

    // 2. Breathing shell. A crisp ring that expands and fades on its own cycle,
    //    slightly out of phase with the core so the orb never looks like a single
    //    uniform scale. Staggered by longitude upstream, so neighbouring landmarks
    //    do not breathe in lockstep.
    const shellPhase = (pulse + 0.35) % 1;
    const shellR = base * (1.25 + shellPhase * 1.15);
    if (shellR <= maxR) {
      ctx.save();
      ctx.globalAlpha = alpha * (1 - shellPhase) * 0.7;
      ctx.strokeStyle = HUMAN_RIGHTS_COLOR;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, shellR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 3. Core. Bright and small, with a soft inner falloff so it reads as a lit
    //    sphere rather than a flat disc.
    const core = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, base);
    core.addColorStop(0, withOpacity('#ffffff', done ? 0.55 : 0.95));
    core.addColorStop(0.35, withOpacity(HUMAN_RIGHTS_COLOR, done ? 0.5 : 0.95));
    core.addColorStop(1, withOpacity(HUMAN_RIGHTS_COLOR, done ? 0.1 : 0.35));
    ctx.beginPath();
    ctx.arc(p.x, p.y, base * (1 + pulse * 0.12), 0, Math.PI * 2);
    ctx.fillStyle = core;
    ctx.fill();

    // A single specular highlight, offset up-left, which is what makes a flat circle
    // read as a sphere. Cheap: one small filled arc.
    if (!done) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x - base * 0.3, p.y - base * 0.3, base * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Selected landmark: a bright ring, matching how a pinned milestone reads, so
    // it is obvious the popup is docked here rather than merely hovered.
    if (state.selectedHumanRight === entry) {
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, base + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Cluster fan. Without this the extra reports were not merely unlabelled, they
    // were literally invisible underneath the first one at the same pixel.
    if (cluster && cluster.length > 1) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      drawStack(p.x, p.y, cluster.length, HUMAN_RIGHTS_COLOR);
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = withOpacity(HUMAN_RIGHTS_COLOR, 0.8);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, base + 2.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // The fanned markers sit a few pixels outboard of the glow, so label them
      // separately - otherwise the count is unreadable against the map.
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = 3;
      ctx.fillText(String(cluster.length), p.x + 11, p.y - 11);
      ctx.restore();
    }

    // Solid core, breathing slightly with the glow.
    const radius = base * (0.86 + pulse * 0.24);
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = withOpacity(HUMAN_RIGHTS_COLOR, alpha);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = withOpacity('#ffffff', done ? 0.3 : 0.45 + pulse * 0.3);
    ctx.stroke();
  }

  // Single source of truth for a tracked movement's drawn endpoints.
  // drawFleet synthesized an infantry tail from `direction` inline while
  // findDeployment read fleet.from/fleet.to — which infantry entries do not have
  // at all. Hovering a map that contained one therefore threw inside the
  // mousemove handler, which killed hover for every layer (events, zones,
  // deployments and crises alike), not just the arrow under the cursor. Both
  // sides derive from here now, so the hit target always matches the pixels.
  function isInfantryKind(fleet) {
    const k = fleet && fleet.kind;
    return k === 'infantry' || k === 'mobilization' || k === 'deployment' || k === 'rotation';
  }

  // Geographic endpoints for a movement, in lon/lat. Returns null when the pair
  // is unusable so callers can skip rather than draw a degenerate arrow.
  //
  // Memoized on the entry for the same reason stackKey() is: draw() runs ~10x/s
  // and findDeployment() runs on every mousemove, so recomputing (and
  // re-allocating) the infantry pair per call per frame is pure garbage
  // collection pressure. normalizeFleet() is the only producer and it never
  // mutates a movement afterwards, so the cache cannot go stale.
  function fleetEndpoints(fleet) {
    if (fleet._ends !== undefined) return fleet._ends;
    fleet._ends = computeFleetEndpoints(fleet);
    return fleet._ends;
  }

  function computeFleetEndpoints(fleet) {
    if (!isInfantryKind(fleet)) {
      if (!isLocatedCoord(fleet?.from) || !isLocatedCoord(fleet?.to)) return null;
      // Reuse the payload objects rather than wrapping them: these are read-only.
      return { from: fleet.from, to: fleet.to };
    }
    const destLon = fleet.lon;
    const destLat = fleet.lat;
    let fromLon = destLon;
    let fromLat = destLat;
    const dir = fleet.direction ? String(fleet.direction).toLowerCase() : 'global';

    // A ground deployment is a point plus a compass heading, so the tail is
    // synthesized 5 degrees BEHIND the destination and the arrowhead lands on the
    // destination. "Behind" means the opposite of travel, hence every offset is
    // the negation of the direction: north travels to higher latitude, so its tail
    // sits at a lower one.
    //
    // This was previously signed the other way for the latitude cases only - east
    // and west were right, north and south were inverted, so a deployment tagged
    // "Heading: North" drew an arrowhead pointing south. Expressing all four as one
    // table keeps the symmetry obvious and stops the halves drifting apart again.
    const TAIL_OFFSET_DEG = 5;
    const BACK_OFFSETS = {
      east: [-TAIL_OFFSET_DEG, 0],   // travel +lon, so tail is west of it
      west: [TAIL_OFFSET_DEG, 0],
      north: [0, -TAIL_OFFSET_DEG],  // travel +lat, so tail is south of it
      south: [0, TAIL_OFFSET_DEG],
    };
    const offset = BACK_OFFSETS[dir];
    if (offset) {
      fromLon = destLon + offset[0];
      fromLat = destLat + offset[1];
    } else {
      // Global/no direction: deterministic offset based on fleet properties.
      const seed = (destLon * 7 + destLat * 13) % 6;
      fromLon = destLon - 3 + seed;
      fromLat = destLat - 3 + ((seed * 2) % 6);
    }
    return { from: { lat: fromLat, lon: fromLon }, to: { lat: destLat, lon: destLon } };
  }

  // Tracked deployment: solid colored vector from origin to destination with a
  // solid arrowhead indicating direction of travel. Ground/troop movements render
  // distinct amber, naval/fleet movements solid blue — never dashed or dotted, and
  // the arrowhead matches the line colour. The arrow tail is deliberately faint.
  // Recency uses the same ladder as the area rings: only a hot (active + recent)
  // movement glows, so a long-quiet fleet movement reads as background.
  // Movements outside the timeline year are skipped.
  function drawFleet(fleet) {
    if (!state.showFleets) return;
    if (fleet._hiddenByTimeline) return;
    // Superseded by a policy seal of the same id - see findAllianceDot.
    if (state.allianceDotIds && state.allianceDotIds.has(fleet.id)) return;

    const isInfantry = isInfantryKind(fleet);
    const isGround = fleet.kind === 'ground';

    const ends = fleetEndpoints(fleet);
    if (!ends) return;
    const a = project(ends.from.lon, ends.from.lat);
    const b = project(ends.to.lon, ends.to.lat);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    const ang = Math.atan2(dy, dx);
    const headLen = 8;

    const tier = layerPaintTier(fleet);
    const spec = LAYER_TIER_PAINT[tier];
    const arrow = LAYER_TIER_ARROW[tier];
    const base = isInfantry || isGround ? GROUND_COLOR : FLEET_COLOR;
    const color = spec.desat ? desaturateHex(base, spec.desat) : base;

    // Tail: a faint memory of the route, brightening into a luminous second pass
    // only for hot movements.
    ctx.save();
    ctx.strokeStyle = withOpacity(color, ARROW_TAIL_OPACITY * arrow.tail);
    ctx.lineWidth = arrow.line * 0.55;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (spec.glow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = FLUO_LINE_GLOW_BLUR;
      ctx.strokeStyle = withOpacity(color, 0.3);
      ctx.lineWidth = arrow.line;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();

    // Arrowhead. Only hot heads breathe and glow; every other tier is desaturated
    // as well as dimmed so the state does not rely on alpha alone.
    ctx.save();
    if (tier === TIER_HOT) {
      ctx.shadowColor = color;
      ctx.shadowBlur = FLUO_LINE_GLOW_BLUR + 5 * (0.5 + 0.5 * Math.sin(Date.now() / 650 + a.x));
    }
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - headLen * Math.cos(ang - 0.4), b.y - headLen * Math.sin(ang - 0.4));
    ctx.lineTo(b.x - headLen * Math.cos(ang + 0.4), b.y - headLen * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fillStyle = tier === TIER_HOT ? color : withOpacity(color, arrow.head);
    ctx.fill();
    ctx.restore();
  }

  // Alliance / defence-policy dot. A point event with an organisation attached,
  // so it renders as a small square-in-ring "seal" rather than an arrow or an
  // area: there is no route and no extent. Same tier ladder as everything else,
  // so a 2023 accession has visibly faded while a 2024 one is still lit.
  function drawAllianceDot(dot) {
    if (!state.showAllianceDots) return;
    if (dot._hiddenByTimeline) return;

    const p = project(dot.lon, dot.lat);
    const tier = layerPaintTier(dot);
    const spec = LAYER_TIER_PAINT[tier];
    const color = spec.desat ? desaturateHex(ALLIANCE_DOT_COLOR, spec.desat) : ALLIANCE_DOT_COLOR;
    const r = Math.max(4, (dot.radiusDeg || 0.9) * latDegToPx() * state.transform.scale);

    if (spec.glow) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 900 + (dot.lon || 0));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = ALLIANCE_DOT_COLOR;
      ctx.shadowBlur = FLUO_GLOW_BLUR + FLUO_PULSE_RADIUS * pulse;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = withOpacity(ALLIANCE_DOT_COLOR, spec.halo);
      ctx.fill();
      ctx.restore();
    }

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = withOpacity(color, spec.fill);
    ctx.fill();

    ctx.save();
    if (spec.glow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = FLUO_LINE_GLOW_BLUR;
    }
    ctx.lineWidth = spec.line * 0.8;
    ctx.strokeStyle = withOpacity(color, spec.stroke);
    ctx.stroke();
    ctx.restore();

    // A square core reads as a seal/marker and is what distinguishes a dot from
    // the milestone dots, which are circles. Hot only: a dimmed policy change
    // should not compete with the landmark next to it.
    if (tier === TIER_HOT) {
      const s = Math.max(2, r * 0.42);
      ctx.fillStyle = color;
      ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
      drawZoneReticle(p, r, ALLIANCE_DOT_COLOR, (dot.lon || 0) * 0.21);
    }
  }

  // Coalesce high-frequency redraws (wheel zoom, drag pan) into a single draw
  // per animation frame instead of one full synchronous draw per input event.
  let drawRequested = false;
  let scheduledDrawId = null;
  function requestDraw() {
    if (drawRequested) return;
    drawRequested = true;
    scheduledDrawId = requestAnimationFrame(() => {
      drawRequested = false;
      scheduledDrawId = null;
      draw();
    });
  }

  // ---- Hit-test ----
  function findEvent(px, py) {
    const hitRadius = HIT_RADIUS_BASE / state.transform.scale;
    const hitRadiusSq = hitRadius * hitRadius;
    const todayISO = currentDayISO();
    for (let i = state.events.length - 1; i >= 0; i--) {
      const ev = state.events[i];
      if (ev._hiddenByTimeline) continue;
      if (!isCategoryVisible(ev.category)) continue;
      // If filterRecent is active, skip events outside the 7-day window
      if (state.filterRecent && !isInRolling7Days(ev.date, todayISO)) continue;
      const p = project(ev.lon, ev.lat);
      const dx = p.x - px;
      const dy = p.y - py;
      if (dx * dx + dy * dy < hitRadiusSq) return ev;
    }
    return null;
  }

  // Radius within which a nearby-but-different landmark is treated as visually
  // confusable with the anchor rather than as a move to a new subject. Scaled with
  // zoom so it stays a constant apparent distance on screen. Roughly twice the hit
  // radius: enough to bridge the gap between a small dot and the tooltip, too small
  // to swallow an adjacent landmark.
  const PROXIMITY_RADIUS = 56;

  // Is a landmark still drawable? One predicate for every layer type, so the
  // proximity guard and the popup-dismissal guard can never disagree about
  // whether an anchor is real. Milestones answer with the milestone filters,
  // operational layers with their own switch, landmarks with their own.
  function anchorIsVisible(anchor) {
    if (!anchor || !anchor.entry) return false;
    const type = anchor.type;
    if (type === 'event') return !eventIsHidden(anchor.entry);
    if (type === 'human_rights') return !humanRightIsHidden(anchor.entry);
    if (type === 'zone' || type === 'deployment' || type === 'crisis' || type === 'alliance') {
      return !layerIsHidden(anchor.entry, type);
    }
    return false;
  }

  function isNearAnchor(px, py, anchor) {
    // No anchor supplied: fall back to whatever the popup is currently describing,
    // pinned first. Every caller passes one explicitly, but the fallback keeps the
    // single-argument form - used by the test suite - meaningful.
    const a = anchor || pinnedAnchor() || hoverAnchor();
    if (!a || !anchorIsVisible(a)) return false;
    // The anchor point, not the entry: a movement arrow's own lat/lon are
    // undefined, so reading them here made every arrow "unreachable" to the
    // proximity guard - which is why hovering a second arrow while one was open
    // snapped the popup shut.
    const point = landmarkAnchorPoint(a.entry);
    if (!point) return false;
    const p = project(point.lon, point.lat);
    if (!p) return false;
    const r = PROXIMITY_RADIUS / state.transform.scale;
    const dx = p.x - px;
    const dy = p.y - py;
    return dx * dx + dy * dy < r * r;
  }

  // Whether two milestones render as one co-located cluster, i.e. share a stack
  // position. Stepping between members must take over the tooltip; stepping
  // between two merely-adjacent dots must not.
  function sameLocationCluster(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.lon == null || a.lat == null || b.lon == null || b.lat == null) return false;
    return stackKey(a) === stackKey(b);
  }

  function findZone(px, py) {
    if (!state.showZones) return null;
    const hitRadius = HIT_RADIUS_BASE / state.transform.scale;
    const hitRadiusSq = hitRadius * hitRadius;
    for (let i = state.zones.length - 1; i >= 0; i--) {
      const zone = state.zones[i];
      if (zone._hiddenByTimeline) continue;
      const p = project(zone.lon, zone.lat);
      const dx = p.x - px;
      const dy = p.y - py;
      if (dx * dx + dy * dy < hitRadiusSq) return zone;
    }
    return null;
  }

  function findDeployment(px, py) {
    if (!state.showFleets) return null;
    // Check if mouse is near any deployment arrow (distance to line segment)
    const hitDist = 8 / state.transform.scale; // threshold in map coordinates
    const hitDistSq = hitDist * hitDist;
    for (let i = state.fleets.length - 1; i >= 0; i--) {
      const fleet = state.fleets[i];
      if (fleet._hiddenByTimeline) continue;
      // Superseded by a policy seal of the same id - see drawFleet.
      if (state.allianceDotIds && state.allianceDotIds.has(fleet.id)) continue;
      // Same endpoint derivation the renderer uses, so infantry arrows (which
      // carry lat/lon + direction, not from/to) are hittable and the hit target
      // lines up with the pixels that were actually drawn.
      const ends = fleetEndpoints(fleet);
      if (!ends) continue;
      const a = project(ends.from.lon, ends.from.lat);
      const b = project(ends.to.lon, ends.to.lat);
      // Distance from point to line segment
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lenSq));
      const closestX = a.x + t * dx;
      const closestY = a.y + t * dy;
      const distSq = (px - closestX) ** 2 + (py - closestY) ** 2;
      if (distSq < hitDistSq) return fleet;
    }
    return null;
  }

  // Crisis zone hit-test: check if mouse is near crisis zone center
  function findCrisis(px, py) {
    if (!state.showCrises) return null;
    const hitRadius = HIT_RADIUS_BASE / state.transform.scale;
    const hitRadiusSq = hitRadius * hitRadius;
    for (let i = state.crises.length - 1; i >= 0; i--) {
      const crisis = state.crises[i];
      if (crisis._hiddenByTimeline) continue;
      const p = project(crisis.lon, crisis.lat);
      const dx = p.x - px;
      const dy = p.y - py;
      if (dx * dx + dy * dy < hitRadiusSq) return crisis;
    }
    return null;
  }

  // Landmark hit test for the Human Rights Violations layer. Only participates when
  // the layer is on: an invisible layer must not steal hover from a milestone.
  function findHumanRight(px, py) {
    if (!state.showHumanRights) return null;
    // Derived from the widest painted landmark, not a separate magic number.
    const hitRadius = HUMAN_RIGHTS_HIT_RADIUS;
    const hitRadiusSq = hitRadius * hitRadius;
    // Walk clusters so a fan of several reports is one target and the returned
    // entry is always the lead, which owns the projected centre.
    let best = null;
    let bestDist = Infinity;
    for (const group of visibleHumanRightClusters()) {
      const lead = group[0];
      const p = project(lead.lon, lead.lat);
      if (!p) continue;
      const dx = p.x - px;
      const dy = p.y - py;
      const dist = dx * dx + dy * dy;
      if (dist < hitRadiusSq && dist < bestDist) {
        bestDist = dist;
        best = lead;
      }
    }
    return best;
  }

  // Alliance-dot hit test. Derived from the same numbers drawAllianceDot uses, so
  // the clickable area is the painted mark and not a separate guess.
  //
  // A movement that has been promoted to a policy seal (Finland and Sweden's
  // NATO accessions) is deliberately invisible here: the seal replaces the arrow
  // rather than sitting on top of it, so the map never shows the same fact twice
  // and the hover target is not split in half between two marks at one pixel.
  function findAllianceDot(px, py) {
    if (!state.showAllianceDots) return null;
    const hitRadius = ALLIANCE_DOT_HIT_RADIUS / state.transform.scale;
    const hitRadiusSq = hitRadius * hitRadius;
    for (let i = state.allianceDots.length - 1; i >= 0; i--) {
      const dot = state.allianceDots[i];
      if (dot._hiddenByTimeline) continue;
      const p = project(dot.lon, dot.lat);
      const dx = p.x - px;
      const dy = p.y - py;
      if (dx * dx + dy * dy < hitRadiusSq) return dot;
    }
    return null;
  }

  // Landmarks are the one layer that pins; zones, deployments and crisis rings were
  // hover-only, so their tooltips vanished the moment the pointer moved and the source
  // link inside them could never be clicked. Same treatment as a milestone now.
  //
  // One finder for all four so the pin/unpin path does not have to know which
  // layer it was, and so the precedence matches the hover order above it.
  function findLayerAt(x, y) {
    const dot = findAllianceDot(x, y);
    if (dot) return { entry: dot, type: 'alliance' };
    const zone = findZone(x, y);
    if (zone) return { entry: zone, type: 'zone' };
    const deploy = findDeployment(x, y);
    if (deploy) return { entry: deploy, type: 'deployment' };
    const crisis = findCrisis(x, y);
    if (crisis) return { entry: crisis, type: 'crisis' };
    return null;
  }

  // The point a landmark is *about* - where its popup docks and how far the
// proximity guard reaches.
//
// This exists because a movement arrow has no single coordinate. A fleet entry
// carries `from`/`to` and a ground entry lat/lon + a heading; neither has a
// top-level `lat`/`lon` for a fleet. Reading one anyway produced undefined,
// which is what made "click an arrow to pin it" silently do nothing: the popup
// opened on hover and could never be pinned, so its source link was as
// unreachable as the hover-only layers were before they were fixed. The
// destination is the anchor because that is where the arrowhead - the end the
// reader is aiming at - is drawn.
function landmarkAnchorPoint(entry) {
    if (!entry) return null;
    if (hasPlottableCoords(entry.lat, entry.lon)) return entry;
    const ends = fleetEndpoints(entry);
    if (ends && hasPlottableCoords(ends.to.lat, ends.to.lon)) return ends.to;
    return null;
  }

  // Draw the layer's popup docked at the marker rather than under the cursor.
  function pinTooltipToLayer(entry, type) {
    if (!tooltip || !entry) return;
    // Validate rather than default. Coercing a missing coordinate to 0 would pin the
    // popup over null island, which check_data.py rejects as bad data everywhere
    // else - the one path that invents the coordinate is the path that must not
    // have it. A layer entry missing a coordinate is also unpinnable, so refusing
    // matches what the hit test would already have done.
    const anchor = landmarkAnchorPoint(entry);
    if (!anchor) return;
    const p = project(anchor.lon, anchor.lat);
    if (!p) return;
    if (type === 'zone') showZoneTooltip(entry, p.x, p.y);
    else if (type === 'deployment') showDeploymentTooltip(entry, p.x, p.y);
    else if (type === 'crisis') showCrisisTooltip(entry, p.x, p.y);
    else if (type === 'alliance') showAllianceDotTooltip(entry, p.x, p.y);
  }

  // Is the pinned layer still drawable? Switching its layer off, or filtering it
  // away, has to release the popup rather than leave it floating over a map it no
  // longer describes.
  function layerIsHidden(entry, type) {
    if (!entry) return true;
    // The timeline counts. Without this the popup's anchor test could call a
    // 2024 accession "visible" while the slider sat in 2015 and the seal was not
    // being drawn - the milestone path always checked _hiddenByTimeline and the
    // layer path did not, so moving the slider left a popup describing a mark
    // that was no longer on screen.
    if (entry._hiddenByTimeline) return true;
    if (type === 'zone') return !state.showZones || !state.filterMilitary;
    if (type === 'deployment') return !state.showFleets || !state.filterMilitary;
    if (type === 'crisis') return !state.showCrises || !state.filterCrisis;
    if (type === 'alliance') return !state.showAllianceDots || !state.filterMilitary;
    return true;
  }

// ---- Tooltip anchor model -------------------------------------------------
  // One anchor concept for every landmark type, because the previous three
  // near-identical branches (pinned milestone / pinned layer / pinned landmark)
  // disagreed in three ways a user notices immediately:
  //
  //   * a pinned layer could not be handed over by a milestone, and a pinned
  //     landmark could not be handed over by anything at all;
  //   * a hover-anchored popup died the moment the pointer left the landmark,
  //     so travelling onto the popup to click "View source" was impossible
  //     without first clicking to pin;
  //   * "sticky" meant two different things for milestones and for layers.
  //
  // Now: `pinnedAnchor()` is what a click committed to, `hoverAnchor()` is what
  // the pointer is currently resting on (or has just travelled onto the popup
  // of), and a handover from a pinned popup stays pinned. That single rule is
  // what makes "only disappears when hovering another active landmark" true for
  // every layer instead of just milestones.
  function pinnedAnchor() {
    if (state.selectedEvent) return { entry: state.selectedEvent, type: 'event' };
    if (state.selectedLayer) return { entry: state.selectedLayer, type: state.selectedLayerType };
    if (state.selectedHumanRight) return { entry: state.selectedHumanRight, type: 'human_rights' };
    return null;
  }

  function hoverAnchor() {
    if (state.hoverAnchor) return { entry: state.hoverAnchor, type: state.hoverAnchorType };
    return null;
  }

  // Record what the popup currently describes. Milestones are mirrored into
  // hoveredEvent/hoveredType because the renderer and the dismissal checks read
  // those directly; every other type lives only in the generic pair, so the two
  // can never disagree about which dot is lit.
  function setHoverAnchor(entry, type) {
    state.hoverAnchor = entry || null;
    state.hoverAnchorType = entry ? type : null;
    if (type === 'event') {
      state.hoveredEvent = entry;
      state.hoveredType = type;
    } else {
      state.hoveredEvent = null;
      state.hoveredType = type || null;
    }
  }

// Everything hoverable, in one precedence order.
//
// Alliance seals are tested FIRST, which is a deliberate exception to the
// milestone-first rule below. A seal is placed at a capital city, and capital
// cities are exactly where milestones cluster: Helsinki already carries the
// "Estonia suffers a coordinated cyberattack" landmark within 70 km, so a
// milestone-first test made the Finland accession unpinnable at its own pixel.
// The seal is also the physically larger mark (ring plus reticle against a
// filled dot), so giving it its own pixels is consistent with "the mark you are
// pointing at wins". The exemption is narrow: only inside the seal's own hit
// radius, so a milestone one dot-width away is still perfectly hittable.
//
// Milestones then win over the area layers, so a milestone sitting on a conflict
// ring stays reachable.
function findLandmarkAt(x, y) {
    const seal = findAllianceDot(x, y);
    if (seal) return { entry: seal, type: 'alliance' };
    const ev = findEvent(x, y);
    if (ev) return { entry: ev, type: 'event' };
    const layer = findLayerAt(x, y);
    if (layer) return layer;
    const rights = findHumanRight(x, y);
    if (rights) return { entry: rights, type: 'human_rights' };
    return null;
  }

  // Show the popup for one landmark. `pinned` docks it at the marker's own
  // projected position so it stops chasing the cursor; otherwise it follows the
  // pointer, which is what a hover popup should do.
  function dockTooltipTo(entry, type, x, y, pinned) {
    if (!tooltip || !entry) return;
    const at = () => {
      if (pinned) {
        const p = project(entry.lon, entry.lat);
        if (p) { x = p.x; y = p.y; }
      }
      switch (type) {
        case 'zone': return moveZoneTooltip(x, y);
        case 'deployment': return moveDeploymentTooltip(x, y);
        case 'crisis': return moveCrisisTooltip(x, y);
        case 'alliance': return moveAllianceDotTooltip(x, y);
        case 'human_rights': return moveHumanRightsTooltip(x, y);
        default: return moveTooltip(x, y);
      }
    };
    switch (type) {
      case 'zone': return showZoneTooltip(entry, x, y);
      case 'deployment': return showDeploymentTooltip(entry, x, y);
      case 'crisis': return showCrisisTooltip(entry, x, y);
      case 'alliance': return showAllianceDotTooltip(entry, x, y);
      case 'human_rights': return showHumanRightsTooltip(entry, x, y);
      default: return showTooltip(entry, x, y);
    }
  }

  // Move the popup to a different landmark. `keepPinned` decides whether the new
  // landmark inherits stickiness: a handover from a pinned popup keeps it (the
  // pointer is about to travel to the new popup and must find it still open),
  // while a handover from a plain hover does not.
  function handOverTo(hit, keepPinned) {
    state.selectedEvent = null;
    state.selectedHumanRight = null;
    state.selectedLayer = null;
    state.selectedLayerType = null;
    if (keepPinned) {
      if (hit.type === 'event') state.selectedEvent = hit.entry;
      else if (hit.type === 'human_rights') state.selectedHumanRight = hit.entry;
      else { state.selectedLayer = hit.entry; state.selectedLayerType = hit.type; }
      markTooltipSticky(true);
    }
    setHoverAnchor(hit.entry, hit.type);
    if (hit.type === 'event') {
      pinTooltipToEvent(hit.entry);
    } else if (hit.type === 'human_rights') {
      pinTooltipToHumanRight(hit.entry);
    } else {
      pinTooltipToLayer(hit.entry, hit.type);
    }
    if (!keepPinned) {
      // Not pinned: the popup still tracks the pointer. Re-anchor it to the
      // marker's projection so the first move after the handover does not snap.
      dockTooltipTo(hit.entry, hit.type, state.lastPointerX, state.lastPointerY, false);
    }
  }

  // ---- Tooltip hover handlers ----
  // Pointer entered the popup. The popup stays anchored to its landmark, which is
  // the whole point: from here the visitor can read it and click its links
  // without ever having pinned anything.
  function handleTooltipMouseEnter() {
    state.tooltipHover = true;
  }

  function handleTooltipMouseLeave() {
    state.tooltipHover = false;
    // Leaving the popup is not leaving the subject. A hover-anchored popup keeps
    // its content while the pointer is away, and the next canvas mousemove
    // re-arbitrates it: staying put if the pointer is still near the landmark,
    // handing over or closing if it has genuinely travelled on.
    if (pinnedAnchor()) return;
    draw();
  }

  // ---- Mouse ----
  canvas.addEventListener('mousemove', handleMouseMove);
  function handleMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    state.lastPointerX = x;
    state.lastPointerY = y;

    if (state.isDragging) {
      state.transform.tx += e.movementX;
      state.transform.ty += e.movementY;
      // Once the press has clearly turned into a pan, drop the popup so it does
      // not float over the map mid-drag. The selection itself is kept until
      // mouseup, so a press that settles within the click threshold still
      // toggles/pins instead of being swallowed by the drag.
      if (state.pressX !== null && state.pressY !== null &&
          Math.hypot(x - state.pressX, y - state.pressY) > CLICK_DRAG_THRESHOLD) {
        hideTooltip();
      }
      requestDraw();
      return;
    }

    const hit = findLandmarkAt(x, y);
    canvas.style.cursor = hit ? 'pointer' : 'grab';

    // --- A landmark is pinned -------------------------------------------------
    // The popup is persistent: moving away over empty ocean, or across the map,
    // never closes it. It only moves when the pointer arrives at a *different*
    // landmark, and even then only once the pointer is unambiguously elsewhere -
    // inside the proximity radius the two marks are visually confusable, and
    // swapping on the way past makes both unreadable.
    const pinned = pinnedAnchor();
    if (pinned) {
      if (!hit) return;                                   // travelling away: hold
      if (hit.entry === pinned.entry && hit.type === pinned.type) {
        state.hoveredEvent = hit.type === 'event' ? hit.entry : null;
        state.hoveredType = hit.type;
        // A popup can be hidden while still pinned (a filter took the landmark
        // off, the popup was re-rendered under the cursor). Put it back.
        if (tooltip && !tooltip.classList.contains('visible')) {
          handOverTo(hit, true);
          draw();
        }
        return;
      }
      if (isNearAnchor(x, y, pinned)) return;             // nearby: hold
      handOverTo(hit, true);                              // far: hand over, still pinned
      draw();
      return;
    }

    // --- No pin: hover arbitration --------------------------------------------
    // 1. Drift. A landmark mark is a handful of pixels across, so a pointer moving
    //    toward the popup drifts off it long before reaching anything else.
    // 2. Nearby, and NOT the same location. Two marks a few pixels apart are
    //    visually ambiguous, and swapping the popup as the pointer crossed the
    //    gap made it impossible to read either one. The popup is left completely
    //    untouched - the anchor does not even move.
    // 3. Same-location cluster. Stepping through co-located milestones is the
    //    point of a cluster, so each member DOES take over.
    const anchor = hoverAnchor();
    if (anchor && hit && !(hit.entry === anchor.entry && hit.type === anchor.type)) {
      if (isNearAnchor(x, y, anchor)) {
        // Same location: let a cluster member open its own popup.
        const sameSpot = hit.type === 'event' && anchor.type === 'event'
          && sameLocationCluster(hit.entry, anchor.entry);
        if (!sameSpot) return;
      }
    }
    if (!hit && anchor && isNearAnchor(x, y, anchor)) return;   // drift: keep it

    if (!hit) {
      // Past the proximity radius with nothing under the pointer, and the pointer
      // is not on the popup: this is a real departure.
      if (state.tooltipHover) return;
      if (anchor) { setHoverAnchor(null, null); hideTooltip(); draw(); }
      return;
    }

    const sameAnchor = anchor && hit.entry === anchor.entry && hit.type === anchor.type;
    if (!sameAnchor) {
      handOverTo(hit, false);
      setHoverAnchor(hit.entry, hit.type);
      draw();
      return;
    }
    // Same landmark, pointer still on it: just let the popup follow.
    dockTooltipTo(hit.entry, hit.type, x, y, false);
  }

  canvas.addEventListener('mousedown', handleMouseDown);
  function handleMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    state.pressX = Number.isFinite(x) ? x : null;
    state.pressY = Number.isFinite(y) ? y : null;
    state.isDragging = true;
    canvas.style.cursor = 'grabbing';
    // Deliberately no dismissal here: the press is only a candidate click, so
    // a pinned popup survives until we know whether the pointer stayed put
    // (toggle/pin) or travelled (drag/pan).
  }

  window.addEventListener('mouseup', handleMouseUp);
  function handleMouseUp(e) {
    state.isDragging = false;
    canvas.style.cursor = 'grab';
    // A release that lands on the popup is a UI interaction with the popup, not
    // a canvas gesture. This listener is on window so it also sees presses that
    // started on the tooltip, and because the popup sits on top of the map the
    // same coordinates hit-test as the dot underneath — so the old code
    // dismissed the pinned popup here, tearing the pager out of the DOM before
    // its click could fire and making "previous milestone" unusable. Deselecting
    // the landmark is the lower-priority behaviour: the popup wins.
    //
    // Containment of the event target is the authoritative test. The sticky
    // `tooltipHover` flag alone is not enough: it is only cleared by mouseleave,
    // which never fires if the pointer leaves the window or the popup is
    // re-rendered under the cursor, and a stuck-true flag would silently kill
    // deselect-by-click for the rest of the session.
    const target = e.target;
    const overPopup = state.tooltipHover ||
      (tooltip && target && typeof tooltip.contains === 'function' && tooltip.contains(target));
    if (overPopup) {
      state.pressX = null;
      state.pressY = null;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (!Number.isFinite(x) || !Number.isFinite(y)) { state.pressX = null; state.pressY = null; return; }
    // A press/release with (almost) no movement selects the event under the
    // cursor and pins its popup, keeping "View source" reachable and clickable.
    const moved = Math.hypot((state.pressX ?? x) - x, (state.pressY ?? y) - y);
    if (moved > CLICK_DRAG_THRESHOLD) {
      // The dots moved out from under the pointer, so any popup is now stale.
      dismissTooltip();
    } else {
      // One hit test for every landmark type, so a click can only ever pin or
      // unpin through a single path. Before this there were three, each with its
      // own idea of what "already pinned" meant, and the layers were the odd ones
      // out: they could be hovered but the branch that made them sticky was
      // unreachable for the two layers that have no from/to endpoints.
      const hit = findLandmarkAt(x, y);
      const pinned = pinnedAnchor();
      if (!hit) {
        // Empty canvas closes a pinned popup.
        dismissTooltip();
      } else if (pinned && hit.entry === pinned.entry && hit.type === pinned.type) {
        // Clicking the pinned landmark again unpins it. Identity, not id: two
        // milestones at one location can share a generated id, and two reports at
        // one country centroid are distinct entries.
        dismissTooltip();
      } else {
        // Pin it. Note the popup is already showing this landmark in the common
        // case (the pointer is on it), so this is a re-dock rather than a retarget.
        handOverTo(hit, true);
      }
    }
    state.pressX = null;
    state.pressY = null;
    draw();
  }

  // Double-click to zoom in around the cursor
  canvas.addEventListener('dblclick', handleDblClick);
  function handleDblClick(e) {
    const rect = canvas.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, 1.5);
  }

  // ---- Zoom helpers (used by controls, wheel, keyboard, double-click) ----
  function applyZoom(x, y, factor) {
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, state.transform.scale * factor));
    const wx = (x - state.transform.tx) / state.transform.scale;
    const wy = (y - state.transform.ty) / state.transform.scale;
    state.transform.scale = newScale;
    state.transform.tx = x - wx * state.transform.scale;
    state.transform.ty = y - wy * state.transform.scale;
    dismissTooltip();
  }

  function zoomAt(x, y, factor) {
    applyZoom(x, y, factor);
    draw();
  }

  function resetView() {
    state.transform.scale = 1;
    state.transform.tx = 0;
    state.transform.ty = 0;
    dismissTooltip();
    draw();
  }

  // ---- Keyboard accessibility ----
  canvas.addEventListener('keydown', handleKeyDown);
  function handleKeyDown(e) {
    if (e.target !== canvas && !canvas.contains(e.target)) return;
    const panStep = 50 / state.transform.scale;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': state.transform.tx += panStep; break;
      case 'ArrowRight': state.transform.tx -= panStep; break;
      case 'ArrowUp': state.transform.ty += panStep; break;
      case 'ArrowDown': state.transform.ty -= panStep; break;
      case '+':
      case '=':
        zoomAt(state.width / 2, state.height / 2, 1.2);
        break;
      case '-':
        zoomAt(state.width / 2, state.height / 2, 1 / 1.2);
        break;
      case '0':
        resetView();
        break;
      case 'Escape':
        resetView();
        break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      dismissTooltip();
      draw();
    }
  }

  // Make canvas focusable for keyboard interaction
  canvas.setAttribute('tabindex', '0');
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', 'Interactive world map with transhumanist milestones');

  // ---- Tooltip ----
  // The metric's own name under the title. `synthetic_biology` -> "Synthetic
  // Biology", `low_resource_speech` -> "Low Resource Speech". The raw slug is
  // only shown when the record carries nothing more specific, so the label is
  // never a worse answer than before.
function submetricLabel(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // Per word, not just the first letter: the slugs are snake_case
  // ("low_resource_speech"), so capitalising only the head gives "Low resource
  // speech", which reads as a sentence fragment rather than a label. Acronyms
  // inside a slug come through lowercased and are not restored - a label that
  // says "Low Resource Speech" is right and one that says "Low ResouRce Speech"
  // because it guessed at acronyms would not be.
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function appendSubmetricLine(wrapper, raw) {
  const label = submetricLabel(raw);
  if (!label) return null;
  const line = document.createElement('div');
  line.className = 'tt-submetric';
  const key = document.createElement('span');
  key.className = 'tt-submetric-key';
  key.textContent = 'Metric';
  const val = document.createElement('span');
  val.className = 'tt-submetric-val';
  val.textContent = label;
  line.append(key, val);
  wrapper.appendChild(line);
  return line;
}

  function createTooltipElement(ev) {
    const color = landmarkColorFor(ev.category, ev.tone) || '#00d4ff';
    const wrapper = createTooltipCard();
    const cat = document.createElement('div');
    cat.className = 'tt-category';
    cat.style.color = color;
    cat.textContent = canonicalCategory(ev.category);
    // Label which half of a two-tone category this milestone belongs to.
    if (ev.tone) cat.textContent += ' \u00b7 ' + ev.tone;
    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = ev.title;
    const meta = document.createElement('div');
    meta.style.cssText = 'color: var(--fg-subtle); font-size: 0.7rem; margin-top: 4px;';
    meta.textContent = `${ev.source} · ${ev.date}`;
    wrapper.append(cat, title, meta);

    // Below the article/metric/value block, so the tooltip reads in the order a
    // reader asks for it: which vertical, what specifically, what happened,
    // how big, where to read more.
    appendSubmetricLine(wrapper, ev.subcategory);

    // Metric-less events publish their title as the value; skip the row when it
    // would only repeat the title heading above it.
    if (ev.value && ev.value !== ev.title) {
      const value = document.createElement('div');
      value.className = 'tt-value';
      value.textContent = ev.value;
      wrapper.appendChild(value);
    }

    if (ev.url && SOURCE_URL_RE.test(ev.url)) {
      const link = document.createElement('a');
      link.href = ev.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'tt-link';
      link.textContent = 'View source ↗';
      wrapper.appendChild(link);
    }

    const stackEvts = stackForEvent(ev);
    if (stackEvts.length > 1) {
      const pager = document.createElement('div');
      pager.className = 'tt-pager';
      pager.style.cssText = 'margin-top: 6px; display: flex; gap: 4px; justify-content: center; align-items: center;';
      // Real <button>s, not <span>s: only form controls match the :disabled
      // pseudo-class and honour the `disabled` property, so a <span> left the
      // pager looking clickable at the first/last milestone and was unreachable
      // by keyboard.
      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'tt-pager-btn tt-pager-prev';
      prevBtn.title = 'Previous milestone';
      prevBtn.setAttribute('aria-label', 'Previous milestone');
      prevBtn.textContent = '←';
      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'tt-pager-btn tt-pager-next';
      nextBtn.title = 'Next milestone';
      nextBtn.setAttribute('aria-label', 'Next milestone');
      nextBtn.textContent = '→';
      const indexEl = document.createElement('span');
      indexEl.className = 'tt-pager-index';
      indexEl.style.cssText = 'font-family: var(--font-mono); font-size: 0.7rem; color: var(--fg-subtle); min-width: 2.5ch; text-align: center;';
      // Start on the milestone actually shown, not always the first one.
      indexEl.textContent = `${Math.max(0, stackEvts.indexOf(ev)) + 1}/${stackEvts.length}`;
      pager.append(prevBtn, indexEl, nextBtn);
      wrapper.appendChild(pager);
    }
    return wrapper;
  }

  // Place the popup beside a point, flipping to the other side rather than hanging
  // off the frame. One implementation for every landmark type: there were four
  // byte-identical copies that had to be kept in step by hand, and the pinned
  // variant in pinTooltipToEvent had already drifted (it ignored TOOLTIP_OFFSET
  // for the fallback branch).
  function placeTooltipBeside(el, x, y) {
    if (!el) return;
    const offset = TOOLTIP_OFFSET;
    const tw = el.offsetWidth || TOOLTIP_WIDTH;
    const th = el.offsetHeight || TOOLTIP_HEIGHT;
    let tx = x + offset;
    let ty = y + offset;
    if (tx + tw > state.width) tx = x - tw - offset;
    if (ty + th > state.height) ty = y - th - offset;
    // Clamp rather than trust: a popup wider than the frame, or one measured
    // before it was laid out, would otherwise start off-screen and be unreachable.
    tx = Math.max(0, Math.min(tx, Math.max(0, state.width - tw)));
    ty = Math.max(0, Math.min(ty, Math.max(0, state.height - th)));
    el.style.left = tx + 'px';
    el.style.top = ty + 'px';
  }

  function moveTooltip(x, y) {
    if (!tooltip) return;
    placeTooltipBeside(tooltip, x, y);
  }

function showTooltip(ev, x, y) {
    if (!tooltip) return;
    // Keep the stack pager in step with the milestone actually on screen, and wire
    // it. The hover tooltip renders the same pager as the pinned popup, but only
    // the popup used to wire it: hovering the second member of a cluster showed
    // "2/2" with a dead prev button, so co-located milestones were reachable only
    // by clicking.
    const stack = stackForEvent(ev);
    state.stackIndex = stack.length > 1 ? Math.max(0, stack.indexOf(ev)) : 0;
    tooltip.replaceChildren(createTooltipElement(ev));
    wireStackPager(tooltip, ev);
    tooltip.classList.add('visible');
    moveTooltip(x, y);
  }

  // Attach prev/next behaviour to whichever stack pager is currently rendered.
  // Shared by the hover tooltip and the pinned popup: both render the same pager,
  // and wiring only one of them is what left the other visibly broken.
  function wireStackPager(container, ev) {
    const stack = stackForEvent(ev);
    if (stack.length <= 1) return;
    if (typeof container.querySelector !== 'function') return;
    const pager = container.querySelector('.tt-pager');
    if (!pager) return;
    const prevBtn = pager.querySelector('.tt-pager-prev');
    const nextBtn = pager.querySelector('.tt-pager-next');
    const indexEl = pager.querySelector('.tt-pager-index');

    const step = (delta) => {
      const members = stackForEvent(ev);
      const target = members[state.stackIndex + delta];
      if (!target) return;
      pinTooltipToEvent(target);
    };
    const handlePrev = (e) => { e.stopPropagation(); step(-1); };
    const handleNext = (e) => { e.stopPropagation(); step(1); };

    if (prevBtn) prevBtn.addEventListener('click', handlePrev);
    if (nextBtn) nextBtn.addEventListener('click', handleNext);
    pager._cleanup = () => {
      if (prevBtn) prevBtn.removeEventListener('click', handlePrev);
      if (nextBtn) nextBtn.removeEventListener('click', handleNext);
    };
    // Reflect the current position. Real <button>s are used precisely so this
    // works: a <span> accepts `disabled` but never matches :disabled, which is
    // why the arrows once looked clickable at the ends of the stack.
    const refresh = () => {
      const total = stackForEvent(ev).length;
      if (indexEl) indexEl.textContent = `${state.stackIndex + 1}/${total}`;
      if (prevBtn) prevBtn.disabled = state.stackIndex === 0;
      if (nextBtn) nextBtn.disabled = state.stackIndex >= total - 1;
    };
    refresh();
  }

  function hideTooltip() {
    if (tooltip) tooltip.classList.remove('visible');
  }

  // Visual marker for "this popup is anchored, not chasing the pointer". Driven
  // from one place so a popup can never claim to be sticky while the state says
  // otherwise (or the reverse), which is what would make the two feel different.
  function markTooltipSticky(on) {
    if (!tooltip) return;
    // add/remove rather than classList.toggle: toggle is standard, but this
    // codebase's test fakes implement only add/remove/contains, and using the
    // wider API here would throw inside the click path rather than merely skip a
    // class.
    if (on) tooltip.classList.add('is-sticky');
    else tooltip.classList.remove('is-sticky');
  }

  // Pin the popup for a selected event: place it beside the dot once and keep
  // it from chasing the cursor, so the "View source" link stays reachable.
  function pinTooltipToEvent(ev) {
    if (!tooltip) return;
    const p = project(ev.lon, ev.lat);

    // Clean up previous pager if any (defensive: tooltip may be a mock without querySelector)
    if (typeof tooltip.querySelector === 'function') {
      const oldPager = tooltip.querySelector('.tt-pager');
      if (oldPager && oldPager._cleanup) oldPager._cleanup();
    }

    tooltip.replaceChildren(createTooltipElement(ev));
    tooltip.classList.add('visible');
    // Placed AFTER the content is in the DOM: offsetWidth/offsetHeight are read
    // there, and measuring the previous popup's box is what used to let a taller
    // pinned popup hang off the bottom of the frame.
    if (p) placeTooltipBeside(tooltip, p.x, p.y);

    // Track which member of the stack is on screen so prev/next move from here
    // (the pager used to snap back to 1/N on every re-pin and never advanced),
    // then hand the pager to the shared wiring so the hover tooltip and this
    // popup cannot drift apart again.
    const stackEvts = stackForEvent(ev);
    state.stackIndex = stackEvts.length > 1 ? Math.max(0, stackEvts.indexOf(ev)) : 0;
    wireStackPager(tooltip, ev);
  }

  // Remove the tooltip AND forget which event it pointed at (including any
  // pinned selection). Forgetting is what lets the next mousemove re-open it
  // cleanly after a pan/zoom/drag moved the dots underneath the pointer.
  // Dock a landmark popup at the landmark rather than under the cursor, so it
  // survives the pointer travelling away to read it or reach its source link.
  function pinTooltipToHumanRight(entry) {
    if (!tooltip || !entry) return;
    const p = project(entry.lon, entry.lat);
    if (!p) return;
    showHumanRightsTooltip(entry, p.x, p.y);
  }

  function dismissTooltip() {
    // Clean up pager event listeners before hiding
    if (tooltip && typeof tooltip.querySelector === 'function') {
      const pager = tooltip.querySelector('.tt-pager');
      if (pager && pager._cleanup) pager._cleanup();
    }
    state.selectedEvent = null;
    state.selectedHumanRight = null;
    state.selectedLayer = null;
    state.selectedLayerType = null;
    state.hoveredEvent = null;
    state.hoveredType = null;
    state.hoverAnchor = null;
    state.hoverAnchorType = null;
    state.stackIndex = 0;
    markTooltipSticky(false);
    hideTooltip();
  }

  // A popup pinned to a milestone that a filter just took off the map would
  // otherwise linger over empty canvas, so drop it when its target disappears.
  function eventIsHidden(ev) {
    if (ev._hiddenByTimeline) return true;
    if (!isCategoryVisible(ev.category)) return true;
    return state.filterRecent && !isInRolling7Days(ev.date, currentDayISO());
  }

  // A docked landmark is released when it stops being drawable: the layer switched
  // off, the timeline filtered it away, or the data was replaced without it. Same
  // reasoning as eventIsHidden for milestones - a popup anchored to nothing is
  // just a stale panel covering the map.
  function humanRightIsHidden(entry) {
    if (!entry) return true;
    if (!state.showHumanRights) return true;
    if (entry._hiddenByTimeline) return true;
    return !state.humanRights.includes(entry);
  }

  function dismissTooltipIfTargetHidden() {
    // One predicate per anchor kind, and the anchor is whichever of the two the
    // popup is describing - pinned first, then hover. Previously only milestones
    // were checked here, so a popup docked to a landmark whose layer had been
    // switched off kept describing a layer that was no longer drawn.
    const anchors = [pinnedAnchor(), hoverAnchor()].filter(Boolean);
    if (anchors.some((a) => !anchorIsVisible(a))) { dismissTooltip(); return; }
  }

  // ---- Zone/Deployment Tooltips ----
  // Shared lifecycle line for layer tooltips: a glowing "●" marker for still
  // active entries (shows how long they have been live) and a dim "○" for
  // concluded ones (shows the full duration span the layers pipeline recorded).
  function appendActivityLine(wrapper, item) {
    const line = document.createElement('div');
    line.style.cssText = 'margin-top: 4px; font-size: 0.7rem; color: var(--fg-muted);';
    line.textContent = `${isLayerActive(item) ? '●' : '○'} ${layerActivityLabel(item)}`;
    if (isLayerActive(item)) {
      line.style.color = 'var(--accent)';
      line.style.fontWeight = '600';
    }
    wrapper.appendChild(line);
    return wrapper;
  }

  function createZoneTooltipElement(zone) {
    const wrapper = createTooltipCard();
    appendTooltipHeader(wrapper, 'Conflict Zone', ZONE_COLOR, zone);
    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = zone.name;
    wrapper.appendChild(title);
    appendSourceLine(wrapper, zone);
    appendNoteLine(wrapper, zone.note);
    return appendActivityLine(wrapper, zone);
  }

  // Alliance / defence-policy seal popup. Same shape as a movement popup so the
  // sublayer reads as part of the Ground & Fleet Deployments datalayer rather
  // than as a fifth unrelated thing on the map.
  function createAllianceDotTooltipElement(dot) {
    const wrapper = createTooltipCard();
    const heading = ALLIANCE_DOT_HEADINGS[dot.kind] || ALLIANCE_DOT_HEADINGS.posture;
    appendTooltipHeader(wrapper, heading, ALLIANCE_DOT_COLOR, dot);
    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = dot.name;
    wrapper.appendChild(title);
    appendSourceLine(wrapper, dot);
    appendFactLine(wrapper, 'Nation', dot.country);
    appendFactLine(wrapper, 'Region', dot.region);
    appendFactLine(wrapper, 'Effective', dot.start_date);
    appendNoteLine(wrapper, dot.note);
    return appendActivityLine(wrapper, dot);
  }

  function createDeploymentTooltipElement(fleet) {
    const wrapper = createTooltipCard();
    const isInfantry = isInfantryKind(fleet);
    const isGround = isInfantry || fleet.kind === 'ground';
    appendTooltipHeader(
      wrapper,
      isGround ? 'Ground Deployment' : 'Fleet Deployment',
      isGround ? GROUND_COLOR : FLEET_COLOR,
      fleet
    );
    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = fleet.label;
    wrapper.appendChild(title);
    appendSourceLine(wrapper, fleet);
    appendFactLine(wrapper, 'Nation', fleet.country);
    appendFactLine(wrapper, 'Region', fleet.region);
    if (fleet.troops) {
      appendFactLine(wrapper, 'Troops', Number(fleet.troops).toLocaleString());
    }

    // Route info. Derived from the same endpoints the renderer draws, so an
    // infantry arrow (lat/lon + direction, no from/to) reports a real route
    // instead of silently showing nothing.
    const ends = fleetEndpoints(fleet);
    if (ends) {
      appendFactLine(wrapper, 'From',
        `${ends.from.lat.toFixed(1)}°, ${ends.from.lon.toFixed(1)}°`);
      appendFactLine(wrapper, 'To',
        `${ends.to.lat.toFixed(1)}°, ${ends.to.lon.toFixed(1)}°`);
    }
    if (fleet.direction) {
      appendFactLine(wrapper, 'Heading', String(fleet.direction).toLowerCase());
    }
    appendNoteLine(wrapper, fleet.note);
    return appendActivityLine(wrapper, fleet);
  }

  function moveZoneTooltip(x, y) {
    if (!tooltip) return;
    placeTooltipBeside(tooltip, x, y);
  }

  function moveDeploymentTooltip(x, y) {
    if (!tooltip) return;
    placeTooltipBeside(tooltip, x, y);
  }

  function showZoneTooltip(zone, x, y) {
    if (!tooltip) return;
    tooltip.replaceChildren(createZoneTooltipElement(zone));
    tooltip.classList.add('visible');
    moveZoneTooltip(x, y);
  }

  function showDeploymentTooltip(fleet, x, y) {
    if (!tooltip) return;
    tooltip.replaceChildren(createDeploymentTooltipElement(fleet));
    tooltip.classList.add('visible');
    moveDeploymentTooltip(x, y);
  }

  function createCrisisTooltipElement(crisis) {
    const wrapper = createTooltipCard();
    appendTooltipHeader(wrapper, 'Crisis Zone', CRISIS_COLOR, crisis);
    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = crisis.name;
    wrapper.appendChild(title);
    appendSourceLine(wrapper, crisis);
    appendNoteLine(wrapper, crisis.note);
    return appendActivityLine(wrapper, crisis);
  }

  function showAllianceDotTooltip(dot, x, y) {
    if (!tooltip) return;
    tooltip.replaceChildren(createAllianceDotTooltipElement(dot));
    tooltip.classList.add('visible');
    moveAllianceDotTooltip(x, y);
  }

  function moveAllianceDotTooltip(x, y) {
    if (!tooltip) return;
    placeTooltipBeside(tooltip, x, y);
  }

  function moveCrisisTooltip(x, y) {
    if (!tooltip) return;
    placeTooltipBeside(tooltip, x, y);
  }

  function showCrisisTooltip(crisis, x, y) {
    if (!tooltip) return;
    tooltip.replaceChildren(createCrisisTooltipElement(crisis));
    tooltip.classList.add('visible');
    moveCrisisTooltip(x, y);
  }

  // Human Rights Violations reuse the milestone tooltip treatment, as specified:
  // a reader who has learned to read a milestone dot can read these too.
  function showHumanRightsTooltip(entry, x, y) {
    if (!tooltip) return;
    tooltip.replaceChildren(createHumanRightsTooltipElement(entry));
    tooltip.classList.add('visible');
    moveHumanRightsTooltip(x, y);
  }

  const moveHumanRightsTooltip = moveCrisisTooltip;

  function createHumanRightsTooltipElement(entry) {
    const wrapper = createTooltipCard();
    const cat = document.createElement('div');
    cat.className = 'tt-category';
    cat.style.color = HUMAN_RIGHTS_COLOR;
    cat.textContent = 'Human Rights Violation';
    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = entry.name;
    wrapper.append(cat, title);
    if (entry.note) {
      const note = document.createElement('div');
      note.style.cssText = 'color: var(--fg-muted); font-size: 0.72rem; margin-top: 4px;';
      note.textContent = entry.note;
      wrapper.appendChild(note);
    }
    // Several reports can geocode to one country centroid. Without this line the
    // legend count reads as a bug: the marker is a fan, not a single report.
    const clusterCount = humanRightClusterSize(entry);
    if (clusterCount > 1) {
      const shared = document.createElement('div');
      shared.style.cssText = 'color: var(--fg-muted); font-size: 0.72rem; margin-top: 4px;';
      shared.textContent = clusterCount + ' reports at this location';
      wrapper.appendChild(shared);
    }

    const meta = document.createElement('div');
    meta.style.cssText = 'color: var(--fg-subtle); font-size: 0.7rem; margin-top: 4px;';
    const bits = [entry.region, entry.start_date].filter(Boolean).join(' \u00b7 ');
    if (entry.source && entry.url && SOURCE_URL_RE.test(entry.url)) {
      const link = document.createElement('a');
      link.href = entry.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.color = 'var(--accent)';
      link.textContent = bits ? bits + ' \u2014 ' + entry.source : entry.source;
      meta.appendChild(link);
    } else {
      meta.textContent = [bits, entry.source].filter(Boolean).join(' \u2014 ') || 'Unknown source';
    }
    wrapper.appendChild(meta);
    return wrapper;
  }

  // ---- Stats computation ----
  // The rolling 7-day window runs from today back six days, inclusive. The window
  // only moves when the day does, but isInRolling7Days() is called once per event
  // per frame (draw runs ~10x/s) and rebuilt two Date objects every time. Memoise
  // on the day it was computed for, so a new todayISO (a real midnight rollover or
  // the test clock) recomputes and replaces the entry.
  let rollingBoundsDay = null;
  let rollingBounds = null;
  function rolling7DayBounds(todayISO) {
    if (rollingBoundsDay === todayISO) return rollingBounds;
    const end = new Date(todayISO + 'T00:00:00Z');
    const start = new Date(end.getTime() - 6 * 86400000); // 6 days back = 7 days total
    rollingBoundsDay = todayISO;
    rollingBounds = { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
    return rollingBounds;
  }

  function parseDateToISO(dateStr) {
    if (!dateStr) return null;
    const trimmed = String(dateStr).trim();
    // Try parsing as YYYY-MM-DD first
    const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    }
    // Try parsing as DD-MM-YYYY or DD/MM/YYYY
    const dmyMatch = trimmed.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
    if (dmyMatch) {
      const day = dmyMatch[1].padStart(2, '0');
      const month = dmyMatch[2].padStart(2, '0');
      const year = dmyMatch[3];
      return `${year}-${month}-${day}`;
    }
    // Fallback: try Date constructor
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
    return null;
  }

  function isInRolling7Days(dateStr, todayISO) {
    const iso = parseDateToISO(dateStr);
    if (!iso) return false;
    const { start, end } = rolling7DayBounds(todayISO);
    return iso >= start && iso <= end;
  }

  // Single source of truth for "today": rendering, hit-testing, stats and the
  // stack map must all window the same day, otherwise a dot can be drawn but not
  // clicked (or vice versa).
  function currentDayISO() {
    const hook = (typeof window !== 'undefined' && window.__WORLDMAP_TEST__)?.getTodayISO;
    return hook ? hook() : new Date().toISOString().slice(0, 10);
  }

  // Legacy ISO week function (kept for test compatibility)
  function weekBoundsISO(todayISO) {
    const d = new Date(todayISO + 'T00:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow + 6));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }

  function isInCurrentWeek(dateStr, todayISO) {
    if (!dateStr) return false;
    const iso = String(dateStr).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
    const { start, end } = weekBoundsISO(todayISO);
    return iso >= start && iso <= end;
  }

  function computeStats() {
    const counts = {
      breakthroughs: 0, conflicts: 0, fleets: 0, crises: 0,
      conflictsActive: 0, conflictsConcluded: 0,
      fleetsActive: 0, fleetsConcluded: 0,
      crisesActive: 0, crisesConcluded: 0
    };
    // Must be the same "today" the stack map and hit-testing window on, or the
    // headline count can disagree with what is drawn on the map.
    const todayISO = currentDayISO();
    state.events.forEach(ev => {
       if (!isCategoryVisible(ev.category)) return;
       // Always count breakthroughs in the last 7 days (static count)
       if (!isInRolling7Days(ev.date, todayISO)) return;
       const statMap = CATEGORY_STAT_MAP[canonicalCategory(ev.category)];
       if (!statMap || statMap.statId !== 'map-stat-active') return;
       counts.breakthroughs++;
     });
     // Conflicts/fleets/crises: always show actual total counts (not zero when
     // invisible), plus an active/concluded split so the fluo/dim styling is
     // reflected in the button labels and legend counts.
     counts.conflicts = state.zones.length;
     counts.conflictsActive = state.zones.filter(isLayerActive).length;
     counts.conflictsConcluded = counts.conflicts - counts.conflictsActive;
     counts.fleets = state.fleets.length + state.allianceDots.length;
     counts.fleetsActive = state.fleets.filter(isLayerActive).length
       + state.allianceDots.filter(isLayerActive).length;
     counts.fleetsConcluded = counts.fleets - counts.fleetsActive;
     counts.crises = state.crises.length;
     counts.crisesActive = state.crises.filter(isLayerActive).length;
     counts.crisesConcluded = counts.crises - counts.crisesActive;
     return counts;
   }

  function toggleFilterRecent() {
    state.filterRecent = !state.filterRecent;
    try { localStorage.setItem(STORAGE_KEY_FILTER_RECENT, String(state.filterRecent)); } catch (_) {}
    rebuildStackMap();
    dismissTooltipIfTargetHidden();
    updateFilterButton('filter-recent', state.filterRecent);
    draw();
    updateStatsDisplay();
    renderLegend();
  }

  function toggleFilterMilitary() {
    state.filterMilitary = !state.filterMilitary;
    // When toggling military filter, also toggle both layers together
    state.showZones = state.filterMilitary;
    state.showFleets = state.filterMilitary;
    try { 
      localStorage.setItem(STORAGE_KEY_FILTER_MILITARY, String(state.filterMilitary)); 
      localStorage.setItem(STORAGE_KEY_SHOW_ZONES, String(state.showZones));
      localStorage.setItem(STORAGE_KEY_SHOW_FLEETS, String(state.showFleets));
    } catch (_) {}
    syncFilterButtons();
    draw();
    updateStatsDisplay();
    renderLegend();
  }

  function toggleFilterCrisis() {
    state.filterCrisis = !state.filterCrisis;
    // When toggling crisis filter, also toggle crisis layer
    state.showCrises = state.filterCrisis;
    try { 
      localStorage.setItem(STORAGE_KEY_FILTER_CRISIS, String(state.filterCrisis)); 
      localStorage.setItem(STORAGE_KEY_SHOW_CRISES, String(state.showCrises));
    } catch (_) {}
    syncFilterButtons();
    draw();
    updateStatsDisplay();
    renderLegend();
  }

  function updateFilterButton(id, pressed) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.setAttribute('aria-pressed', String(pressed));
      btn.style.opacity = pressed ? '1' : '0.5';
    }
  }

  // Whether each upper-left tile currently controls something that is actually
  // painted. The tiles are gated on the filter flag, but the legend can switch
  // every layer underneath a filter off, so the flag alone stays true while
  // nothing is drawn. Reporting the flag re-lit the tile at full brightness with
  // an empty map behind it, which read as "selected" when nothing was selected.
  // Effective visibility = filter flag AND at least one of its layers on.
  function militaryVisible() { return state.filterMilitary && (state.showZones || state.showFleets); }
  function crisisVisible() { return state.filterCrisis && state.showCrises; }

  // Single place that keeps all three tiles in step with what is on the map, so
  // the filter buttons and the legend rows can never disagree.
  function syncFilterButtons() {
    updateFilterButton('filter-recent', state.filterRecent);
    updateFilterButton('filter-military', militaryVisible());
    updateFilterButton('filter-crisis', crisisVisible());
  }

  function toggleLayer(name) {
    if (name === 'zones') {
      state.showZones = !state.showZones;
      try { localStorage.setItem(STORAGE_KEY_SHOW_ZONES, String(state.showZones)); } catch (_) {}
    } else if (name === 'fleets' || name === 'deployments') {
      state.showFleets = !state.showFleets;
      try { localStorage.setItem(STORAGE_KEY_SHOW_FLEETS, String(state.showFleets)); } catch (_) {}
    } else if (name === 'alliance_dots') {
      state.showAllianceDots = !state.showAllianceDots;
      try { localStorage.setItem(STORAGE_KEY_SHOW_ALLIANCE_DOTS, String(state.showAllianceDots)); } catch (_) {}
      // Switching the sublayer off while one of its popups is docked would leave
      // the panel describing marks that are no longer painted.
      if (!state.showAllianceDots
          && state.selectedLayerType === 'alliance') dismissTooltip();
    } else if (name === 'crises') {
      state.showCrises = !state.showCrises;
      try { localStorage.setItem(STORAGE_KEY_SHOW_CRISES, String(state.showCrises)); } catch (_) {}
    } else if (name === 'human_rights') {
      state.showHumanRights = !state.showHumanRights;
      try { localStorage.setItem(STORAGE_KEY_SHOW_HUMAN_RIGHTS, String(state.showHumanRights)); } catch (_) {}
      // Switching the layer off while one of its popups is docked would leave the
      // panel floating over a map it no longer describes.
      if (!state.showHumanRights) dismissTooltip();
    }
    // If enabling a military layer, also enable the military filter
    if ((name === 'zones' && state.showZones) || (name === 'fleets' && state.showFleets) || (name === 'deployments' && state.showFleets)) {
      if (!state.filterMilitary) {
        state.filterMilitary = true;
        try { localStorage.setItem(STORAGE_KEY_FILTER_MILITARY, 'true'); } catch (_) {}
      }
    }
    // If enabling crisis layer, also enable the crisis filter
    if (name === 'crises' && state.showCrises) {
      if (!state.filterCrisis) {
        state.filterCrisis = true;
        try { localStorage.setItem(STORAGE_KEY_FILTER_CRISIS, 'true'); } catch (_) {}
      }
    }
    draw();
    updateStatsDisplay();
    // Re-derive brightness from effective visibility, so switching the last layer
    // off in a group dims that group's tile instead of leaving it lit.
    syncFilterButtons();
    renderLegend();
  }

  /**
   * Phase offset for the silver sweep on a dimmed datalayer row's title text,
   * handed to CSS as --shimmer-delay so the rows drift out of phase instead of
   * pulsing as one block.
   *
   * Derived from the layer key rather than from its position in the legend or a
   * running counter, for the reason the rest of this file keeps its numbers in
   * one place: renderLegend() rebuilds these rows on every layer toggle, filter
   * change and timeline move, so a counter would need resetting and an index
   * would need keeping in step with the list. A key that never changes hands out
   * the same delay every rebuild, and a layer that is added or removed shifts no
   * other row's phase.
   *
   * FNV-1a over the key, folded into one sweep period. Period 7.5s is the CSS
   * --shimmer-period default, so the five offsets land at distinct points of the
   * same loop and no two rows can ever land in step by accident.
   * @param {string} key layer key, e.g. "zones"
   * @returns {string} CSS time value
   */
  function silverSweepDelay(key) {
    const PERIOD_MS = 7500;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return ((h % PERIOD_MS) / 1000).toFixed(2) + 's';
  }

  function appendLayerRow(fragment, opts) {
    const row = document.createElement('div');
    row.style.setProperty('--shimmer-delay', silverSweepDelay(opts.key));
    // `nested` marks a sublayer row: indented and visually subordinate to the
    // datalayer it belongs to, rather than reading as a peer of it.
    row.className = 'map-legend-row' + (opts.nested ? ' map-legend-row--nested' : '');
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-label', `${opts.label}, ${opts.count}`);
    row.tabIndex = 0;
    row.setAttribute('aria-pressed', String(opts.visible));
    row.setAttribute('data-layer', opts.key);
    if (opts.title) row.setAttribute('title', opts.title);
    if (opts.splitColors && opts.splitColors.length > 1) {
      // Split dot: render a dot for each color in the split array
      // so the legend shows both ground (green) and fleet (blue) components.
      for (const c of opts.splitColors) {
        const dot = document.createElement('span');
        dot.className = 'map-legend-dot';
        dot.style.background = c;
        dot.style.borderColor = c;
        dot.setAttribute('aria-hidden', 'true');
        row.append(dot);
      }
    } else {
      const dot = document.createElement('span');
      // One shape class per mark, chosen once, so the legend and the canvas can
      // never disagree about what a layer looks like: ring = area ring, diamond =
      // movement arrow, seal = square-in-ring policy dot.
      const shape = opts.ring ? ' map-legend-dot--ring'
        : opts.diamond ? ' map-legend-dot--diamond'
        : opts.seal ? ' map-legend-dot--seal'
        : '';
      dot.className = 'map-legend-dot' + shape;
      dot.style.background = opts.color;
      dot.style.borderColor = opts.color;
      dot.setAttribute('aria-hidden', 'true');
      row.append(dot);
    }
    const label = document.createElement('span');
    label.className = 'map-legend-label';
    label.textContent = opts.label;
    const count = document.createElement('span');
    count.className = 'map-legend-count';
    count.textContent = opts.count;
    count.setAttribute('aria-hidden', 'true');
    row.append(label, count);
    row.addEventListener('click', () => toggleLayer(opts.key));
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleLayer(opts.key);
      }
    });
    fragment.appendChild(row);
  }

  function updateStatsDisplay() {
    const stats = computeStats();
    const active = document.getElementById('map-stat-active');
    const conflicts = document.getElementById('map-stat-conflicts');
    const fleets = document.getElementById('map-stat-fleets');
    const crises = document.getElementById('map-stat-crises');
    if (active) active.textContent = stats.breakthroughs;
    if (conflicts) conflicts.textContent = stats.conflicts;
    if (fleets) fleets.textContent = stats.fleets;
    if (crises) crises.textContent = stats.crises;

    // Update button labels with smart pluralization
    const breakthroughLabel = document.querySelector('#filter-recent .map-hint-title span:last-child');
    if (breakthroughLabel) {
      breakthroughLabel.textContent = ` ${pluralize(stats.breakthroughs, 'breakthrough', 'breakthroughs')} this week`;
    }
    const conflictLabel = document.querySelector('#filter-military .map-hint-title span:nth-child(2)');
    if (conflictLabel) {
      conflictLabel.textContent = stats.conflictsConcluded > 0
        ? ` ${pluralize(stats.conflicts, 'conflict zone', 'conflict zones')} · ${stats.conflictsActive} active, ${stats.conflictsConcluded} concluded,`
        : ` ${pluralize(stats.conflicts, 'active conflict zone', 'active conflict zones')},`;
    }
    const fleetLabel = document.querySelector('#filter-military .map-hint-title span:last-child');
    if (fleetLabel) {
      fleetLabel.textContent = stats.fleetsConcluded > 0
        ? ` ${pluralize(stats.fleets, 'deployment', 'deployments')} · ${stats.fleetsActive} active, ${stats.fleetsConcluded} concluded`
        : ` ${pluralize(stats.fleets, 'deployment', 'deployments')}`;
    }
    const crisisLabel = document.querySelector('#filter-crisis .map-hint-title span:last-child');
    if (crisisLabel) {
      crisisLabel.textContent = stats.crisesConcluded > 0
        ? ` ${pluralize(stats.crises, 'humanitarian crisis', 'humanitarian crises')} · ${stats.crisesActive} active, ${stats.crisesConcluded} concluded`
        : ` ${pluralize(stats.crises, 'humanitarian crisis', 'humanitarian crises')}`;
    }
  }

  // ---- Milestone data notice ----
  // An empty map with no explanation reads as "no breakthroughs recorded", which
  // is a different and false claim from "we could not reach the data". One small
  // live-region line, built once and reused, fixes the difference for assistive
  // tech as well as sighted visitors.
  let dataNoticeEl = null;
  function renderDataNotice() {
    const mapEl = document.getElementById('world-map');
    if (!mapEl) return;
    const message = state.dataLoadError;
    if (!message) {
      if (dataNoticeEl && dataNoticeEl.parentNode) dataNoticeEl.remove();
      dataNoticeEl = null;
      return;
    }
    if (!dataNoticeEl || !dataNoticeEl.parentNode) {
      dataNoticeEl = document.createElement('p');
      dataNoticeEl.id = 'map-data-notice';
      dataNoticeEl.className = 'map-data-notice';
      dataNoticeEl.setAttribute('role', 'status');
      dataNoticeEl.setAttribute('aria-live', 'polite');
      mapEl.appendChild(dataNoticeEl);
    }
    dataNoticeEl.textContent = message;
  }

  // ---- Legend ----
  // Humanized legend/count breakdown for a layer list (active vs concluded).
  function layerCountTitle(items) {
    const active = items.filter(isLayerActive).length;
    const concluded = items.length - active;
    if (concluded === 0) return `${active} active`;
    return `${active} active, ${concluded} concluded`;
  }

  function renderLegend() {
    const mapEl = document.getElementById('world-map');
    if (!mapEl) return;
    let legendEl = document.getElementById('map-legend');
    if (!legendEl) {
      legendEl = document.createElement('div');
      legendEl.id = 'map-legend';
      legendEl.className = 'map-legend';
      legendEl.setAttribute('role', 'list');
      legendEl.setAttribute('aria-label', 'Milestone categories with event counts');
      mapEl.appendChild(legendEl);
    }

    const counts = {};
      state.events.forEach(ev => {
        const key = canonicalCategory(ev.category);
        if (CATEGORY_COLORS[key]) {
          counts[key] = (counts[key] || 0) + 1;
        }
      });

const fragment = document.createDocumentFragment();

      // Header row: the fold control on the left, the bulk eye on the right.
      const head = document.createElement('div');
      head.className = 'map-legend-head';

      const title = document.createElement('div');
      title.className = 'map-legend-title';
      title.textContent = 'CATEGORIES';
      title.setAttribute('role', 'button');
      title.setAttribute('tabindex', '0');
      title.setAttribute('aria-pressed', String(state.foldedCategories));
      title.setAttribute('aria-label', 'Toggle categories visibility');

      // The click target is the whole header row, not the seven-pixel-tall word. The
      // empty space in front of, above, under and behind CATEGORIES - right up to the
      // eye - toggles the list, which is where a pointer actually goes. Keyboard focus
      // stays on the word itself, where role="button" and tabindex live, because a
      // <button> inside a role="button" is invalid ARIA.
      const toggleFolded = () => {
        // renderLegend() rebuilds the whole frame, which destroys the element that
        // had focus. Without this a keyboard user toggles once and is dumped back on
        // <body>, so the second Enter goes nowhere and the control looks broken.
        const hadFocus = document.activeElement === title ||
                         document.activeElement === head;
        state.foldedCategories = !state.foldedCategories;
        renderLegend();
        if (hadFocus) {
          const next = document.querySelector('.map-legend-title');
          if (next && typeof next.focus === 'function') next.focus();
        }
      };
      head.addEventListener('click', toggleFolded);
      title.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleFolded();
        }
      });
      head.appendChild(title);

      // White eye, drawn rather than an icon font so it scales with the frame and
      // needs no extra asset. The lid is a stroke that rotates down over the iris.
      const bulk = document.createElement('button');
      bulk.type = 'button';
      bulk.id = 'map-legend-bulk-visibility';
      bulk.className = 'map-legend-bulk';
      bulk.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleAllCategories();
      });
      const eyeNs = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(eyeNs, 'svg');
      svg.setAttribute('viewBox', '0 0 12 12');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const outline = document.createElementNS(eyeNs, 'path');
      outline.setAttribute('d', 'M1.1 6 C3 2.9 4.5 2.4 6 2.4 C7.5 2.4 9 2.9 10.9 6'
        + ' C9 9.1 7.5 9.6 6 9.6 C4.5 9.6 3 9.1 1.1 6 Z');
      outline.setAttribute('fill', 'none');
      outline.setAttribute('stroke', 'currentColor');
      outline.setAttribute('stroke-width', '1.1');
      outline.setAttribute('stroke-linejoin', 'round');
      const iris = document.createElementNS(eyeNs, 'circle');
      iris.setAttribute('class', 'eye-iris');
      iris.setAttribute('cx', '6');
      iris.setAttribute('cy', '6');
      iris.setAttribute('r', '1.7');
      iris.setAttribute('fill', 'currentColor');
      const lid = document.createElementNS(eyeNs, 'path');
      lid.setAttribute('class', 'eye-lid');
      lid.setAttribute('d', 'M1.2 6 L10.8 6');
      lid.setAttribute('stroke', 'currentColor');
      lid.setAttribute('stroke-width', '1.4');
      lid.setAttribute('stroke-linecap', 'round');
      svg.append(outline, iris, lid);
      bulk.appendChild(svg);
      applyBulkVisibilityState(bulk);
      head.appendChild(bulk);

      fragment.appendChild(head);

      // Wrapper for category rows that can be folded with animation
      const categoriesWrapper = document.createElement('div');
      categoriesWrapper.className = 'map-legend-categories';
      categoriesWrapper.style.overflow = 'hidden';
      categoriesWrapper.style.transition = 'max-height 0.15s ease, opacity 0.15s ease';
      if (state.foldedCategories) {
        categoriesWrapper.style.maxHeight = '0';
        categoriesWrapper.style.opacity = '0';
      } else {
        categoriesWrapper.style.maxHeight = '500px';
        categoriesWrapper.style.opacity = '1';
      }

      CATEGORY_LEGEND.forEach(cat => {
        const row = document.createElement('div');
        row.className = 'map-legend-row';
        row.setAttribute('role', 'listitem');
        row.setAttribute('aria-label', `${cat.label}, ${counts[cat.key] || 0} events`);
        row.tabIndex = 0;
        row.setAttribute('aria-pressed', String(!state.hiddenCategories.has(cat.key)));
        row.setAttribute('data-category', cat.key);
        const subtone = CATEGORY_SUBTONES[cat.key];
        if (subtone) {
          // Two-tone categories show both colours side by side, like the
          // Deployments ground/fleet row, so the split is discoverable.
          for (const colour of [CATEGORY_COLORS[cat.key], subtone.secondaryColor]) {
            const toneDot = document.createElement('span');
            toneDot.className = 'map-legend-dot';
            toneDot.style.background = colour;
            toneDot.setAttribute('aria-hidden', 'true');
            row.appendChild(toneDot);
          }
          row.setAttribute('aria-label',
            cat.label + ' (' + subtone.primary + ' and ' + subtone.secondary + '), ' +
            (counts[cat.key] || 0) + ' events');
        } else {
          const dot = document.createElement('span');
          dot.className = 'map-legend-dot';
          dot.style.background = CATEGORY_COLORS[cat.key];
          dot.setAttribute('aria-hidden', 'true');
          row.appendChild(dot);
        }
        const label = document.createElement('span');
        label.className = 'map-legend-label';
        label.textContent = cat.label;
        const count = document.createElement('span');
        count.className = 'map-legend-count';
        count.textContent = String(counts[cat.key] || 0);
        count.setAttribute('aria-hidden', 'true');
        row.append(label, count);
        row.addEventListener('click', () => toggleCategory(cat.key));
        row.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleCategory(cat.key);
          }
        });
        categoriesWrapper.appendChild(row);
      });
      fragment.appendChild(categoriesWrapper);

      // Operational layers: toggleable, with the same row pattern as categories.
      // Zones render as a ring, deployments as a diamond (direction arrows on canvas).
      // Crisis zones (humanitarian) render as a ring with purple color.
      const zonesVisible = state.filterMilitary && state.showZones;
      const deploymentsVisible = state.filterMilitary && state.showFleets;
      const crisesVisible = state.filterCrisis && state.showCrises;
      appendLayerRow(fragment, {
        key: 'zones',
        label: LAYER_LABELS.zones,
        visible: zonesVisible,
        color: ZONE_COLOR,
        count: String(state.zones.length),
        ring: true,
        title: layerCountTitle(state.zones)
      });
      appendLayerRow(fragment, {
        key: 'deployments',
        label: LAYER_LABELS.deployments,
        visible: deploymentsVisible,
        splitColors: [GROUND_COLOR, FLEET_COLOR],
        count: String(state.fleets.length + state.allianceDots.length),
        diamond: true,
        title: layerCountTitle(state.fleets.concat(state.allianceDots))
      });
      // The dot sublayer, indented under its parent so the legend reads as one
      // datalayer with two mark types rather than as a fifth unrelated layer.
      // Only rendered when the payload actually carries seals, so a checkout with
      // no alliance_dots key does not show an empty row with a zero on it.
      if (state.allianceDots.length) {
        appendLayerRow(fragment, {
          key: 'alliance_dots',
          label: LAYER_LABELS.alliance_dots,
          visible: deploymentsVisible && state.showAllianceDots,
          color: ALLIANCE_DOT_COLOR,
          count: String(state.allianceDots.length),
          seal: true,
          nested: true,
          title: layerCountTitle(state.allianceDots)
        });
      }
      appendLayerRow(fragment, {
        key: 'crises',
        label: LAYER_LABELS.crises,
        visible: crisesVisible,
        color: CRISIS_COLOR,
        count: String(state.crises.length),
        ring: true,
        title: layerCountTitle(state.crises)
      });
      // Human Rights Violations: landmarks with milestone tooltips, off by
      // default like every operational layer. A layer, not a category, so it
      // carries no category colour and never appears in a category filter.
      appendLayerRow(fragment, {
        key: 'human_rights',
        label: LAYER_LABELS.human_rights,
        visible: state.showHumanRights,
        color: HUMAN_RIGHTS_COLOR,
        count: String(state.humanRights.length),
        landmark: true,
        title: layerCountTitle(state.humanRights)
      });

    // Controls section at bottom of legend — reuse existing controls if present
    // (e.g., from initial markup or previous render) to keep event listeners stable.
    let controlsDiv = document.getElementById('map-legend-controls');
    let zoomInBtn = document.getElementById('zoom-in');
    let zoomOutBtn = document.getElementById('zoom-out');
    let resetBtn = document.getElementById('reset-view');
    let terminatorToggle = document.getElementById('terminator-toggle');
    let terminatorIcon = document.getElementById('terminator-icon');
    let terminatorLabel = document.getElementById('terminator-label');

    if (!controlsDiv) {
      controlsDiv = document.createElement('div');
      controlsDiv.id = 'map-legend-controls';
      controlsDiv.className = 'map-legend-controls';
      controlsDiv.setAttribute('role', 'group');
      controlsDiv.setAttribute('aria-label', 'Map controls');
    } else {
      // Clear existing children to rebuild
      controlsDiv.replaceChildren();
    }

    function setupButton(btn, id, className, ariaLabel, text, handler) {
      if (!btn) {
        btn = document.createElement('button');
        btn.id = id;
        btn.className = className;
        btn.setAttribute('aria-label', ariaLabel);
        btn.textContent = text;
      }
      // Always ensure handler is attached (idempotent via flag)
      const flag = '_handler_' + id;
      if (!btn[flag]) {
        btn[flag] = true;
        btn.addEventListener('click', handler);
      }
      return btn;
    }

    zoomInBtn = setupButton(zoomInBtn, 'zoom-in', 'map-control-btn', 'Zoom in', '+', () => zoomAt(state.width / 2, state.height / 2, 1.4));
    zoomOutBtn = setupButton(zoomOutBtn, 'zoom-out', 'map-control-btn', 'Zoom out', '−', () => zoomAt(state.width / 2, state.height / 2, 1 / 1.4));
    resetBtn = setupButton(resetBtn, 'reset-view', 'map-control-btn', 'Reset map view', '⟲', resetView);
    function setupTerminatorToggle(btn, icon) {
      if (btn._terminatorHandler) return; // already set up
      btn._terminatorHandler = true;
      btn.addEventListener('click', () => {
        state.showTerminator = !state.showTerminator;
        btn.setAttribute('aria-pressed', state.showTerminator);
        // Icon shows current state: ☾ = night overlay on, ☀ = off
        icon.textContent = state.showTerminator ? '☾' : '☀';
        draw();
      });
    }

    if (!terminatorToggle) {
      terminatorToggle = document.createElement('button');
      terminatorToggle.id = 'terminator-toggle';
      terminatorToggle.className = 'map-control-btn';
      terminatorIcon = document.createElement('span');
      terminatorIcon.id = 'terminator-icon';
      terminatorLabel = document.createElement('span');
      terminatorLabel.id = 'terminator-label';
      terminatorLabel.textContent = 'Day/Night';
      terminatorToggle.append(terminatorIcon, terminatorLabel);
    }
    setupTerminatorToggle(terminatorToggle, terminatorIcon);
    // Update terminator toggle state (in case it existed already)
    terminatorToggle.setAttribute('aria-pressed', state.showTerminator);
    // Icon shows what clicking will do: ☀ = will show day (turn off), ☾ = will show night (turn on)
    terminatorIcon.textContent = state.showTerminator ? '☾' : '☀';

    controlsDiv.append(zoomInBtn, zoomOutBtn, resetBtn, terminatorToggle);
    fragment.appendChild(controlsDiv);

    legendEl.replaceChildren(fragment);
  }

  // ---- Data loading ----
  let eventsAbortController = null;

  // Map a raw event.json entry to the internal shape, applying fallbacks for
  // every optional field so downstream rendering never hits placeholders.
  // Includes intelligent geocoding fallback for missing or invalid coordinates.
  function normalizeEvent(e) {
    let lat = e.geolocation?.lat;
    let lon = e.geolocation?.lon;
    // Accept the already-flattened form as well, so normalising is idempotent.
    //
    // This was a silent data-loss bug: normalise() rewrites geolocation into flat
    // lat/lon and drops the geolocation object, so normalising its own output a
    // second time found no coordinates at all, failed isPlottable() and discarded
    // every record. setEvents() is exposed, so handing it the current state back is
    // a legitimate thing to do, and it silently emptied the map.
    if (!Number.isFinite(lat) && Number.isFinite(e.lat)) lat = e.lat;
    if (!Number.isFinite(lon) && Number.isFinite(e.lon)) lon = e.lon;
    // Intelligent geocoding fallback if coordinates missing OR invalid (0,0 indicates missing)
    // Shares the one predicate, so "the pipeline said unlocated" and "the client
    // thinks these coordinates are fine" can never disagree.
    const hasValidCoords = hasPlottableCoords(lat, lon);
    // When the pipeline has already ruled on this record it says so explicitly
    // (`located: false`, emitted after running its full geocoding cascade).
    // Honouring that decision matters: the client-side table below is a third,
    // smaller copy of the institution hints and uses the older "first match in
    // source+title+category" rule, so a second opinion here could place a
    // milestone somewhere the pipeline deliberately did not - and would place it
    // worse. The fallback still runs for hand-authored or legacy payloads, which
    // carry no such flag.
    const pipelineLocated = e.located === false;
    if (!hasValidCoords && !pipelineLocated) {
      const geo = geocodeInstitution(e.source, e.title, e.category);
      if (geo) {
        lat = geo.lat;
        lon = geo.lon;
      }
    }
    // Built field by field rather than spread from `e`, so an upstream payload
    // cannot smuggle in a cached `_stackKey` (or any other internal flag) that
    // would make two different events collapse into one stack.
    return {
      id: e.id || `${lat},${lon},${e.title ?? 'Untitled'}`,
      lat,
      lon,
      title: e.title ?? 'Untitled',
      category: e.category ?? 'Unknown',
      // The sub-metric ("synthetic_biology", "gene_editing"), carried by
      // events.json. It is what answers "what specifically?" under the vertical,
      // and it used to live only in milestones.json - so the map, the one place a
      // reader meets a record without scrolling anywhere else, could not show it.
      subcategory: typeof e.subcategory === 'string' ? e.subcategory : '',
      value: e.value ?? '',
      source: e.source ?? 'Unknown',
      url: e.url ?? '',
      date: String(e.date ?? '')
    };
  }

  // Events without usable numeric coordinates or string title/category are not
  // renderable and must be dropped before drawing or stat/legend counting.
  // NaN/Infinity slips past typeof checks (1e400 parses to Infinity), so gate
  // on Number.isFinite and reject out-of-range coordinates too.
  // The one place coordinate bounds are written down. Milestones and the layer
  // pin both refuse the same inputs for the same reason, and a second copy of the
  // +/-90 / +/-180 pair is a second thing to forget to update.
  // How close to the origin counts as "not a real place". Must stay equal to
  // ORIGIN_EPSILON in scripts/location_contract.py - test_check_data.py's schema
  // parity suite fails the build if the two drift.
  const ORIGIN_EPSILON = 1e-6;

  // The single definition of a usable coordinate. Hand-mirrors
  // location_contract.is_located(), and every layer of the app goes through it:
  // milestones (isPlottable), layer entries (isLocatedCoord), and normalizeEvent's
  // "does this record need geocoding" test all used to carry their own copy, and one
  // of those copies did not reject the origin at all - so a payload the validator
  // rejected would still have plotted a dot in the Gulf of Guinea.
  function hasPlottableCoords(lat, lon) {
    if (typeof lat !== 'number' || typeof lon !== 'number') return false;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
    // Only the joint origin is ever the sentinel. (0, 140) Tokyo is a real place, so
    // this must not sweep up equatorial or prime-meridian coordinates.
    return !(Math.abs(lat) <= ORIGIN_EPSILON && Math.abs(lon) <= ORIGIN_EPSILON);
  }

  function isPlottable(ev) {
    return typeof ev.title === 'string' &&
      typeof ev.category === 'string' &&
      hasPlottableCoords(ev.lat, ev.lon);
  }

  // True only for a developer machine. Used to decide whether the fabricated
  // SAMPLE_EVENTS may be shown, so a deployed copy can never present invented
  // milestones as real ones. `location` is read defensively because this also runs
  // under a DOM stub in the test harness.
  const isLocalDev = (() => {
    try {
      const h = window.location && window.location.hostname;
      if (!h) return false;
      return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' ||
        h === '0.0.0.0' || h.endsWith('.localhost');
    } catch (_) {
      return false;
    }
  })();

  async function loadEvents() {
    if (eventsAbortController) eventsAbortController.abort();
    eventsAbortController = new AbortController();

    const eventsUrl = '/data/events.json';
    try {
      const r = await fetch(eventsUrl, { cache: 'no-store', signal: eventsAbortController.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (data && Array.isArray(data.events)) {
        state.events = data.events.map(normalizeEvent).filter(isPlottable);
        state.dataLoadError = null;
      } else {
        // Shape mismatch is a broken deploy, not an empty dataset. Say so rather
        // than rendering a blank map that looks like "no milestones yet".
        state.events = [];
        state.dataLoadError = 'events.json did not contain an "events" array';
        console.warn('[worldmap] ' + state.dataLoadError);
      }
      rebuildStackMap();
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Dev keeps a usable map while iterating; production must not invent data.
      if (isLocalDev) {
        state.events = SAMPLE_EVENTS;
        state.dataLoadError = null;
        console.warn('[worldmap] Failed to load events.json, using LOCAL DEV sample data:', err);
      } else {
        state.events = [];
        state.dataLoadError = 'milestone data is temporarily unavailable';
        console.warn('[worldmap] Failed to load events.json:', err);
      }
      rebuildStackMap();
    }
    renderDataNotice();
  }

  // Operational layers: conflict zones (dots) and tracked fleet movements
  // (direction arrows). Purely additive — safe to fall back to empty arrays.
  let layersAbortController = null;

  function normalizeZone(z) {
    // radiusDeg: coerce to a finite number and clamp to a sane range so a bad
    // value can never produce NaN pixels or a dot larger than a hemisphere.
    const rawR = Number(z.radiusDeg);
    const radiusDeg = Number.isFinite(rawR) && rawR > 0
      ? Math.min(Math.max(rawR, 0.5), 30)
      : 3;
    return {
      id: z.id || '',
      name: z.name || 'Unnamed zone',
      region: z.region || '',
      lat: z.lat,
      lon: z.lon,
      radiusDeg,
      status: z.status || 'active',
      start_date: z.start_date || '',
      end_date: z.end_date || '',
      source: z.source || '',
      url: z.url || '',
      note: z.note || '',
      actor: z.actor || '',
      // last_news_year MUST survive normalisation.
      //
      // This single missing field is why the Ukraine conflict zone rendered
      // dimmed while it was the most-reported active war zone on the map.
      // layerRecencyYear() reads `last_news_year` first and falls back to the
      // start year; the published file carries 2026 for Ukraine (ISW), but
      // normalise built a fresh object and left the field out, so the tier logic
      // fell through to start_date 2022 -> age 4 -> `quiet` -> no glow. Gaza and
      // the Red Sea were dimmed by exactly the same line of code. Every field the
      // renderer, the tier ladder or the tooltip can read has to be listed here,
      // because this function is the layer's only door into the payload.
      last_news_year: z.last_news_year
    };
  }

  function normalizeFleet(f) {
    const isInfantry = f.kind === 'infantry' || f.kind === 'mobilization' || f.kind === 'deployment' || f.kind === 'rotation';
    if (isInfantry) {
      // Infantry deployments have lat/lon instead of from/to
      return {
        id: f.id || '',
        label: f.name || f.label || 'Infantry Deployment',
        kind: f.kind,
        lat: f.lat,
        lon: f.lon,
        status: f.status || 'active',
        start_date: f.start_date || '',
        end_date: f.end_date || '',
        note: f.note || '',
        source: f.source || '',
        // url/country/region were dropped here, so the deployment popup could never
        // offer a source link or name the nation or region for a ground movement.
        url: f.url || '',
        country: f.country || '',
        region: f.region || '',
        actor: f.actor || '',
        troops: f.troops,
        direction: f.direction,
        last_news_year: f.last_news_year,
        radiusDeg: f.radiusDeg || 2
      };
    }
    // Fleet/ground movements have from/to
    return {
      id: f.id || '',
      label: f.label || 'Deployment',
      kind: f.kind === 'ground' ? 'ground' : 'fleet',
      from: f.from || {},
      to: f.to || {},
      status: f.status || 'active',
      start_date: f.start_date || f.date || '',
      end_date: f.end_date || '',
      note: f.note || '',
      source: f.source || '',
      url: f.url || '',
      actor: f.actor || '',
      last_news_year: f.last_news_year
    };
  }

  // The same Number.isFinite + range gate as isPlottable (1e400 Infinity slips
  // past typeof checks); bad layers draw NaN dots/arrows, so drop them first.
  function isZonePlottable(z) {
    return typeof z.name === 'string' &&
      Number.isFinite(z.lat) && z.lat >= -90 && z.lat <= 90 &&
      Number.isFinite(z.lon) && z.lon >= -180 && z.lon <= 180 &&
  hasPlottableCoords(z.lat, z.lon);
  }

  // Human rights entries share the zone shape so the tooltip builder can render
  // them like milestones. radiusDeg is dropped on purpose: these are landmarks,
  // not area rings.
  function normalizeHumanRight(h) {
    return {
      id: h.id || '',
      name: h.name || 'Unnamed report',
      region: h.region || '',
      lat: Number(h.lat),
      lon: Number(h.lon),
      status: h.status || 'active',
      start_date: h.start_date || '',
      end_date: h.end_date || '',
      source: h.source || '',
      url: h.url || '',
      note: h.note || ''
    };
  }

  function isHumanRightPlottable(h) {
    return isZonePlottable(h);
  }

  // A fleet arrow needs both endpoints valid; a missing/malformed endpoint
  // drops the whole movement instead of drawing a degenerate arrow. (0,0) is
  // the "unlocated" marker (same convention as normalizeEvent) and is rejected.
  const isLocatedCoord = (c) => hasPlottableCoords(c?.lat, c?.lon);

  function isFleetPlottable(f) {
    const isInfantry = f.kind === 'infantry' || f.kind === 'mobilization' || f.kind === 'deployment' || f.kind === 'rotation';
    if (isInfantry) {
      return isLocatedCoord({ lat: f.lat, lon: f.lon });
    }
    return isLocatedCoord(f?.from) && isLocatedCoord(f?.to);
  }

  async function loadLayers() {
    if (layersAbortController) layersAbortController.abort();
    layersAbortController = new AbortController();

    const layersUrl = '/data/world_layers.json';
    try {
      const r = await fetch(layersUrl, { cache: 'no-store', signal: layersAbortController.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      state.zones = Array.isArray(data.conflict_zones)
        ? data.conflict_zones.map(normalizeZone).filter(isZonePlottable)
        : [];
      state.crises = Array.isArray(data.crisis_zones)
        ? data.crisis_zones.map(normalizeZone).filter(isZonePlottable)
        : [];
      const deployments = data.deployments && Array.isArray(data.deployments)
        ? data.deployments
        : (data.fleet_movements && Array.isArray(data.fleet_movements) ? data.fleet_movements : []);
      state.fleets = deployments.map(normalizeFleet).filter(isFleetPlottable);
      // Alliance & defence-policy dots: a dot sublayer of the Ground & Fleet
      // Deployments datalayer (accessions, posture changes, mandates). Optional,
      // so a payload without the key yields an empty sublayer rather than an
      // error - the same additive contract the other layers have.
      state.allianceDots = Array.isArray(data.alliance_dots)
        ? data.alliance_dots.map(normalizeAllianceDot).filter(isAllianceDotPlottable)
        : [];
      rebuildAllianceDotIds();
      // Human Rights Violations: an operational layer, not a milestone category.
      // Landmarks, so they get milestone tooltips rather than a ring.
      state.humanRights = Array.isArray(data.human_rights_violations)
        ? data.human_rights_violations.map(normalizeHumanRight).filter(isHumanRightPlottable)
        : [];
      rebuildHumanRightStackMap();
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('[worldmap] Failed to load world_layers.json, using empty layers:', err);
      state.zones = [];
      state.fleets = [];
      state.allianceDots = [];
      state.allianceDotIds = new Set();
      state.crises = [];
      state.humanRights = [];
      rebuildHumanRightStackMap();
    }
  }

  // Alliance / defence-policy dots. A point event with a date and an
  // organisation attached ("Finland joined NATO"), which is why it is a dot and
  // not a ring or an arrow: there is no area to claim and no route to draw.
  function normalizeAllianceDot(d) {
    return {
      id: d.id || '',
      name: d.name || 'Unnamed policy change',
      region: d.region || '',
      lat: d.lat,
      lon: d.lon,
      // Which kind of change this is, used for the tooltip heading and for the
      // dot's accent: accession / posture / mandate / industrial.
      kind: d.kind || 'posture',
      status: d.status || 'active',
      start_date: d.start_date || '',
      end_date: d.end_date || '',
      source: d.source || '',
      url: d.url || '',
      note: d.note || '',
      actor: d.actor || '',
      country: d.country || '',
      last_news_year: d.last_news_year
    };
  }

  function isAllianceDotPlottable(d) {
    return typeof d.name === 'string' && hasPlottableCoords(d.lat, d.lon);
  }

  // Ids of the policy seals that replaced a movement arrow. Kept as a Set and
  // rebuilt whenever the dot list changes, so drawFleet/findDeployment can ask a
  // single question ("has this movement been promoted?") instead of rescanning the
  // dots per arrow per frame.
  let allianceDotIds = new Set();
  function rebuildAllianceDotIds() {
    allianceDotIds = new Set(state.allianceDots.map((d) => d.id).filter(Boolean));
    state.allianceDotIds = allianceDotIds;
  }

  // ---- Animation loop ----
  let lastDrawTime = 0;
  let animationFrameId = null;

  function loop() {
    if (document.hidden || prefersReducedMotion) {
      animationFrameId = null;
      return;
    }
    const now = Date.now();
    if (state.events.length && now - lastDrawTime >= DRAW_INTERVAL_MS) {
      draw();
      lastDrawTime = now;
    }
    animationFrameId = requestAnimationFrame(loop);
  }

  function onVisibilityChange() {
    if (!document.hidden) {
      if (!animationFrameId) animationFrameId = requestAnimationFrame(loop);
      if (state.showTerminator && state.events.length) draw();
    }
  }

let terminatorInterval = null;
function startTerminatorInterval() {
  if (prefersReducedMotion) return;
  if (terminatorInterval) clearInterval(terminatorInterval);
  terminatorInterval = setInterval(() => {
    if (!document.hidden && state.showTerminator && state.events.length) draw();
  }, TERMINATOR_UPDATE_MS);
}

// Cluster milestone events by year: only events dated in that year stay visible.
// Like filterLayersByYear, this is intentionally inert until the slider moves so
// a first-time visitor sees the whole milestone set.
function filterEventsByYear(year) {
  state.events.forEach(ev => {
    if (ev.date) {
      // Route through parseDateToISO (same accept-surface as the 7-day filter):
      // raw .slice(0,4) would misparse "15/03/2026" as the year 15.
      ev._hiddenByTimeline = parseInt((parseDateToISO(ev.date) || '').slice(0, 4), 10) !== year;
    } else {
      ev._hiddenByTimeline = false;
    }
  });
  // Stacks must track the slider, otherwise the count badge and the pager keep
  // paging through milestones the visitor cannot see.
  rebuildStackMap();
}

// Cluster the operational layers by year, mirroring how the slider clusters
// milestone events: still-active entries are plotted from their start year
// onward, concluded ones only inside their active window. Items are left
// untouched on first load so a fresh visitor sees the full set (consistent
// with the events behaviour — the slider only engages once moved).
function filterLayersByYear(year) {
  state.zones.forEach(z => { z._hiddenByTimeline = !layerVisibleInYear(z, year); });
  state.fleets.forEach(f => { f._hiddenByTimeline = !layerVisibleInYear(f, year); });
  state.crises.forEach(c => { c._hiddenByTimeline = !layerVisibleInYear(c, year); });
  // Policy seals carry the same start/end dates as the arrows, so the slider has
  // to reach them too - a 2023 accession must vanish when the handle moves to 2015.
  state.allianceDots.forEach(d => { d._hiddenByTimeline = !layerVisibleInYear(d, year); });
  // Landmarks are an operational layer too and carry the same start/end dates and
  // status as the zones above, so the slider has to reach them. It did not: nothing
  // ever set _hiddenByTimeline on these entries, which left every _hiddenByTimeline
  // check in drawHumanRightsLandmark, findHumanRight and visibleHumanRightClusters
  // permanently false. Moving the slider appeared to do nothing at all to this layer.
  state.humanRights.forEach(h => { h._hiddenByTimeline = !layerVisibleInYear(h, year); });
}

// Timeline slider initialization
function initTimelineSlider() {
  const timeline = document.getElementById('map-timeline');
  const track = document.getElementById('map-timeline-track');
  const handle = document.getElementById('map-timeline-handle');
  const yearsContainer = document.getElementById('map-timeline-years');
  
  if (!timeline || !track || !handle) return () => {};
  
  // Generate year labels
  renderTimelineYears();
  
  // Set initial handle position and APPLY filter on load so historical milestones respect slider
  updateTimelineHandle();
  applyTimelineFilter();
  
  // Mouse events
  let isDragging = false;
  
  function onPointerDown(e) {
    isDragging = true;
    e.preventDefault();
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  }
  
  function onPointerMove(e) {
    if (!isDragging) return;
    updateTimelineFromClientX(e.clientX);
  }
  
  function onPointerUp() {
    isDragging = false;
    document.body.style.userSelect = '';
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
  }
  
  function onTrackClick(e) {
    if (e.target === track) {
      updateTimelineFromClientX(e.clientX);
    }
  }
  
  // Register event listeners
  track.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointerdown', onPointerDown);
  track.addEventListener('click', onTrackClick);
  handle.addEventListener('keydown', onHandleKeydown);
  
  function onHandleKeydown(e) {
    let changed = false;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        timelineYear = Math.max(TIMELINE_MIN_YEAR, timelineYear - 1);
        changed = true;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        timelineYear = Math.min(getTimelineMaxYear(), timelineYear + 1);
        changed = true;
        break;
      case 'Home':
        timelineYear = TIMELINE_MIN_YEAR;
        changed = true;
        break;
      case 'End':
        timelineYear = getTimelineMaxYear();
        changed = true;
        break;
    }
    if (changed) {
      e.preventDefault();
      updateTimelineHandle();
      applyTimelineFilter();
    }
  }

  function updateTimelineFromClientX(clientX) {
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    timelineYear = Math.round(TIMELINE_MIN_YEAR + ratio * (getTimelineMaxYear() - TIMELINE_MIN_YEAR));
    updateTimelineHandle();
    applyTimelineFilter();
  }
  
  function updateTimelineHandle() {
    const ratio = (timelineYear - TIMELINE_MIN_YEAR) / (getTimelineMaxYear() - TIMELINE_MIN_YEAR);
    handle.style.left = `${ratio * 100}%`;
    timeline.setAttribute('aria-valuenow', Math.round(ratio * 100));
    // Update handle aria-label
    handle.setAttribute('aria-label', `Year ${timelineYear}`);
    // Update year label display
    const yearLabel = document.getElementById('map-timeline-year-label');
    if (yearLabel) {
      yearLabel.textContent = timelineYear;
    }
  }
  
  function renderTimelineYears() {
    if (!yearsContainer) return;
    yearsContainer.replaceChildren();
    const totalYears = getTimelineMaxYear() - TIMELINE_MIN_YEAR + 1;
    const step = Math.max(1, Math.ceil(totalYears / 25));
    for (let year = TIMELINE_MIN_YEAR; year <= getTimelineMaxYear(); year++) {
      if ((year - TIMELINE_MIN_YEAR) % step !== 0 && year !== getTimelineMaxYear()) continue;
      const label = document.createElement('span');
      label.textContent = year.toString();
      label.style.position = 'absolute';
      label.style.left = `${((year - TIMELINE_MIN_YEAR) / (getTimelineMaxYear() - TIMELINE_MIN_YEAR)) * 100}%`;
      label.style.transform = 'translateX(-50%)';
      label.style.fontSize = '0.55rem';
      label.style.fontFamily = 'var(--font-mono)';
      label.style.color = 'var(--fg-subtle)';
      label.style.whiteSpace = 'nowrap';
      label.style.pointerEvents = 'none';
      yearsContainer.appendChild(label);
    }
  }
  
  function applyTimelineFilter() {
    // Filter events by year and cluster the operational layers per year too.
    filterEventsByYear(timelineYear);
    filterLayersByYear(timelineYear);
    dismissTooltipIfTargetHidden();
    draw();
    updateStatsDisplay();
  }

  // Return cleanup function for timeline slider
  return function cleanupTimelineSlider() {
    track.removeEventListener('pointerdown', onPointerDown);
    handle.removeEventListener('pointerdown', onPointerDown);
    track.removeEventListener('click', onTrackClick);
    handle.removeEventListener('keydown', onHandleKeydown);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
  };
}

// ---- Init ----
  async function load() {
    await loadEvents();
    await loadLayers();
    updateStatsDisplay();
    renderLegend();
    resize();
    const resizeObserver = new ResizeObserver(scheduleResize);
  resizeObserver.observe(canvas.parentElement);
  window._mapResizeObserver = resizeObserver;
    document.addEventListener('visibilitychange', onVisibilityChange);
    animationFrameId = requestAnimationFrame(loop);
    startTerminatorInterval();

    // Initialize filter buttons. Listeners are attached per button, then the
    // brightness/pressed state is derived once from effective visibility so a
    // returning visitor whose saved flags and saved layer state disagree (filter
    // on, every layer off) does not start with a lit but empty tile.
    const filterRecentBtn = document.getElementById('filter-recent');
    const filterMilitaryBtn = document.getElementById('filter-military');
    if (filterRecentBtn) {
      filterRecentBtn.addEventListener('click', toggleFilterRecent);
    }
    if (filterMilitaryBtn) {
      filterMilitaryBtn.addEventListener('click', toggleFilterMilitary);
    }

    // Initialize crisis filter button
    const filterCrisisBtn = document.getElementById('filter-crisis');
    if (filterCrisisBtn) {
      filterCrisisBtn.addEventListener('click', toggleFilterCrisis);
    }
    syncFilterButtons();


    // Initialize timeline slider
    const cleanupTimelineSlider = initTimelineSlider();

    // Keep tooltip open while the pointer is over it so the source link is clickable
    if (tooltip) {
      tooltip.addEventListener('mouseenter', handleTooltipMouseEnter);
      tooltip.addEventListener('mouseleave', handleTooltipMouseLeave);
      // A press that begins on the popup is never a map pan. Clearing the press
      // origin stops handleMouseMove from treating a drag across the popup as a
      // canvas drag and hiding the very popup being dragged from.
      tooltip.addEventListener('mousedown', handleTooltipMouseDown);
    }
  }

  function handleTooltipMouseDown() {
    state.pressX = null;
    state.pressY = null;
  }

  function cleanup() {
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
    if (scheduledDrawId) { cancelAnimationFrame(scheduledDrawId); scheduledDrawId = null; }
    if (terminatorInterval) { clearInterval(terminatorInterval); terminatorInterval = null; }
    window.removeEventListener('beforeunload', flushAndStopGeocodeCache);
    window.removeEventListener('pagehide', flushAndStopGeocodeCache);
    if (geocodeCacheIntervalId) { clearInterval(geocodeCacheIntervalId); geocodeCacheIntervalId = null; }
    if (eventsAbortController) eventsAbortController.abort();
    if (layersAbortController) layersAbortController.abort();
    if (resizeTimeout) clearTimeout(resizeTimeout);
    if (window._mapResizeObserver) window._mapResizeObserver.disconnect();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    canvas.removeEventListener('mousemove', handleMouseMove);
    canvas.removeEventListener('mousedown', handleMouseDown);
    window.removeEventListener('mouseup', handleMouseUp);
    canvas.removeEventListener('dblclick', handleDblClick);
    canvas.removeEventListener('keydown', handleKeyDown);
    if (tooltip) {
      tooltip.removeEventListener('mouseenter', handleTooltipMouseEnter);
      tooltip.removeEventListener('mouseleave', handleTooltipMouseLeave);
      tooltip.removeEventListener('mousedown', handleTooltipMouseDown);
    }
    if (cleanupTimelineSlider) cleanupTimelineSlider();
    if (dataNoticeEl && dataNoticeEl.parentNode) dataNoticeEl.remove();
    dataNoticeEl = null;
  }

  // ---- Test hook (inert in production; enabled only when the harness pre-sets the flag) ----
  if (typeof window !== 'undefined' && window.__WORLDMAP_TEST__) {
    const existingTestHook = window.__WORLDMAP_TEST__;
    window.__WORLDMAP_TEST__ = {
      canonicalCategory,
  parseHiddenCategories,
  HIDDEN_CATEGORIES_MAX_BYTES,
      CATEGORY_COLORS,
      CATEGORY_STAT_MAP,
      CATEGORY_LEGEND,
      CATEGORY_ALIASES,
  CATEGORY_SUBTONES,
  landmarkColorFor,
  secondaryColorFor,
  HUMAN_RIGHTS_COLOR,
  HUMAN_RIGHTS_PULSE_MS,
  HUMAN_RIGHTS_HIT_RADIUS,
  HUMAN_RIGHTS_CORE_MAX,
  HUMAN_RIGHTS_GLOW_INNER,
  HUMAN_RIGHTS_GLOW_PULSE,
  normalizeHumanRight,
  isHumanRightPlottable,
  findHumanRight,
  areAllCategoriesHidden,
  toggleAllCategories,
  renderLegend,
  mapBox,
  mapScreenRect,
  project,
  // Resize synchronously and redraw. Tests need a canvas change to take effect
  // before the next assertion; the production path uses the debounced
  // scheduleResize() instead.
  resizeNow() { applyResize(); draw(); },
  humanRightStackFor,
  humanRightClusterSize,
  visibleHumanRightClusters,
  isNearAnchor,
  sameLocationCluster,
  PROXIMITY_RADIUS,
      normalizeEvent,
      parseGeocodeCache,
      SOURCE_URL_RE,
      isPlottable,
      normalizeZone,
      isZonePlottable,
      normalizeFleet,
      isFleetPlottable,
      // Alliance / defence-policy seal sublayer.
      normalizeAllianceDot,
      isAllianceDotPlottable,
      findAllianceDot,
      LAYER_LABELS,
      silverSweepDelay,
      ALLIANCE_DOT_COLOR,
      ALLIANCE_DOT_HEADINGS,
      // Responsible-actor resolution (nation / alliance / UN) + the flag glyph.
      resolveActor,
      flagGlyph,
      ACTOR_TABLE,
      // Anchor model, exposed so the tests can assert the hover/stick contract
      // without synthesising pointer events for every landmark type.
      findLandmarkAt,
      pinnedAnchor,
      hoverAnchor,
      anchorIsVisible,
      landmarkAnchorPoint,
      get allianceDots() { return state.allianceDots; },
      weekBoundsISO,
      isInCurrentWeek,
      get getTodayISO() {
        return existingTestHook?.getTodayISO ?? (() => new Date().toISOString().slice(0, 10));
      },
      getView: () => ({ ...state.transform }),
      setFilterRecent: (val) => { state.filterRecent = val; rebuildStackMap(); syncFilterButtons(); draw(); updateStatsDisplay(); renderLegend(); },
      setFilterMilitary: (val) => { state.filterMilitary = val; state.showZones = val; state.showFleets = val; syncFilterButtons(); draw(); updateStatsDisplay(); renderLegend(); },
      toggleLayer,
      militaryVisible,
      crisisVisible,
      // Layer lifecycle helpers + stats (fluo/concluded split).
      layerStatus,
      isLayerActive,
      layerActivityLabel,
      layerVisibleInYear,
      normalizeLayerDate,
      computeStats,
      layerCountTitle,
      isInfantryKind,
      fleetEndpoints,
      isStaleLayer,
      layerTier,
      layerPaintTier,
      layerRecencyYear,
      isSingleListSourced,
      LAYER_TIER_PAINT,
      LAYER_TIER_ARROW,
      get LAYER_FRESH_YEARS() { return LAYER_FRESH_YEARS; },
      get LAYER_STALE_YEARS() { return LAYER_STALE_YEARS; },
      isLocalDev,
      renderDataNotice,
      get SAMPLE_EVENTS() { return SAMPLE_EVENTS; },
      setDataLoadError: (msg) => { state.dataLoadError = msg; renderDataNotice(); },
      get dataLoadError() { return state.dataLoadError; },
      get GEOCODE_CACHE_MAX_BYTES() { return GEOCODE_CACHE_MAX_BYTES; },
      // Replace the loaded layer data (used to exercise fluo/dim + timeline
      // clustering deterministically without mutating the shared fixtures).
      // `allianceDots` is the odd one out: OMITTING it leaves the current seals in
      // place, and only an explicit array replaces them. The four positional
      // params above are all required, so "not passed" would otherwise silently
      // mean "empty" - and the first thing that does is a test that never heard
      // of the sublayer wiping it before asserting it exists.
      setLayers: (zones, fleets, crises, humanRights, allianceDots) => {
        state.zones = (zones || []).map(normalizeZone).filter(isZonePlottable);
        state.fleets = (fleets || []).map(normalizeFleet).filter(isFleetPlottable);
        state.crises = (crises || []).map(normalizeZone).filter(isZonePlottable);
        state.humanRights = (humanRights || []).map(normalizeHumanRight).filter(isHumanRightPlottable);
        if (allianceDots !== undefined) {
          state.allianceDots = allianceDots.map(normalizeAllianceDot).filter(isAllianceDotPlottable);
        }
        rebuildAllianceDotIds();
        rebuildHumanRightStackMap();
        // A docked landmark may not exist in the replacement data.
        if (state.selectedHumanRight
            && !state.humanRights.includes(state.selectedHumanRight)) {
          dismissTooltip();
        }
        if (state.selectedLayer
            && ![state.zones, state.fleets, state.crises, state.allianceDots]
              .some((list) => list.includes(state.selectedLayer))) {
          dismissTooltip();
        }
        updateStatsDisplay();
        renderLegend();
      },
      getLayers: () => ({
        zones: state.zones,
        fleets: state.fleets,
        crises: state.crises,
        humanRights: state.humanRights,
        allianceDots: state.allianceDots
      }),
      // Same pattern as setLayers but for milestone events (drives timeline
      // clustering tests deterministically).
      setEvents: (events) => {
        state.events = (events || []).map(normalizeEvent).filter(isPlottable);
        rebuildStackMap();
        draw();
        updateStatsDisplay();
        renderLegend();
      },
      getEvents: () => state.events,
      // Exposed so tests can reset transient hover/selection state, which is
      // anchored by design and would otherwise leak between them.
      getState: () => state,
      // Drive the same year-clustering code path as the timeline slider.
      setTimelineYear: (year) => {
        timelineYear = Math.max(TIMELINE_MIN_YEAR, Math.min(getTimelineMaxYear(), year));
        filterEventsByYear(timelineYear);
        filterLayersByYear(timelineYear);
        dismissTooltipIfTargetHidden();
        draw();
        updateStatsDisplay();
      },
      getTimelineYear: () => timelineYear,
      // Stack membership for one location (visit order) — what the count badge
      // and the pager are built from.
      stackForEvent,
      toggleCategory,
      // Pure geometry for the day/night terminator (deterministic tests): the
      // shared sunrise/sunset curve plus the unwrapped night band it feeds.
      buildTerminatorGeo,
      buildNightBand,
      // Screen projection + the default-view latitude window it crops to.
      project,
      get MAP_LAT_NORTH() { return MAP_LAT_NORTH; },
      get MAP_LAT_SOUTH() { return MAP_LAT_SOUTH; },
      get MAP_LAT_SPAN() { return MAP_LAT_SPAN; },
      get TERMINATOR_LAT_LIMIT() { return TERMINATOR_LAT_LIMIT; },
      get NIGHT_FILL() { return NIGHT_FILL; },
      // Pin the sun position (lat, lon) so day/night rendering is deterministic;
      // pass (null, null) to restore the live clock.
      setSunPosition: (lat, lon) => {
        state.sunPositionOverride = (lat === null && lon === null) ? null : { lat: lat || 0, lon: lon || 0 };
        draw();
      }
    };
  }

  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('pagehide', cleanup);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
