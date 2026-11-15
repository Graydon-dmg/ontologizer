// @ts-check
// Epic A: the organise engine (src/core/engine/organize.js) against a fake model. Each check is
// fed its planted fault first, so a check that cannot fail is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeClient, createMemoryStore, lines } from '../c/fake.js';
import { runCall } from '../../src/core/engine/call.js';
import { makeEvent, foldAll, foldInto, emptyOntology } from '../../src/core/events.js';
import {
  organize, checkInput, readTree, effectiveDepth, maxDeepest, sampleItems, ROOT_ID, UNSORTED_ID, BAD_TREE,
} from '../../src/core/engine/organize.js';
import { genItems } from './fixtures/items/gen.js';

/** @type {{ id: string, label: string, text?: string }[]} */
const SAMPLE_120 = JSON.parse(readFileSync(new URL('./fixtures/items/sample-120.json', import.meta.url), 'utf8'));

/** @param {(params: any, i: number) => any} respond */
function setup(respond) {
  const store = createMemoryStore(); const fake = createFakeClient({ respond, chunkMs: 0 });
  let start = Date.now(); const id = 'm';
  const ectx = { store, id, models: { fast: 'claude-haiku-5-5', strong: 'claude-sonnet-5-5' },
    emit: (/** @type {string} */ t, /** @type {any} */ f) => store.append(id, makeEvent(t, f, start)), resetClock: () => { start = Date.now(); },
    call: (/** @type {any} */ p, /** @type {any} */ on) => runCall(() => fake, p, on), durable: async () => {} };
  return { store, fake, ectx, events: () => store.list(id), map: () => store.read(id) };
}

const isFamilies = (/** @type {any} */ p) => p.system.includes('family tree');
const isPlacement = (/** @type {any} */ p) => p.system.includes('Place each item');

/**
 * A fake model. Families: a valid tree for the depth the prompt asks for. Placement: parses the
 * batch and answers one line per item (round-robin by a hash of the id) unless `place` overrides.
 * @param {{
 *   labels?: string[],
 *   families?: (params: any) => any,
 *   place?: (ids: string[], ctx: { keys: string[], retry: boolean, index: number, defaults: () => any[] }) => any[],
 *   placeError?: any, delayMs?: number,
 * }} [o]
 */
function model(o = {}) {
  const labels = o.labels ?? ['Alpha', 'Bravo', 'Charlie', 'Delta'];
  return (/** @type {any} */ params, /** @type {number} */ index) => {
    if (isFamilies(params)) {
      if (o.families) return o.families(params);
      const depth = Number(/(\d) levels below the root/.exec(params.messages[0].content)?.[1] ?? 3);
      return { text: tree(depth, labels) };
    }
    if (isPlacement(params)) {
      if (o.placeError) return { error: o.placeError };
      const prompt = params.messages[0].content;
      const famPart = prompt.split('Families:\n')[1].split('\n\nItems (')[0];
      const keys = famPart.split('\n').filter((/** @type {string} */ l) => l.startsWith('{')).map((/** @type {string} */ l) => JSON.parse(l).key);
      const itemPart = prompt.split(/\nItems \(\d+\):\n/)[1].split('\nThese items')[0];
      const ids = itemPart.split('\n').filter((/** @type {string} */ l) => l.startsWith('{')).map((/** @type {string} */ l) => JSON.parse(l).id);
      const retry = prompt.includes('missed last time');
      const defaults = () => ids.map((id) => ({ id, family: keys[hash(id) % keys.length] }));
      const objs = o.place ? o.place(ids, { keys, retry, index, defaults }) : defaults();
      return { text: lines(objs), ...(o.delayMs ? { delayMs: o.delayMs } : {}) };
    }
    return { text: '' };
  };
}

/** @param {string} s */
const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

/** A valid family tree. depth 2: the 4+ labels as top families. depth 3: each with two sub-families. @param {number} depth @param {string[]} labels */
function tree(depth, labels) {
  /** @type {any[]} */
  const out = [];
  labels.forEach((l, i) => {
    out.push({ key: `t${i}`, label: l, parent: 'ROOT', description: `About ${l}` });
    if (depth >= 3) for (const s of ['One', 'Two']) out.push({ key: `t${i}${s}`, label: `${l} ${s}`, parent: `t${i}`, description: `${l} ${s} things` });
  });
  return lines(out);
}

/**
 * The exactly-once check on a finished map. Throws (AssertionError) when it does not hold.
 * @param {any} map @param {string[]} ids
 */
function exactlyOnce(map, ids) {
  const nodes = Object.values(map.nodes);
  const isFamily = (/** @type {any} */ n) => n.id === ROOT_ID || n.id.startsWith(ROOT_ID);
  const leaves = nodes.filter((/** @type {any} */ n) => !isFamily(n)).map((/** @type {any} */ n) => n.id);
  assert.equal(leaves.length, ids.length, 'leaf count');
  assert.deepEqual([...leaves].sort(), [...ids].sort(), 'leaf ids equal the input ids');
  /** @type {Map<string, number>} */
  const kids = new Map();
  for (const n of /** @type {any[]} */ (nodes)) {
    if (n.parent === null) continue;
    assert.ok(map.nodes[n.parent], `parent of ${n.id} exists`);
    kids.set(n.parent, (kids.get(n.parent) ?? 0) + 1);
  }
  for (const n of /** @type {any[]} */ (nodes)) {
    if (!isFamily(n)) assert.equal(kids.get(n.id) ?? 0, 0, `leaf ${n.id} has no children`);
    else assert.ok((kids.get(n.id) ?? 0) > 0, `family ${n.id} is not empty`);
  }
}

/** A hand-made map: root, family f, leaves. @param {string[]} leafIds */
const handMap = (leafIds) => ({ nodes: {
  [ROOT_ID]: { id: ROOT_ID, parent: null },
  '_root/f': { id: '_root/f', parent: ROOT_ID },
  ...Object.fromEntries(leafIds.map((id) => [id, { id, parent: '_root/f' }])),
} });

const ids120 = SAMPLE_120.map((i) => i.id);
/** @param {any[]} events @param {string} t */
const ofType = (events, t) => events.filter((e) => e.t === t);
/** The leaf node.added events. @param {any[]} events */
const leafEvents = (events) => events.filter((e) => e.t === 'node.added' && !e.node.id.startsWith(ROOT_ID));

// ---------------------------------------------------------------------------------------------

test('1. exactly once: every item is one leaf; misses go under Unsorted', async () => {
  const missing = new Set([ids120[3], ids120[40], ids120[99]]);
  const t = setup(model({ place: (ids, { defaults }) => defaults().filter((l) => !missing.has(l.id)) }));
  const res = await organize(t.ectx, { name: 'Payments', items: SAMPLE_120, depth: 3, mode: 'agent' });
  assert.equal(res.unsorted, 3);
  exactlyOnce(t.map(), ids120);
  const nodes = t.map().nodes;
  assert.ok(nodes[UNSORTED_ID], 'unsorted exists');
  assert.equal(nodes[UNSORTED_ID].parent, ROOT_ID);
  assert.ok(ofType(t.events(), 'category.added').some((e) => e.category.id === UNSORTED_ID));
  for (const id of missing) assert.equal(nodes[id].parent, UNSORTED_ID);
  const insight = ofType(t.events(), 'insight');
  assert.equal(insight.length, 1);
  assert.equal(insight[0].text, '3 of 120 items could not be placed and are under Unsorted.');
});

test('1b. the exactlyOnce helper catches a dropped item, an extra item, a childless family and a leaf with children', () => {
  exactlyOnce(handMap(['a', 'b']), ['a', 'b']);                                    // control: passes
  assert.throws(() => exactlyOnce(handMap(['a']), ['a', 'b']));                    // dropped item
  assert.throws(() => exactlyOnce(handMap(['a', 'b', 'c']), ['a', 'b']));          // invented item
  const m = handMap(['a', 'b']);
  /** @type {any} */ (m.nodes)['_root/empty'] = { id: '_root/empty', parent: ROOT_ID };
  assert.throws(() => exactlyOnce(m, ['a', 'b']));                                 // childless family
  const m2 = handMap(['a', 'b']);
  /** @type {any} */ (m2.nodes).c = { id: 'c', parent: 'a' };
  assert.throws(() => exactlyOnce(m2, ['a', 'b', 'c']));                           // leaf with a child
});

test('2. small lists: 10 items at depth 3 get one family level', async () => {
  const items = genItems(10);
  assert.equal(effectiveDepth(10, 3), 2);
  assert.equal(effectiveDepth(24, 3), 3);
  const t = setup(model());
  await organize(t.ectx, { name: 'Small', items, depth: 3, mode: 'agent' });
  const families = t.fake.calls.filter((c) => isFamilies(c.params));
  assert.equal(families.length, 1);
  assert.match(families[0].params.messages[0].content, /2 levels below the root/);
  const nodes = Object.values(t.map().nodes);
  assert.equal(Math.max(...nodes.map((n) => n.depth)), 2);
  exactlyOnce(t.map(), items.map((i) => i.id));
  assert.equal(nodes.filter((n) => !n.id.startsWith(ROOT_ID)).length, 10);
});

test('2b. a depth-3 tree for a small list is rejected', async () => {
  // planted fault: the model ignores the depth and returns two family levels
  const lines3 = JSON.parse('[' + tree(3, ['A', 'B', 'C', 'D']).trim().split('\n').join(',') + ']');
  const r = readTree(lines3, 2, 8);
  assert.ok(r.problems.length > 0);
  assert.ok(r.problems.some((p) => /level 2; the deepest level is 1/.test(p)), r.problems.join('; '));
  assert.equal(readTree(JSON.parse('[' + tree(2, ['A', 'B', 'C', 'D']).trim().split('\n').join(',') + ']'), 2, 8).problems.length, 0);
  const t = setup(model({ families: () => ({ text: tree(3, ['A', 'B', 'C', 'D']) }) }));
  await assert.rejects(organize(t.ectx, { name: 'Small', items: genItems(10), depth: 3, mode: 'agent' }), { message: BAD_TREE });
});

test('3. nothing invented: ids outside the batch are ignored', async () => {
  const items = genItems(250);
  const t = setup(model({ place: (ids, { defaults, keys, index }) => [
    ...defaults(),
    { id: 'ghost', family: keys[0] },
    { id: index === 1 ? 'item-249' : 'item-0', family: keys[0] },   // an id that is in the other batch (or a placed one)
    { id: ids[0], family: 'no-such-family' },                        // a made-up family key never places
  ] }));
  await organize(t.ectx, { name: 'Ghosts', items, depth: 3, mode: 'agent' });
  const map = t.map();
  assert.equal(map.nodes.ghost, undefined);
  assert.equal(Object.keys(map.nodes).some((id) => id.includes('ghost')), false);
  const input = new Set(items.map((i) => i.id));
  for (const n of Object.values(map.nodes)) {
    if (n.id.startsWith(ROOT_ID)) continue;
    assert.ok(input.has(n.id), `${n.id} is an input id`);
  }
  for (const n of Object.values(map.nodes)) if (n.id !== ROOT_ID) assert.ok(n.id.startsWith(ROOT_ID) || input.has(n.id));
  exactlyOnce(map, items.map((i) => i.id));
});

test('4. no double placement: misses retried, repeats ignored', async () => {
  const items = genItems(250);
  const t = setup(model({ place: (ids, { defaults, keys, retry }) => {
    if (retry) {
      // every missed id answered twice, plus an id that was placed in pass 1
      return [...defaults(), ...defaults(), { id: 'item-1', family: keys[keys.length - 1] }];
    }
    const base = defaults().filter((l) => Number(l.id.split('-')[1]) % 10 !== 0);   // omit every 10th
    return ids.includes('item-205') ? [...base, ...base.slice(0, 5), { id: 'item-205', family: keys[0] }, { id: 'item-205', family: keys[1] }] : base;
  } }));
  const res = await organize(t.ectx, { name: 'Doubles', items, depth: 3, mode: 'agent' });
  assert.equal(res.unsorted, 0);
  const leaves = leafEvents(t.events());
  assert.equal(leaves.length, 250);
  assert.equal(new Set(leaves.map((e) => e.node.id)).size, 250, 'each id once in node.added');
  exactlyOnce(t.map(), items.map((i) => i.id));
  assert.ok(t.fake.calls.some((c) => isPlacement(c.params) && c.params.messages[0].content.includes('missed last time')), 'retry ran');
});

test('5. bad family tree: two attempts, then BAD_TREE and no leaves written', async () => {
  const two = lines([
    { key: 'a', label: 'Alpha', parent: 'ROOT', description: '' },
    { key: 'b', label: 'Bravo', parent: 'ROOT', description: '' },
  ]);
  const t = setup(model({ families: () => ({ text: two }) }));
  await assert.rejects(organize(t.ectx, { name: 'Bad', items: SAMPLE_120, depth: 2, mode: 'agent' }), { message: BAD_TREE });
  const fam = t.fake.calls.filter((c) => isFamilies(c.params));
  assert.equal(fam.length, 2);
  assert.ok(!fam[0].params.messages[0].content.includes('last attempt'));
  assert.match(fam[1].params.messages[0].content, /Your last attempt had these problems/);
  assert.match(fam[1].params.messages[0].content, /there are 2 top-level families/);
  assert.equal(t.fake.calls.filter((c) => isPlacement(c.params)).length, 0);
  const added = ofType(t.events(), 'node.added');
  assert.equal(added.length, 1);
  assert.equal(added[0].node.id, ROOT_ID);
});

test('6. event order and leaf fields (agent mode)', async () => {
  const t = setup(model());
  await organize(t.ectx, { name: 'Payments', items: SAMPLE_120, depth: 3, mode: 'agent' });
  const ev = t.events();
  assert.equal(ev[0].t, 'ontology.created');
  assert.equal(ev[0].mode, 'agent');
  assert.equal(ev[0].root, '_root');
  assert.equal(ev[1].t, 'view.changed');
  assert.equal(ev[1].patch.filter.maxDepth, 2);
  assert.equal(ev[2].t, 'node.added');
  assert.equal(ev[2].node.id, ROOT_ID);
  assert.equal(ev[2].node.depth, 0);
  assert.equal(ev[2].node.origin, 'seed');
  assert.equal(ev[2].node.createdBy, 'organize');
  assert.equal(t.map().view.filter.maxDepth, 2);

  // families: top-level category.added immediately followed by its node.added
  const rest = ev.slice(3).filter((e) => !e.t.startsWith('job.'));
  const firstLeaf = rest.findIndex((e) => e.t === 'node.added' && !e.node.id.startsWith(ROOT_ID));
  const famEvents = rest.slice(0, firstLeaf);
  assert.ok(famEvents.length > 0);
  assert.ok(rest.slice(firstLeaf).every((e) => e.t === 'node.added' && !e.node.id.startsWith(ROOT_ID)), 'all leaves after all families, nothing else among them');
  let idx = 0;
  /** @type {Set<string>} */
  const seen = new Set([ROOT_ID]);
  famEvents.forEach((e, i) => {
    if (e.t === 'category.added') {
      assert.equal(e.category.family, 0);
      assert.equal(e.category.index, idx++);
      const nx = famEvents[i + 1];
      assert.equal(nx.t, 'node.added');
      assert.equal(nx.node.id, e.category.id);
      assert.equal(nx.node.parent, ROOT_ID);
    } else {
      assert.equal(e.t, 'node.added');
      assert.ok(seen.has(e.node.parent), `${e.node.id} written after its parent ${e.node.parent}`);
      seen.add(e.node.id);
    }
  });
  assert.equal(idx, 4);

  // leaves
  const leaves = leafEvents(ev);
  assert.deepEqual(leaves.map((e) => e.node.id), ids120, 'input order');
  const byId = t.map().nodes;
  for (const [i, e] of leaves.entries()) {
    const n = e.node;
    const src = SAMPLE_120[i];
    assert.equal(n.label, src.label);
    assert.equal(n.summary, src.text ?? '');
    assert.equal(n.origin, 'seed');
    assert.equal(n.createdBy, 'organize');
    assert.equal(n.status, 'done');
    let top = byId[n.parent];
    while (top.parent !== ROOT_ID) top = byId[top.parent];
    assert.equal(n.category, top.id, 'category is the top-level family id');
  }
});

test('6b. a leaf with no text has an empty summary', async () => {
  const items = genItems(30, { text: false });
  const t = setup(model());
  await organize(t.ectx, { name: 'NoText', items, depth: 3, mode: 'agent' });
  for (const e of leafEvents(t.events())) assert.equal(e.node.summary, '');
});

test('6c. human mode: mode human, no view.changed, filter.maxDepth stays null', async () => {
  const t = setup(model());
  await organize(t.ectx, { name: 'Mine', items: SAMPLE_120, depth: 3, mode: 'human' });
  assert.equal(t.events()[0].mode, 'human');
  assert.equal(t.map().mode, 'human');
  assert.equal(ofType(t.events(), 'view.changed').length, 0);
  assert.equal(t.map().view.filter.maxDepth, null);
  exactlyOnce(t.map(), ids120);
});

test('7. ids: a model family called Unsorted does not take _root/unsorted', async () => {
  const missing = new Set([ids120[0], ids120[1], ids120[2]]);
  const t = setup(model({ labels: ['Unsorted', 'Bravo', 'Charlie', 'Delta'],
    place: (ids, { defaults }) => defaults().filter((l) => !missing.has(l.id)) }));
  await organize(t.ectx, { name: 'Payments', items: SAMPLE_120, depth: 3, mode: 'agent' });
  const nodes = t.map().nodes;
  assert.equal(nodes['_root/unsorted-2'].label, 'Unsorted');
  assert.equal(nodes['_root/unsorted-2'].summary, 'About Unsorted');
  assert.equal(nodes[UNSORTED_ID].summary, 'Items the model could not place.');
  for (const id of missing) assert.equal(nodes[id].parent, UNSORTED_ID);
  assert.ok(Object.values(nodes).some((n) => n.parent === '_root/unsorted-2'));
  exactlyOnce(t.map(), ids120);
});

test('8. batching, metering and call settings', async () => {
  const items = genItems(450);
  const t = setup(model({ delayMs: 30 }));
  await organize(t.ectx, { name: 'Batches', items, depth: 3, mode: 'agent' });
  assert.equal(t.fake.calls.length, 1 + Math.ceil(450 / 200));
  const fam = t.fake.calls.filter((c) => isFamilies(c.params));
  const place = t.fake.calls.filter((c) => isPlacement(c.params));
  assert.equal(fam.length, 1);
  assert.equal(place.length, 3);
  assert.equal(fam[0].params.output_config.effort, 'medium');
  assert.equal(fam[0].params.max_tokens, 8000);
  for (const c of place) {
    assert.equal(c.params.output_config.effort, 'low');
    assert.equal(c.params.max_tokens, 12000);
    const n = Number(/Items \((\d+)\)/.exec(c.params.messages[0].content)?.[1]);
    assert.ok(n <= 200 && n > 0, `batch of ${n}`);
  }
  exactlyOnce(t.map(), items.map((i) => i.id));
});

/** Peak overlap of intervals; a finish at the same ms as a start counts as finished first. @param {{ startedAt: number, finishedAt: number|null }[]} calls */
function peak(calls) {
  /** @type {[number, number][]} */
  const pts = [];
  for (const c of calls) { pts.push([c.startedAt, 1]); pts.push([/** @type {number} */ (c.finishedAt), -1]); }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0; let max = 0;
  for (const [, d] of pts) { cur += d; max = Math.max(max, cur); }
  return max;
}

test('8b. at most 3 placement calls in flight', async () => {
  const items = genItems(1200);   // 6 batches
  const t = setup(model({ delayMs: 60 }));
  await organize(t.ectx, { name: 'Flight', items, depth: 3, mode: 'agent' });
  const place = t.fake.calls.filter((c) => isPlacement(c.params));
  assert.equal(place.length, 6);
  const p = peak(place);
  assert.ok(p <= 3, `peak in flight ${p}`);
  assert.ok(p >= 2, `calls ran in parallel (peak ${p})`);
  // planted fault: the peak helper does see overlap beyond 3
  assert.equal(peak([1, 2, 3, 4].map(() => ({ startedAt: 0, finishedAt: 10 }))), 4);
});

test('9. sampling', async () => {
  const big = genItems(5000);
  const s = sampleItems(big);
  assert.ok(s.length <= 2000);
  assert.equal(s.length, 1667);
  s.forEach((it, i) => assert.equal(it, big[i * 3]));
  assert.equal(sampleItems(genItems(2000)).length, 2000);
  assert.equal(maxDeepest(2500), 200);

  const items = genItems(2500);
  const t = setup(model());
  await organize(t.ectx, { name: 'Sampled', items, depth: 3, mode: 'agent' });
  const prompt = t.fake.calls.find((c) => isFamilies(c.params))?.params.messages[0].content;
  assert.match(prompt, /an even sample of 1250 of 2500/);
  assert.equal(prompt.split('\n').filter((/** @type {string} */ l) => l.startsWith('- ')).length, 1250);
});

test('10. a 401 on a placement call rejects the run', async () => {
  const t = setup(model({ placeError: { status: 401 } }));
  await assert.rejects(organize(t.ectx, { name: 'Auth', items: SAMPLE_120, depth: 3, mode: 'agent' }), (/** @type {any} */ e) => e.status === 401);
  assert.equal(leafEvents(t.events()).length, 0);
  // control: other errors do not reject the run: the items get the retry, then go under Unsorted
  const t2 = setup(model({ placeError: { status: 500 } }));
  await organize(t2.ectx, { name: 'Down', items: SAMPLE_120, depth: 3, mode: 'agent' });
  const m2 = t2.map();
  assert.ok(SAMPLE_120.every((/** @type {any} */ it) => m2.nodes[it.id]?.parent === UNSORTED_ID), 'every item under Unsorted');
});

test('11. scale: 2,000 items finish in under 20 s and are placed exactly once', async () => {
  const items = genItems(2000);
  const t = setup(model());
  const t0 = Date.now();
  await organize(t.ectx, { name: 'Scale', items, depth: 3, mode: 'agent' });
  assert.ok(Date.now() - t0 < 20000, `took ${Date.now() - t0} ms`);
  exactlyOnce(t.map(), items.map((i) => i.id));
});

// Waits on another epic (hydrate/export speed work), so the 10,000-item run is not asserted here yet.
test('11b. scale: 10,000 items finish in under 60 s, are placed exactly once, and the map folds in under 200 ms', async () => {
  const items = genItems(10000);
  const t = setup(model());
  // As the real store (src/core/store.js) does since the fold-speed epic: fold each event in place.
  /** @type {any[]} */ const log = [];
  const acc = emptyOntology();
  t.store.append = (/** @type {string} */ _id, /** @type {any} */ e) => { log.push(e); foldInto(acc, e); };
  t.store.read = () => acc;
  t.store.list = () => log;
  const t0 = Date.now();
  await organize(t.ectx, { name: 'Scale', items, depth: 3, mode: 'agent' });
  const ran = Date.now() - t0;
  assert.ok(ran < 60000, `run took ${ran} ms`);
  exactlyOnce(t.map(), items.map((i) => i.id));
  // The page and every reader replay the log: one fold of all ~10k events must stay fast.
  const f0 = performance.now();
  const o = foldAll(log);
  const folded = performance.now() - f0;
  assert.equal(Object.keys(o.nodes).length, Object.keys(t.map().nodes).length);
  assert.ok(folded < 200, `fold took ${folded.toFixed(0)} ms`);
  // planted fault: a fold that copies the node table per node.added (the 1.8.0 fold) blows the budget
  const slow = (/** @type {any[]} */ ev) => { let nodes = {}; for (const e of ev) if (e.t === 'node.added') nodes = { ...nodes, [e.node.id]: e.node }; return nodes; };
  const s0 = performance.now();
  slow(log);
  assert.ok(performance.now() - s0 > folded, 'the quadratic fold is slower than the real one');
});

// ---------------------------------------------------------------------------------------------
// 12. checkInput

const ok = (/** @type {any} */ body) => checkInput(body);
/** @param {any} body @param {string} error */
const bad = (body, error) => assert.deepEqual(checkInput(body), { ok: false, error });
const item = (/** @type {any} */ extra = {}) => ({ id: 'a', label: 'A', ...extra });
const body = (/** @type {any} */ extra = {}) => ({ name: 'N', items: [item()], ...extra });
const many = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, label: `L${i}` }));

test('12. checkInput: name', () => {
  const E = 'name must be 1 to 120 characters';
  bad(body({ name: '' }), E);
  bad(body({ name: '   ' }), E);
  bad(body({ name: 'x'.repeat(121) }), E);
  bad(body({ name: 5 }), E);
  bad(null, E);
  assert.equal(ok(body({ name: 'x'.repeat(120) })).ok, true);
  const r = ok(body({ name: '  Spaced  ' }));
  assert.ok(r.ok && r.input.name === 'Spaced' && r.input.mode === 'agent' && r.input.depth === 3);
});

test('12. checkInput: item count by mode', () => {
  bad(body({ items: many(10001) }), 'items must be a list of 1 to 10000 items');
  bad(body({ items: many(501), mode: 'human' }), 'items must be a list of 1 to 500 items');
  bad(body({ items: [] }), 'items must be a list of 1 to 10000 items');
  bad(body({ items: 'x' }), 'items must be a list of 1 to 10000 items');
  assert.equal(ok(body({ items: many(500), mode: 'human' })).ok, true);
  assert.equal(ok(body({ items: many(10000) })).ok, true);
  assert.equal(ok(body({ items: many(501) })).ok, true);   // agent mode takes 501
});

test('12. checkInput: item id', () => {
  const E = 'item 0: id must be 1 to 120 letters, digits or . _ : ~ - and may not start with _';
  for (const id of ['a/b', '_x', '', 'x'.repeat(121), 'a b', '.a', 5, undefined]) bad(body({ items: [item({ id })] }), E);
  for (const id of ['x'.repeat(120), 'a_b', 'pay.refund-payment', 'a:b~c', '9']) assert.equal(ok(body({ items: [item({ id })] })).ok, true, String(id));
  bad(body({ items: [item(), item({ id: '_y' })] }), E.replace('item 0', 'item 1'));
});

test('12. checkInput: reserved names', () => {
  bad(body({ items: [item({ id: 'constructor' })] }), 'item 0: "constructor" is a reserved name');
  bad(body({ items: [item({ id: 'toString' })] }), 'item 0: "toString" is a reserved name');
  assert.equal(ok(body({ items: [item({ id: 'constructors' })] })).ok, true);
});

test('12. checkInput: item label', () => {
  const E = 'item 0: label must be 1 to 80 characters';
  for (const label of ['', '   ', 'x'.repeat(81), 'a\u0001b', 'a\nb', 7]) bad(body({ items: [item({ label })] }), E);
  assert.equal(ok(body({ items: [item({ label: 'x'.repeat(80) })] })).ok, true);
});

test('12. checkInput: item text', () => {
  const E = 'item 0: text must be at most 500 characters';
  bad(body({ items: [item({ text: 'x'.repeat(501) })] }), E);
  bad(body({ items: [item({ text: 5 })] }), E);
  assert.equal(ok(body({ items: [item({ text: 'x'.repeat(500) })] })).ok, true);
  assert.equal(ok(body({ items: [item({ text: '' })] })).ok, true);
});

test('12. checkInput: duplicate ids, depth, mode', () => {
  bad(body({ items: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'a' }), item({ id: 'b' })] }), 'duplicate ids: a, b');
  assert.equal(ok(body({ items: [item({ id: 'a' }), item({ id: 'b' })] })).ok, true);
  for (const depth of [1, 5, 2.5, '3', null, 0]) bad(body({ depth }), 'depth must be 2, 3 or 4');
  for (const depth of [2, 3, 4]) assert.equal(ok(body({ depth })).ok, true);
  const d = ok(body());
  assert.ok(d.ok && d.input.depth === 3);
  for (const mode of ['robot', 'Human', null, 5]) bad(body({ mode }), 'mode must be agent or human');
  for (const mode of ['agent', 'human']) assert.equal(ok(body({ mode })).ok, true);
});

test('12. checkInput: a bad input stops organize before anything is written', async () => {
  const t = setup(model());
  await assert.rejects(organize(t.ectx, { name: '', items: [item()] }), { message: 'organize: name must be 1 to 120 characters' });
  assert.equal(t.events().length, 0);
  assert.equal(t.fake.calls.length, 0);
});
