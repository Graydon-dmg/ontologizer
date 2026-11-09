// @ts-check
// Service mode maps: async build + wait, the build queue, save, in-process fuse, health.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
process.env.ONTOLOGIZER_STUB_SPEED = '1000';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import { boot, req, seed, stubEngine, tempHome, fixtureEvents } from './helpers-service.js';
import { startServer } from '../../src/server/index.js';
import { openStore } from '../../src/core/store.js';

/**
 * The async-build check: POST /maps answers 202 within 1 s, then wait reports idle and the
 * snapshot has nodes.
 * @param {{ post: () => Promise<{ status: number, body: any }>, wait: (id: string) => Promise<any>, snapshot: (id: string) => Promise<any> }} api
 */
async function buildProblems(api) {
  const problems = [];
  const t0 = Date.now();
  const r = await api.post();
  const ms = Date.now() - t0;
  if (r.status !== 202) problems.push(`POST /maps answered ${r.status}`);
  if (ms >= 1000) problems.push(`POST /maps took ${ms} ms`);
  const id = r.body?.id;
  if (!id) return [...problems, 'no id'];
  if (r.body.viewUrl !== `/v1/t/default/maps/${id}/view`) problems.push(`viewUrl ${r.body.viewUrl}`);
  if (r.body.eventsUrl !== `/v1/t/default/maps/${id}/events`) problems.push(`eventsUrl ${r.body.eventsUrl}`);
  const w = await api.wait(id);
  if (w.state !== 'idle') problems.push(`wait: ${w.state}`);
  const snap = await api.snapshot(id);
  if (!snap || !Object.keys(snap.nodes || {}).length) problems.push('the snapshot has no nodes');
  return problems;
}

/** The stub engine with a slow build (1.5 s), so awaiting it in the handler would show. @param {any} x */
const slowEngine = (x) => {
  const e = stubEngine(x);
  return { ...e, async build(/** @type {any} */ brief) { await new Promise((r) => setTimeout(r, 1500)); return e.build(brief); } };
};

test('POST /maps returns 202 within 1 s with the stub engine; wait then reports idle and the snapshot has nodes', async () => {
  const { srv } = await boot({ makeEngine: async (/** @type {any} */ x) => slowEngine(x) });
  try {
    const check = await req(srv.url, '/v1/t/default/maps/check', { method: 'POST', body: { context: 'plastic model kits' } });
    assert.equal(check.status, 200);
    const c = check.json();
    assert.equal(c.ready, true);
    const api = {
      post: async () => { const r = await req(srv.url, '/v1/t/default/maps', { method: 'POST', body: { brief: c.brief, name: c.name } }); return { status: r.status, body: r.json() }; },
      wait: async (/** @type {string} */ id) => {
        const busy = (await req(srv.url, `/v1/t/default/maps/${id}/wait?timeout=0`)).json();
        assert.equal(busy.state, 'busy'); // the build is still running: the 202 did not wait for it
        assert.equal(busy.jobs[0].kind, 'build');
        return (await req(srv.url, `/v1/t/default/maps/${id}/wait?timeout=20000`)).json();
      },
      snapshot: async (/** @type {string} */ id) => (await req(srv.url, `/v1/t/default/maps/${id}/snapshot`)).json(),
    };
    assert.deepEqual(await buildProblems(api), []);
    const list = (await req(srv.url, '/v1/t/default/maps')).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Plastic modeling');
    assert.ok(list[0].nodes > 0);
    // Planted fault: a handler that awaits the build takes longer than 1 s.
    const awaiting = { ...api, post: async () => { await new Promise((r) => setTimeout(r, 1500)); return api.post(); } };
    assert.ok((await buildProblems(awaiting)).some((p) => p.includes('took')));
  } finally { await srv.close(); }
});

test('--max-builds caps builds running at once; the rest wait in a queue (and the 202 is immediate)', async () => {
  let running = 0; let peak = 0;
  const gated = (/** @type {any} */ x) => {
    const e = stubEngine(x);
    return { ...e, async build(/** @type {any} */ brief) {
      running++; peak = Math.max(peak, running);
      try { await new Promise((r) => setTimeout(r, 150)); await e.build(brief); } finally { running--; }
    } };
  };
  const { srv } = await boot({ maxBuilds: 2, makeEngine: async (/** @type {any} */ x) => gated(x) });
  try {
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const r = await req(srv.url, '/v1/t/default/maps', { method: 'POST', body: { brief: { context: `t${i}`, subject: `t${i}` }, name: `t${i}` } });
      assert.equal(r.status, 202);
      ids.push(r.json().id);
    }
    assert.equal(new Set(ids).size, 4);
    const queued = (await req(srv.url, `/v1/t/default/maps/${ids[3]}/wait?timeout=0`)).json();
    assert.equal(queued.state, 'busy');
    for (const id of ids) assert.equal((await req(srv.url, `/v1/t/default/maps/${id}/wait?timeout=20000`)).json().state, 'idle');
    assert.equal(peak, 2);
  } finally { await srv.close(); }
});

test('a build that fails (no API key) shows as a failed build job on the map, and wait reports the error', async () => {
  const failing = (/** @type {any} */ x) => ({ ...stubEngine(x), async build() { throw new Error('No Anthropic API key: run ontologizer key set'); } });
  const { srv } = await boot({ makeEngine: async (/** @type {any} */ x) => failing(x) });
  try {
    const r = await req(srv.url, '/v1/t/default/maps', { method: 'POST', body: { brief: { context: 'x' } } });
    assert.equal(r.status, 202);
    const w = (await req(srv.url, `/v1/t/default/maps/${r.json().id}/wait?timeout=5000`)).json();
    assert.equal(w.state, 'idle');
    assert.match(w.error, /No Anthropic API key/);
    const snap = (await req(srv.url, `/v1/t/default/maps/${r.json().id}/snapshot`)).json();
    const job = Object.values(snap.jobs)[0];
    assert.equal(/** @type {any} */ (job).state, 'failed');
  } finally { await srv.close(); }
});

test('save renames a finished draft; a busy map is refused with 409', async () => {
  const { srv } = await boot({ makeEngine: async (/** @type {any} */ x) => slowEngine(x) });
  try {
    const r = (await req(srv.url, '/v1/t/default/maps', { method: 'POST', body: { brief: { context: 'x' } } })).json();
    assert.equal((await req(srv.url, `/v1/t/default/maps/${r.id}/save`, { method: 'POST', body: { name: 'kits' } })).status, 409);
    await req(srv.url, `/v1/t/default/maps/${r.id}/wait?timeout=20000`);
    const s = await req(srv.url, `/v1/t/default/maps/${r.id}/save`, { method: 'POST', body: { name: 'kits' } });
    assert.equal(s.status, 200);
    assert.deepEqual(s.json(), { ok: true, id: 'kits', viewUrl: '/v1/t/default/maps/kits/view' });
    assert.equal((await req(srv.url, '/v1/t/default/maps/kits/snapshot')).status, 200);
    assert.equal((await req(srv.url, `/v1/t/default/maps/${r.id}/snapshot`)).status, 404);
    assert.equal((await req(srv.url, '/v1/t/default/maps/kits/save', { method: 'POST', body: { name: 'Bad Name' } })).status, 400);
  } finally { await srv.close(); }
});

/**
 * The in-process fuse check: a fuse makes a new map id, opens no new port, and its url is that map's view.
 * @param {() => Promise<{ reply: any, ids: () => string[] }>} runFuse
 */
async function fuseProblems(runFuse) {
  const problems = [];
  const listen = net.Server.prototype.listen;
  let listens = 0;
  net.Server.prototype.listen = function (/** @type {any[]} */ ...args) { listens++; return listen.apply(this, /** @type {any} */ (args)); };
  /** @type {any} */
  let out;
  try { out = await runFuse(); } finally { net.Server.prototype.listen = listen; }
  const { reply, ids } = out;
  if (listens) problems.push(`the fuse opened ${listens} new server(s)`);
  if (!reply?.draftId) return [...problems, 'no draftId'];
  if (!ids().includes(reply.draftId)) problems.push('the draft is not a map in this home');
  if (reply.url !== `/v1/t/default/maps/${reply.draftId}/view`) problems.push(`url ${reply.url} is not the draft's view`);
  return problems;
}

test('fuse in service mode creates a new map id in the same process and opens no new port', async () => {
  const { srv, home } = await boot();
  try {
    await seed(home, 'default', 'plastic-modeling');
    await seed(home, 'default', 'manga', 'manga');
    const ids = () => openStore(home).list({ drafts: true }).map((m) => m.id);
    await req(srv.url, '/v1/t/default/maps/plastic-modeling/snapshot'); // the map's handler exists before the fuse
    const problems = await fuseProblems(async () => {
      const r = await req(srv.url, '/v1/t/default/maps/plastic-modeling/actions', { method: 'POST', body: { type: 'fuse', with: 'manga', into: 'gunpla' } });
      assert.equal(r.status, 202);
      return { reply: r.json(), ids };
    });
    assert.deepEqual(problems, []);
    // The new map is served by the same server.
    const fused = (await req(srv.url, '/v1/t/default/maps')).json().find((/** @type {any} */ m) => m.draft);
    assert.ok(fused);
    assert.equal((await req(srv.url, `/v1/t/default/maps/${fused.id}/view`)).status, 200);
  } finally { await srv.close(); }

  // Planted fault: the child-server path (the one-map server's fuse) opens a new port.
  const store = openStore(tempHome());
  store.importEvents('plastic-modeling', fixtureEvents('plastic-modeling'));
  store.importEvents('manga', fixtureEvents('manga'));
  const one = await startServer({ store, engine: stubEngine({ store, id: 'plastic-modeling' }), id: 'plastic-modeling', makeEngine: async (d) => stubEngine({ store, id: d }) });
  try {
    const faulty = await fuseProblems(async () => {
      const r = await fetch(new URL('api/action', one.url), { method: 'POST', body: JSON.stringify({ type: 'fuse', with: 'manga' }) });
      return { reply: await r.json(), ids: () => store.list({ drafts: true }).map((/** @type {any} */ m) => m.id) };
    });
    assert.ok(faulty.some((p) => p.includes('new server')), faulty.join('; '));
  } finally { await one.close(); }
});

test('health: live is always 200; ready is 503 when the home is gone', async () => {
  const home = tempHome();
  const { srv } = await boot({ home });
  try {
    assert.equal((await req(srv.url, '/v1/health/live')).status, 200);
    assert.equal((await req(srv.url, '/v1/health/ready')).status, 200);
    fs.rmSync(home, { recursive: true, force: true });
    assert.equal((await req(srv.url, '/v1/health/ready')).status, 503);
    assert.equal((await req(srv.url, '/v1/health/live')).status, 200);
  } finally { await srv.close(); }
});

test('bad input: 400 with { ok: false, error } as JSON', async () => {
  const { srv } = await boot();
  try {
    for (const [p, body] of [
      ['/v1/t/default/maps', { brief: 'x' }],
      ['/v1/t/default/maps', { brief: {}, depth: 99 }],
      ['/v1/t/default/maps/check', { context: '' }],
      ['/v1/t/default/maps/check', { context: 'x', answers: 'no' }],
    ]) {
      const r = await req(srv.url, String(p), { method: 'POST', body });
      assert.equal(r.status, 400, String(p));
      assert.match(String(r.headers['content-type']), /^application\/json/);
      assert.equal(r.json().ok, false);
      assert.equal(typeof r.json().error, 'string');
    }
    assert.equal((await req(srv.url, '/v1/t/BAD/maps')).status, 404);
    assert.equal((await req(srv.url, '/v1/t/default/maps/no-such-map/snapshot')).status, 404);
  } finally { await srv.close(); }
});

/**
 * The /dist/ static route (the embed bundle, built by Part I4): served without a token from
 * <web>/dist/, and nothing outside the web folder.
 * @param {(p: string) => Promise<{ status: number, body: string }>} get
 */
async function distProblems(get) {
  const problems = [];
  const ok = await get('/dist/embed.js');
  if (ok.status !== 200 || !ok.body.includes('embed-bundle')) problems.push(`/dist/embed.js: ${ok.status}`);
  // Contained to the web folder, as every static route is (the one-map server's rule).
  for (const p of ['/dist/../../package.json', '/dist/%2e%2e/%2e%2e/package.json', '/dist/nope.js']) {
    const r = await get(p);
    if (r.status !== 404) problems.push(`${p}: ${r.status}`);
  }
  return problems;
}

test('/dist/* is served from <web>/dist/ without a token, and cannot escape the web folder', async () => {
  const { startService } = await import('../../src/server/service.js');
  const { createToken, tokensPath } = await import('../../src/server/tokens.js');
  const webDir = tempHome();
  fs.mkdirSync(`${webDir}/dist`);
  fs.writeFileSync(`${webDir}/dist/embed.js`, '/* embed-bundle */');
  fs.writeFileSync(`${webDir}/index.html`, '<html></html>');
  const home = tempHome();
  createToken(tokensPath(home), { name: 'me' });
  const srv = await startService({ home, port: 0, tokensFile: tokensPath(home), webDir, makeEngine: async (x) => stubEngine(x) });
  try {
    assert.deepEqual(await distProblems((p) => req(srv.url, p)), []);
    // Planted fault: a server without the route (every /dist/ path is 404) is reported.
    const noRoute = async () => ({ status: 404, body: 'not found' });
    assert.ok((await distProblems(noRoute)).some((p) => p.startsWith('/dist/embed.js')));
  } finally { await srv.close(); }
});
