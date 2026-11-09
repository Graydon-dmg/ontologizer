// @ts-check
// Search opens the collapsed branches that hold a match (ancestorsToExpand), with its planted fault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import { searchNodes, ancestorsToExpand } from '../../web/shell/search.js';

const demo = foldAll(readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l)));

/** Matches still hidden by a collapsed ancestor after expanding `open`. @param {any} o @param {string[]} ids @param {string[]} collapsed @param {string[]} open */
function stillHidden(o, ids, collapsed, open) {
  const col = new Set(collapsed.filter((c) => !open.includes(c)));
  return ids.filter((id) => {
    for (let p = o.nodes[id]?.parent; p != null; p = o.nodes[p]?.parent) if (col.has(p)) return true;
    return false;
  });
}

const deep = Object.values(demo.nodes).find((n) => n.depth === 3);
assert.ok(deep, 'the fixture has a depth-3 node');
const parent = /** @type {string} */ (deep.parent);
const grand = /** @type {string} */ (demo.nodes[parent].parent);

test('a match under a collapsed grandparent and parent: both are opened, shallowest first', () => {
  const ids = searchNodes(demo, deep.label);
  assert.ok(ids.includes(deep.id));
  const collapsed = [parent, grand];
  const open = ancestorsToExpand(demo, ids, collapsed);
  assert.deepEqual(open.slice(0, 2), [grand, parent]);
  assert.deepEqual(stillHidden(demo, ids, collapsed, open), []);
});

test('nothing collapsed, or no match inside a collapsed branch: nothing to open', () => {
  assert.deepEqual(ancestorsToExpand(demo, [deep.id], []), []);
  assert.deepEqual(ancestorsToExpand(demo, [deep.id], null), []);
  const other = Object.values(demo.nodes).find((n) => n.depth === 1 && n.id !== grand);
  assert.deepEqual(ancestorsToExpand(demo, [deep.id], [/** @type {any} */ (other).id]), []);
  assert.deepEqual(ancestorsToExpand(demo, [], [grand]), []);
});

test('a collapsed node that is itself a match is not opened (it is drawn)', () => {
  assert.deepEqual(ancestorsToExpand(demo, [grand], [grand]), []);
});

test('planted fault: a helper that only looks at the direct parent leaves the match hidden', () => {
  const parentOnly = (/** @type {any} */ o, /** @type {string[]} */ ids, /** @type {string[]} */ col) => ids.map((id) => o.nodes[id]?.parent).filter((p) => col.includes(p));
  const collapsed = [grand];
  assert.ok(stillHidden(demo, [deep.id], collapsed, parentOnly(demo, [deep.id], collapsed)).length > 0, 'the planted helper is wrong');
  assert.deepEqual(stillHidden(demo, [deep.id], collapsed, ancestorsToExpand(demo, [deep.id], collapsed)), []);
});

test('a parent cycle does not loop forever', () => {
  const o = { nodes: { a: { id: 'a', parent: 'b', depth: 1 }, b: { id: 'b', parent: 'a', depth: 1 } } };
  assert.deepEqual(ancestorsToExpand(/** @type {any} */ (o), ['a'], ['b']), ['b']);
});
