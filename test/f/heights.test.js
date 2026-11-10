// @ts-check
// Height modes in the 3D view: learning order, coverage, connectedness. Pure, deterministic, in [0, 1].
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import {
  learningLevels, coverageScores, linkDegrees, normalise, heightsFor, easeToward, arcLift, DEPTH_WEIGHT, HEIGHT_MODES,
} from '../../web/views/sky/heights.js';

const onto = foldAll(fs.readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));

/** A small map: root r, categories a, b; a has children a1, a2; b has b1. */
function tiny(edges = /** @type {{ from: string, to: string, type: string }[]} */ ([]), extra = {}) {
  const n = (/** @type {string} */ id, /** @type {string|null} */ parent, /** @type {number} */ depth, o = {}) =>
    ({ id, parent, depth, status: 'done', article: null, sources: [], ...o });
  return {
    nodes: {
      r: n('r', null, 0), a: n('a', 'r', 1), b: n('b', 'r', 1),
      a1: n('a1', 'a', 2), a2: n('a2', 'a', 2), b1: n('b1', 'b', 2),
      ...extra,
    },
    edges: edges.map((e, i) => ({ id: `e${i}`, ...e })),
  };
}
const inUnit = (/** @type {Map<string, number>} */ m) => [...m.values()].every((v) => Number.isFinite(v) && v >= 0 && v <= 1);

// ---------- learning order ----------

/** @param {typeof learningLevels} fn @returns {string[]} */
function checkLearning(fn) {
  const p = [];
  // No links: tree depth is the base, so the map still reads (root lowest, leaves highest).
  const flat = fn(tiny());
  if (flat.get('r') !== 0) p.push(`root ${flat.get('r')} != 0`);
  if (flat.get('a1') !== 2 * DEPTH_WEIGHT) p.push(`a1 ${flat.get('a1')} != depth base`);
  // a1 requires-> b1 ("b1 needs a1 first"), b1 -> a: a chain lifts each above the one before it.
  const chain = fn(tiny([{ from: 'a1', to: 'b1', type: 'requires' }, { from: 'b1', to: 'a', type: 'requires' }]));
  if (!(/** @type {number} */ (chain.get('b1')) >= /** @type {number} */ (chain.get('a1')) + 1)) p.push('b1 not a level above a1');
  if (!(/** @type {number} */ (chain.get('a')) >= /** @type {number} */ (chain.get('b1')) + 1)) p.push('a not a level above b1');
  // Other kinds do not count.
  const other = fn(tiny([{ from: 'a1', to: 'b1', type: 'influences' }]));
  if (other.get('b1') !== flat.get('b1')) p.push('an influences link moved b1');
  return p;
}

test('learningLevels: depth is the base; a requires link puts the needer at least one level above', () => {
  assert.deepEqual(checkLearning(learningLevels), []);
});

test('planted fault: a layering that reads requires backwards is caught', () => {
  /** @type {typeof learningLevels} */
  const backwards = (o) => learningLevels({ ...o, edges: (o.edges || []).map((e) => ({ ...e, from: e.to, to: e.from })) });
  assert.ok(checkLearning(backwards).some((x) => x.includes('not a level above')));
});

test('learningLevels: a cycle is broken deterministically, whatever the edge order', () => {
  const cyc = [{ from: 'a1', to: 'a2', type: 'requires' }, { from: 'a2', to: 'b1', type: 'requires' }, { from: 'b1', to: 'a1', type: 'requires' }];
  const one = learningLevels(tiny(cyc));
  const two = learningLevels(tiny([...cyc].reverse()));
  assert.deepEqual([...one].sort(), [...two].sort());
  for (const v of one.values()) assert.ok(Number.isFinite(v));
  // The walk starts at a1 (sorted first) and drops b1 -> a1: the chain a1 < a2 < b1 survives.
  assert.ok(/** @type {number} */ (one.get('a2')) > /** @type {number} */ (one.get('a1')));
  assert.ok(/** @type {number} */ (one.get('b1')) > /** @type {number} */ (one.get('a2')));
  // Self-links and links to unknown nodes are ignored.
  const odd = learningLevels(tiny([{ from: 'a1', to: 'a1', type: 'requires' }, { from: 'ghost', to: 'a1', type: 'requires' }]));
  assert.equal(odd.get('a1'), 2 * DEPTH_WEIGHT);
});

test('learningLevels: a long chain is fine (no recursion limit)', () => {
  /** @type {Record<string, any>} */
  const nodes = { r: { parent: null, depth: 0 } };
  const edges = [];
  for (let i = 0; i < 20000; i++) {
    nodes[`n${i}`] = { parent: 'r', depth: 1 };
    if (i) edges.push({ from: `n${i - 1}`, to: `n${i}`, type: 'requires' });
  }
  const lv = learningLevels({ nodes, edges });
  assert.equal(lv.get('n19999'), 19999 + DEPTH_WEIGHT);
});

test('learning heights on the fixture: in [0, 1], the highest is 1, every requires link climbs', () => {
  const h = /** @type {Map<string, number>} */ (heightsFor('learning', onto));
  assert.equal(h.size, Object.keys(onto.nodes).length);
  assert.ok(inUnit(h));
  assert.equal(Math.max(...h.values()), 1);
  const req = onto.edges.filter((e) => e.type === 'requires');
  assert.ok(req.length > 0);
  // The fixture's requires links have no cycle, so every one climbs.
  for (const e of req) assert.ok(/** @type {number} */ (h.get(e.to)) > /** @type {number} */ (h.get(e.from)), `${e.from} -> ${e.to}`);
});

// ---------- coverage ----------

test('coverage: an explained, sourced node with researched children sits above a thin one; pending is unexplored', () => {
  const art = { summary: 's', body: 'b', seeAlso: [], sources: [{ url: 'u1' }, { url: 'u2' }] };
  const o = tiny([], {
    a1: { id: 'a1', parent: 'a', depth: 2, status: 'done', article: art, sources: [{ url: 'u1' }, { url: 'u2' }] },
    a2: { id: 'a2', parent: 'a', depth: 2, status: 'done', article: art, sources: [{ url: 'u3' }] },
    b1: { id: 'b1', parent: 'b', depth: 2, status: 'pending', article: null, sources: [] },
  });
  const c = coverageScores(o);
  assert.ok(inUnit(c));
  const g = (/** @type {string} */ k) => /** @type {number} */ (c.get(k));
  assert.ok(g('a1') > g('b1'), 'explained leaf above a pending leaf');
  assert.ok(g('a') > g('b'), 'a branch with researched children above one without');
  // Unsmoothed, a pending leaf is exactly 0.
  assert.equal(coverageScores(o, { smooth: 0 }).get('b1'), 0);
  // Smoothing keeps each node its own height (not one flat average) yet pulls neighbours together.
  const raw = coverageScores(o, { smooth: 0 });
  assert.notEqual(g('a1'), g('a'));
  assert.ok(Math.abs(g('a1') - g('a')) <= Math.abs(/** @type {number} */ (raw.get('a1')) - /** @type {number} */ (raw.get('a'))) + 1e-12);
});

test('planted fault: coverage that ignores the article is caught', () => {
  const art = { summary: 's', body: 'b', seeAlso: [], sources: [] };
  const o = tiny([], { a1: { id: 'a1', parent: 'a', depth: 2, status: 'done', article: art, sources: [] } });
  const blind = coverageScores({ ...o, nodes: Object.fromEntries(Object.entries(o.nodes).map(([k, n]) => [k, { ...n, article: null }])) }, { smooth: 0 });
  const real = coverageScores(o, { smooth: 0 });
  assert.ok(/** @type {number} */ (real.get('a1')) > /** @type {number} */ (real.get('a2')));
  assert.equal(blind.get('a1'), blind.get('a2'), 'the blind version cannot tell them apart');
});

test('coverage on the fixture is in [0, 1] and deterministic', () => {
  const a = coverageScores(onto), b = coverageScores(onto);
  assert.ok(inUnit(a));
  assert.deepEqual([...a], [...b]);
});

// ---------- connectedness ----------

test('connectedness: degree counts both ends, bridges weigh more, sqrt keeps a hub from flattening the rest', () => {
  const edges = [];
  for (const t of ['a', 'b', 'a2', 'b1']) edges.push({ from: 'a1', to: t, type: 'influences' });
  edges.push({ from: 'a2', to: 'b1', type: 'bridge' });
  const o = tiny(edges);
  const d = linkDegrees(o);
  assert.equal(d.get('a1'), 4);
  assert.equal(d.get('a2'), 2.5);
  assert.equal(d.get('r'), 0);
  const h = /** @type {Map<string, number>} */ (heightsFor('connectedness', o));
  assert.equal(h.get('a1'), 1);
  assert.equal(h.get('r'), 0);
  assert.ok(Math.abs(/** @type {number} */ (h.get('a')) - Math.sqrt(1 / 4)) < 1e-12, 'sqrt-scaled, not linear');
  assert.ok(inUnit(h));
});

// ---------- edge cases for every mode ----------

test('every mode: no links, a single node, an empty map, and Off', () => {
  const single = { nodes: { r: { parent: null, depth: 0, status: 'done', article: null, sources: [] } }, edges: [] };
  for (const mode of HEIGHT_MODES.filter((m) => m !== 'off')) {
    const none = /** @type {Map<string, number>} */ (heightsFor(mode, tiny()));
    assert.ok(inUnit(none), mode);
    const one = /** @type {Map<string, number>} */ (heightsFor(mode, single));
    assert.equal(one.size, 1);
    assert.ok(inUnit(one), mode);
    assert.equal(/** @type {Map<string, number>} */ (heightsFor(mode, { nodes: {}, edges: [] })).size, 0);
  }
  // No links: connectedness is flat zero; learning is the depth base with the root at 0.
  assert.ok([.../** @type {Map<string, number>} */ (heightsFor('connectedness', tiny())).values()].every((v) => v === 0));
  assert.equal(/** @type {Map<string, number>} */ (heightsFor('learning', tiny())).get('r'), 0);
  assert.equal(heightsFor('off', onto), null);
  assert.equal(heightsFor('nonsense', onto), null);
});

test('normalise: all zero stays zero, curve applied before dividing', () => {
  assert.deepEqual([...normalise(new Map([['a', 0], ['b', 0]]))], [['a', 0], ['b', 0]]);
  assert.deepEqual([...normalise(new Map([['a', 1], ['b', 4]]), Math.sqrt)], [['a', 0.5], ['b', 1]]);
});

// ---------- animation and arcs ----------

test('easeToward: moves toward the target, framerate-independent, and lands exactly', () => {
  const two = easeToward(easeToward(0, 100, 16), 100, 16);
  const one = easeToward(0, 100, 32);
  assert.ok(Math.abs(two - one) < 1e-9);
  let v = 0;
  for (let i = 0; i < 200; i++) v = easeToward(v, 100, 16);
  assert.equal(v, 100);
  v = 50;
  for (let i = 0; i < 200; i++) v = easeToward(v, 0, 16);
  assert.equal(v, 0, 'Off lands exactly on the floor');
});

test('arcLift: an arc between very different heights still crests above both ends', () => {
  assert.equal(arcLift(80, 10, 12), 80, 'close ends keep their own height');
  const h = arcLift(40, 0, 180);
  const crest = (0 + 180) / 2 + h;
  assert.ok(crest > 180);
});
