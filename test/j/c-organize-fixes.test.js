// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// Organise 3LR fixes. MED-4: a failed retry batch's items go under Unsorted (only a rejected key or
// an abort ends the run). MED-2: the run is one organize job (startRun's id) from its first write to
// its last; a run cut by a restart is marked failed, and a failed run is one failed job. M1: the
// stopping and queue checks come before the 4 MiB body is read, and at most 2 bodies are read at once.
// Each check feeds its planted fault (a broken copy of the module) first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFakeClient, createMemoryStore, lines } from '../c/fake.js';
import { runCall } from '../../src/core/engine/call.js';
import { makeEvent } from '../../src/core/events.js';
import { organize, UNSORTED_ID, BAD_TREE } from '../../src/core/engine/organize.js';
import { createEngine } from '../../src/core/engine/index.js';
import { startService } from '../../src/server/service.js';
import { openStore } from '../../src/core/store.js';
import { tempHome, stubEngine, req } from '../i/helpers-service.js';
import { faultyModule } from '../i/helpers-fault.js';

const MODELS = { fast: 'claude-haiku-5-5', strong: 'claude-sonnet-5-5' };
const items = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => ({ id: `it${i}`, label: `Item ${i}` }));
// A valid depth-2 tree: four top-level families (parent ROOT).
const FAMILIES = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((l, i) => ({ key: `t${i}`, label: l, parent: 'ROOT', description: `About ${l}` }));
const isFamilies = (/** @type {any} */ p) => p.system.includes('family tree');

/**
 * A fake model: a valid tree; placement answers every item of a batch, except that a batch holding
 * `failId` fails (in the first pass and the retry alike) with a 529, or with `failWith`.
 * @param {{ failId?: string, failWith?: any }} [o]
 */
function model(o = {}) {
  return (/** @type {any} */ params) => {
    if (isFamilies(params)) return { text: lines(FAMILIES) };
    const itemPart = params.messages[0].content.split(/\nItems \(\d+\):\n/)[1].split('\nThese items')[0];
    const ids = itemPart.split('\n').filter((/** @type {string} */ l) => l.startsWith('{')).map((/** @type {string} */ l) => JSON.parse(l).id);
    if (o.failId && ids.includes(o.failId)) return { error: o.failWith ?? Object.assign(new Error('overloaded'), { status: 529 }) };
    return { text: lines(ids.map((id, i) => ({ id, family: `t${i % 4}` }))) };
  };
}
/** @param {any} respond */
function setup(respond) {
  const store = createMemoryStore(); const fake = createFakeClient({ respond, chunkMs: 0 });
  const id = 'm'; const start = Date.now();
  const ectx = { store, id, models: MODELS, emit: (/** @type {string} */ t, /** @type {any} */ f) => store.append(id, makeEvent(t, f, start)),
    call: (/** @type {any} */ p, /** @type {any} */ on) => runCall(() => fake, p, on), durable: async () => {} };
  return { ectx, events: () => /** @type {any[]} */ (store.list(id)), map: () => store.read(id) };
}
/** @param {string} rel @param {Array<[string, string]>} fault */
const broken = async (rel, fault) => /** @type {any} */ (await faultyModule(rel, fault));

test('MED-4: a failed retry batch goes under Unsorted, and the first pass placements are kept', async () => {
  const list = items(500);   // batches of 200: it0..199, it200..399, it400..499; it250's batch always fails
  /** @param {any} org */
  const outcome = async (org) => {
    const t = setup(model({ failId: 'it250' }));
    try { await org(t.ectx, { name: 'M', items: list, depth: 2, mode: 'agent' }); } catch (e) { return { rejected: e }; }
    return { map: t.map() };
  };
  const ok = await outcome(organize);
  assert.ok(!('rejected' in ok), 'the run finished');
  const m = /** @type {any} */ (ok).map;
  assert.equal(m.nodes.it250.parent, UNSORTED_ID);   // its retry batch (it250..299) failed too
  assert.equal(m.nodes.it0.parent.startsWith('_root/'), true);
  assert.notEqual(m.nodes.it0.parent, UNSORTED_ID);   // pass 1's placements are kept
  assert.notEqual(m.nodes.it499.parent, UNSORTED_ID);
  assert.equal(list.filter((it) => m.nodes[it.id]).length, 500);
  // planted fault: the old rule (any retry failure ends the run) loses everything
  // (the copy lives in a temp folder, so its one package import is pointed at this checkout's copy)
  const f = await broken('src/core/engine/organize.js', [['if (isAuthError(e) || isAbort(e) || isUsageLimit(e)) {', 'if (retry || isAuthError(e)) {'],
    ["import PQueue from 'p-queue';", `import PQueue from '${import.meta.resolve('p-queue')}';`]]);
  assert.ok('rejected' in await outcome(f.organize));
});

test('MED-4: a rejected key and an abort still end the run', async () => {
  await organize(setup(model()).ectx, { name: 'M', items: items(30), depth: 2, mode: 'agent' });   // control: no failure, it finishes
  for (const failWith of [Object.assign(new Error('bad key'), { status: 401 }), Object.assign(new Error('The build was stopped.'), { name: 'AbortError' })]) {
    const t = setup(model({ failId: 'it3', failWith }));
    await assert.rejects(organize(t.ectx, { name: 'M', items: items(30), depth: 2, mode: 'agent' }), { message: failWith.message });
  }
});

test('the daily limit ends the run, and its job fails with the limit\'s message', async () => {
  const limit = Object.assign(new Error('This tenant reached its daily limit of 5 model calls.'), { name: 'UsageLimitError', code: 'USAGE_LIMIT', retryAfter: 60 });
  /** @param {any} org */
  const outcome = async (org) => {
    const t = setup(model({ failId: 'it3', failWith: limit }));
    let rejected = null;
    try { await org(t.ectx, { name: 'M', items: items(30), depth: 2, mode: 'agent' }); } catch (e) { rejected = e; }
    return { rejected, jobs: Object.values(t.map().jobs) };
  };
  const { rejected, jobs } = await outcome(organize);
  assert.equal(rejected, limit);
  assert.deepEqual(jobs.map((j) => [j.state, j.error]), [['failed', limit.message]]);
  // planted fault: treating the limit like an overload finishes the run "done", everything under Unsorted
  const f = await broken('src/core/engine/organize.js', [['|| isUsageLimit(e)) {', ') {'],
    ["import PQueue from 'p-queue';", `import PQueue from '${import.meta.resolve('p-queue')}';`]]);
  const bad = await outcome(f.organize);
  assert.equal(bad.rejected, null);
  assert.deepEqual(bad.jobs.map((j) => j.state), ['done']);
});

test('MED-2: the run is one organize job under the caller\'s id: started after the root, done after the last leaf', async () => {
  const t = setup(model());
  await organize(t.ectx, { name: 'M', items: items(30), depth: 2, mode: 'agent', jobId: 'organize-1-7' });
  const ev = t.events();
  const started = ev.findIndex((e) => e.t === 'job.started');
  const lastLeaf = ev.findLastIndex((e) => e.t === 'node.added');
  assert.equal(ev[started].job.id, 'organize-1-7');
  assert.equal(ev[started].job.kind, 'organize');
  assert.ok(started > ev.findIndex((e) => e.t === 'node.added' && e.node.id === '_root'));
  assert.ok(started < ev.findIndex((e) => e.t === 'node.added' && e.node.id !== '_root'));
  assert.equal(ev.at(-1).t, 'job.done');
  assert.ok(ev.length - 1 > lastLeaf);
  assert.deepEqual(Object.keys(t.map().jobs), ['organize-1-7']);
  // a failed run under a caller's id leaves the ending to the caller: no job.failed of its own
  const bad = setup(() => ({ text: 'nonsense' }));
  await assert.rejects(organize(bad.ectx, { name: 'M', items: items(30), depth: 2, mode: 'agent', jobId: 'organize-1-8' }), { message: BAD_TREE });
  assert.ok(!bad.events().some((e) => e.t === 'job.failed'));
  // without one (the CLI), the run ends its own job
  const cli = setup(() => ({ text: 'nonsense' }));
  await assert.rejects(organize(cli.ectx, { name: 'M', items: items(30), depth: 2, mode: 'agent' }));
  assert.deepEqual(Object.values(cli.map().jobs).map((j) => j.state), ['failed']);
});

/**
 * A router on a free port (the real one, or a broken copy) with the stub engine unless told otherwise.
 * @param {any} start startService @param {Record<string, any>} [o]
 */
async function serve(start, o = {}) {
  const home = o.home ?? tempHome();
  const srv = await start({ home, host: '127.0.0.1', port: 0, allowHosts: [], maxBuilds: 1, version: 'test', tokensFile: null,
    makeEngine: o.makeEngine ?? (async (/** @type {any} */ x) => stubEngine(x)), ...(o.maxQueued !== undefined ? { maxQueued: o.maxQueued } : {}) });
  return { home, srv, origin: `http://127.0.0.1:${srv.port}` };
}
/** @param {string} origin @param {string} id */
const waitFor = async (origin, id) => JSON.parse((await req(origin, `/v1/t/default/maps/${id}/wait?timeout=3000`, { headers: { accept: 'application/json' } })).body);

test('MED-2: a run cut by a restart is marked failed, and wait_for_map says so', async () => {
  /** @param {any} start */
  const after = async (start) => {
    const home = tempHome();
    const store = openStore(home, { tenant: 'default' });
    const id = store.createDraft({ context: 'x' }, undefined, { events: [
      { t: 'ontology.created', at: 0, name: 'M', root: '_root', brief: {}, categories: [], mode: 'agent' },
      { t: 'node.added', at: 1, node: { id: '_root', label: 'M', parent: null, category: '', depth: 0 } },
      { t: 'job.started', at: 2, job: { id: 'organize-9-1', kind: 'organize' } },
    ] });
    store.flush?.(id);
    const { srv, origin } = await serve(start, { home });
    try { return await waitFor(origin, id); } finally { await srv.close(); }
  };
  const w = await after(startService);
  assert.equal(w.state, 'idle');
  assert.equal(w.error, 'Interrupted by a restart');
  // planted fault: the restart check that skips organise drafts leaves the run looking alive
  const f = await broken('src/server/service.js', [['        if (cut) {', '        if (false) {']]);
  const bad = await after(f.startService);
  assert.notEqual(bad.error, 'Interrupted by a restart');
});

test('MED-2: a failed organise is exactly one organize job, failed, and wait_for_map returns idle with the error', async () => {
  /** @param {any} start */
  const run = async (start) => {
    const fake = createFakeClient({ chunkMs: 0, respond: () => ({ text: 'nonsense' }) });
    const { srv, origin, home } = await serve(start, {
      makeEngine: async (/** @type {any} */ x) => createEngine({ store: x.store, id: x.id, client: x.meter(fake), models: MODELS }) });
    try {
      const r = await req(origin, '/v1/t/default/maps/organize', { method: 'POST', body: { name: 'M', items: items(30), depth: 2 }, headers: { accept: 'application/json' } });
      assert.equal(r.status, 202, r.body);
      const { id } = JSON.parse(r.body);
      const w = await waitFor(origin, id);
      const jobs = Object.values(openStore(home, { tenant: 'default' }).read(id).jobs).filter((j) => j.kind === 'organize');
      return { w, jobs };
    } finally { await srv.close(); }
  };
  const { w, jobs } = await run(startService);
  assert.deepEqual(jobs.map((j) => j.state), ['failed']);
  assert.equal(jobs[0].error, BAD_TREE);
  assert.deepEqual({ state: w.state, error: w.error }, { state: 'idle', error: BAD_TREE });
  // planted fault: startRun ending the run under a fresh id leaves the started job running beside it
  const f = await broken('src/server/service.js', [['job: { id: jobId, kind, error: b.error }', 'job: { id: `${kind}-x`, kind, error: b.error }']]);
  const bad = await run(f.startService);
  assert.notDeepEqual(bad.jobs.map((j) => j.state), ['failed']);
});

/**
 * An organise request that sends its headers (Content-Length 4 MiB) and a first chunk, then nothing.
 * Resolves its response, or null when none arrives in `ms`; `end()` sends a body and finishes it.
 * @param {string} origin @param {number} [ms]
 */
function hanging(origin, ms = 1500) {
  const u = new URL(origin);
  const body = JSON.stringify({ name: 'M', items: items(3) });
  const r = http.request({ host: u.hostname, port: u.port, path: '/v1/t/default/maps/organize', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(4 * 1024 * 1024 - 1) } });
  r.on('error', () => {});
  r.write(' ');
  /** @type {Promise<{ status: number, retryAfter: string|undefined } | null>} */
  const response = new Promise((resolve) => {
    r.on('response', (res) => { res.resume(); resolve({ status: /** @type {number} */ (res.statusCode), retryAfter: /** @type {any} */ (res.headers['retry-after']) }); });
    setTimeout(() => resolve(null), ms).unref();
  });
  return { response, close: () => r.destroy(), body };
}

test('M1: with the queue full, a 4 MiB body is never read: 429 at once, even with a body that never ends', async () => {
  /** @param {any} start */
  const attempt = async (start) => {
    const { srv, origin } = await serve(start, { maxQueued: 0 });
    try {
      // one slow build holds the only slot (the stub replays the fixture at its own pace)
      const b = await req(origin, '/v1/t/default/maps', { method: 'POST', body: { brief: { context: 'x' } }, headers: { accept: 'application/json' } });
      assert.equal(b.status, 202, b.body);
      const h = hanging(origin);
      const res = await h.response;
      h.close();
      return res;
    } finally { await srv.close(); }
  };
  const res = await attempt(startService);
  assert.equal(res?.status, 429);
  assert.equal(res?.retryAfter, '30');
  // planted fault: the queue check only after the body is read never answers a body that never ends
  const f = await broken('src/server/service.js', [['      if (queueFull()) return refuseUnread(', '      if (false) return refuseUnread(']]);
  assert.equal(await attempt(f.startService), null);
});

test('M1: at most 2 organise bodies are read at once: a third gets 429 with Retry-After 5, until one finishes', async () => {
  /** @param {any} start */
  const attempt = async (start) => {
    const { srv, origin } = await serve(start);
    const open = [hanging(origin, 3000), hanging(origin, 3000)];
    try {
      await new Promise((r) => setTimeout(r, 200));   // both are being read
      const third = hanging(origin, 1000);
      const r3 = await third.response;
      third.close();
      // one of the two ends (its connection goes away): a new list is read again
      open[0].close();
      await new Promise((r) => setTimeout(r, 200));
      const r4 = await req(origin, '/v1/t/default/maps/organize', { method: 'POST', body: {}, headers: { accept: 'application/json' } });
      return { r3, r4: r4.status };
    } finally { for (const h of open) h.close(); await srv.close(); }
  };
  const { r3, r4 } = await attempt(startService);
  assert.deepEqual(r3, { status: 429, retryAfter: '5' });
  assert.equal(r4, 400);   // read and checked (an empty body): not refused by the cap
  // planted fault: no cap: the third body is read like the others, and no answer comes
  const f = await broken('src/server/service.js', [['      if (organizeReads >= ORGANIZE_READS) {', '      if (false) {']]);
  assert.equal((await attempt(f.startService)).r3, null);
});
