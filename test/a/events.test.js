// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, foldAll, emptyOntology, makeEvent } from '../../src/core/events.js';

const created = {
  t: 'ontology.created', at: 0, name: 'Demo', root: 'demo',
  brief: { context: 'c', subject: 's', scope: 'sc', purpose: 'p', level: 'beginner' }, categories: [],
};
const node = (id, parent, category, depth) => ({
  id, label: id, parent, category, depth, origin: 'context', sources: [], article: null,
  status: 'done', createdBy: 'wave0',
});
const events = [
  created,
  { t: 'category.added', at: 1, category: { id: 'demo/a', label: 'A', index: 0, family: 0 } },
  { t: 'node.added', at: 2, node: node('demo', null, '', 0) },
  { t: 'node.added', at: 3, node: node('demo/a', 'demo', 'demo/a', 1) },
  { t: 'node.added', at: 4, node: node('demo/a/x', 'demo/a', 'demo/a', 2) },
  { t: 'node.updated', at: 5, id: 'demo/a/x', patch: { summary: 'sum' } },
  { t: 'edge.added', at: 6, edge: { id: 'e1', from: 'demo/a', to: 'demo/a/x', type: 'requires', why: 'w' } },
  { t: 'view.changed', at: 7, patch: { filter: { categories: ['demo/a'] } } },
  { t: 'lens.added', at: 8, lens: { id: 'l1', persona: 'chef', analogs: {} } },
  { t: 'lens.analog', at: 9, lensId: 'l1', nodeId: 'demo/a', label: 'Knife', breaks: 'not sharp' },
  { t: 'job.queued', at: 10, job: { id: 'j1', kind: 'research', nodeId: 'demo/a' } },
  { t: 'job.started', at: 11, job: { id: 'j1', kind: 'research', nodeId: 'demo/a' } },
  { t: 'job.failed', at: 12, job: { id: 'j1', kind: 'research', nodeId: 'demo/a', error: 'boom' } },
  { t: 'insight', at: 13, text: 'hi', nodeId: 'demo/a' },
  { t: 'ontology.renamed', at: 14, name: 'Renamed' },
  { t: 'some.future.event', at: 15, whatever: 1 },
];

/** Deep-freeze so any mutation inside fold throws. */
function freeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) freeze(v);
  }
  return o;
}

/** Purity check: same events twice -> deep-equal; inputs unchanged. Returns problems. */
function checkPure(foldFn) {
  const problems = [];
  try {
    const a = events.reduce((o, e) => foldFn(o, e), emptyOntology());
    const b = events.reduce((o, e) => foldFn(o, e), emptyOntology());
    try { assert.deepEqual(a, b); } catch { problems.push('two folds differ'); }
    let o = emptyOntology();
    for (const e of events) {
      const before = structuredClone(o);
      const next = foldFn(o, e);
      try { assert.deepEqual(o, before); } catch { problems.push(`input mutated by ${e.t}`); }
      o = next;
    }
  } catch (err) {
    problems.push(`threw: ${/** @type {Error} */ (err).message}`);
  }
  return problems;
}

/** Filter-merge check. Returns problems. */
function checkFilterMerge(foldFn) {
  let o = foldFn(foldAll([created]), { t: 'view.changed', at: 1, patch: { filter: { categories: ['x'] } } });
  o = foldFn(o, { t: 'view.changed', at: 2, patch: { filter: { maxDepth: 2 } } });
  const problems = [];
  if (JSON.stringify(o.view.filter.categories) !== '["x"]') problems.push('filter.categories wiped');
  if (o.view.filter.maxDepth !== 2) problems.push('maxDepth not set');
  return problems;
}

test('emptyOntology has view defaults', () => {
  const o = emptyOntology();
  assert.deepEqual(o.view, {
    collapsed: [], focus: '', layout: 'graph-2d', lens: null, filter: { categories: null, maxDepth: null },
  });
  assert.equal(o.version, 1);
  assert.notEqual(emptyOntology(), emptyOntology());
});

test('foldAll builds the expected ontology', () => {
  const o = foldAll(events);
  assert.equal(o.name, 'Renamed');
  assert.equal(o.root, 'demo');
  assert.equal(o.view.focus, 'demo');
  assert.equal(o.categories.length, 1);
  assert.equal(Object.keys(o.nodes).length, 3);
  assert.equal(o.nodes['demo/a/x'].summary, 'sum');
  assert.equal(o.edges.length, 1);
  assert.deepEqual(o.view.filter, { categories: ['demo/a'], maxDepth: null });
  assert.deepEqual(o.lenses.l1.analogs['demo/a'], { label: 'Knife', breaks: 'not sharp' });
  assert.equal(o.jobs.j1.state, 'failed');
  assert.equal(o.jobs.j1.error, 'boom');
  assert.deepEqual(o.insights, [{ at: 13, text: 'hi', nodeId: 'demo/a' }]);
});

test('node.added with a missing parent is still folded', () => {
  const o = foldAll([created, { t: 'node.added', at: 1, node: node('demo/z/y', 'demo/z', 'demo/z', 2) }]);
  assert.ok(o.nodes['demo/z/y']);
});

test('fold is pure (deep-frozen inputs, repeatable)', () => {
  assert.deepEqual(checkPure(fold), []);
  // Fully frozen input: any mutation inside fold throws in strict mode.
  let o = freeze(emptyOntology());
  for (const e of events) o = freeze(fold(o, freeze(structuredClone(e))));
  assert.equal(o.name, 'Renamed');
});

test('planted fault: a fold that writes Date.now() or mutates its input is caught', () => {
  const clocky = (o, e) => ({ ...fold(o, e), name: String(Date.now() + Math.random()) });
  assert.ok(checkPure(clocky).length > 0, 'clock-reading fold must fail');
  const mutating = (o, e) => { o.insights.push({ at: 0, text: 'x' }); return fold(o, e); };
  assert.ok(checkPure(mutating).length > 0, 'mutating fold must fail');
});

test('view.changed filter merges one level deeper', () => {
  assert.deepEqual(checkFilterMerge(fold), []);
});

test('planted fault: a shallow filter merge is caught', () => {
  const shallow = (o, e) =>
    e.t === 'view.changed' ? { ...o, view: { ...o.view, ...e.patch } } : fold(o, e);
  assert.ok(checkFilterMerge(shallow).includes('filter.categories wiped'));
});

test('makeEvent stamps at relative to start', () => {
  const start = Date.now() - 1000;
  const e = makeEvent('insight', { text: 'x' }, start);
  assert.equal(e.t, 'insight');
  assert.equal(e.text, 'x');
  assert.ok(e.at >= 1000 && e.at < 5000);
});
