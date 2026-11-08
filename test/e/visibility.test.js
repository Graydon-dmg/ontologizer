// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import * as real from '../../web/views/graph/math.js';

const events = readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const onto = foldAll(events);
const nodes = Object.values(onto.nodes);
const tools = /** @type {any} */ (nodes.find((n) => n.label === 'Tools' && n.depth === 1));
const root = onto.nodes[onto.root];

/** @param {() => void} fn */
const throws = (fn) => { try { fn(); } catch { return true; } return false; };
/** @param {(m: any) => void} check @param {any} impl @param {any} faulty */
function checkCatches(check, impl, faulty) {
  check(impl);
  assert.ok(throws(() => check(faulty)), 'planted fault was not caught');
}
const below = (/** @type {string} */ id) => nodes.filter((n) => n.id.startsWith(id + '/')).map((n) => n.id).sort();
const none = { categories: null, maxDepth: null };

test('collapsing Tools hides exactly its descendants, not Tools; catches hiding the collapsed node', () => {
  const expected = below(tools.id);
  assert.ok(expected.length > 0);
  const check = (/** @type {any} */ m) => {
    const h = m.hiddenIds(onto, [tools.id], none);
    assert.deepEqual([...h].sort(), expected);
    assert.ok(!h.has(tools.id));
    assert.equal(m.hiddenIds(onto, [], none).size, 0);
  };
  const faulty = { ...real, hiddenIds: (/** @type {any} */ o, /** @type {any} */ c, /** @type {any} */ f) => new Set([...real.hiddenIds(o, c, f), ...c]) };
  checkCatches(check, real, faulty);
});

test('filter maxDepth 1 hides every node at depth >= 2', () => {
  const expected = nodes.filter((n) => n.depth >= 2).map((n) => n.id).sort();
  assert.ok(expected.length > 0);
  const h = real.hiddenIds(onto, [], { categories: null, maxDepth: 1 });
  assert.deepEqual([...h].sort(), expected);
});

test('filter categories hides other categories but never the root; catches a root-hiding filter', () => {
  const expected = nodes.filter((n) => n.parent != null && n.category !== tools.id).map((n) => n.id).sort();
  assert.ok(expected.length > 0);
  const check = (/** @type {any} */ m) => {
    const h = m.hiddenIds(onto, [], { categories: [tools.id], maxDepth: null });
    assert.deepEqual([...h].sort(), expected);
    assert.ok(!h.has(root.id));
    assert.ok(!h.has(tools.id));
  };
  const faulty = { ...real, hiddenIds: (/** @type {any} */ o, /** @type {any} */ c, /** @type {any} */ f) => new Set([...real.hiddenIds(o, c, f), o.root]) };
  checkCatches(check, real, faulty);
});
