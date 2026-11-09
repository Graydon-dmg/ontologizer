// @ts-check
// The embed's search opens collapsed branches that hold a match (revealPatch), with its planted fault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold } from '../../src/core/events.js';
import { searchNodes, revealPatch } from '../../web/embed/helpers.js';
import { fixtureEvents } from './build-check.js';
import { foldAll } from '../../src/core/events.js';
import { hiddenIds } from '../../web/views/graph/math.js';

const map = foldAll(fixtureEvents('plastic-modeling'));
const deep = /** @type {any} */ (Object.values(map.nodes).find((n) => n.depth === 3));
const parent = deep.parent;
const grand = map.nodes[parent].parent;

/** Collapse ids the way the embed does (a local view.changed event). @param {any} o @param {string[]} ids */
const collapse = (o, ids) => fold(o, { t: 'view.changed', at: 0, patch: { collapsed: ids } });

test('searching inside collapsed branches opens them, grandparent included, and the matches are drawn', () => {
  const o = collapse(map, [grand, parent]);
  const ids = searchNodes(o, deep.label);
  assert.ok(hiddenIds(o, o.view.collapsed, o.view.filter).has(deep.id), 'hidden before the search');
  const patch = revealPatch(o, ids);
  assert.ok(patch);
  const after = fold(o, { t: 'view.changed', at: 0, patch });
  for (const id of ids) assert.ok(!hiddenIds(after, after.view.collapsed, after.view.filter).has(id), id);
  // Clearing the search sends nothing: the branches stay open.
  assert.equal(revealPatch(after, searchNodes(after, '')), null);
});

test('unrelated collapsed branches stay collapsed; nothing to open gives null', () => {
  const other = /** @type {any} */ (Object.values(map.nodes).find((n) => n.depth === 1 && n.id !== grand)).id;
  const o = collapse(map, [other, grand]);
  assert.deepEqual(revealPatch(o, [deep.id]), { collapsed: [other] });
  assert.equal(revealPatch(collapse(map, [other]), [deep.id]), null);
});

test('planted fault: a reveal that only opens the direct parent leaves the match hidden', () => {
  const o = collapse(map, [grand]);
  const parentOnly = { collapsed: o.view.collapsed.filter((c) => c !== deep.parent) };
  const bad = fold(o, { t: 'view.changed', at: 0, patch: parentOnly });
  assert.ok(hiddenIds(bad, bad.view.collapsed, bad.view.filter).has(deep.id));
  const good = fold(o, { t: 'view.changed', at: 0, patch: /** @type {any} */ (revealPatch(o, [deep.id])) });
  assert.ok(!hiddenIds(good, good.view.collapsed, good.view.filter).has(deep.id));
});
