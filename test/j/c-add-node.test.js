// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// C · addNode() on maps built from the fixtures: exactly one node, every refusal writes nothing, a
// child of the root is a new category. Each check feeds its planted fault first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../../src/core/store.js';
import { addNode, addNodeAction } from '../../src/server/actions/add-node.js';
import { BUSY, SAVING } from '../../src/server/texts.js';
import { fixtureEvents } from '../i/helpers-service.js';
import { faultyModule } from '../i/helpers-fault.js';
import { validate } from '../a/fixtures.test.js';

const ACTOR = { id: 'tok', kind: 'agent' };

/** A fresh files store holding one fixture map; emit stamps the actor, as map.js's does. @param {string} name */
function setup(name = 'plastic-modeling') {
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'onto-c-')));
  store.importEvents(name, fixtureEvents(name));
  const id = name;
  /** @type {any[]} */ const written = [];
  const emit = (/** @type {string} */ t, /** @type {object} */ fields) => {
    const ev = { t, at: store.now(id), ...fields, actor: ACTOR };
    written.push(ev);
    return store.append(id, ev);
  };
  return { store, id, emit, written };
}

/** A broken copy of add-node.js. @param {Array<[string, string]>} fault */
const broken = async (fault) => /** @type {any} */ (await faultyModule('src/server/actions/add-node.js', fault));

/** The problems with one add: exactly one node.added (+ one category.added only under the root). @param {any} r @param {any[]} written @param {boolean} underRoot */
function oneNodeProblems(r, written, underRoot) {
  /** @type {string[]} */ const p = [];
  if (r.status !== 201) p.push(`status ${r.status}`);
  const nodes = written.filter((e) => e.t === 'node.added');
  const cats = written.filter((e) => e.t === 'category.added');
  if (nodes.length !== 1) p.push(`${nodes.length} node.added`);
  if (cats.length !== (underRoot ? 1 : 0)) p.push(`${cats.length} category.added`);
  if (written.length !== nodes.length + cats.length) p.push('other events written');
  return p;
}

test('one call appends exactly one node, and answers the folded node', async () => {
  const s = setup();
  const o = s.store.read(s.id);
  const parentId = Object.values(o.nodes).find((n) => n.depth === 1).id;
  const r = addNode(s.store, s.id, { parentId, label: '  Restaking ', summary: ' Reusing staked ETH ' }, { emit: s.emit });
  assert.deepEqual(oneNodeProblems(r, s.written, false), []);
  assert.equal(r.status, 201);
  const node = /** @type {any} */ (r).node;
  assert.deepEqual(node, s.store.read(s.id).nodes[`${parentId}/restaking`]);
  assert.equal(node.label, 'Restaking');
  assert.equal(node.summary, 'Reusing staked ETH');
  assert.equal(node.depth, o.nodes[parentId].depth + 1);
  assert.equal(node.category, o.nodes[parentId].category);
  assert.equal(node.createdBy, 'add_node');
  assert.equal(s.written[0].actor, ACTOR);
  // planted fault: a handler that appends the node twice
  const f = await broken([["  return { status: 201, node:", "  emit('node.added', { node: { id: nid + '-x', label, parent: parentId } });\n  return { status: 201, node:"]]);
  const t = setup();
  const r2 = f.addNode(t.store, t.id, { parentId, label: 'Restaking' }, { emit: t.emit });
  assert.notDeepEqual(oneNodeProblems(r2, t.written, false), []);
});

test('under the root: a category with the next index and family 0, and a valid fixture', async () => {
  const s = setup();
  const o = s.store.read(s.id);
  const r = /** @type {any} */ (addNode(s.store, s.id, { parentId: o.root, label: 'Restaking' }, { emit: s.emit }));
  assert.deepEqual(oneNodeProblems(r, s.written, true), []);
  assert.deepEqual(s.written[0].category, { id: r.node.id, label: 'Restaking', index: o.categories.length, family: 0 });
  assert.equal(r.node.category, r.node.id);
  const all = [...fixtureEvents('plastic-modeling'), ...s.written];
  assert.deepEqual(validate(all), []);
  // planted fault: leaving the category out fails the fixture validator
  const f = await broken([["  if (isRootChild) emit('category.added'", "  if (false) emit('category.added'"]]);
  const t = setup();
  f.addNode(t.store, t.id, { parentId: o.root, label: 'Restaking' }, { emit: t.emit });
  assert.notDeepEqual(validate([...fixtureEvents('plastic-modeling'), ...t.written]), []);
});

test('every input refusal answers its text and writes nothing', () => {
  const s = setup('demo');
  const root = s.store.read(s.id).root;
  /** @type {Array<[any, number, string]>} */
  const cases = [
    [{ label: 'x' }, 400, 'give parentId and label'],
    [{ parentId: '', label: 'x' }, 400, 'give parentId and label'],
    [{ parentId: root }, 400, 'give parentId and label'],
    [{ parentId: root, label: '   ' }, 400, 'label must be 1 to 80 characters'],
    [{ parentId: root, label: 'x'.repeat(81) }, 400, 'label must be 1 to 80 characters'],
    [{ parentId: root, label: 'a\u0007b' }, 400, 'label must be 1 to 80 characters'],
    [{ parentId: root, label: 7 }, 400, 'label must be 1 to 80 characters'],
    [{ parentId: root, label: 'x', summary: 'y'.repeat(301) }, 400, 'summary must be at most 300 characters'],
    [{ parentId: root, label: 'x', summary: 3 }, 400, 'summary must be at most 300 characters'],
    [{ parentId: 'x', label: 'y' }, 404, 'no node "x"'],
  ];
  for (const [input, status, error] of cases) assert.deepEqual(addNode(s.store, s.id, input, { emit: s.emit }), { status, error }, JSON.stringify(input));
  assert.equal(s.written.length, 0);
  // 80 characters is still fine
  assert.equal(addNode(s.store, s.id, { parentId: root, label: 'x'.repeat(80) }, { emit: s.emit }).status, 201);
});

test('unknown parent: 404 and nothing written', async () => {
  const s = setup();
  assert.deepEqual(addNode(s.store, s.id, { parentId: 'x', label: 'y' }, { emit: s.emit }), { status: 404, error: 'no node "x"' });
  assert.equal(s.written.length, 0);
  // planted fault: appending before the parent check
  const f = await broken([["  if (!Object.hasOwn(o.nodes, parentId)) return", "  emit('node.added', { node: { id: 'x/y', label, parent: parentId } });\n  if (!Object.hasOwn(o.nodes, parentId)) return"]]);
  const t = setup();
  f.addNode(t.store, t.id, { parentId: 'x', label: 'y' }, { emit: t.emit });
  assert.notEqual(t.written.length, 0);
});

test('built-in names are not nodes: parentId "constructor" answers 404 and writes nothing', async () => {
  for (const parentId of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const s = setup();
    assert.deepEqual(addNode(s.store, s.id, { parentId, label: 'y' }, { emit: s.emit }), { status: 404, error: `no node "${parentId}"` });
    assert.equal(s.written.length, 0, parentId);
  }
  // planted fault: an o.nodes[parentId] check lets "constructor" through and writes depth NaN
  const f = await broken([['  if (!Object.hasOwn(o.nodes, parentId)) return', '  if (!o.nodes[parentId]) return']]);
  const t = setup();
  const r = f.addNode(t.store, t.id, { parentId: 'constructor', label: 'y' }, { emit: t.emit });
  assert.notEqual(r.status, 404);
  assert.ok(Number.isNaN(t.written.find((e) => e.t === 'node.added').node.depth));
});

test('duplicate label (case and spaces ignored): 409 with the existing id, and nothing written', async () => {
  const s = setup();
  const o = s.store.read(s.id);
  const child = Object.values(o.nodes).find((n) => n.depth === 2);
  const parentId = /** @type {string} */ (child.parent);
  const r = addNode(s.store, s.id, { parentId, label: `  ${child.label.toUpperCase()} ` }, { emit: s.emit });
  assert.deepEqual(r, { status: 409, error: `"${child.label.toUpperCase()}" already exists under ${parentId}: ${child.id}` });
  assert.equal(s.written.length, 0);
  // planted fault: no duplicate check (childId then makes a "-2" id)
  const f = await broken([['  if (same) return', '  if (false) return']]);
  const t = setup();
  const r2 = f.addNode(t.store, t.id, { parentId, label: child.label }, { emit: t.emit });
  assert.equal(r2.status, 201);
  assert.match(r2.node.id, /-2$/);
});

test('a map that is building or being saved: 409 with the router texts, and nothing written', () => {
  const s = setup();
  const root = s.store.read(s.id).root;
  assert.deepEqual(addNode(s.store, s.id, { parentId: root, label: 'y' }, { emit: s.emit, busy: () => true }), { status: 409, error: BUSY });
  assert.deepEqual(addNode(s.store, s.id, { parentId: root, label: 'y' }, { emit: s.emit, busy: () => false, saving: () => true }), { status: 409, error: SAVING });
  assert.equal(s.written.length, 0);
  assert.equal(addNode(s.store, s.id, { parentId: root, label: 'y' }, { emit: s.emit, busy: () => false, saving: () => false }).status, 201);
});

test('addNodeAction answers 201 { ok, node } only after sync, and the refusals with { ok: false, error }', async () => {
  const s = setup();
  const root = s.store.read(s.id).root;
  /** @type {any[]} */ const replies = [];
  const order = /** @type {string[]} */ ([]);
  const json = (/** @type {any} */ _res, /** @type {number} */ status, /** @type {any} */ body) => { order.push('reply'); replies.push({ status, body }); };
  const ctx = { sync: async () => { order.push('sync'); }, busy: () => false, saving: () => false };
  await addNodeAction({ res: {}, body: { type: 'add_node', parentId: root, label: 'Restaking' }, ctx, store: s.store, id: s.id, json, emit: s.emit });
  assert.deepEqual(order, ['sync', 'reply']);
  assert.equal(replies[0].status, 201);
  assert.deepEqual(replies[0].body, { ok: true, node: s.store.read(s.id).nodes[`${root}/restaking`] });
  await addNodeAction({ res: {}, body: { parentId: 'nope', label: 'x' }, ctx, store: s.store, id: s.id, json, emit: s.emit });
  assert.deepEqual(replies[1], { status: 404, body: { ok: false, error: 'no node "nope"' } });
  // the one-map server has no ctx: busy and saving count as false
  await addNodeAction({ res: {}, body: { parentId: root, label: 'Other' }, ctx: undefined, store: s.store, id: s.id, json, emit: s.emit });
  assert.equal(replies[2].status, 201);
  // a store that can't sync answers 503
  await addNodeAction({ res: {}, body: { parentId: root, label: 'Third' }, ctx: { sync: async () => { throw new Error('down'); } }, store: s.store, id: s.id, json, emit: s.emit });
  assert.equal(replies[3].status, 503);
});

test('many adds in a row get distinct ids, and a repeated label is refused', () => {
  const s = setup('demo');
  const root = s.store.read(s.id).root;
  const ids = new Set();
  for (let i = 0; i < 20; i++) ids.add(/** @type {any} */ (addNode(s.store, s.id, { parentId: root, label: `New ${i}` }, { emit: s.emit })).node.id);
  assert.equal(ids.size, 20);
  assert.equal(addNode(s.store, s.id, { parentId: root, label: 'new 3' }, { emit: s.emit }).status, 409);
});
