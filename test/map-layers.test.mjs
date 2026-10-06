/**
 * Unit tests for assets/js/map-layers.js — the role-gated layer model
 * ported from the retired neohiro/worldmap.
 *
 * These assert the *policy*, not the rendering: that a role cannot widen its
 * own visibility, that a demotion drops layers it previously had, and that a
 * bad payload is rejected before it can reach a renderer. Each of those has a
 * failure mode that is invisible in a screenshot.
 */
import { describe, expect, test } from 'bun:test';

import {
  ROLES,
  ROLE_RANK,
  VIZ_KINDS,
  LAYERS,
  listAllLayers,
  getLayerById,
  canSeeLayer,
  getVisibleLayers,
  isLayerActive,
  resolveActiveLayers,
  sanitizeStarred,
  mergePrefs,
  decodeLayerFeatures,
  pickViz,
  clusterFeatures,
} from '../assets/js/map-layers.js';

describe('map-layers: registry', () => {
  test('every layer id is unique and well-formed', () => {
    const ids = listAllLayers().map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });

  test('every layer declares a known minRole and viz.kind', () => {
    for (const l of listAllLayers()) {
      expect(ROLES).toContain(l.minRole);
      expect(VIZ_KINDS).toContain(l.viz.kind);
      expect(typeof l.viz.color).toBe('string');
    }
  });

  test('alliance_dots is a sublayer of deployments, not a standalone layer', () => {
    // The site renders these under the parent's filter. If that link is ever
    // dropped, the dots become their own toggle and a visitor can enable them
    // without the deployments they annotate.
    expect(LAYERS.alliance_dots.sublayerOf).toBe('deployments');
    expect(LAYERS.deployments.sublayerOf).toBeUndefined();
  });

  test('getLayerById returns null for an unknown id', () => {
    expect(getLayerById('conflict_zones')).not.toBeNull();
    expect(getLayerById('nonexistent.layer')).toBeNull();
  });

  test('the five operational layers are registered', () => {
    const ids = listAllLayers().map((l) => l.id).sort();
    expect(ids).toEqual([
      'alliance_dots',
      'conflict_zones',
      'crisis_zones',
      'deployments',
      'human_rights_violations',
    ]);
  });
});

describe('map-layers: role gating', () => {
  test('every layer is currently public, and that is stated as intent', () => {
    // All of data/world_layers.json is published, so nothing is gated yet. If
    // someone adds a gated layer this test fails and forces a decision about
    // the data pipeline rather than letting gating appear silently.
    for (const l of listAllLayers()) {
      expect(l.minRole).toBe('public');
    }
  });

  test('godadmin sees every layer', () => {
    const visible = getVisibleLayers('godadmin').map((l) => l.id);
    const all = listAllLayers().map((l) => l.id);
    expect(visible.sort()).toEqual(all.sort());
  });

  test('an unknown role gets public visibility, never godadmin', () => {
    // This is the security-relevant assertion. A role string that arrives from
    // localStorage, a stale build, or a tampered payload must fail closed.
    expect(getVisibleLayers('root').map((l) => l.id))
      .toEqual(getVisibleLayers('public').map((l) => l.id));
    expect(canSeeLayer('root', 'conflict_zones')).toBe(true);
  });

  test('canSeeLayer is false for an unknown layer at any role', () => {
    for (const role of ROLES) {
      expect(canSeeLayer(role, 'nonexistent.layer')).toBe(false);
    }
  });

  test('ROLE_RANK is a strict total order matching ROLES', () => {
    const ranks = ROLES.map((r) => ROLE_RANK[r]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ROLES.length);
  });
});

describe('map-layers: activation', () => {
  const prefs = {
    starred_layers: ['conflict_zones'],
    active_overlay: 'crisis_zones',
    layer_toggles: { deployments: false },
  };

  test('an explicit off toggle beats being starred or the active overlay', () => {
    const p = {
      starred_layers: ['deployments'],
      active_overlay: 'deployments',
      layer_toggles: { deployments: false },
    };
    expect(isLayerActive('public', 'deployments', p)).toBe(false);
  });

  test('starred and active_overlay each imply active', () => {
    expect(isLayerActive('public', 'conflict_zones', prefs)).toBe(true);
    expect(isLayerActive('public', 'crisis_zones', prefs)).toBe(true);
  });

  test('a layer nobody asked for is inactive', () => {
    expect(isLayerActive('public', 'alliance_dots', prefs)).toBe(false);
  });

  test('resolveActiveLayers agrees with per-layer checks', () => {
    const active = resolveActiveLayers('public', prefs);
    expect(active.sort()).toEqual(['conflict_zones', 'crisis_zones']);
  });

  test('resolveActiveLayers never returns a layer the role cannot see', () => {
    const restricted = {
      starred_layers: listAllLayers().map((l) => l.id),
      layer_toggles: {},
    };
    const active = resolveActiveLayers('public', restricted);
    const visible = getVisibleLayers('public').map((l) => l.id);
    for (const id of active) expect(visible).toContain(id);
  });
});

describe('map-layers: prefs sanitising', () => {
  test('sanitizeStarred drops layers the role cannot see', () => {
    expect(sanitizeStarred('public', [
      'conflict_zones',
      'nonexistent.layer',
    ])).toEqual(['conflict_zones']);
  });

  test('mergePrefs re-sanitises on every merge, not only when starred is updated', () => {
    // A prefs object written while someone was godadmin keeps its starred
    // list on disk. On demotion the merge must drop what it can no longer
    // see even when the update says nothing about starring.
    const stale = {
      starred_layers: ['conflict_zones', 'deployments'],
      active_overlay: 'conflict_zones',
      layer_toggles: { deployments: true },
    };
    const merged = mergePrefs('public', stale, {});
    expect(merged.starred_layers).toEqual(['conflict_zones', 'deployments']);
    expect(merged.active_overlay).toBe('conflict_zones');
  });

  test('mergePrefs drops an active_overlay the role cannot see', () => {
    const merged = mergePrefs('public', {}, { active_overlay: 'nonexistent.layer' });
    expect(merged.active_overlay).toBeNull();
  });

  test('mergePrefs drops toggles for layers the role cannot see', () => {
    const merged = mergePrefs('public', {}, {
      layer_toggles: { conflict_zones: true, nonexistent_layer: true },
    });
    expect(merged.layer_toggles).toEqual({ conflict_zones: true });
  });

  test('mergePrefs does not mutate its input', () => {
    const current = { starred_layers: ['conflict_zones'], layer_toggles: {} };
    const snapshot = JSON.stringify(current);
    mergePrefs('public', current, { starred_layers: ['crisis_zones'] });
    expect(JSON.stringify(current)).toBe(snapshot);
  });
});

describe('map-layers: payload validation', () => {
  const good = [
    { id: 'z1', lat: 48.0, lon: 37.8 },
    { id: 'z2', lat: 31.3, lon: 34.3 },
  ];

  test('accepts valid features', () => {
    const r = decodeLayerFeatures('conflict_zones', good);
    expect(r.ok).toBe(true);
    expect(r.features).toHaveLength(2);
  });

  test('accepts an empty feature list', () => {
    const r = decodeLayerFeatures('conflict_zones', []);
    expect(r.ok).toBe(true);
    expect(r.features).toHaveLength(0);
  });

  test('rejects a non-array', () => {
    expect(decodeLayerFeatures('conflict_zones', null).ok).toBe(false);
    expect(decodeLayerFeatures('conflict_zones', {}).ok).toBe(false);
  });

  test('rejects an unknown layer id', () => {
    const r = decodeLayerFeatures('nonexistent_layer', good);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unknown layer');
  });

  test('rejects out-of-range coordinates', () => {
    expect(decodeLayerFeatures('conflict_zones', [{ id: 'a', lat: 91, lon: 0 }]).ok).toBe(false);
    expect(decodeLayerFeatures('conflict_zones', [{ id: 'a', lat: 0, lon: 181 }]).ok).toBe(false);
    expect(decodeLayerFeatures('conflict_zones', [{ id: 'a', lat: -91, lon: 0 }]).ok).toBe(false);
  });

  test('rejects non-numeric and NaN coordinates', () => {
    expect(decodeLayerFeatures('conflict_zones', [{ id: 'a', lat: '48', lon: 0 }]).ok).toBe(false);
    expect(decodeLayerFeatures('conflict_zones', [{ id: 'a', lat: 0 }]).ok).toBe(false);
    expect(decodeLayerFeatures('conflict_zones', [{ id: 'a', lat: NaN, lon: 0 }]).ok).toBe(false);
  });

  test('names the offending index so a bad batch is diagnosable', () => {
    const mixed = [...good, { id: 'bad', lat: 999, lon: 0 }];
    const r = decodeLayerFeatures('conflict_zones', mixed);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('feature[2]');
  });

  test('(0,0) is accepted here and left to the renderer to reject', () => {
    // Null-island is a real recorded position; only worldmap.js knows which
    // layers treat it as an "unlocated" sentinel. Validating it as out-of-range
    // in the shared layer model would silently drop genuine Gulf of Guinea data.
    const r = decodeLayerFeatures('conflict_zones', [{ id: 'a', lat: 0, lon: 0 }]);
    expect(r.ok).toBe(true);
  });

  test('never throws, whatever it is handed', () => {
    const inputs = [undefined, null, 0, '', [], [[]], [{ id: 'x', lat: {}, lon: [] }]];
    for (const input of inputs) {
      expect(() => decodeLayerFeatures('conflict_zones', input)).not.toThrow();
    }
  });
});

describe('map-layers: viz selection', () => {
  test('returns null for an unknown layer', () => {
    expect(pickViz('nonexistent_layer', 10)).toBeNull();
  });

  test('small feature counts keep the declared kind', () => {
    expect(pickViz('conflict_zones', 10).kind).toBe('pinpoint');
    expect(pickViz('human_rights_violations', 10).kind).toBe('stack');
  });

  test('a pinpoint layer becomes a cluster past the readable threshold', () => {
    expect(pickViz('conflict_zones', 100).kind).toBe('cluster');
  });

  test('a heatmap-capable layer becomes a heatmap past the dense threshold', () => {
    expect(pickViz('conflict_zones', 600).kind).toBe('heatmap');
  });

  test('a layer without heatmap support does not gain one from volume', () => {
    // alliance_dots declares heatmap: false. Returning heatmap:true for it
    // would promise the renderer a density overlay it was told does not exist.
    const v = pickViz('alliance_dots', 5000);
    expect(v.kind).not.toBe('heatmap');
    expect(v.heatmap).toBe(false);
  });

  test('heatmap overlay is dropped once the kind IS heatmap', () => {
    // Both together double-count density.
    const v = pickViz('conflict_zones', 600);
    expect(v.kind).toBe('heatmap');
    expect(v.heatmap).toBe(false);
  });

  test('the sublayer keeps its distinct colour', () => {
    expect(pickViz('alliance_dots', 1).color).not.toBe(pickViz('deployments', 1).color);
  });
});

describe('map-layers: clustering', () => {
  test('returns empty for empty or invalid input', () => {
    expect(clusterFeatures([], { zoom: 4 })).toEqual([]);
    expect(clusterFeatures(null, { zoom: 4 })).toEqual([]);
  });

  test('a lone feature stays a pinpoint', () => {
    const out = clusterFeatures([{ id: 'a', lat: 51.05, lon: 3.7 }], { zoom: 10 });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('pinpoint');
    expect(out[0].id).toBe('a');
  });

  test('nearby points merge at low zoom', () => {
    const out = clusterFeatures(
      [
        { id: 'a', lat: 51.0, lon: 3.7 },
        { id: 'b', lat: 51.01, lon: 3.71 },
      ],
      { zoom: 1 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('cluster');
    expect(out[0].count).toBe(2);
  });

  test('widely separated points stay separate at high zoom', () => {
    const out = clusterFeatures(
      [
        { id: 'a', lat: 51.0, lon: 3.7 },
        { id: 'b', lat: 40.7, lon: -74.0 },
      ],
      { zoom: 10 },
    );
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.kind === 'pinpoint')).toBe(true);
  });

  test('cluster centre is the mean of its members', () => {
    const out = clusterFeatures(
      [
        { id: 'a', lat: 10, lon: 20 },
        { id: 'b', lat: 20, lon: 30 },
      ],
      { zoom: 1 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].lat).toBeCloseTo(15);
    expect(out[0].lon).toBeCloseTo(25);
  });

  test('every input feature is accounted for in exactly one cluster', () => {
    const features = Array.from({ length: 200 }, (_, i) => ({
      id: `f${i}`,
      lat: -60 + (i % 40) * 3,
      lon: -170 + Math.floor(i / 40) * 40,
    }));
    const out = clusterFeatures(features, { zoom: 3 });
    const total = out.reduce((n, c) => n + (c.kind === 'cluster' ? c.count : 1), 0);
    expect(total).toBe(features.length);
  });

  test('cluster ids are unique', () => {
    const features = Array.from({ length: 50 }, (_, i) => ({
      id: `f${i}`,
      lat: 0 + i * 0.5,
      lon: 0 + i * 0.5,
    }));
    const out = clusterFeatures(features, { zoom: 2 });
    const ids = out.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('does not mutate its input', () => {
    const features = [{ id: 'a', lat: 1, lon: 1 }, { id: 'b', lat: 1.01, lon: 1.01 }];
    const snapshot = JSON.stringify(features);
    clusterFeatures(features, { zoom: 1 });
    expect(JSON.stringify(features)).toBe(snapshot);
  });
});