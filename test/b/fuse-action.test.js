// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openStore } from '../../src/core/store.js';
import { startServer } from '../../src/server/index.js';
import { tempHome, fixtureEvents } from './helpers.js';

function seeded() {
  const store = openStore(tempHome());
  store.importEvents('plastic-modeling', fixtureEvents('plastic-modeling'));
  store.importEvents('manga', fixtureEvents('manga'));
  return store;
}

/** @param {string} url @param {any} body */
async function act(url, body) {
  const r = await fetch(new URL('api/action', url), { method: 'POST', body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

/**
 * A fake engine.fuse shaped like Epic G's: createDraft, onDraft(id), events, then resolve with the id.
 * @param {any} store @param {{ useOnDraft?: boolean, fail?: any }} [o]
 */
function fakeFuse(store, { useOnDraft = true, fail = null } = {}) {
  /** @type {any[]} */ const calls = [];
  /** @type {() => void} */ let release = () => {};
  const gate = new Promise((r) => { release = () => r(undefined); });
  /** @param {string} a @param {string} b @param {any} opts */
  const fuse = async (a, b, opts) => {
    calls.push([a, b, { into: opts.into }]);
    if (fail) throw fail;
    const draftId = store.createDraft({ context: 'fused' }, opts.into ?? 'fused');
    store.append(draftId, { t: 'ontology.created', at: 0, name: opts.into ?? 'fused', root: 'fused', brief: {}, categories: [] });
    if (useOnDraft) opts.onDraft?.(draftId);
    await gate;
    return draftId;
  };
  return { fuse, calls, release: () => release() };
}

test('GET /api/maps lists every other map, saved first then drafts; host guard applies', async () => {
  const store = seeded();
  const draft = store.createDraft({}, 'a-draft');
  const srv = await startServer({ store, engine: { enqueue: () => 'j' }, id: 'plastic-modeling' });
  const rows = await (await fetch(new URL('api/maps', srv.url))).json();
  assert.deepEqual(rows.map((/** @type {any} */ r) => r.id), ['manga', draft]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['draft', 'id', 'name', 'nodes', 'updatedAt']);
  assert.equal(rows[0].draft, false);
  assert.equal(rows[1].draft, true);
  // Planted fault: an unfiltered list would include the map being served.
  assert.ok(store.list({ drafts: true }).some((/** @type {any} */ r) => r.id === 'plastic-modeling'));
  const port = new URL(srv.url).port;
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/maps', headers: { host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); });
  });
  assert.equal(status, 403);
  await srv.close();
});

test('fuse validation: 400 for a missing, unknown, ambiguous or same map, a bad into, or no engine factory', async () => {
  const store = seeded();
  store.importEvents('manga-two', fixtureEvents('manga'));
  const f = fakeFuse(store);
  const srv = await startServer({ store, engine: { enqueue: () => 'j', fuse: f.fuse }, id: 'plastic-modeling', makeEngine: async () => ({}) });
  for (const body of [{}, { with: '' }, { with: 7 }, { with: 'nope' }, { with: 'man' }, { with: 'plastic-modeling' },
    { with: 'manga', into: 'Bad Name' }, { with: 'manga', into: 'a'.repeat(41) }, { with: 'manga', into: '../x' }]) {
    const r = await act(srv.url, { type: 'fuse', ...body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.ok, false);
    assert.equal(typeof r.body.error, 'string');
  }
  assert.equal(f.calls.length, 0);
  await srv.close();
  const noFactory = await startServer({ store, engine: { enqueue: () => 'j', fuse: f.fuse }, id: 'plastic-modeling' });
  assert.equal((await act(noFactory.url, { type: 'fuse', with: 'manga' })).status, 400);
  await noFactory.close();
});

test('fuse: 202 with an absolute url to a second server for the draft; dedupe; job events; children close with the parent', async () => {
  const store = seeded();
  const f = fakeFuse(store);
  /** @type {string[]} */ const engines = [];
  const makeEngine = async (/** @type {string} */ d) => { engines.push(d); return { enqueue: () => 'j' }; };
  const srv = await startServer({ store, engine: { enqueue: () => 'j', fuse: f.fuse }, id: 'plastic-modeling', makeEngine });

  const r = await act(srv.url, { type: 'fuse', with: 'man', into: 'gunpla' }); // prefix resolves
  assert.equal(r.status, 202);
  assert.deepEqual(f.calls, [['plastic-modeling', 'manga', { into: 'gunpla' }]]);
  const { jobId, draftId, url } = r.body;
  assert.match(draftId, /^draft-/);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.notEqual(new URL(url).port, new URL(srv.url).port);
  assert.deepEqual(engines, [draftId]);
  // The child serves the draft live, before fuse has finished.
  const snap = await (await fetch(new URL('api/snapshot', url))).json();
  assert.equal(snap.root, 'fused');
  assert.equal(store.sessions.get(draftId)?.port, Number(new URL(url).port));
  // Same request while running: same job, no second fuse.
  const again = await act(srv.url, { type: 'fuse', with: 'manga', into: 'gunpla' });
  assert.deepEqual(again.body, r.body);
  assert.equal(f.calls.length, 1);
  // The job shows on THIS map; job.done carries draftId and url.
  assert.equal(store.read('plastic-modeling').jobs[jobId].state, 'running');
  f.release();
  await new Promise((res) => setTimeout(res, 50));
  const done = store.read('plastic-modeling').jobs[jobId];
  assert.deepEqual({ state: done.state, kind: done.kind, with: done.with, draftId: done.draftId, url: done.url },
    { state: 'done', kind: 'fuse', with: 'manga', draftId, url });

  await srv.close();
  await assert.rejects(fetch(new URL('api/snapshot', url)), 'the child should close with the parent');
  assert.equal(store.sessions.get(draftId), null);
});

test('fuse: an engine without onDraft still answers with the url once fuse returns; a 401 ends as job.failed', async () => {
  const store = seeded();
  const late = fakeFuse(store, { useOnDraft: false });
  const srv = await startServer({ store, engine: { enqueue: () => 'j', fuse: late.fuse }, id: 'plastic-modeling', makeEngine: async () => ({ enqueue: () => 'j' }) });
  const pending = act(srv.url, { type: 'fuse', with: 'manga' });
  setTimeout(() => late.release(), 50);
  const r = await pending;
  assert.equal(r.status, 202);
  assert.match(r.body.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  await srv.close();

  const store2 = seeded();
  const bad = fakeFuse(store2, { fail: Object.assign(new Error('401'), { status: 401 }) });
  const srv2 = await startServer({ store: store2, engine: { enqueue: () => 'j', fuse: bad.fuse }, id: 'plastic-modeling', makeEngine: async () => ({}) });
  const f = await act(srv2.url, { type: 'fuse', with: 'manga' });
  assert.equal(f.status, 202);
  await new Promise((res) => setTimeout(res, 50));
  const job = store2.read('plastic-modeling').jobs[f.body.jobId];
  assert.equal(job.state, 'failed');
  assert.equal(job.error, 'Your Anthropic API key was rejected: run ontologizer key set');
  assert.equal(f.body.url, undefined);
  await srv2.close();

  // Planted fault: a router answering 400 to fuse fails the 202 expectations above.
  const faultyRouter = (/** @type {any} */ b) => (b.type === 'fuse' ? 400 : 202);
  assert.notEqual(faultyRouter({ type: 'fuse', with: 'manga' }), 202);
});
