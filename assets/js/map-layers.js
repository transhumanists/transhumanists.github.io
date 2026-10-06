/**
 * map-layers.js — role-gated operational layers for the transhumanists map
 *
 * Ported from neohiro/worldmap (`src/worldmap.js`), which is being removed.
 * That module was a general-purpose layer registry for a private dashboard;
 * this file keeps the parts the account site can actually use and drops the
 * rest. What survived, and why:
 *
 *   KEPT — role gating. auth-bar.js already resolves a viewer to one of
 *   public / user / assistant / godadmin, but the map ignored it: every
 *   operational layer was visible to everyone. The site's own data is all
 *   publishable, so nothing is gated *yet*; what was missing was the
 *   mechanism, so a layer can be restricted without a second refactor.
 *
 *   KEPT — payload validation. check_data.py validates world_layers.json at
 *   publish time, but that runs in CI against the committed file. A payload
 *   that is valid in git and invalid after a partial fetch (truncated body,
 *   stale cache, a proxy that rewrites JSON) reached the renderer unchecked.
 *   decodeLayerPayload rejects those instead of drawing them.
 *
 *   KEPT — count-adaptive viz. Human-rights violations arrive as landmark
 *   stacks; alliance dots and deployments as points. Below ~25 features
 *   markers are readable individually; above, they need clustering. The
 *   threshold rule came from the removed module.
 *
 *   DROPPED — the layer catalogue itself (46 layers over tailnet peers, BGP,
 *   OTX, Shodan, visitor heatmaps). Those are the private dashboard's
 *   concerns. This site publishes conflict zones, crises, deployments,
 *   alliance dots and human-rights violations, and that list lives in
 *   data/world_layers.json, not here.
 *
 *   DROPPED — the Cloudflare Pages Function and its KV viewport store. This
 *   site is GitHub Pages: no Functions runtime, no KV. Viewport persistence
 *   would need to be localStorage or not at all.
 *
 *   DROPPED — projectLatLon. worldmap.js has its own `project()` tuned for
 *   its canvas, with terminator and tilt handling. A second projection would
 *   disagree with the first at every pixel.
 *
 * No external dependencies. Every export is a pure function: no DOM, no
 * fetch, no globals. That is what made the original testable and it is what
 * keeps these assertions fast.
 */

// Must match the roles auth-bar.js can produce (auth-bar.js:181, network-ux.js:950).
// A role this table does not know is treated as the lowest privilege rather
// than trusted: an unrecognised role must never widen visibility.
export const ROLES = ['public', 'user', 'assistant', 'godadmin'];

export const ROLE_RANK = Object.freeze({
  public: 0,
  user: 1,
  assistant: 2,
  godadmin: 3,
});

export const VIZ_KINDS = ['pinpoint', 'cluster', 'stack'];

/**
 * LAYERS — the operational layers this site publishes.
 *
 * `minRole: 'public'` on every entry today. That is deliberate, not an
 * oversight: the data behind these layers is already public (it is published
 * to data/world_layers.json), so gating it would be theatre. The field exists
 * so restricting a layer later is a one-word edit rather than a redesign.
 *
 * `viz.kind`:
 *   pinpoint — one marker per feature
 *   cluster  — grid-clustered by zoom; for point-ish layers that accumulate
 *   stack    — the landmark stacks worldmap.js already draws for human rights
 */
export const LAYERS = Object.freeze({
  conflict_zones: {
    id: 'conflict_zones',
    label: 'Conflict zones',
    minRole: 'public',
    viz: { kind: 'pinpoint', color: '#ff6d8a', heatmap: true, heat_radius: 16 },
  },
  crisis_zones: {
    id: 'crisis_zones',
    label: 'Crisis zones',
    minRole: 'public',
    viz: { kind: 'pinpoint', color: '#b388ff', heatmap: true, heat_radius: 16 },
  },
  deployments: {
    id: 'deployments',
    label: 'Ground & Fleet Deployments',
    minRole: 'public',
    viz: { kind: 'cluster', color: '#ffb347', heatmap: true, heat_radius: 14 },
  },
  alliance_dots: {
    id: 'alliance_dots',
    label: 'Alliance & defence policy',
    minRole: 'public',
    // A dot sublayer of deployments: alliance accessions, posture changes,
    // mandates. It follows its parent's filter rather than having its own,
    // so it can never appear alone and be mistaken for a deployment.
    sublayerOf: 'deployments',
    viz: { kind: 'cluster', color: '#7de2d1', heatmap: false },
  },
  human_rights_violations: {
    id: 'human_rights_violations',
    label: 'Human rights violations',
    minRole: 'public',
    viz: { kind: 'stack', color: '#ff7043', heatmap: false },
  },
});

const LAYER_BY_ID = new Map(
  Object.values(LAYERS).map((l) => [l.id, l]),
);

/** Above this feature count, markers stop being individually readable. */
const CLUSTER_THRESHOLD = 25;
/** Above this, individual positions carry no meaning worth drawing. */
const HEATMAP_THRESHOLD = 500;

function rankOf(role) {
  // Unknown role -> lowest privilege. Never `|| ROLE_RANK[role]` on a lookup
  // that can miss: undefined would compare as falsy and read as "no access"
  // by accident rather than by decision.
  return Object.prototype.hasOwnProperty.call(ROLE_RANK, role)
    ? ROLE_RANK[role]
    : ROLE_RANK.public;
}

/** Every layer id, in registry order. */
export function listAllLayers() {
  return Object.values(LAYERS);
}

/** Look up one layer. Returns null for an unknown id. */
export function getLayerById(id) {
  return LAYER_BY_ID.get(id) || null;
}

/** Can this role see this layer? Unknown role and unknown layer are both no. */
export function canSeeLayer(role, layerId) {
  const layer = LAYER_BY_ID.get(layerId);
  if (!layer) return false;
  return rankOf(role) >= rankOf(layer.minRole);
}

/** The layers visible to a role, in registry order. */
export function getVisibleLayers(role) {
  return listAllLayers().filter((l) => canSeeLayer(role, l.id));
}

/**
 * Effective state for a layer: is it showing right now?
 *
 * An explicit `false` toggle always wins. Without that rule a layer could be
 * switched off and still render, because `active_overlay` would re-enable it.
 */
export function isLayerActive(role, layerId, prefs) {
  if (!canSeeLayer(role, layerId)) return false;
  const toggles = (prefs && prefs.layer_toggles) || {};
  const starred = (prefs && prefs.starred_layers) || [];
  const active = (prefs && prefs.active_overlay) || null;
  if (toggles[layerId] === false) return false;
  if (toggles[layerId] === true) return true;
  if (starred.includes(layerId)) return true;
  if (active === layerId) return true;
  return false;
}

/** Layer ids that should render for a role under the given prefs. */
export function resolveActiveLayers(role, prefs) {
  return getVisibleLayers(role)
    .filter((l) => isLayerActive(role, l.id, prefs))
    .map((l) => l.id);
}

/** Drop starred ids the role cannot see, preserving order. */
export function sanitizeStarred(role, starredIds) {
  return (starredIds || []).filter((id) => canSeeLayer(role, id));
}

/**
 * Merge a partial prefs update. Returns a new object; never mutates.
 *
 * Re-sanitises the starred list on *every* merge, not only when the update
 * carries one. That is the point: a prefs object persisted while someone held
 * a higher role must lose its now-inaccessible layers the moment they are
 * demoted, without waiting for them to touch the star control.
 */
export function mergePrefs(role, current, update) {
  const base = current || {
    starred_layers: [],
    active_overlay: null,
    layer_toggles: {},
  };
  const merged = { ...base, ...update };

  if (update && update.starred_layers !== undefined) {
    merged.starred_layers = Array.isArray(update.starred_layers)
      ? sanitizeStarred(role, update.starred_layers)
      : [];
  } else if (current && Array.isArray(current.starred_layers)) {
    merged.starred_layers = sanitizeStarred(role, current.starred_layers);
  }

  if (update && update.active_overlay !== undefined) {
    merged.active_overlay =
      update.active_overlay === null || canSeeLayer(role, update.active_overlay)
        ? update.active_overlay
        : null;
  }

  if (update && update.layer_toggles) {
    const toggles = { ...(base.layer_toggles || {}) };
    for (const [id, value] of Object.entries(update.layer_toggles)) {
      if (canSeeLayer(role, id)) toggles[id] = !!value;
    }
    merged.layer_toggles = toggles;
  }

  return merged;
}

/**
 * Validate one layer's features before they reach the renderer.
 *
 * Returns { ok: true, features } or { ok: false, error } — never throws, so a
 * caller in a fetch handler does not need a try/catch for bad data.
 *
 * Rejects, in order: a non-array, an unknown layer id, and out-of-range or
 * non-numeric coordinates. (0,0) is accepted here and filtered downstream by
 * worldmap.js's own plottability predicates, because null-island is a real
 * recorded position in Gulf of Guinea waters and only that file knows which
 * sentinel conventions apply to which layer.
 */
export function decodeLayerFeatures(layerId, features) {
  if (!Array.isArray(features)) {
    return { ok: false, error: 'features is not an array' };
  }
  if (!LAYER_BY_ID.has(layerId)) {
    return { ok: false, error: `unknown layer ${layerId}` };
  }
  const out = [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    if (!f || typeof f !== 'object') {
      return { ok: false, error: `feature[${i}] not an object` };
    }
    // Different layers carry different geometry: zones use lat/lon, alliance
    // dots and deployments the same, human-rights landmarks lat/lon too. The
    // contract is deliberately loose about *which* key, strict about the value.
    const lat = f.lat;
    const lon = f.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') {
      return { ok: false, error: `feature[${i}] missing numeric lat/lon` };
    }
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return { ok: false, error: `feature[${i}] lat/lon is NaN` };
    }
    if (lat < -90 || lat > 90) {
      return { ok: false, error: `feature[${i}] lat ${lat} out of range` };
    }
    if (lon < -180 || lon > 180) {
      return { ok: false, error: `feature[${i}] lon ${lon} out of range` };
    }
    out.push(f);
  }
  return { ok: true, features: out };
}

/**
 * Choose a render strategy from the layer's declared viz and the feature count.
 *
 * Two thresholds, both carried over from the removed module:
 *   <= 25    declared kind; every feature is individually meaningful
 *   <= 500   cluster if the layer can cluster, else declared kind
 *   > 500    heatmap where offered; positions stop being readable
 *
 * Returns null for an unknown layer, which callers treat as "draw nothing"
 * rather than defaulting to a kind that may not fit the data.
 */
export function pickViz(layerId, featureCount) {
  const layer = LAYER_BY_ID.get(layerId);
  if (!layer) return null;
  const base = layer.viz;
  const count = featureCount | 0;

  let kind = base.kind;
  if (count > HEATMAP_THRESHOLD && base.heatmap) {
    kind = 'heatmap';
  } else if (count > CLUSTER_THRESHOLD && base.kind === 'pinpoint') {
    kind = 'cluster';
  }

  return {
    kind,
    color: base.color,
    // A heatmap already encodes density; asking for the heat overlay on top of
    // it double-counts, so it is dropped when the kind IS heatmap.
    heatmap: !!base.heatmap && kind !== 'heatmap',
    heat_radius: base.heat_radius || 16,
  };
}

/**
 * Grid-cluster points for display. Equirectangular, zoom-dependent cell size.
 *
 * Cell size is pixels-per-degree derived from zoom, so the number of clusters
 * a layer produces is roughly constant as the user zooms — the same property
 * that keeps a scatter plot legible at every scale.
 *
 * Singletons pass through as pinpoints rather than becoming one-member
 * clusters, so a caller can distinguish "this is a real location" from "this
 * is an aggregate" without a second lookup.
 *
 * Pure: no DOM, no globals.
 */
export function clusterFeatures(features, opts) {
  const { zoom = 4 } = opts || {};
  if (!Array.isArray(features) || features.length === 0) return [];

  const PIXELS_PER_DEGREE = 0.5;
  const cellPx = Math.min(
    256,
    Math.max(4, 2 ** (22 - zoom) * PIXELS_PER_DEGREE),
  );
  const cellDeg = cellPx / PIXELS_PER_DEGREE;

  const cells = new Map();
  for (const f of features) {
    const cx = Math.floor(f.lon / cellDeg);
    const cy = Math.floor(f.lat / cellDeg);
    const key = `${cx},${cy}`;
    let bucket = cells.get(key);
    if (!bucket) {
      bucket = { count: 0, sumLat: 0, sumLon: 0, ids: [] };
      cells.set(key, bucket);
    }
    bucket.count += 1;
    bucket.sumLat += f.lat;
    bucket.sumLon += f.lon;
    bucket.ids.push(f.id);
  }

  const out = [];
  for (const [key, b] of cells) {
    if (b.count === 1) {
      out.push({
        kind: 'pinpoint',
        id: b.ids[0],
        lat: b.sumLat,
        lon: b.sumLon,
      });
    } else {
      out.push({
        kind: 'cluster',
        id: `cluster:${key}`,
        lat: b.sumLat / b.count,
        lon: b.sumLon / b.count,
        count: b.count,
      });
    }
  }
  return out;
}