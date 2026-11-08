// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import { searchNodes } from '../../web/shell/search.js';

const events = fs.readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const onto = foldAll(events);
const CEMENT = 'plastic-modeling/tools/adhesives/plastic-cement';

/** The check: label search finds cement, ignores ids, empty query is empty. */
function check(/** @type {(o:any,q:string,l?:number)=>string[]} */ search) {
  const r = search(onto, 'cem');
  assert.ok(r.includes(CEMENT), 'cem should match plastic cement');
  assert.equal(r[0], CEMENT, 'plastic cement should rank first');
  assert.deepEqual(search(onto, 'plastic-modeling/'), [], 'ids must not match');
  assert.deepEqual(search(onto, '   '), []);
}

/** Planted fault: matches on ids instead of labels. */
function searchById(/** @type {any} */ o, /** @type {string} */ q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  return Object.values(o.nodes).filter((n) => n.id.toLowerCase().includes(s)).map((n) => n.id);
}

test("Searching 'cem' on the plastic-modeling fixture matches the plastic cement node, by label", () => {
  assert.doesNotThrow(() => check(searchNodes));
  assert.throws(() => check(searchById), 'id-based search must fail the check');
});

test('ranking and limit', () => {
  const o = foldAll([
    { t: 'ontology.created', at: 0, name: 'x', root: 'x', brief: {}, categories: [] },
    ...[['x/a', 'Big glue', 2], ['x/b', 'Glue', 1], ['x/c', 'Superglue', 1]].map(([id, label, depth], i) =>
      ({ t: 'node.added', at: i + 1, node: { id, label, parent: 'x', category: '', depth, origin: 'seed', sources: [], article: null, status: 'done', createdBy: 'w' } })),
  ]);
  assert.deepEqual(searchNodes(o, ' GLUE '), ['x/b', 'x/a', 'x/c']);
  assert.equal(searchNodes(o, 'glue', 2).length, 2);
});
