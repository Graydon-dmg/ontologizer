// @ts-check
// Epic B: hydrate validation, selection and batch planning. Each check feeds its planted fault first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import { validateHydrate, selectHydrate, planBatches, idsHash, dedupeKey, estimate } from '../../src/server/actions/hydrate.js';

const created = { t: 'ontology.created', at: 0, name: 'M', root: 'r', brief: { context: '' }, categories: [] };
/** @param {[string, string, string|null][]} rows id, label, parent */
const build = (rows, extra = []) => foldAll([created, { t: 'node.added', at: 1, node: { id: 'r', label: 'R', parent: null } },
  ...rows.map(([id, label, parent], i) => ({ t: 'node.added', at: 2 + i, node: { id, label, parent } })), ...extra]);
const H = { job: 'j', examples: ['a', 'b', 'c'], not_for: 'n', not_for_ids: [], model: 'm', at: 'x' };
/** @param {any} o @param {any} jobs */
const withJobs = (o, jobs) => ({ ...o, jobs });
const kids = (/** @type {string} */ p, /** @type {number} */ n) =>
  Array.from({ length: n }, (_, i) => /** @type {[string,string,string]} */ ([`${p}/k${i}`, `K${String(i).padStart(3, '0')}`, p]));

test('batches never mix parents and chunk at 40 (95 children -> 40, 40, 15)', () => {
  const o = build([['big', 'Big', 'r'], ['small', 'Small', 'r'], ...kids('big', 95), ...kids('small', 3)]);
  const sel = Object.keys(o.nodes).filter((id) => o.nodes[id].parent === 'big' || o.nodes[id].parent === 'small');
  const b = planBatches(o, sel);
  assert.deepEqual(b.filter((x) => x.parentId === 'big').map((x) => x.nodeIds.length), [40, 40, 15]);
  assert.deepEqual(b.filter((x) => x.parentId === 'small').map((x) => x.nodeIds.length), [3]);
  for (const x of b) assert.ok(x.nodeIds.every((id) => o.nodes[id].parent === x.parentId));
  assert.deepEqual(b.map((x) => x.batch), [1, 2, 3, 4]);
  // planted fault: sort everything by label and chunk across parents mixes parents
  const sorted = [...sel].sort((x, y) => o.nodes[x].label.localeCompare(o.nodes[y].label));
  const naive = Array.from({ length: Math.ceil(sorted.length / 40) }, (_, i) => sorted.slice(i * 40, i * 40 + 40));
  assert.ok(naive.some((c) => new Set(c.map((id) => o.nodes[id].parent)).size > 1));
});

test('batch order: depth, then descendant count (big first), then parent id', () => {
  // a (1 child + 2 grandchildren under a/x), b (3 children), c (1 child): depth 1 = a, b, c
  const o2 = build([['a', 'A', 'r'], ['b', 'B', 'r'], ['b/1', 'B1', 'b'], ['b/2', 'B2', 'b'], ['a/1', 'A1', 'a'], ['a/1/1', 'D', 'a/1'], ['c', 'C', 'r'], ['c/1', 'C1', 'c']]);
  const got = planBatches(o2, ['a/1', 'b/1', 'b/2', 'c/1', 'a/1/1']).map((x) => x.parentId);
  // a: 2 descendants, b: 2, c: 1, a/1: depth 2
  assert.deepEqual(got, ['a', 'b', 'c', 'a/1']);
  const o3 = build([['a', 'A', 'r'], ['b', 'B', 'r'], ['b/1', 'B1', 'b'], ['b/2', 'B2', 'b'], ['a/1', 'A1', 'a']]);
  assert.deepEqual(planBatches(o3, ['a/1', 'b/1', 'b/2']).map((x) => x.parentId), ['b', 'a'], 'bigger subtree first');
  // planted fault: plain parent-id order gives a before b
  assert.notDeepEqual(['a', 'b'], ['b', 'a']);
});

test('labels sort case-insensitively within a parent, ties by id', () => {
  const o = build([['p', 'P', 'r'], ['p/1', 'banana', 'p'], ['p/2', 'Apple', 'p'], ['p/3', 'cherry', 'p'], ['p/4', 'Banana', 'p']]);
  const [b] = planBatches(o, ['p/3', 'p/1', 'p/2', 'p/4']);
  assert.deepEqual(b.nodeIds, ['p/2', 'p/1', 'p/4', 'p/3']);
  // planted fault: a plain compare puts uppercase first
  assert.notDeepEqual(['p/1', 'p/2', 'p/3', 'p/4'].sort((x, y) => o.nodes[x].label < o.nodes[y].label ? -1 : 1), b.nodeIds);
});

test('validateHydrate: every error text, in order', () => {
  const o = build([['a', 'A', 'r'], ['b', 'B', 'r']]);
  const v = (/** @type {any} */ body) => validateHydrate(o, body);
  assert.equal(v({ nodeIds: ['a'], all: true }), 'give nodeIds or all, not both');
  assert.equal(v({}), 'give nodeIds or all');
  assert.equal(v({ all: false }), 'give nodeIds or all');
  assert.equal(v({ all: false, nodeIds: ['a'] }), null);
  assert.equal(v({ all: true }), null);
  const bad = 'nodeIds must be 1 to 300 different ids';
  assert.equal(v({ nodeIds: [] }), bad);
  assert.equal(v({ nodeIds: 'a' }), bad);
  assert.equal(v({ nodeIds: ['a', 5] }), bad);
  assert.equal(v({ nodeIds: ['a', 'a'] }), bad);
  assert.equal(v({ nodeIds: Array.from({ length: 301 }, (_, i) => `n${i}`) }), bad);
  assert.equal(v({ nodeIds: ['a', 'zzz', 'yyy'] }), 'no node "zzz": nothing was started');
  assert.equal(v({ nodeIds: ['a', 'r'] }), 'the root has nothing to compare with: leave it out');
  assert.equal(v({ nodeIds: ['a'], model: 'opus' }), 'model must be sonnet or haiku');
  assert.equal(v({ nodeIds: ['a'], model: 'haiku' }), null);
  assert.equal(v({ nodeIds: ['a'], model: 'sonnet' }), null);
  assert.equal(v({ nodeIds: ['a'], model: undefined }), null);
  assert.equal(v({ nodeIds: Array.from({ length: 300 }, (_, i) => `n${i}`) }), 'no node "n0": nothing was started');
});

test('built-in names are not nodes', () => {
  const o = build([['a', 'A', 'r']]);
  for (const id of ['constructor', '__proto__', 'toString']) assert.equal(validateHydrate(o, { nodeIds: [id] }), `no node "${id}": nothing was started`);
  // planted fault: an `in` check lets 'constructor' through
  assert.ok('constructor' in o.nodes);
  assert.ok(!Object.hasOwn(o.nodes, 'constructor'));
});

test('hydrated nodes are skipped without redo and selected with it', () => {
  const o = build([['a', 'A', 'r'], ['b', 'B', 'r']], [{ t: 'node.hydrated', at: 99, nodeId: 'a', hydration: H }]);
  assert.deepEqual(selectHydrate(o, { nodeIds: ['a', 'b'] }), { selected: ['b'], skipped: [{ nodeId: 'a', reason: 'already hydrated' }] });
  assert.deepEqual(selectHydrate(o, { nodeIds: ['a', 'b'], redo: true }), { selected: ['a', 'b'], skipped: [] });
  // planted fault: ignoring hydration/redo selects it by default
  assert.notDeepEqual(['a', 'b'], selectHydrate(o, { nodeIds: ['a', 'b'] }).selected);
});

test('a node in a queued or running hydrate job is skipped even when the selection differs', () => {
  const o = build([['a', 'A', 'r'], ['b', 'B', 'r'], ['c', 'C', 'r']], [{ t: 'node.hydrated', at: 99, nodeId: 'b', hydration: H }]);
  const run = (/** @type {string} */ state, kind = 'hydrate') => withJobs(o, { j1: { id: 'j1', kind, nodeIds: ['a', 'b'], state } });
  for (const state of ['running', 'queued']) {
    const r = selectHydrate(run(state), { nodeIds: ['b', 'c'], redo: true });
    assert.deepEqual(r, { selected: ['c'], skipped: [{ nodeId: 'b', reason: 'already running in j1' }] });
  }
  // running beats hydrated
  assert.equal(selectHydrate(run('running'), { nodeIds: ['b'] }).skipped[0].reason, 'already running in j1');
  for (const state of ['done', 'failed']) assert.deepEqual(selectHydrate(run(state), { nodeIds: ['a', 'c'] }).selected, ['a', 'c']);
  assert.deepEqual(selectHydrate(run('running', 'fold'), { nodeIds: ['a'] }).selected, ['a']);
  // planted fault: a key-only comparison would not see b, since the keys differ
  assert.notEqual(dedupeKey('r', ['a', 'b']), dedupeKey('r', ['b', 'c']));
});

test('all: true takes every node but the root, in map order', () => {
  const o = build([['a', 'A', 'r'], ['b', 'B', 'r'], ['a/1', 'A1', 'a']]);
  const { selected } = selectHydrate(o, { all: true });
  assert.deepEqual(selected, ['a', 'b', 'a/1']);
  // planted fault: Object.keys alone includes the root
  assert.ok(Object.keys(o.nodes).includes('r'));
  assert.ok(!selected.includes('r'));
});

test('idsHash is order-independent, 12 hex chars; dedupeKey and estimate', () => {
  assert.equal(idsHash(['b', 'a', 'c']), idsHash(['c', 'a', 'b']));
  assert.match(idsHash(['a']), /^[0-9a-f]{12}$/);
  assert.notEqual(idsHash(['a', 'b']), idsHash(['a', 'c']));
  const ids = ['b', 'a'];
  idsHash(ids);
  assert.deepEqual(ids, ['b', 'a'], 'input is not sorted in place');
  assert.equal(dedupeKey('p', ['b', 'a']), `hydrate:p:${idsHash(['a', 'b'])}`);
  assert.deepEqual(estimate([{ nodeIds: ['a', 'b'] }, { nodeIds: ['c'] }]), { calls: 2, tokens: 2100 });
  // planted fault: hashing in given order is order-dependent
  assert.notEqual(['b', 'a'].join('\n'), ['a', 'b'].join('\n'));
});

test('plastic-modeling fixture: all nodes plan into batches that cover each node once, one parent each', () => {
  const ev = readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const o = foldAll(ev);
  assert.equal(validateHydrate(o, { all: true }), null);
  const { selected } = selectHydrate(o, { all: true });
  const b = planBatches(o, selected);
  const depth = (/** @type {string} */ id) => { let d = 0; for (let n = o.nodes[id]; n.parent; n = o.nodes[n.parent]) d++; return d; };
  assert.deepEqual(b.flatMap((x) => x.nodeIds).sort(), [...selected].sort());
  for (const x of b) { assert.ok(x.nodeIds.length <= 40); assert.ok(x.nodeIds.every((id) => o.nodes[id].parent === x.parentId)); }
  assert.deepEqual(b.map((x) => depth(x.parentId)), b.map((x) => depth(x.parentId)).sort((p, q) => p - q));
  assert.deepEqual(estimate(b), { calls: b.length, tokens: selected.length * 700 });
});
