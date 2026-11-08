// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import * as tokens from '../../web/shared/tokens.js';
import { registerView, listViews } from '../../web/shared/view.js';

const ORIGINS = ['seed', 'context', 'general', 'fuse', 'rosetta'];
const EDGE_TYPES = ['influences', 'requires', 'part-of', 'bridge', 'analog'];

/**
 * Returns a list of problems found in a tokens module.
 * @param {any} t
 * @returns {string[]}
 */
export function checkTokens(t) {
  /** @type {string[]} */
  const problems = [];
  for (const origin of ORIGINS) {
    for (const sourced of [true, false]) {
      const v = t.originOutline(origin, sourced);
      if (v === undefined || v === null || typeof v.stroke !== 'string' || !v.stroke) {
        problems.push(`originOutline(${origin}, ${sourced}) returned no value`);
      }
    }
  }
  for (const type of EDGE_TYPES) {
    const v = t.edgeStyle(type);
    if (!v || !v.color) problems.push(`edgeStyle(${type}) returned no value`);
  }
  for (let f = 0; f < 3; f++) {
    for (let i = 0; i < 12; i++) {
      const c = t.categoryColor(i, f);
      if (typeof c !== 'string' || !c) problems.push(`categoryColor(${i}, ${f}) returned no value`);
    }
  }
  return problems;
}

test('real tokens module has no problems', () => {
  assert.deepEqual(checkTokens(tokens), []);
});

test('planted fault: missing rosetta outline is reported', () => {
  const fake = {
    ...tokens,
    originOutline: (/** @type {string} */ o, /** @type {boolean} */ s) =>
      o === 'rosetta' ? undefined : tokens.originOutline(o, s),
  };
  const problems = checkTokens(fake);
  assert.ok(problems.length > 0);
  assert.ok(problems.some((p) => p.includes('rosetta')));
});

test('category colors distinct and family-shifted', () => {
  const f0 = Array.from({ length: 12 }, (_, i) => tokens.categoryColor(i, 0));
  assert.equal(new Set(f0).size, 12);
  for (let i = 0; i < 12; i++) assert.notEqual(tokens.categoryColor(i, 1), f0[i]);
  assert.equal(tokens.categoryColor(12), f0[0]);
  assert.equal(tokens.categoryColor(-3), f0[0]);
  assert.equal(tokens.categoryColor(NaN), f0[0]);
  assert.equal(tokens.categoryColor(1, 2), tokens.categoryColor(7, 2));
});

test('nodeRadius', () => {
  assert.equal(tokens.nodeRadius(0), 5);
  assert.equal(tokens.nodeRadius(1e9), 22);
  assert.equal(tokens.nodeRadius(-4), 5);
  assert.equal(tokens.nodeRadius(NaN), 5);
  let prev = 0;
  for (const d of [0, 1, 2, 5, 10, 50, 500, 1e6]) {
    const r = tokens.nodeRadius(d);
    assert.ok(r >= prev);
    prev = r;
  }
});

test('origin rules', () => {
  assert.equal(tokens.originOutline('context', true).dash, null);
  assert.notEqual(tokens.originOutline('general', true).dash, null);
  assert.equal(tokens.originOutline('fuse', true).double, true);
  for (const o of ['general', 'context']) {
    assert.deepEqual(tokens.originOutline(o, false).dash, [1, 3]);
  }
  assert.equal(tokens.originOutline('seed', false).dash, null);
  assert.ok(tokens.originOutline('nonsense', true).stroke);
});

test('edge styles distinct', () => {
  const s = EDGE_TYPES.map((t) => JSON.stringify(tokens.edgeStyle(t)));
  assert.equal(new Set(s).size, EDGE_TYPES.length);
  assert.ok(tokens.edgeStyle('wat').color);
});

test('depthLightness', () => {
  let prev = -Infinity;
  for (const d of [-5, 0, 1, 2, 3, 4, 5, 100, 1e9, Infinity, NaN, -Infinity]) {
    const v = tokens.depthLightness(d);
    assert.ok(!Number.isNaN(v));
  }
  for (const d of [0, 1, 2, 3, 4, 5, 50]) {
    const v = tokens.depthLightness(d);
    assert.ok(v >= prev);
    prev = v;
  }
  assert.equal(tokens.depthLightness(4), tokens.depthLightness(99));
});

test('view registry', () => {
  registerView('a', 'A', 'x-a');
  registerView('b', 'B', 'x-b');
  assert.deepEqual(listViews().map((v) => v.id), ['a', 'b']);
  registerView('a', 'A2', 'x-a2');
  const l = listViews();
  assert.equal(l.length, 2);
  assert.equal(l[0].label, 'A2');
  l.pop();
  assert.equal(listViews().length, 2);
});
