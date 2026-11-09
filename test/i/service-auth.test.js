// @ts-check
// Service mode auth: 401 without a token, 403 for a missing scope, 404 across tenants, Origin on
// cookie POSTs, and no token secret anywhere. Each check has its planted fault built in.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
process.env.ONTOLOGIZER_STUB_SPEED = '1000';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { boot, req, seed, readSse } from './helpers-service.js';
import { tokensPath, newToken } from '../../src/server/tokens.js';

/** Every /v1/t/ route, with a map id that exists in tenant "default". @param {string} id */
const ROUTES = (id) => [
  ['GET', '/v1/t/default/status'],
  ['GET', '/v1/t/default/maps'],
  ['POST', '/v1/t/default/maps/check', { context: 'x' }],
  ['POST', '/v1/t/default/maps', { brief: { context: 'x' } }],
  ['GET', `/v1/t/default/maps/${id}/snapshot`],
  ['GET', `/v1/t/default/maps/${id}/events?from=0`],
  ['GET', `/v1/t/default/maps/${id}/wait?timeout=0`],
  ['POST', `/v1/t/default/maps/${id}/actions`, { type: 'focus', nodeId: 'x' }],
  ['POST', `/v1/t/default/maps/${id}/chat`, { text: 'hi' }],
  ['POST', `/v1/t/default/maps/${id}/save`, { name: 'saved' }],
  ['GET', `/v1/t/default/maps/${id}/view`],
  ['GET', `/v1/t/default/maps/${id}/api/snapshot`],
  ['GET', `/v1/t/default/maps/${id}/api/events?from=0`],
  ['GET', `/v1/t/default/maps/${id}/api/maps`],
  ['POST', `/v1/t/default/maps/${id}/api/action`, { type: 'focus', nodeId: 'x' }],
  ['GET', '/v1/t/default/nothing-here'],
];

/**
 * The 401 check: every route, with no credentials and with wrong ones, answers 401.
 * @param {string} url @param {any[]} routes @returns {Promise<string[]>}
 */
async function unauthProblems(url, routes) {
  const problems = [];
  const wrong = [
    {},
    { authorization: `Bearer ${newToken()}` },
    { authorization: 'Bearer not-a-token' },
    { authorization: 'Basic abc' },
    { cookie: 'ontologizer_session=forged' },
  ];
  for (const [method, p, body] of routes) {
    for (const headers of wrong) {
      const r = await req(url, p, { method, body, headers });
      if (r.status !== 401) problems.push(`${method} ${p} with ${JSON.stringify(headers)}: ${r.status}`);
    }
  }
  return problems;
}

/** A server with one route registered outside the auth wrapper (the planted fault). */
function faultyServer() {
  return new Promise((resolve) => {
    const s = http.createServer((rq, res) => {
      const open = rq.url?.endsWith('/status');
      res.writeHead(open || rq.headers.authorization === 'Bearer ok' ? 200 : 401);
      res.end('{}');
    });
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${/** @type {any} */ (s.address()).port}/`, close: () => s.close() }));
  });
}

test('with tokens loaded, every /v1/t/ route returns 401 without a token and with a wrong one', async () => {
  const { srv, home } = await boot({ tokens: [{ name: 'ci', scopes: ['read', 'build'] }] });
  try {
    await seed(home, 'default', 'demo');
    assert.deepEqual(await unauthProblems(srv.url, ROUTES('demo')), []);
    // Health and static files need no token.
    assert.equal((await req(srv.url, '/v1/health/live')).status, 200);
    assert.equal((await req(srv.url, '/v1/health/ready')).status, 200);
    assert.equal((await req(srv.url, '/shell/base.js')).status, 200);
    assert.equal((await req(srv.url, '/')).status, 200);
  } finally { await srv.close(); }
  // Planted fault: a route outside the auth wrapper is reported.
  const bad = /** @type {any} */ (await faultyServer());
  try {
    const problems = await unauthProblems(bad.url, [['GET', '/v1/t/default/status'], ['GET', '/v1/t/default/maps']]);
    assert.ok(problems.some((p) => p.includes('/status')), 'the open /status route must be reported');
    assert.ok(!problems.some((p) => p.includes('/maps:')), 'the wrapped route is fine');
  } finally { bad.close(); }
});

/**
 * The 403 check: a read-only token is refused (403) on every route that needs build.
 * @param {(method: string, p: string, body: any) => Promise<number>} call @param {string} id
 */
async function scopeProblems(call, id) {
  const problems = [];
  for (const [method, p, body] of [
    ['POST', '/v1/t/default/maps', { brief: { context: 'x' } }],
    ['POST', '/v1/t/default/maps/check', { context: 'x' }],
    ['POST', `/v1/t/default/maps/${id}/actions`, { type: 'focus', nodeId: 'x' }],
    ['POST', `/v1/t/default/maps/${id}/api/action`, { type: 'focus', nodeId: 'x' }],
    ['POST', `/v1/t/default/maps/${id}/save`, { name: 'saved' }],
  ]) {
    const status = await call(method, p, body);
    if (status !== 403) problems.push(`${method} ${p}: ${status}`);
  }
  return problems;
}

test('a read-only token gets 403 on POST /maps, /actions, /save; reads still work', async () => {
  const { srv, home, secrets } = await boot({ tokens: [{ name: 'reader', scopes: ['read'] }, { name: 'builder', scopes: ['read', 'build'] }] });
  try {
    await seed(home, 'default', 'demo');
    const as = (/** @type {string} */ name) => ({ authorization: `Bearer ${secrets[name]}` });
    const call = async (/** @type {string} */ method, /** @type {string} */ p, /** @type {any} */ body) => (await req(srv.url, p, { method, body, headers: as('reader') })).status;
    assert.deepEqual(await scopeProblems(call, 'demo'), []);
    assert.equal((await req(srv.url, '/v1/t/default/maps', { headers: as('reader') })).status, 200);
    assert.equal((await req(srv.url, '/v1/t/default/maps/demo/snapshot', { headers: as('reader') })).status, 200);
    // The builder may act.
    const r = await req(srv.url, '/v1/t/default/maps/demo/actions', { method: 'POST', body: { type: 'focus', nodeId: 'x' }, headers: as('builder') });
    assert.equal(r.status, 202);
    // Planted fault: a scope check that only checks the tenant lets the reader through.
    const tenantOnly = async () => 202;
    assert.equal((await scopeProblems(tenantOnly, 'demo')).length, 5);
  } finally { await srv.close(); }
});

/**
 * The tenant check: a token for tenant a gets 404 on every route of tenant b's map.
 * @param {(p: string) => Promise<number>} get
 */
async function tenantProblems(get) {
  const problems = [];
  for (const p of ['/v1/t/b/maps/secret/snapshot', '/v1/t/b/maps/secret/view', '/v1/t/b/maps/secret/api/snapshot', '/v1/t/b/maps', '/v1/t/b/status']) {
    const s = await get(p);
    if (s !== 404) problems.push(`${p}: ${s}`);
  }
  return problems;
}

test('a token for tenant a gets 404 on tenant b\'s map (and its own tenant works)', async () => {
  const { srv, home, secrets } = await boot({ tokens: [{ name: 'a', tenant: 'a', scopes: ['read', 'build'] }] });
  try {
    await seed(home, 'b', 'secret');
    await seed(home, 'a', 'mine');
    const h = { authorization: `Bearer ${secrets.a}` };
    assert.deepEqual(await tenantProblems(async (p) => (await req(srv.url, p, { headers: h })).status), []);
    const own = await req(srv.url, '/v1/t/a/maps', { headers: h });
    assert.equal(own.status, 200);
    assert.deepEqual(own.json().map((/** @type {any} */ m) => m.id), ['mine']);
    // The map really exists in b, and only in b's folder.
    assert.ok(fs.existsSync(`${home}/tenants/b/secret/events.jsonl`));
    // Planted fault: a store lookup that ignores the tenant serves b's map to a's token.
    const ignoresTenant = async (/** @type {string} */ p) => (await req(srv.url, p.replace('/t/b/', '/t/a/').replace('secret', 'mine'), { headers: h })).status;
    assert.ok((await tenantProblems(ignoresTenant)).length >= 3);
  } finally { await srv.close(); }
});

/**
 * The Origin check for cookie POSTs.
 * @param {(origin: string|null) => Promise<number>} post a POST with the session cookie and this Origin (null: none)
 * @param {string} own the server's own origin
 */
async function originProblems(post, own) {
  const problems = [];
  for (const o of ['http://evil.example', 'null', `${own}.evil.example`, null]) {
    const s = await post(o);
    if (s !== 403) problems.push(`Origin ${o}: ${s}`);
  }
  const ok = await post(own);
  if (ok === 403) problems.push('the server\'s own origin was refused');
  return problems;
}

test('a cookie POST with a foreign Origin gets 403; Bearer needs no Origin', async () => {
  const { srv, home, secrets, origin } = await boot({ tokens: [{ name: 'me', scopes: ['read', 'build'] }] });
  try {
    await seed(home, 'default', 'demo');
    const login = await req(srv.url, '/v1/session', { method: 'POST', body: { token: secrets.me }, headers: { origin } });
    assert.equal(login.status, 200);
    assert.deepEqual(login.json(), { ok: true, tenant: 'default', scopes: ['read', 'build'] });
    const set = String(login.headers['set-cookie']);
    assert.match(set, /^ontologizer_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\//);
    const cookie = set.split(';')[0];
    // A wrong token is refused.
    assert.equal((await req(srv.url, '/v1/session', { method: 'POST', body: { token: newToken() } })).status, 401);
    // GET with the cookie works.
    const who = await req(srv.url, '/v1/session', { headers: { cookie } });
    assert.equal(who.status, 200);
    assert.equal(who.json().tenant, 'default');
    const post = async (/** @type {string|null} */ o) => (await req(srv.url, '/v1/t/default/maps/demo/actions', {
      method: 'POST', body: { type: 'focus', nodeId: 'x' }, headers: { cookie, ...(o === null ? {} : { origin: o }) },
    })).status;
    assert.deepEqual(await originProblems(post, origin), []);
    // Bearer requests need not carry an Origin.
    const bearer = await req(srv.url, '/v1/t/default/maps/demo/actions', { method: 'POST', body: { type: 'focus', nodeId: 'x' }, headers: { authorization: `Bearer ${secrets.me}` } });
    assert.equal(bearer.status, 202);
    // Planted fault: an Origin check that skips cookie requests (every POST passes).
    const skips = async () => 202;
    assert.ok((await originProblems(skips, origin)).length >= 4);
    // Sign out: the cookie stops working.
    assert.equal((await req(srv.url, '/v1/session', { method: 'DELETE', headers: { cookie, origin } })).status, 200);
    assert.equal((await req(srv.url, '/v1/session', { headers: { cookie } })).status, 401);
  } finally { await srv.close(); }
});

test('a revoked token stops working at once, and its sessions end with it', async () => {
  const { srv, home, secrets, origin } = await boot({ tokens: [{ name: 'me', scopes: ['read'] }, { name: 'other', scopes: ['read'] }] });
  try {
    const login = await req(srv.url, '/v1/session', { method: 'POST', body: { token: secrets.me }, headers: { origin } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    assert.equal((await req(srv.url, '/v1/t/default/maps', { headers: { cookie } })).status, 200);
    const { revokeToken } = await import('../../src/server/tokens.js');
    await new Promise((r) => setTimeout(r, 20)); // a new mtime
    assert.equal(revokeToken(tokensPath(home), 'me'), true);
    assert.equal((await req(srv.url, '/v1/t/default/maps', { headers: { cookie } })).status, 401);
    assert.equal((await req(srv.url, '/v1/t/default/maps', { headers: { authorization: `Bearer ${secrets.me}` } })).status, 401);
    assert.equal((await req(srv.url, '/v1/t/default/maps', { headers: { authorization: `Bearer ${secrets.other}` } })).status, 200);
  } finally { await srv.close(); }
});

/**
 * The secret check: none of these texts contains any of the secrets.
 * @param {string[]} texts @param {string[]} secrets
 */
function leakProblems(texts, secrets) {
  const problems = [];
  for (const [i, t] of texts.entries()) {
    for (const s of secrets) if (t.includes(s)) problems.push(`text ${i} contains a token secret`);
  }
  return problems;
}

test('no response, log line or page contains a token secret; tokens.json holds only hashes', async () => {
  /** @type {string[]} */
  const logs = [];
  const { srv, home, secrets, origin } = await boot({ tokens: [{ name: 'admin', scopes: ['admin'] }, { name: 'ci', scopes: ['read'] }], log: (l) => logs.push(l) });
  try {
    await seed(home, 'default', 'demo');
    const texts = [];
    const H = { authorization: `Bearer ${secrets.admin}` };
    const login = await req(srv.url, '/v1/session', { method: 'POST', body: { token: secrets.ci }, headers: { origin } });
    texts.push(login.body, JSON.stringify(login.headers));
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    for (const p of ['/', '/v1/session', '/v1/t/default/status', '/v1/t/default/maps', '/v1/t/default/maps/demo/view', '/v1/t/default/maps/demo/snapshot', '/v1/t/default/maps/demo/wait?timeout=0', '/v1/t/default/maps/demo/api/maps']) {
      for (const headers of [H, { cookie }]) {
        const r = await req(srv.url, p, { headers });
        assert.ok(r.status < 400, `${p}: ${r.status}`);
        texts.push(r.body, JSON.stringify(r.headers));
      }
    }
    const ev = await readSse(srv.url, '/v1/t/default/maps/demo/events?from=0', 3, H);
    texts.push(JSON.stringify(ev.events));
    // The status lists tokens by name and scopes only.
    const status = (await req(srv.url, '/v1/t/default/status', { headers: H })).json();
    assert.deepEqual(status.tokens, [{ name: 'admin', tenant: 'default', scopes: ['admin'] }, { name: 'ci', tenant: 'default', scopes: ['read'] }]);
    assert.equal(status.store, 'files');
    assert.equal(status.maps, 1);
    assert.equal(status.server.version, 'test');
    texts.push(...logs, fs.readFileSync(tokensPath(home), 'utf8'));
    const all = Object.values(secrets);
    assert.deepEqual(leakProblems(texts, all), []);
    // tokens.json: only hashes, mode 0600.
    const rows = JSON.parse(fs.readFileSync(tokensPath(home), 'utf8'));
    for (const r of rows) assert.match(r.hash, /^sha256:[0-9a-f]{64}$/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(tokensPath(home)).mode & 0o777, 0o600);
    // Planted fault: a status handler that returns the token is caught by the same scan.
    const leaky = JSON.stringify({ ...status, tokens: [{ name: 'ci', token: secrets.ci }] });
    assert.equal(leakProblems([leaky], all).length, 1);
  } finally { await srv.close(); }
});

test('the Host check: foreign Host is refused; --allow-host lets a proxy name in', async () => {
  const { srv } = await boot({ allowHosts: ['maps.internal'] });
  try {
    assert.equal((await req(srv.url, '/v1/health/live', { headers: { host: 'evil.example' } })).status, 403);
    assert.equal((await req(srv.url, '/v1/health/live', { headers: { host: `127.0.0.1:${srv.port + 1}` } })).status, 403);
    assert.equal((await req(srv.url, '/v1/health/live', { headers: { host: `localhost:${srv.port}` } })).status, 200);
    assert.equal((await req(srv.url, '/v1/health/live', { headers: { host: 'maps.internal' } })).status, 200);
  } finally { await srv.close(); }
});

test('without tokens (loopback only) everything is open, as the one-map server is; a foreign Origin is still refused', async () => {
  const { srv, home, origin } = await boot();
  try {
    await seed(home, 'default', 'demo');
    assert.equal((await req(srv.url, '/v1/t/default/maps')).status, 200);
    const s = await req(srv.url, '/v1/session');
    assert.deepEqual(s.json(), { ok: true, tenant: 'default', scopes: ['admin'], open: true });
    const act = (/** @type {any} */ headers) => req(srv.url, '/v1/t/default/maps/demo/actions', { method: 'POST', body: { type: 'focus', nodeId: 'x' }, headers });
    assert.equal((await act({})).status, 202);
    assert.equal((await act({ origin })).status, 202);
    assert.equal((await act({ origin: 'http://evil.example' })).status, 403);
  } finally { await srv.close(); }
});
