// @ts-check
// S1 and S4: reserved names, the queue's dedupe key and nodeIds, the stub's hydrate and organize hooks.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobQueue } from '../../src/core/engine/queue.js';
import { createEngine as createStub } from '../../src/cli/engine-stub.js';
import { createEngine } from '../../src/core/engine/index.js';
import { openStore, RESERVED_NAMES } from '../../src/core/store.js';
import { tempHome } from '../i/helpers-service.js';

test('no saved map can be named organize or check', () => {
  for (const name of ['organize', 'check']) assert.ok(RESERVED_NAMES.includes(name), name);
  const store = openStore(tempHome());
  for (const name of ['organize', 'check', 'tenants']) {
    const id = store.createDraft({ context: 'x' }, 'x');
    assert.throws(() => store.save(id, name), /reserved/, name);
  }
  // planted fault: without the reserved names, a store lets the save through
  const lax = (/** @type {string} */ n) => ['tenants'].includes(n);
  assert.equal(lax('organize'), false);
});

test('queue: dedupeKey overrides kind:nodeId, and refs carry a copy of nodeIds', async () => {
  /** @type {any[]} */ const seen = [];
  const q = createJobQueue({ emit: (t, f) => seen.push({ t, ...f }) });
  let release = () => {};
  const gate = new Promise((/** @type {any} */ r) => { release = r; });
  const ids = ['a', 'b'];
  const one = q.add({ kind: 'hydrate', nodeIds: ids, dedupeKey: 'hydrate:p:1' }, () => gate);
  const two = q.add({ kind: 'hydrate', nodeIds: ['c'], dedupeKey: 'hydrate:p:2' }, () => gate);
  const dup = q.add({ kind: 'hydrate', nodeIds: ['a'], dedupeKey: 'hydrate:p:1' }, () => gate);
  // planted fault: without dedupeKey both hydrate jobs share "hydrate:" and the second is a duplicate
  assert.equal(two.duplicate, false);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.jobId, one.jobId);
  ids.push('mutated');
  release();
  await q.onIdle();
  const refs = seen.filter((e) => e.job.id === one.jobId).map((e) => e.job);
  assert.deepEqual(refs.map((r) => r.nodeIds), [['a', 'b'], ['a', 'b'], ['a', 'b']]);
  assert.ok(refs.every((r) => !('nodeId' in r)), 'no nodeId key when the job has none');
  // existing kinds keep their key and nodeId
  const r = q.add({ kind: 'explain', nodeId: 'x' }, async () => {});
  const r2 = q.add({ kind: 'explain', nodeId: 'x' }, async () => {});
  assert.equal(r2.duplicate, true);
  await r.done;
  assert.equal(seen.at(-1).job.nodeId, 'x');
});

test('engine: a hydrate job needs no nodeId; other kinds still do', async () => {
  const store = openStore(tempHome());
  const id = store.createDraft({ context: 'x' }, 'x');
  const engine = createEngine({ store, id, client: {} });
  assert.throws(() => engine.enqueue({ kind: 'explain' }), /nodeId is required/);
  const jobId = engine.enqueue({ kind: 'hydrate', nodeIds: ['a', 'b'] });
  await engine.idle();
  const job = store.read(id).jobs[jobId];
  assert.equal(job.state, 'failed'); // the placeholder throws until Epic B lands
  assert.deepEqual(job.nodeIds, ['a', 'b']);
  await assert.rejects(engine.organize({}), /organize: name must be 1 to 120 characters/);
});

test('stub engine: hydrate keeps nodeIds on its job events; organize validates its input', async () => {
  const store = openStore(tempHome());
  const id = store.createDraft({ context: 'x' }, 'x');
  const stub = createStub({ store, id });
  const jobId = stub.enqueue({ kind: 'hydrate', nodeIds: ['a'] });
  await new Promise((r) => setTimeout(r, 50));
  const job = store.read(id).jobs[jobId];
  assert.equal(job.state, 'done');
  assert.deepEqual(job.nodeIds, ['a']);
  assert.ok(!('nodeId' in job));
  await assert.rejects(stub.organize({}), /organize: name must be 1 to 120 characters/);
});
