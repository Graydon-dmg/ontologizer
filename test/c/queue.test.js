// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobQueue } from '../../src/core/engine/queue.js';
import { createEngine } from '../../src/core/engine/index.js';
import { KEY_REJECTED } from '../../src/core/engine/call.js';
import { createMemoryStore } from './fake.js';

/** A recording emit: pushes { t, ...fields } into `events`. */
function recorder() {
  /** @type {any[]} */
  const events = [];
  return { events, emit: (/** @type {string} */ t, /** @type {object} */ f) => { events.push({ t, ...f }); } };
}

/** A work function you finish by hand. */
function gate() {
  /** @type {(v?: any) => void} */ let release = () => {};
  /** @type {(e: any) => void} */ let fail = () => {};
  const promise = new Promise((res, rej) => { release = res; fail = rej; });
  return { promise, release, fail };
}

const tick = () => new Promise((r) => setImmediate(r));

/** How many job.queued events there are for this kind + node. */
function countQueued(/** @type {any[]} */ events, /** @type {string} */ kind, /** @type {string} */ nodeId) {
  return events.filter((e) => e.t === 'job.queued' && e.job.kind === kind && e.job.nodeId === nodeId).length;
}

/** Planted fault: a queue that never dedupes. */
function createNoDedupeQueue(/** @type {(t: string, f: object) => void} */ emit) {
  let n = 0;
  return {
    add(/** @type {any} */ job) {
      const ref = { id: `${job.kind}-${++n}`, kind: job.kind, nodeId: job.nodeId };
      emit('job.queued', { job: ref });
      return { jobId: ref.id, duplicate: false };
    },
  };
}

test('explain clicked twice on one node queues one job', async () => {
  const { events, emit } = recorder();
  const q = createJobQueue({ emit, concurrency: 1 });
  const g = gate();
  let calls = 0;
  const work = async () => { calls++; await g.promise; };
  const a = q.add({ kind: 'explain', nodeId: 'n' }, work);
  const b = q.add({ kind: 'explain', nodeId: 'n' }, work);
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(a.jobId, b.jobId);
  g.release();
  await q.onIdle();
  assert.equal(calls, 1);
  assert.equal(countQueued(events, 'explain', 'n'), 1);

  // planted fault: the helper must notice a queue without dedupe
  const bad = recorder();
  const noDedupe = createNoDedupeQueue(bad.emit);
  noDedupe.add({ kind: 'explain', nodeId: 'n' });
  noDedupe.add({ kind: 'explain', nodeId: 'n' });
  assert.equal(countQueued(bad.events, 'explain', 'n'), 2);
});

test('deduped while running too', async () => {
  const { emit } = recorder();
  const q = createJobQueue({ emit, concurrency: 1 });
  const g = gate();
  const a = q.add({ kind: 'explain', nodeId: 'n' }, () => g.promise);
  await tick();
  const b = q.add({ kind: 'explain', nodeId: 'n' }, () => g.promise);
  assert.equal(b.duplicate, true);
  assert.equal(b.jobId, a.jobId);
  g.release();
  await q.onIdle();
});

test('after a job finishes, the same kind and node can be queued again', async () => {
  const { events, emit } = recorder();
  const q = createJobQueue({ emit });
  const a = q.add({ kind: 'explain', nodeId: 'n' }, async () => {});
  await a.done;
  const b = q.add({ kind: 'explain', nodeId: 'n' }, async () => {});
  await b.done;
  assert.equal(b.duplicate, false);
  assert.notEqual(a.jobId, b.jobId);
  assert.equal(countQueued(events, 'explain', 'n'), 2);
});

test('different kinds on one node are not deduped', async () => {
  const { events, emit } = recorder();
  const q = createJobQueue({ emit });
  const a = q.add({ kind: 'explain', nodeId: 'n' }, async () => {});
  const b = q.add({ kind: 'sources', nodeId: 'n' }, async () => {});
  assert.equal(b.duplicate, false);
  assert.notEqual(a.jobId, b.jobId);
  await q.onIdle();
  assert.equal(events.filter((e) => e.t === 'job.queued').length, 2);
});

test('research context vs general on one node are not deduped; same mode is', async () => {
  const store = createMemoryStore();
  const engine = createEngine({ store, id: 'o1', client: /** @type {any} */ ({}) });
  const a = engine.enqueue({ kind: 'research', nodeId: 'n', mode: 'context' });
  const b = engine.enqueue({ kind: 'research', nodeId: 'n', mode: 'general' });
  const c = engine.enqueue({ kind: 'research', nodeId: 'n', mode: 'context' });
  assert.notEqual(a, b);
  assert.equal(c, a); // same mode is still deduped (detects a check that never dedupes)
  const queued = store.list('o1').filter((e) => e.t === 'job.queued');
  assert.equal(queued.length, 2);
  assert.notEqual(queued[0].job.id, queued[1].job.id);
  await engine.idle(); // the work fails (no such node); that is fine
});

/** Run the priority scenario against a queue; returns the order in which jobs started. */
async function priorityOrder(/** @type {(emit: any) => any} */ make) {
  const { events, emit } = recorder();
  const q = make(emit);
  const block = gate();
  q.add({ kind: 'explain', nodeId: 'block' }, () => block.promise);
  await tick();
  for (const id of ['a', 'b', 'c']) q.add({ kind: 'explain', nodeId: id }, async () => {}, { priority: 0 });
  q.add({ kind: 'explain', nodeId: 'hot' }, async () => {}, { priority: 10 });
  block.release();
  await q.onIdle();
  const idOf = new Map(events.filter((e) => e.t === 'job.queued').map((e) => [e.job.id, e.job.nodeId]));
  return events.filter((e) => e.t === 'job.started').map((e) => idOf.get(e.job.id));
}

test('priority 10 starts before priority 0 jobs', async () => {
  const order = await priorityOrder((emit) => createJobQueue({ emit, concurrency: 1 }));
  assert.deepEqual(order, ['block', 'hot', 'a', 'b', 'c']);

  // planted fault: a queue that ignores priority puts "hot" last, so the assertion fails
  const fifo = await priorityOrder(createFifo);
  assert.notDeepEqual(fifo, ['block', 'hot', 'a', 'b', 'c']);
  assert.equal(fifo[fifo.length - 1], 'hot');
});

/** Planted fault: the real queue, but every job is added at priority 0. */
function createFifo(/** @type {any} */ emit) {
  const real = createJobQueue({ emit, concurrency: 1 });
  return { add: (/** @type {any} */ j, /** @type {any} */ w) => real.add(j, w, { priority: 0 }), onIdle: real.onIdle };
}

test('event order per job: queued, started, done, with {id, kind, nodeId}', async () => {
  const { events, emit } = recorder();
  const q = createJobQueue({ emit });
  const { jobId, done } = q.add({ kind: 'sources', nodeId: 'n' }, async () => {});
  assert.deepEqual(await done, { ok: true });
  assert.deepEqual(events.map((e) => e.t), ['job.queued', 'job.started', 'job.done']);
  for (const e of events) assert.deepEqual(e.job, { id: jobId, kind: 'sources', nodeId: 'n' });
  // planted fault: a wrong order must not satisfy the same check
  assert.notDeepEqual(['job.started', 'job.queued', 'job.done'], events.map((e) => e.t));
});

test('throwing work: job.failed with message, done resolves, queue keeps going', async () => {
  const { events, emit } = recorder();
  const q = createJobQueue({ emit, concurrency: 1 });
  const bad = q.add({ kind: 'explain', nodeId: 'a' }, async () => { throw new Error('boom'); });
  const good = q.add({ kind: 'explain', nodeId: 'b' }, async () => {});
  const out = await bad.done; // must not reject
  assert.equal(out.ok, false);
  assert.equal(/** @type {any} */ (out).error.message, 'boom');
  assert.deepEqual(await good.done, { ok: true });
  const failed = events.filter((e) => e.t === 'job.failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].job.error, 'boom');
  assert.equal(failed[0].job.id, bad.jobId);
  assert.equal(events.filter((e) => e.t === 'job.done').length, 1); // only the good one
});

test('a 401 from the work reads as the key-rejected message', async () => {
  const { events, emit } = recorder();
  const q = createJobQueue({ emit });
  const { done } = q.add({ kind: 'explain', nodeId: 'n' }, async () => {
    throw { status: 401, name: 'AuthenticationError', message: 'x' };
  });
  assert.equal((await done).ok, false);
  const failed = events.find((e) => e.t === 'job.failed');
  assert.equal(failed.job.error, 'Your Anthropic API key was rejected: run ontologizer key set');
  assert.equal(failed.job.error, KEY_REJECTED);
  assert.notEqual(failed.job.error, 'x'); // planted fault: raw message must not leak through
});

test('engine.enqueue validates input and returns a jobId synchronously', async () => {
  const store = createMemoryStore();
  const engine = createEngine({ store, id: 'o1', client: /** @type {any} */ ({}) });
  assert.throws(() => engine.enqueue(/** @type {any} */ ({ kind: 'nope', nodeId: 'n' })));
  assert.throws(() => engine.enqueue(/** @type {any} */ ({ kind: 'explain' })));
  assert.throws(() => engine.enqueue(/** @type {any} */ ({ kind: 'explain', nodeId: '' })));
  assert.equal(store.list('o1').length, 0); // rejected jobs leave no trace
  const jobId = engine.enqueue({ kind: 'explain', nodeId: 'n' });
  assert.equal(typeof jobId, 'string');
  const queued = store.list('o1').filter((e) => e.t === 'job.queued');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].job.id, jobId);
  await engine.idle();
});

test('concurrency 2 with 5 blocking jobs never runs more than 2 at once', async () => {
  const { events, emit } = recorder();
  const q = createJobQueue({ emit, concurrency: 2 });
  let running = 0;
  let max = 0;
  const gates = [0, 1, 2, 3, 4].map(() => gate());
  gates.forEach((g, i) => q.add({ kind: 'explain', nodeId: `n${i}` }, async () => {
    running++; max = Math.max(max, running);
    try { await g.promise; } finally { running--; }
  }));
  await tick();
  assert.equal(running, 2);
  for (const g of gates) { g.release(); await tick(); }
  await q.onIdle();
  assert.equal(max, 2);
  assert.equal(events.filter((e) => e.t === 'job.done').length, 5);
});
