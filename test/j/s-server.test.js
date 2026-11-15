// @ts-check
// S5: the new routes' security, limit and size gates, and `_root/…` ids printed as they are.
// Each check feeds its planted fault first.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
process.env.ONTOLOGIZER_STUB_SPEED = '1000';
import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { boot, req, seed, stubEngine, tempHome } from '../i/helpers-service.js';
import { startService } from '../../src/server/service.js';
import { createUsage } from '../../src/server/usage.js';
import { actionFor } from '../../src/server/policy.js';
import { contextPack } from '../../src/core/export/context.js';
import { outline } from '../../src/core/engine/chat.js';
import { foldAll } from '../../src/core/events.js';

const bearer = (/** @type {string} */ t) => ({ authorization: `Bearer ${t}` });
const ORG = '/v1/t/default/maps/organize';

/** POST a big body; resolves with the status as soon as it arrives. The server answers 413 and then
 * cuts the upload, so a cut upload (EPIPE / ECONNRESET) before any status counts as 413.
 * @param {string} url @param {string} p @param {string} data @returns {Promise<number>} */
function postStatus(url, p, data) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    let status = 0;
    const r = http.request({ host: u.hostname, port: u.port, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json' } }, (res) => {
      status = /** @type {number} */ (res.statusCode); res.resume(); resolve(status);
    });
    r.on('error', (/** @type {any} */ e) => (status ? resolve(status) : ['EPIPE', 'ECONNRESET'].includes(e.code) ? resolve(413) : reject(e)));
    r.end(data);
  });
}

test('hydrate and add_node via …/actions need the build scope: a read token gets 403', async () => {
  // planted fault: a new sub-route (…/nodes, …/hydrate) is mapped to read by actionFor
  assert.equal(actionFor('nodes'), 'read');
  assert.equal(actionFor('hydrate'), 'read');
  assert.equal(actionFor('actions'), 'job');
  const { home, srv, secrets } = await boot({ tokens: [{ name: 'r', scopes: ['read'] }, { name: 'b', scopes: ['build'] }] });
  try {
    await seed(home, 'default', 'm1');
    const act = (/** @type {string} */ who, /** @type {any} */ body) => req(srv.url, '/v1/t/default/maps/m1/actions', { method: 'POST', headers: bearer(secrets[who]), body });
    for (const body of [{ type: 'hydrate', all: true }, { type: 'add_node', parentId: 'plastic-modeling', label: 'X' }]) {
      assert.equal((await act('r', body)).status, 403, body.type);
      const b = await act('b', body);
      assert.notEqual(b.status, 403, body.type); // a build token is not refused (the feature's own answer varies as epics land)
    }
    assert.equal((await act('b', { type: 'hydrate' })).json().error, 'give nodeIds or all');
    assert.equal((await act('b', { type: 'add_node', label: 'X' })).json().error, 'give parentId and label');
    assert.equal((await req(srv.url, ORG, { method: 'POST', headers: bearer(secrets.r), body: { name: 'x', items: [] } })).status, 403);
  } finally { await srv.close(); }
});

test('hydrate is behind the daily limit (429); add_node, which calls no model, is not', async () => {
  const home = tempHome();
  await seed(home, 'default', 'm1');
  const usage = createUsage({ home, limitCalls: 1 });
  usage.record('default', { calls: 1 });
  const srv = await startService({ home, host: '127.0.0.1', port: 0, allowHosts: [], maxBuilds: 2, version: 'test', tokensFile: null, usage,
    makeEngine: async (/** @type {any} */ x) => stubEngine(x) });
  try {
    const act = (/** @type {any} */ body) => req(`http://127.0.0.1:${srv.port}`, '/v1/t/default/maps/m1/actions', { method: 'POST', body });
    assert.equal((await act({ type: 'hydrate', all: true })).status, 429);
    // the planted fault's shape: an action left out of MODEL_ACTIONS gets past the limit (here add_node, on purpose)
    assert.notEqual((await act({ type: 'add_node', parentId: 'plastic-modeling', label: 'X' })).status, 429);
  } finally { await srv.close(); }
});

test('the organize route accepts a 3 MiB body (501 placeholder) and refuses 5 MiB with 413', async () => {
  const { srv } = await boot();
  try {
    const body = (/** @type {number} */ bytes) => JSON.stringify({ name: 'big', items: [{ id: 'a', label: 'A', text: 'x'.repeat(bytes) }] });
    // planted fault: the default 64 KiB cap refuses even a small big body
    assert.equal(await postStatus(srv.url, '/v1/t/default/maps', body(100 * 1024)), 413);
    assert.equal(await postStatus(srv.url, ORG, body(3 * 1024 * 1024)), 501);
    assert.equal(await postStatus(srv.url, ORG, body(5 * 1024 * 1024)), 413);
    const empty = await req(srv.url, ORG, { method: 'POST', body: {} });
    assert.equal(empty.status, 400);
    assert.equal(empty.json().error, 'give name and items');
    assert.equal((await req(srv.url, ORG)).status, 405);
  } finally { await srv.close(); }
});

test('the organize route keeps build_map\'s queue cap: 429 with Retry-After when the tenant\'s queue is full', async () => {
  const make = (/** @type {any} */ x) => ({ ...stubEngine(x), build: () => new Promise(() => {}) });
  const { srv } = await boot({ maxBuilds: 1, maxQueued: 1, makeEngine: async (/** @type {any} */ x) => make(x) });
  try {
    const ok = { name: 'x', items: [{ id: 'a', label: 'A' }] };
    // planted fault: with the queue empty the request gets through to the placeholder
    assert.equal((await req(srv.url, ORG, { method: 'POST', body: ok })).status, 501);
    for (const c of ['a0', 'a1']) assert.equal((await req(srv.url, '/v1/t/default/maps', { method: 'POST', body: { brief: { context: c } } })).status, 202);
    const full = await req(srv.url, ORG, { method: 'POST', body: ok });
    assert.equal(full.status, 429);
    assert.equal(full.headers['retry-after'], '30');
  } finally { await srv.close(); }
});

test('_root/x ids print unescaped in the context pack and the chat outline', () => {
  const o = foldAll([
    { t: 'ontology.created', at: 0, name: 'Org', root: '_root', brief: { context: 'x', subject: 'x', scope: '', purpose: '', level: 'beginner' }, categories: [] },
    { t: 'node.added', at: 1, node: { id: '_root', label: 'Org', parent: null, category: '', depth: 0, sources: [], status: 'done', createdBy: 'organize' } },
    { t: 'node.added', at: 2, node: { id: '_root/finance', label: 'Finance', parent: '_root', category: '_root/finance', depth: 1, sources: [], status: 'done', createdBy: 'organize' } },
    { t: 'node.added', at: 3, node: { id: 'de~fi', label: 'DeFi', parent: '_root/finance', category: '_root/finance', depth: 2, sources: [], status: 'done', createdBy: 'organize' } },
  ]);
  const pack = contextPack(o, { budget: 4000 });
  const chat = JSON.stringify(outline(o));
  assert.ok(pack.includes('Org (_root)'), 'the root id is printed as is');
  assert.ok(chat.includes('_root/finance'), 'the id is printed as is');
  for (const text of [pack, chat]) {
    assert.ok(!text.includes('\\_root'), 'no escaped id');
    assert.ok(text.includes('de~fi'));
  }
  // planted fault: the 1.8.0 regex refuses a leading _ (the id would be escaped)
  assert.equal(/^[A-Za-z0-9][\w.:/-]{0,299}$/.test('_root/finance'), false);
});
