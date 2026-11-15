// @ts-check
// B3: the hydrate job body (validation, retry, events, failure report) and B2's prompt, against the
// fake client. Each check feeds its planted fault, so a check that cannot fail is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hydrateJob, validLine } from '../../src/core/engine/hydrate.js';
import { hydratePrompt } from '../../src/core/engine/prompts-hydrate.js';
import { runCall, KEY_REJECTED } from '../../src/core/engine/call.js';
import { createJobQueue } from '../../src/core/engine/queue.js';
import { createFakeClient, createMemoryStore, lines } from '../c/fake.js';

const MODELS = { fast: 'fake-haiku', strong: 'fake-sonnet' };
const fixture = readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** A small map: root r; families a (children a1, a2, a3), b (one child b1), c. */
function smallMap() {
  const store = createMemoryStore();
  const add = (/** @type {string} */ id, /** @type {string} */ label, /** @type {string|null} */ parent, /** @type {number} */ depth) =>
    store.append('m', { t: 'node.added', at: 1, node: { id, label, parent, depth, category: '', summary: `${label} things`, sources: [], article: null, status: 'done', createdBy: 'test', origin: 'seed' } });
  store.append('m', { t: 'ontology.created', at: 0, name: 'm', root: 'r', brief: { subject: 'Crypto' }, categories: [] });
  add('r', 'Root', null, 0);
  for (const f of ['a', 'b', 'c']) add(f, f.toUpperCase(), 'r', 1);
  for (const k of ['a1', 'a2', 'a3']) add(k, k.toUpperCase(), 'a', 2);
  add('b1', 'B1', 'b', 2);
  return store;
}

/** @param {any} store @param {(p: any, i: number) => any} respond */
function ctxFor(store, respond, id = 'm') {
  const fake = createFakeClient({ respond, chunkMs: 0 });
  const ectx = {
    store, id, models: MODELS,
    emit: (/** @type {string} */ t, /** @type {any} */ f) => store.append(id, { t, at: 1, ...f }),
    call: (/** @type {any} */ p, /** @type {any} */ on) => runCall(() => fake, p, on),
  };
  return { ectx, fake };
}

/** A passing line for node id with look-alike other. @param {string} id @param {string[]} others */
const good = (id, others) => ({ id, job: `Job of ${id}`, examples: [`${id} one`, `${id} two`, `${id} three`], not_for: `Not ${others.join(', ')}.`, not_for_ids: others });
/** @param {any} store */
const hyd = (store, id = 'm') => store.list(id).filter((/** @type {any} */ e) => e.t === 'node.hydrated');

test('a full reply stores every node at once, with model id and time; one call, no tools', async () => {
  const store = smallMap();
  const { ectx, fake } = ctxFor(store, () => ({ text: lines([good('a1', ['a2']), good('a2', ['a1', 'a3']), good('a3', ['a1'])]) }));
  await hydrateJob(ectx, { nodeIds: ['a1', 'a2', 'a3'], model: 'sonnet', nodeId: 'a' });
  assert.equal(fake.calls.length, 1);
  const p = fake.calls[0].params;
  assert.equal(p.model, 'fake-sonnet');
  assert.equal(p.max_tokens, 12000);
  assert.deepEqual(p.output_config, { effort: 'medium' });
  assert.equal(p.tools, undefined);
  const o = store.read('m');
  assert.deepEqual(o.nodes.a2.hydration.not_for_ids, ['a1', 'a3']);
  assert.equal(o.nodes.a1.hydration.model, 'fake-sonnet');
  assert.match(o.nodes.a1.hydration.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(hyd(store).length, 3);
});

test('haiku uses the fast model', async () => {
  const store = smallMap();
  const { ectx, fake } = ctxFor(store, () => ({ text: lines([good('a1', ['a2'])]) }));
  await hydrateJob(ectx, { nodeIds: ['a1'], model: 'haiku', nodeId: 'a' });
  assert.equal(fake.calls[0].params.model, 'fake-haiku');
});

test('all three fields or none: missing not_for is retried once, then the node stays empty and the job fails naming it', async () => {
  const store = smallMap();
  const bad = { ...good('a2', ['a1']), not_for: undefined };
  const { ectx, fake } = ctxFor(store, () => ({ text: lines([good('a1', ['a2']), bad, good('a3', ['a1'])]) }));
  await assert.rejects(hydrateJob(ectx, { nodeIds: ['a1', 'a2', 'a3'], model: 'sonnet', nodeId: 'a' }),
    { message: 'hydrate: 1 of 3 nodes failed validation: a2' });
  assert.equal(fake.calls.length, 2);
  // the retry asks only for the failing node
  assert.match(fake.calls[1].params.messages[0].content, /The nodes to hydrate \(1\):\n- id: a2\n/);
  const o = store.read('m');
  assert.equal(Object.hasOwn(o.nodes.a2, 'hydration'), false);
  assert.ok(o.nodes.a1.hydration && o.nodes.a3.hydration);   // the nodes that passed stay stored
  // planted fault: storing the partial object leaves a hydration on a2
  const partial = { ...bad, not_for: '' };
  assert.equal(validLine(o, 'a2', bad), null);
  assert.equal(validLine(o, 'a2', partial), null);
});

test('a retry that passes fixes the node; the job succeeds', async () => {
  const store = smallMap();
  const { ectx, fake } = ctxFor(store, (_p, i) => ({ text: lines(i === 0 ? [good('a1', ['a2'])] : [good('a2', ['a1'])]) }));
  await hydrateJob(ectx, { nodeIds: ['a1', 'a2'], model: 'sonnet', nodeId: 'a' });
  assert.equal(fake.calls.length, 2);
  assert.ok(store.read('m').nodes.a2.hydration);
});

test('a max_tokens stop retries the nodes that never arrived', async () => {
  const store = smallMap();
  const { ectx, fake } = ctxFor(store, (_p, i) => (i === 0
    ? { text: lines([good('a1', ['a2'])]) + '{"id":"a2","job":"cut', stop_reason: 'max_tokens' }
    : { text: lines([good('a2', ['a1'])]) }));
  await hydrateJob(ectx, { nodeIds: ['a1', 'a2'], model: 'sonnet', nodeId: 'a' });
  assert.equal(fake.calls.length, 2);
  assert.ok(store.read('m').nodes.a2.hydration);
});

test('not_for_ids must be real ids, never the node itself, no repeats, at most 3', () => {
  const o = smallMap().read('m');
  assert.ok(validLine(o, 'a1', good('a1', ['a2'])));
  // planted faults: each of these would store a bad pointer
  assert.equal(validLine(o, 'a1', good('a1', ['does-not-exist'])), null);
  assert.equal(validLine(o, 'a1', good('a1', ['a1'])), null);
  assert.equal(validLine(o, 'a1', good('a1', ['a2', 'a2'])), null);
  assert.equal(validLine(o, 'a1', good('a1', ['a2', 'a3', 'b', 'c'])), null);
  assert.equal(validLine(o, 'a1', good('a1', ['constructor'])), null);   // built-in name, not a node
  assert.equal(validLine(o, 'a1', good('a1', [])), null);                // a1 has siblings
  // the parent's siblings count as real neighbours
  assert.ok(validLine(o, 'a1', good('a1', ['b'])));
});

test('an only child may have no look-alikes; others may not', () => {
  const o = smallMap().read('m');
  const lone = { ...good('b1', []), not_for: '' };
  assert.ok(validLine(o, 'b1', lone));
  assert.equal(validLine(o, 'a1', { ...good('a1', []), not_for: '' }), null);
});

test('job and examples: lengths, exactly 3, all different', () => {
  const o = smallMap().read('m');
  const g = good('a1', ['a2']);
  assert.equal(validLine(o, 'a1', { ...g, job: '   ' }), null);
  assert.equal(validLine(o, 'a1', { ...g, job: 'x'.repeat(201) }), null);
  assert.equal(validLine(o, 'a1', { ...g, examples: ['a', 'b'] }), null);
  assert.equal(validLine(o, 'a1', { ...g, examples: ['a', 'b', 'c', 'd'] }), null);
  assert.equal(validLine(o, 'a1', { ...g, examples: ['a', 'a', 'b'] }), null);
  assert.equal(validLine(o, 'a1', { ...g, examples: ['a', 'b', 7] }), null);
  assert.equal(validLine(o, 'a1', { ...g, examples: ['a', 'b', 'x'.repeat(201)] }), null);
  assert.equal(validLine(o, 'a1', { ...g, not_for: 'x'.repeat(401) }), null);
  assert.ok(validLine(o, 'a1', { ...g, job: '  ' + 'x'.repeat(200) + '  ' }));   // trimmed first
});

test('no foreign ids: a line for an id outside the batch is ignored; repeats of an id are ignored', async () => {
  const store = smallMap();
  const { ectx } = ctxFor(store, () => ({ text: lines([good('a1', ['a2']), good('a3', ['a1']), { ...good('a1', ['a3']), job: 'Second' }]) }));
  await assert.rejects(hydrateJob(ectx, { nodeIds: ['a1', 'a2'], model: 'sonnet', nodeId: 'a' }), /1 of 2 nodes failed validation: a2/);
  const o = store.read('m');
  assert.equal(Object.hasOwn(o.nodes.a3, 'hydration'), false);   // planted fault: storing it gives a3 a hydration
  assert.equal(o.nodes.a1.hydration.job, 'Job of a1');           // the first answer wins
  assert.equal(hyd(store).length, 1);
});

test('the failure names at most 10 ids', async () => {
  const store = createMemoryStore();
  store.append('m', { t: 'ontology.created', at: 0, name: 'm', root: 'r', brief: { subject: 'S' }, categories: [] });
  store.append('m', { t: 'node.added', at: 1, node: { id: 'r', label: 'R', parent: null, depth: 0 } });
  const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
  for (const id of ids) store.append('m', { t: 'node.added', at: 1, node: { id, label: id, parent: 'r', depth: 1 } });
  const { ectx } = ctxFor(store, () => ({ text: '' }));
  await assert.rejects(hydrateJob(ectx, { nodeIds: ids, model: 'sonnet', nodeId: 'r' }),
    { message: `hydrate: 12 of 12 nodes failed validation: ${ids.slice(0, 10).join(', ')}` });
});

test('a 401 fails the job with the key-rejected message', async () => {
  const store = smallMap();
  const { ectx } = ctxFor(store, () => ({ error: { status: 401 } }));
  /** @type {any[]} */ const events = [];
  const q = createJobQueue({ emit: (t, f) => events.push({ t, ...f }) });
  q.add({ kind: 'hydrate', nodeId: 'a' }, () => hydrateJob(ectx, { nodeIds: ['a1'], model: 'sonnet', nodeId: 'a' }));
  await q.onIdle();
  const failed = events.find((e) => e.t === 'job.failed');
  assert.equal(failed.job.error, KEY_REJECTED);
  assert.equal(hyd(store).length, 0);
});

test('lines are stored as they stream, before the call ends', async () => {
  const store = smallMap();
  /** @type {number[]} */ const seenAt = [];
  const { ectx } = ctxFor(store, () => ({ text: lines([good('a1', ['a2']), good('a2', ['a1'])]) }));
  const emit = ectx.emit;
  let ended = false;
  ectx.emit = (t, f) => { seenAt.push(ended ? 1 : 0); emit(t, f); };
  const call = ectx.call;
  ectx.call = async (p, on) => { const r = await call(p, on); ended = true; return r; };
  await hydrateJob(ectx, { nodeIds: ['a1', 'a2'], model: 'sonnet', nodeId: 'a' });
  assert.deepEqual(seenAt, [0, 0]);
});

test('prompt: subject, parent path, batch nodes with summary and children, every sibling, the parent\'s siblings', () => {
  const store = createMemoryStore();
  for (const e of fixture) store.append('pm', e);
  const o = store.read('pm');
  const parent = 'plastic-modeling/tools';
  const kids = Object.values(o.nodes).filter((/** @type {any} */ n) => n.parent === parent).map((/** @type {any} */ n) => n.id);
  assert.ok(kids.length >= 3);
  const batch = kids.slice(0, 1);
  const { system, prompt } = hydratePrompt(o, parent, batch);
  assert.ok(prompt.includes(o.brief.subject));
  assert.ok(prompt.includes('Plastic Modeling > Tools') || prompt.includes(`${o.nodes[o.root].label} > ${o.nodes[parent].label}`));
  for (const id of kids) assert.ok(prompt.includes(`- ${id}: ${o.nodes[id].label}`), `sibling ${id} listed`);   // outside the batch too
  const uncles = Object.values(o.nodes).filter((/** @type {any} */ n) => n.parent === o.root && n.id !== parent);
  for (const u of uncles) assert.ok(prompt.includes(`- ${u.id}: ${u.label}`), `parent's sibling ${u.id} listed`);
  const n = o.nodes[batch[0]];
  assert.ok(prompt.includes(`- id: ${n.id}`) && prompt.includes(`label: ${n.label}`));
  if (n.summary) assert.ok(prompt.includes('summary: '));
  const grand = Object.values(o.nodes).filter((/** @type {any} */ c) => c.parent === n.id);
  for (const g of grand.slice(0, 20)) assert.ok(prompt.includes(/** @type {any} */ (g).label));
  assert.match(system, /never the node itself/i);
  assert.match(system, /not_for_ids/);
  assert.doesNotMatch(system + prompt, /web search/i);
  // planted fault: a prompt listing only the batch would miss the other siblings
  const onlyBatch = batch.map((id) => `- ${id}: ${o.nodes[id].label}`).join('\n');
  assert.ok(!kids.slice(1).every((id) => onlyBatch.includes(`- ${id}:`)));
});
