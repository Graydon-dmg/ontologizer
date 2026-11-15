// @ts-check
// A4: the offline stub organises deterministically and writes the real engine's event shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stubOrganize } from '../../src/cli/engine-stub-organize.js';
import { createMemoryStore } from '../c/fake.js';
import { genItems } from './fixtures/items/gen.js';

const SAMPLE = JSON.parse(readFileSync(new URL('./fixtures/items/sample-120.json', import.meta.url), 'utf8'));

/** @param {any} input @param {any} [actor] */
async function run(input, actor) {
  const store = createMemoryStore();
  const r = await stubOrganize({ store, id: 'm', input, emit: (t, f) => store.append('m', { t, at: 0, ...f }), actor });
  return { r, map: store.read('m'), events: store.list('m') };
}

/** Every input id is a childless node once, and no family is childless. @param {any} map @param {string[]} ids */
function exactlyOnce(map, ids) {
  const nodes = Object.values(map.nodes);
  const leaves = nodes.filter((/** @type {any} */ n) => !n.id.startsWith('_root')).map((/** @type {any} */ n) => n.id).sort();
  const parents = new Set(nodes.map((/** @type {any} */ n) => n.parent));
  return JSON.stringify(leaves) === JSON.stringify([...ids].sort())
    && leaves.every((id) => !parents.has(id))
    && nodes.every((/** @type {any} */ n) => !n.id.startsWith('_root') || parents.has(n.id));
}

test('stub: every item exactly once, families by first characters, depth 3', async () => {
  const { r, map } = await run({ name: 'sample', items: SAMPLE });
  assert.ok(exactlyOnce(map, SAMPLE.map((/** @type {any} */ i) => i.id)));
  // planted fault: dropping one leaf breaks the check
  const broken = { ...map, nodes: { ...map.nodes } };
  delete broken.nodes[SAMPLE[0].id];
  assert.equal(exactlyOnce(broken, SAMPLE.map((/** @type {any} */ i) => i.id)), false);
  assert.equal(r.unsorted, 0);
  assert.equal(Math.max(...Object.values(map.nodes).map((/** @type {any} */ n) => n.depth)), 3);
  for (const c of map.categories) assert.match(c.label, /^([A-Z#]|0-9)$/);
  assert.equal(map.mode, 'agent');
  assert.equal(map.view.filter.maxDepth, 2);
});

test('stub: deterministic, digits under 0-9, small lists get depth 2', async () => {
  const a = await run({ name: 's', items: genItems(300) });
  const b = await run({ name: 's', items: genItems(300) });
  assert.deepEqual(Object.keys(a.map.nodes), Object.keys(b.map.nodes));
  assert.ok(a.map.categories.some((/** @type {any} */ c) => c.label === '0-9'));
  const small = await run({ name: 's', items: genItems(10), depth: 3 });
  assert.equal(Math.max(...Object.values(small.map.nodes).map((/** @type {any} */ n) => n.depth)), 2);
  assert.ok(exactlyOnce(small.map, genItems(10).map((i) => i.id)));
});

test('stub: human mode keeps the view, actor is stamped, bad input is refused', async () => {
  const { map, events } = await run({ name: 's', items: SAMPLE, mode: 'human' }, { id: 'u1', kind: 'human' });
  assert.equal(map.mode, 'human');
  assert.equal(map.view.filter.maxDepth, null);
  assert.ok(events.every((/** @type {any} */ e) => e.actor?.id === 'u1'));
  await assert.rejects(run({ name: 's', items: [{ id: 'constructor', label: 'x' }] }), /reserved name/);
});
