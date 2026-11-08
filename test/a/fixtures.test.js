// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foldAll } from '../../src/core/events.js';

const dir = new URL('../../fixtures/', import.meta.url);
/** @param {string} name */
const load = (name) =>
  fs.readFileSync(new URL(name, dir), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

/** @param {any[]} events @returns {string[]} */
export function validate(events) {
  /** @type {string[]} */
  const p = [];
  if (!events.length || events[0].t !== 'ontology.created') p.push('first event is not ontology.created');
  for (let i = 1; i < events.length; i++) {
    if (!(events[i].at >= events[i - 1].at)) p.push(`at decreases at event ${i}`);
  }
  const o = foldAll(events);
  const catIds = new Set(o.categories.map((c) => c.id));
  const seenN = new Set();
  const seenE = new Set();
  for (const e of events) {
    if (e.t === 'node.added') {
      if (seenN.has(e.node.id)) p.push(`duplicate node id ${e.node.id}`);
      seenN.add(e.node.id);
    }
    if (e.t === 'edge.added') {
      if (seenE.has(e.edge.id)) p.push(`duplicate edge id ${e.edge.id}`);
      seenE.add(e.edge.id);
    }
  }
  for (const n of Object.values(o.nodes)) {
    if (n.id === o.root) {
      if (n.parent !== null) p.push('root has a parent');
      if (n.category !== '') p.push('root category is not ""');
      continue;
    }
    const par = n.parent ? o.nodes[n.parent] : undefined;
    if (!par) { p.push(`node ${n.id} parent ${n.parent} missing`); continue; }
    if (n.depth !== par.depth + 1) p.push(`node ${n.id} depth ${n.depth} != parent depth + 1`);
    if (!n.id.startsWith(par.id + '/')) p.push(`node ${n.id} id does not start with parent id`);
    if (!catIds.has(n.category)) p.push(`node ${n.id} category ${n.category} unknown`);
  }
  for (const e of o.edges) {
    if (!o.nodes[e.from]) p.push(`edge ${e.id} from ${e.from} missing`);
    if (!o.nodes[e.to]) p.push(`edge ${e.id} to ${e.to} missing`);
  }
  return p;
}

const plastic = load('plastic-modeling.events.jsonl');
const manga = load('manga.events.jsonl');
const count = (/** @type {any[]} */ ev, /** @type {string} */ t) => ev.filter((e) => e.t === t).length;

test('plastic fixture is valid', () => {
  assert.deepEqual(validate(plastic), []);
  const o = foldAll(plastic);
  assert.equal(o.categories.length, 8);
  const nn = count(plastic, 'node.added');
  assert.ok(nn >= 70 && nn <= 100, `nodes ${nn}`);
  const ne = count(plastic, 'edge.added');
  assert.ok(ne >= 15 && ne <= 25, `edges ${ne}`);
  assert.equal(count(plastic, 'insight'), 2);
  for (const n of Object.values(o.nodes)) assert.ok(n.hook && n.summary, `hook/summary ${n.id}`);
  for (const id of [
    'plastic-modeling/tools',
    'plastic-modeling/tools/adhesives',
    'plastic-modeling/tools/adhesives/plastic-cement',
    'plastic-modeling/tools/adhesives/ca-glue',
    'plastic-modeling/tools/adhesives/pva-glue',
  ]) assert.ok(o.nodes[id], id);
  assert.equal(o.nodes['plastic-modeling/tools'].label, 'Tools');
  assert.equal(o.nodes['plastic-modeling/tools/adhesives/ca-glue'].label, 'CA glue');
});

test('manga fixture is valid', () => {
  assert.deepEqual(validate(manga), []);
  const o = foldAll(manga);
  assert.equal(o.categories.length, 6);
  const nn = count(manga, 'node.added');
  assert.ok(nn >= 30 && nn <= 40, `nodes ${nn}`);
  assert.equal(count(manga, 'edge.added'), 8);
  for (const n of Object.values(o.nodes)) assert.ok(n.hook && n.summary, `hook/summary ${n.id}`);
});

test('PLANTED FAULT: orphan parent is reported', () => {
  const bad = [...plastic, { t: 'node.added', at: 99999, node: { id: 'plastic-modeling/nope/x', label: 'x', parent: 'plastic-modeling/nope', category: 'plastic-modeling/tools', depth: 2, origin: 'context', sources: [], article: null, status: 'done', createdBy: 'wave1' } }];
  const problems = validate(bad);
  assert.ok(problems.some((m) => m.includes('plastic-modeling/nope')), problems.join('; '));
});
