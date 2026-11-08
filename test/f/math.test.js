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
