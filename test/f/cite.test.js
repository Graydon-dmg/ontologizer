// @ts-check
// Chat citations in the 3D view: exactly the cited nodes and the links between them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import { citedSets, centroid, allOffscreen } from '../../web/views/sky/math.js';

const onto = foldAll(fs.readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));
const R = 'plastic-modeling';
const CEMENT = `${R}/tools/adhesives/plastic-cement`;
const KIT = `${R}/kits/injection-molded-kits`;
const ADHESIVES = `${R}/tools/adhesives`;

/** @param {typeof citedSets} fn @returns {string[]} */
function checkCited(fn) {
  const p = [];
  const s = fn([CEMENT, KIT], onto);
  if (!s) return ['null for real ids'];
  if (s.nodes.size !== 2 || !s.nodes.has(CEMENT) || !s.nodes.has(KIT)) p.push(`nodes: ${[...s.nodes]}`);
  if (s.nodes.has(ADHESIVES)) p.push('a neighbour (the parent) was included');
  const between = onto.edges.filter((e) => [CEMENT, KIT].includes(e.from) && [CEMENT, KIT].includes(e.to)).map((e) => e.id);
  if (between.length === 0) p.push('fixture has no edge between the two cited nodes');
  for (const id of between) if (!s.edges.has(id)) p.push(`missing link ${id}`);
  for (const id of s.edges) if (!between.includes(id)) p.push(`link ${id} has an uncited end`);
  if (fn(null, onto) !== null || fn([], onto) !== null) p.push('null / [] must clear');
  const ghost = fn(['no/such/node'], onto);
  if (ghost !== null) p.push('unknown ids must not count as a citation');
  return p;
}

test('citedSets: exactly the cited nodes and the links between them; null and [] clear', () => {
  assert.deepEqual(checkCited(citedSets), []);
});

test('planted fault: a citation that pulls in neighbours and half-cited links is caught', () => {
  /** @type {typeof citedSets} */
  const leaky = (ids, o) => {
    if (!ids || !ids.length) return null;
    const nodes = new Set(ids);
    for (const id of ids) { const n = /** @type {any} */ (o.nodes[id]); if (n && n.parent) nodes.add(n.parent); }
    const edges = new Set((o.edges || []).filter((e) => nodes.has(e.from) || nodes.has(e.to)).map((e) => e.id));
    return { nodes, edges };
  };
  assert.ok(checkCited(leaky).length > 0);
});

test('centroid and allOffscreen', () => {
  assert.deepEqual(centroid([[0, 0, 0], [2, 4, 6]]), [1, 2, 3]);
  assert.equal(centroid([]), null);
  assert.equal(allOffscreen([{ x: 2, y: 0, z: 0.5 }, { x: 0, y: 0, z: 1.5 }]), true);
  assert.equal(allOffscreen([{ x: 2, y: 0, z: 0.5 }, { x: 0.2, y: -0.3, z: 0.9 }]), false);
  assert.equal(allOffscreen([]), false);
});
