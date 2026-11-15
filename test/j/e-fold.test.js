// @ts-check
// E1: foldInto / foldAll are byte-identical to the frozen 1.8.0 fold (plus S's cases), never own an
// event's objects, and are linear. Each check feeds its planted fault first, so a check that cannot
// fail is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fold, foldInto, foldAll, emptyOntology } from '../../src/core/events.js';
import { fold180, emptyOntology180, oracle } from './e-oracle-fold.js';
import { genStream, median } from '../../scripts/bench-fold.js';

const FIXTURES = ['demo', 'manga', 'plastic-modeling'];
/** @param {string} name @returns {any[]} */
const events = (name) => readFileSync(new URL(`../../fixtures/${name}.events.jsonl`, import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** One of every event type, with the awkward cases. @param {string} root @returns {any[]} */
function synthetic(root) {
  const H = { job: 'J', examples: ['a', 'b'], not_for: 'N', not_for_ids: ['x'], model: 'm', at: '2026-11-15T00:00:00.000Z' };
  const node = (/** @type {string} */ id, /** @type {any} */ more = {}) => ({ id, label: id.toUpperCase(), parent: root, category: 'c', summary: '', tags: [], ...more });
  return [
    { t: 'ontology.created', at: 0, name: 'S', root, brief: { context: 'x' }, categories: [{ id: 'c', label: 'C' }] },
    { t: 'node.added', at: 1, node: node('a', { sources: [{ title: 'T', url: 'u' }], article: 'art' }) },
    { t: 'node.added', at: 2, node: node('b') },
    { t: 'node.added', at: 3, node: node('a', { label: 'A again' }) }, // duplicate id replaces
    { t: 'node.added', at: 4, node: node('__proto__') },
    { t: 'node.added', at: 5, node: node('c') },
    { t: 'node.added', at: 5, node: null },
    { t: 'node.updated', at: 6, id: 'a', patch: { summary: 'new', tags: ['q'] } },
    { t: 'node.updated', at: 7, id: 'b', patch: { label: 'B2' } },
    { t: 'node.updated', at: 8, id: 'nope', patch: { label: 'x' } },
    { t: 'node.updated', at: 9, id: '__proto__', patch: { label: 'P' } },
    { t: 'node.hydrated', at: 10, nodeId: 'a', hydration: structuredClone(H) },
    { t: 'node.hydrated', at: 11, nodeId: 'nope', hydration: structuredClone(H) },
    { t: 'node.hydrated', at: 12, nodeId: 'b', hydration: { job: 1, examples: 'x' } },
    { t: 'edge.added', at: 13, edge: { id: 'e1', from: 'a', to: 'b', kind: 'related' } },
    { t: 'edge.added', at: 14, edge: { id: 'e2', from: 'b', to: 'c', kind: 'related' } },
    { t: 'edge.added', at: 15, edge: { id: 'e1', from: 'a', to: 'c', kind: 'other' } },
    { t: 'category.added', at: 16, category: { id: 'd', label: 'D' } },
    { t: 'category.added', at: 17, category: { id: 'c', label: 'C2' } },
    { t: 'job.queued', at: 18, job: { id: 'j1', kind: 'research', nodeId: 'a' } },
    { t: 'job.started', at: 19, job: { id: 'j1', kind: 'research' } },
    { t: 'job.done', at: 20, job: { id: 'j1', kind: 'research' } },
    { t: 'job.queued', at: 21, job: { id: 'j2', kind: 'research' } },
    { t: 'job.failed', at: 22, job: { id: 'j2', kind: 'research', error: 'boom' } },
    { t: 'lens.added', at: 23, lens: { id: 'l1', label: 'Lens', analogs: { a: { label: 'x' } } } },
    { t: 'lens.added', at: 24, lens: { id: 'l2', label: 'Empty' } },
    { t: 'lens.analog', at: 25, lensId: 'l1', nodeId: 'b', label: 'with', breaks: 'it breaks' },
    { t: 'lens.analog', at: 26, lensId: 'l1', nodeId: 'c', label: 'without' },
    { t: 'lens.analog', at: 27, lensId: 'nope', nodeId: 'c', label: 'unknown' },
    { t: 'view.changed', at: 28, patch: { filter: { categories: ['c'] }, collapsed: ['a'] } },
    { t: 'view.changed', at: 29, patch: { layout: 'sky-3d', filter: { maxDepth: 2 } } },
    { t: 'chat.asked', at: 30, chatId: 'main', msgId: 'm1', text: 'hi', images: [{ hash: 'h', mime: 'image/png', w: 1, h: 2, extra: 1 }] },
    { t: 'chat.answered', at: 31, chatId: 'main', msgId: 'm2', replyTo: 'm1', text: 'yo', citations: [{ nodeId: 'a', label: 'A' }], sources: [{ title: 'T', url: 'u' }], suggestions: [{ kind: 'research', nodeId: 'a', mode: 'context', label: 'L' }], usedWeb: true },
    { t: 'chat.asked', at: 32, chatId: 'main', msgId: 'm1', text: 'duplicate id', images: [] },
    { t: 'chat.failed', at: 33, chatId: 'main', replyTo: 'm1', error: 'bad' },
    { t: 'visibility.raised', at: 34, to: 'private', reason: 'source', sources: ['zeta', 'alpha'] },
    { t: 'visibility.raised', at: 35, to: 'private', reason: 'fuse', sources: ['mid', 'alpha'] },
    { t: 'visibility.raised', at: 36, to: 'public', reason: 'source', sources: ['no'] },
    { t: 'insight', at: 37, text: 'with node', nodeId: 'a' },
    { t: 'insight', at: 38, text: 'without node' },
    { t: 'ontology.renamed', at: 39, name: 'Renamed' },
    { t: 'mystery.event', at: 40, x: 1 },
    null,
    { t: 'ontology.created', at: 41, name: 'Second', root: 'b', brief: { context: 'y' }, categories: [{ id: 'z', label: 'Z' }], mode: 'agent' },
    { t: 'ontology.created', at: 42, name: 'Third', root: 'a', mode: 'robot' },
  ];
}

/** Planted fault: node.updated deletes then re-adds the key, so the updated node moves to the end. */
function movesUpdated(/** @type {any} */ o, /** @type {any} */ e) {
  if (e && e.t === 'node.updated' && o.nodes[e.id]) {
    const prev = o.nodes[e.id];
    delete o.nodes[e.id];
    o.nodes[e.id] = { ...prev, ...(e.patch || {}) };
    return o;
  }
  return foldInto(o, e);
}
/** Planted fault: node.added stores the event's own node. */
function storesEventNode(/** @type {any} */ o, /** @type {any} */ e) {
  if (e && e.t === 'node.added' && e.node && e.node.id) { o.nodes[e.node.id] = e.node; return o; }
  return foldInto(o, e);
}

/** @param {any[]} ev @param {(o: any, e: any) => any} f */
const run = (ev, f) => { const o = emptyOntology(); for (const e of ev) f(o, e); return o; };

const streams = /** @type {[string, any[]][]} */ ([
  ...FIXTURES.map((f) => /** @type {[string, any[]]} */ ([`fixture ${f}`, events(f)])),
  ['synthetic, every event type', synthetic('a')],
  ['synthetic, root __proto__', synthetic('__proto__')],
  ...FIXTURES.map((f) => /** @type {[string, any[]]} */ ([`fixture ${f} then synthetic`, [...events(f), ...synthetic('a').slice(1)]])),
]);

test('foldAll, foldInto and fold are byte-identical to the 1.8.0 oracle', () => {
  for (const [name, ev] of streams) {
    const want = oracle(ev);
    assert.equal(JSON.stringify(foldAll(ev)), JSON.stringify(want), `foldAll: ${name}`);
    assert.deepStrictEqual(foldAll(ev), want, `foldAll deep: ${name}`);
    assert.equal(JSON.stringify(run(ev, foldInto)), JSON.stringify(want), `foldInto: ${name}`);
    const pure = ev.reduce(fold, emptyOntology());
    assert.equal(JSON.stringify(pure), JSON.stringify(want), `fold reduce: ${name}`);
    assert.deepStrictEqual(pure, want, `fold reduce deep: ${name}`);
  }
  assert.deepStrictEqual(emptyOntology(), emptyOntology180());
});

test('a generated 10k-node stream folds byte-identical to the 1.8.0 oracle', () => {
  // The oracle is quadratic (about 7 s here), so it runs once; the pure fold is covered above.
  const ev = genStream(10000);
  const want = JSON.stringify(oracle(ev));
  assert.equal(JSON.stringify(foldAll(ev)), want);
  assert.equal(JSON.stringify(run(ev, foldInto)), want);
});

test('the synthetic stream reaches every case (the oracle result is not trivial)', () => {
  const o = /** @type {any} */ (oracle(synthetic('a')));
  assert.ok(Object.hasOwn(o.nodes, '__proto__') && o.nodes.a.hydration && o.nodes.a.label === 'A again');
  assert.equal(o.chat.length, 3);
  assert.equal(o.visibility, 'private');
  assert.deepEqual(o.privateSources, ['alpha', 'mid', 'zeta']);
  assert.equal(o.mode, 'agent'); // the second created sets it; the third (robot) leaves it
  assert.equal(o.name, 'Third');
  assert.equal(o.lenses.l1.analogs.b.breaks, 'it breaks');
  assert.equal(o.jobs.j2.state, 'failed');
  assert.equal(o.edges.length, 2);
  // planted fault: key order is part of the equivalence, so moving an updated node is caught
  const ev = synthetic('a');
  assert.notEqual(JSON.stringify(run(ev, movesUpdated)), JSON.stringify(oracle(ev)));
  assert.equal(JSON.stringify(run(ev, foldInto)), JSON.stringify(oracle(ev)));
});

test('events stay unowned: mutating an event after foldInto leaves the map unchanged', () => {
  /** @param {(o: any, e: any) => any} f */
  const build = (f) => {
    const hyd = { job: 'J', examples: ['a'], not_for: 'N', not_for_ids: ['x'], model: 'm', at: 't' };
    const add = { t: 'node.added', at: 1, node: { id: 'a', label: 'A', parent: null, sources: [{ title: 'T', url: 'u' }] } };
    const upd = { t: 'node.updated', at: 2, id: 'a', patch: { summary: 'S', tags: ['q'] } };
    const hy = { t: 'node.hydrated', at: 3, nodeId: 'a', hydration: hyd };
    const ed = { t: 'edge.added', at: 4, edge: { id: 'e', from: 'a', to: 'a' } };
    const o = emptyOntology();
    for (const e of [add, upd, hy, ed]) f(o, e);
    const before = JSON.stringify(o);
    add.node.label = 'MUTATED'; add.node.sources[0].title = 'MUTATED';
    upd.patch.summary = 'MUTATED';
    hyd.examples.push('MUTATED'); hyd.job = 'MUTATED';
    ed.edge.to = 'MUTATED';
    return { before, after: JSON.stringify(o) };
  };
  const bad = build(storesEventNode);
  assert.notEqual(bad.before, bad.after, 'planted fault (stores e.node) must show the mutation');
  const good = build(foldInto);
  assert.equal(good.before, good.after);
  // view.changed collapsed, category and lens are copied (one level, as in 1.8.0; patch values are shared as before)
  const col = ['x']; const cat = { id: 'c', label: 'C' }; const lens = { id: 'l', label: 'L', analogs: { a: { label: 'x' } } };
  const o2 = /** @type {any} */ (foldAll([{ t: 'view.changed', at: 1, patch: { collapsed: col } }, { t: 'category.added', at: 2, category: cat }, { t: 'lens.added', at: 3, lens }]));
  col.push('M'); cat.label = 'M'; lens.label = 'M';
  assert.deepEqual(o2.view.collapsed, ['x']);
  assert.equal(o2.categories[0].label, 'C');
  assert.equal(o2.lenses.l.label, 'L');
});

test('foldInto returns the very object it was given; fold never returns the input for a change', () => {
  const o = emptyOntology();
  const e = { t: 'node.added', at: 1, node: { id: 'a', label: 'A' } };
  assert.equal(foldInto(o, e), o);
  assert.ok(Object.hasOwn(o.nodes, 'a'));
  assert.equal(foldInto(o, { t: 'mystery', at: 2 }), o);
  assert.equal(foldInto(o, null), o);
  // planted fault: a foldInto that returns a copy is caught by identity
  const copying = (/** @type {any} */ x, /** @type {any} */ ev) => foldInto({ ...x }, ev);
  assert.notEqual(copying(o, { t: 'insight', at: 3, text: 't' }), o);
  const p = emptyOntology();
  const q = fold(p, e);
  assert.notEqual(q, p);
  assert.equal(Object.keys(p.nodes).length, 0, 'fold must not mutate its input');
  assert.equal(Object.keys(q.nodes).length, 1);
  const frozen = structuredClone(JSON.parse(JSON.stringify(q)));
  fold(q, { t: 'node.updated', at: 4, id: 'a', patch: { label: 'B' } });
  assert.deepEqual(JSON.parse(JSON.stringify(q)), frozen, 'fold must not mutate its input on update either');
});

test('speed: 10,000 nodes + 2,000 edges fold in under 200 ms; the 1.8.0 fold does not', () => {
  const ev = genStream(10000, 2000);
  assert.equal(ev.length, 1 + 10000 + 2000);
  foldAll(ev); // warm up
  const ms = median(() => { foldAll(ev); });
  console.log(`foldAll 10k nodes + 2k edges: median of 5 = ${ms.toFixed(1)} ms`);
  assert.ok(ms < 200, `foldAll took ${ms.toFixed(0)} ms`);
  // planted fault: the 1.8.0 fold copies the node table every time and is far over the limit
  const small = genStream(3000, 600);
  const t = performance.now(); oracle(small);
  const slow = performance.now() - t;
  console.log(`oracle (1.8.0 fold) 3k nodes: ${slow.toFixed(0)} ms`);
  assert.ok(slow > 200, `oracle took only ${slow.toFixed(0)} ms: raise the planted-fault size`);
});

test('150,000 events fold without throwing', () => {
  const ev = [
    { t: 'ontology.created', at: 0, name: 'Big', root: 'r', brief: {}, categories: [] },
    ...['r', 'a', 'b', 'c'].map((id, i) => ({ t: 'node.added', at: i + 1, node: { id, label: id, parent: id === 'r' ? null : 'r' } })),
  ];
  for (let i = 0; ev.length < 150000; i++) {
    ev.push(i % 2 ? { t: 'insight', at: ev.length, text: `i${i}` } : { t: 'node.updated', at: ev.length, id: 'abc'[i % 3], patch: { summary: `s${i}` } });
  }
  const o = foldAll(ev);
  assert.ok(o.insights.length > 70000);
  // planted fault: spreading that many items into one call is the thing that overflows the stack
  assert.throws(() => Math.max(...ev.map((e) => e.at)), RangeError);
});
