// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import { toWorld, boundsOf, treeDistance, arcPoints } from '../../web/views/sky/math.js';

const load = (/** @type {string} */ name) =>
  fs.readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const events = load('plastic-modeling.events.jsonl');
const onto = foldAll(events);
const R = 'plastic-modeling';
const CEMENT = `${R}/tools/adhesives/plastic-cement`;
const CA = `${R}/tools/adhesives/ca-glue`;
const TOOLS = `${R}/tools`;
const KIT = `${R}/kits/injection-molded-kits`;

// ---------- treeDistance ----------

/** @param {(a: string, b: string, o: any) => number} fn @returns {string[]} problems */
function checkTreeDistance(fn) {
  const p = [];
  if (fn(CEMENT, CA, onto) !== 2) p.push(`siblings: ${fn(CEMENT, CA, onto)} != 2`);
  if (fn(CEMENT, TOOLS, onto) !== 2) p.push(`grandparent: ${fn(CEMENT, TOOLS, onto)} != 2`);
  const cross = onto.nodes[CEMENT].depth + onto.nodes[KIT].depth; // through the root
  if (fn(CEMENT, KIT, onto) !== cross) p.push(`cross-category: ${fn(CEMENT, KIT, onto)} != ${cross}`);
  if (fn(CEMENT, CA, onto) !== fn(CA, CEMENT, onto)) p.push('not symmetric');
  return p;
}

test('treeDistance: siblings 2, grandparent 2, different categories through the root', () => {
  assert.deepEqual(checkTreeDistance(treeDistance), []);
  assert.equal(treeDistance(CEMENT, CEMENT, onto), 0);
});

test('planted fault: a distance that counts only depth is caught', () => {
  const depthOnly = (/** @type {string} */ a, /** @type {string} */ b, /** @type {any} */ o) =>
    Math.abs(o.nodes[a].depth - o.nodes[b].depth);
  assert.ok(checkTreeDistance(depthOnly).length > 0);
});

test('treeDistance tolerates a missing parent and two roots', () => {
  const o = { nodes: {
    a: { parent: null }, a1: { parent: 'a' },
    b: { parent: null }, b1: { parent: 'b' },
    orphan: { parent: 'not-yet' },
  } };
  assert.equal(treeDistance('a1', 'b1', o), 3); // a1 -> a ~bridge~ b -> b1
  assert.ok(Number.isFinite(treeDistance('orphan', 'a1', o)));
});

// ---------- arcPoints ----------

/** @param {typeof arcPoints} fn @returns {string[]} */
function checkArc(fn) {
  const p = [];
  const close = (/** @type {number} */ x, /** @type {number} */ y) => Math.abs(x - y) < 1e-9;
  for (const height of [10, 40, 120]) {
    /** @type {[number, number, number]} */ const from = [-50, 0, 20];
    /** @type {[number, number, number]} */ const to = [70, 0, -30];
    const pts = fn(from, to, height);
    if (!pts[0].every((v, i) => close(v, from[i]))) p.push(`h=${height}: does not start at from`);
    if (!pts[pts.length - 1].every((v, i) => close(v, to[i]))) p.push(`h=${height}: does not end at to`);
    const apex = Math.max(...pts.map((q) => q[1]));
    if (!close(apex, height)) p.push(`h=${height}: apex ${apex}`);
  }
  return p;
}

test('arcPoints starts at from, ends at to, and peaks at the given height', () => {
  assert.deepEqual(checkArc(arcPoints), []);
  assert.equal(arcPoints([0, 0, 0], [1, 0, 0], 5).length, 25);
});

test('planted fault: an arc whose apex ignores the height is caught', () => {
  const fixed = (/** @type {any} */ f, /** @type {any} */ t, /** @type {number} */ _h, n = 24) =>
    arcPoints(f, t, 30, n);
  assert.ok(checkArc(/** @type {any} */ (fixed)).length > 0);
});

// ---------- toWorld ----------

test('toWorld centers the bounds and scales the larger side to size; y becomes z', () => {
  const b = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
  assert.deepEqual(toWorld({ x: 100, y: 50 }, b, 400), [0, 0, 0]);
  assert.deepEqual(toWorld({ x: 200, y: 100 }, b, 400), [200, 0, 100]);
  assert.deepEqual(toWorld({ x: 5, y: 5 }, { minX: 5, minY: 5, maxX: 5, maxY: 5 }, 400), [0, 0, 0]);
  assert.deepEqual(boundsOf(new Map()), { minX: 0, minY: 0, maxX: 0, maxY: 0 });
});

// ---------- truncate (lens analog labels) ----------
import { truncate } from '../../web/views/sky/math.js';

test('truncate keeps short text, cuts long text to at most max characters with an ellipsis', () => {
  assert.equal(truncate('mise en place'), 'mise en place');
  const long = 'deglazing the pan with a splash of dry white wine';
  const t = truncate(long, 30);
  assert.ok(t.length <= 30, t);
  assert.ok(t.endsWith('…'));
  assert.ok(long.startsWith(t.slice(0, -1)));
  assert.equal(truncate('x'.repeat(40), 30).length, 30);
});

// ---------- placeLabels (node label declutter) ----------
import { placeLabels } from '../../web/views/sky/math.js';

/** @param {typeof placeLabels} fn @returns {string[]} */
function checkPlace(fn) {
  const p = [];
  const box = (id, x, tier, dist, was = false) => ({ id, x, y: 100, w: 80, h: 15, tier, dist, was });
  // a and b overlap; c is clear. Category (tier 1) beats leaf (tier 3) even when farther away.
  const r1 = fn([box('leaf', 110, 3, 10), box('cat', 100, 1, 99), box('far', 400, 3, 50)]);
  if (!r1.has('cat') || r1.has('leaf') || !r1.has('far')) p.push(`priority/overlap: ${[...r1]}`);
  // Same tier: nearer wins.
  const r2 = fn([box('near', 100, 3, 5), box('farther', 120, 3, 50)]);
  if (!r2.has('near') || r2.has('farther')) p.push(`distance: ${[...r2]}`);
  // Tier 0 (hover/focus) always shows, even overlapping.
  const r3 = fn([box('cat', 100, 1, 1), box('hover', 105, 0, 9)]);
  if (!r3.has('hover')) p.push('hovered label hidden');
  // Hysteresis: a label already shown keeps its place against a slightly nearer newcomer.
  const r4 = fn([box('old', 100, 3, 20, true), box('new', 150, 3, 10)]);
  if (!r4.has('old')) p.push('shown label lost its place to a newcomer');
  return p;
}

test('placeLabels: priority, overlap, distance, hover always, hysteresis', () => {
  assert.deepEqual(checkPlace(placeLabels), []);
});

test('planted fault: a placer that ignores overlap is caught', () => {
  const all = (/** @type {any[]} */ c) => new Set(c.map((x) => x.id));
  assert.ok(checkPlace(/** @type {any} */ (all)).length > 0);
});
