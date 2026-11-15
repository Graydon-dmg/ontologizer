// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// B1 in service mode: the live router with the real engine and a fake model client (metered, so every
// call counts in get_usage and against the daily limit). Each check feeds its planted fault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from '../../src/server/service.js';
import { createUsage } from '../../src/server/usage.js';
import { createEngine } from '../../src/core/engine/index.js';
import { openStore } from '../../src/core/store.js';
import { createFakeClient, lines } from '../c/fake.js';
import { tempHome, req, boot } from '../i/helpers-service.js';

const MODELS = { fast: 'fast-model', strong: 'strong-model' };
const M = 'hm';
const bearer = (/** @type {string} */ t) => ({ authorization: `Bearer ${t}` });

/** Root r; families f1..f5 (two children each: fNa, fNb); family f1 also has fat with 95 children. */
function mapEvents() {
  const ev = [{ t: 'ontology.created', at: 0, name: M, root: 'r', brief: { subject: 'Test' }, categories: [] }];
  const add = (/** @type {string} */ id, /** @type {string|null} */ parent, /** @type {number} */ depth) =>
    ev.push({ t: 'node.added', at: 1, node: { id, label: id.toUpperCase(), parent, depth, category: '', summary: '', sources: [], article: null, status: 'done', createdBy: 'test', origin: 'seed' } });
  add('r', null, 0);
  for (let f = 1; f <= 5; f++) { add(`f${f}`, 'r', 1); add(`f${f}a`, `f${f}`, 2); add(`f${f}b`, `f${f}`, 2); }
  add('fat', 'f1', 2);
  for (let k = 0; k < 95; k++) add(`fat${String(k).padStart(2, '0')}`, 'fat', 3);
  return ev;
}
const KIDS = [1, 2, 3, 4, 5].flatMap((f) => [`f${f}a`, `f${f}b`]);   // 5 batches of 2

/** Answers every "- id: x" in the prompt with a passing line whose look-alike is another batch node. @param {any} params */
function answer(params) {
  const ids = [...String(params.messages[0].content).matchAll(/^- id: (.+)$/gm)].map((m) => m[1]);
  const sib = [...String(params.messages[0].content).matchAll(/^- ([^:\s]+): /gm)].map((m) => m[1]).filter((x) => x !== 'id');
  return lines(ids.map((id) => ({ id, job: `Job ${id}`, examples: ['one', 'two', 'three'], not_for: 'Not the other.',
    not_for_ids: [sib.find((s) => s !== id) ?? ''] })));
}

/** @param {{ limitCalls?: number, delayMs?: number }} [o] */
async function serve(o = {}) {
  const home = tempHome();
  const s = openStore(home);
  s.importEvents(M, mapEvents());
  s.flush?.();
  const fake = createFakeClient({ chunkMs: 0, respond: (p) => ({ delayMs: o.delayMs ?? 0, text: answer(p) }) });
  const usage = createUsage({ home, limitCalls: o.limitCalls ?? null });
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, allowHosts: [], maxBuilds: 2, version: 'test', tokensFile: null, usage,
    makeEngine: async (/** @type {any} */ x) => createEngine({ store: x.store, id: x.id, client: x.meter(fake), models: MODELS }),
  });
  const origin = `http://127.0.0.1:${srv.port}`;
  const act = async (/** @type {any} */ body) => {
    const r = await req(origin, `/v1/t/default/maps/${M}/actions`, { method: 'POST', body: { type: 'hydrate', ...body } });
    return { status: r.status, body: /** @type {any} */ (JSON.parse(r.body || '{}')), headers: r.headers };
  };
  const wait = async () => JSON.parse((await req(origin, `/v1/t/default/maps/${M}/wait?timeout=20000`)).body);
  const calls = async () => JSON.parse((await req(origin, '/v1/t/default/usage')).body).calls;
  const map = () => openStore(home).read(M);
  /** Hydrate job records: one per job.queued. */
  const queued = () => Object.values(map().jobs ?? {}).filter((/** @type {any} */ j) => j.kind === 'hydrate').length;
  return { srv, fake, act, wait, calls, map, queued };
}

test('nodeIds over 5 families: 5 batches, 202, every node stored; get_usage calls rise by the batches', async () => {
  const s = await serve();
  try {
    assert.equal(await s.calls(), 0);
    const r = await s.act({ nodeIds: KIDS });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.deepEqual(r.body.jobs.map((/** @type {any} */ j) => j.parentId), ['f1', 'f2', 'f3', 'f4', 'f5']);
    assert.deepEqual(r.body.jobs.map((/** @type {any} */ j) => j.batch), [1, 2, 3, 4, 5]);
    assert.deepEqual(r.body.estimate, { calls: 5, tokens: 10 * 700 });
    assert.deepEqual(r.body.skipped, []);
    await s.wait();
    const m = s.map();
    for (const id of KIDS) assert.ok(m.nodes[id].hydration, id);
    assert.equal(m.nodes.f1a.hydration.model, 'strong-model');
    // planted fault: a raw (unmetered) client leaves the counter at 0
    assert.equal(s.fake.calls.length, 5);
    assert.equal(await s.calls(), 5);
    // the jobs carry their nodeIds, and the job nodeId is the parent
    const jobs = Object.values(m.jobs).filter((/** @type {any} */ j) => j.kind === 'hydrate');
    assert.deepEqual(jobs.map((/** @type {any} */ j) => [j.nodeId, j.nodeIds, j.state]).sort(),
      [1, 2, 3, 4, 5].map((f) => [`f${f}`, [`f${f}a`, `f${f}b`], 'done']));
    assert.ok(s.fake.calls.every((c) => c.params.tools === undefined), 'no web search, no source tools');
  } finally { await s.srv.close(); }
});

test('a node with 95 children: batches of 40, 40 and 15, all under it', async () => {
  const s = await serve();
  try {
    const kids = Array.from({ length: 95 }, (_, k) => `fat${String(k).padStart(2, '0')}`);
    const r = await s.act({ nodeIds: kids });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.deepEqual(r.body.jobs.map((/** @type {any} */ j) => [j.parentId, j.nodeIds.length]), [['fat', 40], ['fat', 40], ['fat', 15]]);
    await s.wait();
    assert.ok(kids.every((k) => s.map().nodes[k].hydration));
  } finally { await s.srv.close(); }
});

test('all or nothing at the limit: 5 batches with room for 2 → 429 and no job.queued', async () => {
  const s = await serve({ limitCalls: 2 });
  try {
    const r = await s.act({ nodeIds: KIDS });
    assert.equal(r.status, 429, JSON.stringify(r.body));
    assert.match(r.body.error, /^Daily limit reached/);
    assert.ok(Number(r.headers['retry-after']) > 0);
    // planted fault: starting the 2 batches that fit would append job.queued events
    assert.equal(s.queued(), 0);
    assert.equal(s.fake.calls.length, 0);
    // exactly at the limit passes: 2 batches with room for 2
    const two = await s.act({ nodeIds: ['f1a', 'f1b', 'f2a', 'f2b'] });
    assert.equal(two.status, 202, JSON.stringify(two.body));
    await s.wait();
  } finally { await s.srv.close(); }
});

test('skips: hydrated nodes are skipped without redo (200, nothing queued) and redone with it', async () => {
  const s = await serve();
  try {
    await s.act({ nodeIds: ['f1a', 'f1b'] });
    await s.wait();
    const again = await s.act({ nodeIds: ['f1a', 'f1b'] });
    // planted fault: re-hydrating by default would queue a batch and answer 202
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { ok: true, jobs: [], skipped: [{ nodeId: 'f1a', reason: 'already hydrated' }, { nodeId: 'f1b', reason: 'already hydrated' }], estimate: { calls: 0, tokens: 0 } });
    const redo = await s.act({ nodeIds: ['f1a', 'f1b'], redo: true });
    assert.equal(redo.status, 202);
    assert.equal(redo.body.jobs.length, 1);
    await s.wait();
    assert.equal(s.fake.calls.length, 2);
  } finally { await s.srv.close(); }
});

test('dedupe: the same request while it runs answers 200, jobs [], every node already running; an overlapping selection skips the shared node', async () => {
  const s = await serve({ delayMs: 300 });
  try {
    const first = await s.act({ nodeIds: ['f1a', 'f1b'] });
    assert.equal(first.status, 202);
    const jobId = first.body.jobs[0].jobId;
    const before = s.queued();
    const second = await s.act({ nodeIds: ['f1a', 'f1b'] });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(second.body.jobs, []);
    assert.deepEqual(second.body.skipped, [{ nodeId: 'f1a', reason: `already running in ${jobId}` }, { nodeId: 'f1b', reason: `already running in ${jobId}` }]);
    // planted fault: dedupe by dedupeKey alone would queue [f1b, f2a] (a different key) and hydrate f1b twice
    const overlap = await s.act({ nodeIds: ['f1b', 'f2a'] });
    assert.equal(overlap.status, 202);
    assert.deepEqual(overlap.body.skipped, [{ nodeId: 'f1b', reason: `already running in ${jobId}` }]);
    assert.deepEqual(overlap.body.jobs.map((/** @type {any} */ j) => j.nodeIds), [['f2a']]);
    assert.equal(s.queued(), before + 1);
    await s.wait();
  } finally { await s.srv.close(); }
});

test('validation answers 400 and starts nothing; constructor is not a node', async () => {
  const s = await serve();
  try {
    const cases = [
      [{ nodeIds: ['f1a'], all: true }, 'give nodeIds or all, not both'],
      [{}, 'give nodeIds or all'],
      [{ nodeIds: [] }, 'nodeIds must be 1 to 300 different ids'],
      [{ nodeIds: ['f1a', 'f1a'] }, 'nodeIds must be 1 to 300 different ids'],
      [{ nodeIds: ['constructor'] }, 'no node "constructor": nothing was started'],
      [{ nodeIds: ['r'] }, 'the root has nothing to compare with: leave it out'],
      [{ nodeIds: ['f1a'], model: 'opus' }, 'model must be sonnet or haiku'],
    ];
    for (const [body, error] of cases) {
      const r = await s.act(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, error);
    }
    assert.equal(s.fake.calls.length, 0);
    assert.equal(s.queued(), 0);
  } finally { await s.srv.close(); }
});

test('a read token gets 403 from the real handler; a build token gets 202', async () => {
  const { home, srv, secrets } = await boot({ tokens: [{ name: 'r', scopes: ['read'] }, { name: 'b', scopes: ['build'] }] });
  try {
    const st = openStore(home, { tenant: 'default' });
    st.importEvents(M, mapEvents());
    st.flush?.();
    const act = (/** @type {string} */ who) => req(srv.url, `/v1/t/default/maps/${M}/actions`, { method: 'POST', headers: bearer(secrets[who]), body: { type: 'hydrate', nodeIds: ['f1a'] } });
    assert.equal((await act('r')).status, 403);
    assert.equal((await act('b')).status, 202);
  } finally { await srv.close(); }
});
