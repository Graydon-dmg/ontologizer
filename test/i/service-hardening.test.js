// @ts-check
// The fixes from the security review: save during a chat, proxies in open mode, streams that outlive
// their token, the reserved name, the scope ladder, resource bounds, sessions, the open-mode note,
// Host/Origin behind a proxy, status paths for admins only, and the view page's sign-in redirect.
// Each check has its planted fault built in.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
process.env.ONTOLOGIZER_STUB_SPEED = '1000';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { boot, req, seed, stubEngine, tempHome } from './helpers-service.js';
import { startService, activeWork, TOKENS_FOUND_NOTE } from '../../src/server/service.js';
import { createToken, revokeToken, tokensPath, hasScope, SCOPES } from '../../src/server/tokens.js';
import { openStore, RESERVED_NAMES } from '../../src/core/store.js';

const bearer = (/** @type {string} */ t) => ({ authorization: `Bearer ${t}` });
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** A stub engine whose ask() waits until `release()` is called, then answers. */
function chatGate() {
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((r) => { release = () => r(undefined); });
  const make = (/** @type {any} */ x) => ({
    ...stubEngine(x),
    async *ask() { await gate; yield { type: 'done' }; },
  });
  return { make, release: () => release() };
}

// ---------- 1. save during a chat ----------

/**
 * The save-during-chat check: while a chat answer is being written, save is refused (409) and the
 * work list names the chat.
 * @param {(build: any, jobs: any, chatting: boolean) => any[]} work the work-list function under test
 */
function chatWorkProblems(work) {
  const problems = [];
  if (!work(undefined, {}, true).some((j) => j.kind === 'chat')) problems.push('a chat in flight is not counted as work');
  if (work(undefined, {}, false).length) problems.push('an idle map has work');
  if (!work({ state: 'running' }, {}, false).length) problems.push('a running build is not counted');
  return problems;
}

test('save while a chat answer is being written gets 409, and succeeds once it is done', async () => {
  assert.deepEqual(chatWorkProblems(activeWork), []);
  // Planted fault: a work list that ignores chats (the crash: save renamed the map under the chat).
  const withoutChats = (/** @type {any} */ b, /** @type {any} */ j) => activeWork(b, j, false);
  assert.ok(chatWorkProblems(withoutChats).includes('a chat in flight is not counted as work'));

  const g = chatGate();
  const { srv, home, secrets } = await boot({ tokens: [{ name: 'b', scopes: ['build'] }], makeEngine: async (/** @type {any} */ x) => g.make(x) });
  try {
    await seed(home, 'default', 'm1');
    const chat = req(srv.url, '/v1/t/default/maps/m1/chat', { method: 'POST', headers: bearer(secrets.b), body: { text: 'q' } });
    await sleep(150);
    const s = await req(srv.url, '/v1/t/default/maps/m1/save', { method: 'POST', headers: bearer(secrets.b), body: { name: 'renamed' } });
    assert.equal(s.status, 409, s.body);
    const w = (await req(srv.url, '/v1/t/default/maps/m1/wait?timeout=0', { headers: bearer(secrets.b) })).json();
    assert.ok(w.jobs.some((/** @type {any} */ j) => j.kind === 'chat'));
    g.release();
    assert.equal((await chat).status, 200);
    const s2 = await req(srv.url, '/v1/t/default/maps/m1/save', { method: 'POST', headers: bearer(secrets.b), body: { name: 'renamed' } });
    assert.equal(s2.status, 200, s2.body);
  } finally { await srv.close(); }
});

test('closing the server stops a chat in flight (the handler aborts it)', async () => {
  const g = chatGate();
  const { srv, home } = await boot({ makeEngine: async (/** @type {any} */ x) => g.make(x) });
  await seed(home, 'default', 'm1');
  const chat = req(srv.url, '/v1/t/default/maps/m1/chat', { method: 'POST', body: { text: 'q' } }).then(() => 'ended', () => 'ended');
  await sleep(150);
  await srv.close();
  assert.equal(await Promise.race([chat, sleep(2000).then(() => 'still open')]), 'ended');
  g.release();
});

const SERVE_SCRIPT = (/** @type {string} */ home, /** @type {boolean} */ withServe) => `
process.env.ONTOLOGIZER_KEYRING = 'none'; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
const { main } = await import(${JSON.stringify(new URL('../../src/cli/main.js', import.meta.url).href)});
setTimeout(() => { Promise.reject(new Error('ENOENT: a late append after a rename')); }, 300);
${withServe
    ? `const code = await main(['serve', '--port', '0', '--home', ${JSON.stringify(home)}, '--exit-after', '900'], { openBrowser: async () => {}, onSignal: () => () => {} });
console.log('exit ' + code); process.exit(code);`
    : 'await new Promise((r) => setTimeout(r, 900)); console.log("exit 0");'}
`;

/** @param {{ status: number|null, stdout: string, stderr: string }} r */
function survivalProblems(r) {
  const problems = [];
  if (r.status !== 0) problems.push(`the process exited ${r.status}`);
  if (!/exit 0/.test(r.stdout)) problems.push('serve did not finish normally');
  if (!/an operation failed in the background: ENOENT/.test(r.stderr)) problems.push('the failure was not logged');
  return problems;
}

test('serve keeps serving through an unhandled rejection, and logs one line', () => {
  const run = (/** @type {boolean} */ withServe) => spawnSync(process.execPath, ['--input-type=module', '-e', SERVE_SCRIPT(tempHome(), withServe)], { encoding: 'utf8', timeout: 20000 });
  assert.deepEqual(survivalProblems(run(true)), []);
  // Planted fault: the same rejection without serve's handler kills the process.
  assert.ok(survivalProblems(run(false)).some((p) => p.startsWith('the process exited')));
});

// ---------- 2. open mode behind a proxy ----------

/** @param {(headers: Record<string, string>) => Promise<number>} get @returns {Promise<string[]>} */
async function proxyProblems(get) {
  const problems = [];
  for (const [h, v] of [['forwarded', 'for=203.0.113.9'], ['x-forwarded-for', '203.0.113.9'], ['x-forwarded-host', 'maps.example'], ['x-real-ip', '203.0.113.9']]) {
    const s = await get({ [h]: v });
    if (s !== 403) problems.push(`${h}: ${s}`);
  }
  if ((await get({})) !== 200) problems.push('a direct request was refused');
  return problems;
}

test('open mode refuses --allow-host, and refuses any proxied request with 403', async () => {
  await assert.rejects(startService({ home: tempHome(), port: 0, allowHosts: ['maps.example'], makeEngine: async (x) => stubEngine(x) }),
    (err) => /** @type {any} */ (err).code === 'NO_TOKENS' && /Refusing --allow-host without tokens/.test(String(/** @type {any} */ (err).message)));
  const { srv, home } = await boot();
  try {
    await seed(home, 'default', 'm1');
    const get = async (/** @type {Record<string, string>} */ headers) => (await req(srv.url, '/v1/t/default/maps', { headers })).status;
    assert.deepEqual(await proxyProblems(get), []);
    // Even a proxy that rewrites Host to the upstream (127.0.0.1:<port>) is caught by its headers.
    assert.equal((await req(srv.url, '/', { headers: { host: `127.0.0.1:${srv.port}`, 'x-forwarded-for': '1.2.3.4' } })).status, 403);
    // Planted fault: a server that ignores proxy headers is reported.
    assert.equal((await proxyProblems(async () => 200)).length, 4);
  } finally { await srv.close(); }
  // With tokens, proxies are fine.
  const t = await boot({ tokens: [{ name: 'me' }], allowHosts: ['maps.example'] });
  try {
    assert.equal((await req(t.srv.url, '/v1/t/default/maps', { headers: { ...bearer(t.secrets.me), 'x-forwarded-for': '1.2.3.4', host: 'maps.example' } })).status, 200);
  } finally { await t.srv.close(); }
});

// ---------- 3. streams end when their token or session does ----------

/**
 * Open a stream, run `end` (a revoke or a sign-out), and report whether the stream ended within `ms`.
 * @param {string} url @param {string} p @param {Record<string, string>} headers @param {() => any} end @param {number} ms
 */
async function streamEndProblems(url, p, headers, end, ms) {
  const u = new URL(url);
  let ended = false;
  let status = 0;
  const r = http.get({ host: u.hostname, port: u.port, path: p, headers }, (res) => {
    status = /** @type {number} */ (res.statusCode);
    res.resume();
    res.on('end', () => { ended = true; });
    res.on('close', () => { ended = true; });
  });
  r.on('error', () => { ended = true; });
  await sleep(100);
  if (status !== 200) { r.destroy(); return [`the stream did not open (${status})`]; }
  await end();
  await sleep(ms);
  r.destroy();
  return ended ? [] : ['the stream is still open'];
}

test('revoking a token, or signing out, ends its open event streams within one ping', async () => {
  const PING = 60;
  const { srv, home, secrets, origin } = await boot({ tokens: [{ name: 'r', scopes: ['read'] }, { name: 'keep', scopes: ['read'] }], pingMs: PING });
  try {
    await seed(home, 'default', 'm1');
    const path1 = '/v1/t/default/maps/m1/events?from=99999';
    assert.deepEqual(await streamEndProblems(srv.url, path1, bearer(secrets.r), async () => { await sleep(20); revokeToken(tokensPath(home), 'r'); }, PING * 3), []);
    // A session's stream ends when the session does.
    const login = await req(srv.url, '/v1/session', { method: 'POST', body: { token: secrets.keep }, headers: { origin } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    assert.deepEqual(await streamEndProblems(srv.url, '/v1/t/default/maps/m1/api/events?from=99999', { cookie },
      () => req(srv.url, '/v1/session', { method: 'DELETE', headers: { cookie, origin } }), PING * 3), []);
    // Planted fault: a stream whose token is NOT revoked stays open, and the same check reports it.
    assert.deepEqual(await streamEndProblems(srv.url, path1, bearer(secrets.keep), () => {}, PING * 3), ['the stream is still open']);
  } finally { await srv.close(); }
});

// ---------- 4. the reserved name ----------

/** @param {any} store @param {string} id */
function reservedProblems(store, id) {
  const problems = [];
  for (const name of RESERVED_NAMES) {
    try { store.save(id, name); problems.push(`saved as "${name}"`); } catch (err) {
      if (!/reserved/.test(String(/** @type {Error} */ (err).message))) problems.push(`unclear message: ${/** @type {Error} */ (err).message}`);
    }
    try { store.importEvents(name, []); problems.push(`imported as "${name}"`); } catch { /* refused */ }
  }
  return problems;
}

test('"tenants" is a reserved map name in every tenant', async () => {
  const home = tempHome();
  for (const tenant of ['default', 'acme']) {
    const store = openStore(home, { tenant });
    const id = store.createDraft({ context: 'x' }, 'x');
    assert.deepEqual(reservedProblems(store, id), []);
  }
  // Planted fault: a store that allows the name is reported.
  const lax = { save: () => 'tenants', importEvents: () => 'tenants' };
  assert.equal(reservedProblems(lax, 'x').length, 2);
  // And over HTTP.
  const { srv, secrets } = await boot({ home, tokens: [{ name: 'b', scopes: ['build'] }] });
  try {
    await seed(home, 'default', 'm1');
    const r = await req(srv.url, '/v1/t/default/maps/m1/save', { method: 'POST', headers: bearer(secrets.b), body: { name: 'tenants' } });
    assert.equal(r.status, 400);
    assert.match(r.json().error, /reserved/);
  } finally { await srv.close(); }
});

// ---------- 5. the scope ladder ----------

/** @param {(scopes: string[], need: string) => boolean} has */
function ladderProblems(has) {
  const problems = [];
  const want = /** @type {Array<[string[], string, boolean]>} */ ([
    [['read'], 'read', true], [['read'], 'ask', false], [['read'], 'build', false],
    [['ask'], 'read', true], [['ask'], 'ask', true], [['ask'], 'build', false],
    [['build'], 'read', true], [['build'], 'ask', true], [['build'], 'admin', false],
    [['admin'], 'build', true], [['read', 'build'], 'ask', true], [[], 'read', false], [['read'], 'nope', false],
  ]);
  for (const [scopes, need, ok] of want) if (has(scopes, need) !== ok) problems.push(`${scopes.join(',')} -> ${need}: ${!ok}`);
  return problems;
}

test('scopes are a ladder: read < ask < build < admin; chat needs ask; read only reads', async () => {
  assert.deepEqual(SCOPES, ['read', 'ask', 'build', 'admin']);
  assert.deepEqual(ladderProblems(hasScope), []);
  // Planted fault: a flat check (a build-only token cannot read its own map) is reported.
  const flat = (/** @type {string[]} */ s, /** @type {string} */ n) => s.includes('admin') || s.includes(n);
  assert.ok(ladderProblems(flat).length >= 4);

  const g = chatGate();
  g.release();
  const { srv, home, secrets } = await boot({
    tokens: [{ name: 'r', scopes: ['read'] }, { name: 'a', scopes: ['ask'] }, { name: 'b', scopes: ['build'] }],
    makeEngine: async (/** @type {any} */ x) => g.make(x),
  });
  try {
    await seed(home, 'default', 'm1');
    const chat = (/** @type {string} */ who, p = 'chat') => req(srv.url, `/v1/t/default/maps/m1/${p}`, { method: 'POST', headers: bearer(secrets[who]), body: { text: 'q' } });
    assert.equal((await chat('r')).status, 403);
    assert.equal((await chat('r', 'api/chat')).status, 403);
    assert.equal((await chat('a')).status, 200);
    assert.equal((await req(srv.url, '/v1/t/default/maps/m1/actions', { method: 'POST', headers: bearer(secrets.a), body: { type: 'focus', nodeId: 'x' } })).status, 403);
    // A build-only token can view and wait on its own map.
    assert.equal((await req(srv.url, '/v1/t/default/maps/m1/wait?timeout=0', { headers: bearer(secrets.b) })).status, 200);
    assert.equal((await req(srv.url, '/v1/t/default/maps/m1/view', { headers: bearer(secrets.b) })).status, 200);
    assert.equal((await chat('b')).status, 200);
  } finally { await srv.close(); }
});

// ---------- 6. resource bounds ----------

/** Builds that never finish, recording the order they start in. */
function stuckBuilds() {
  /** @type {string[]} */
  const started = [];
  const make = (/** @type {any} */ x) => ({ ...stubEngine(x), build: (/** @type {any} */ brief) => { started.push(brief.context); return new Promise(() => {}); } });
  return { started, make };
}

test('builds: a per-tenant cap on waiting builds (429), and queued builds start round-robin across tenants', async () => {
  const s = stuckBuilds();
  const { srv, secrets } = await boot({
    maxBuilds: 1, maxQueued: 3, makeEngine: async (/** @type {any} */ x) => s.make(x),
    tokens: [{ name: 'a', tenant: 'a', scopes: ['build'] }, { name: 'b', tenant: 'b', scopes: ['build'] }],
  });
  try {
    const post = async (/** @type {string} */ t, /** @type {string} */ c) => (await req(srv.url, `/v1/t/${t}/maps`, { method: 'POST', headers: bearer(secrets[t]), body: { brief: { context: c } } })).status;
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push(await post('a', `a${i}`));
    assert.deepEqual(codes, [202, 202, 202, 202, 429, 429]); // 1 running + 3 waiting
    assert.equal(await post('b', 'b0'), 202); // another tenant has its own queue
    assert.equal(await post('b', 'b1'), 202);
    await sleep(50);
    assert.deepEqual(s.started, ['a0']);
  } finally { await srv.close(); }

  // Round-robin: with one slot, a tenant with many waiting builds does not starve another.
  const order = [];
  /** @type {Array<() => void>} */
  const finish = [];
  const make = (/** @type {any} */ x) => ({ ...stubEngine(x), build: (/** @type {any} */ brief) => { order.push(brief.context); return new Promise((r) => finish.push(() => r(undefined))); } });
  const rr = await boot({ maxBuilds: 1, makeEngine: async (/** @type {any} */ x) => make(x), tokens: [{ name: 'a', tenant: 'a', scopes: ['build'] }, { name: 'b', tenant: 'b', scopes: ['build'] }] });
  try {
    const post = (/** @type {string} */ t, /** @type {string} */ c) => req(rr.srv.url, `/v1/t/${t}/maps`, { method: 'POST', headers: bearer(rr.secrets[t]), body: { brief: { context: c } } });
    for (const c of ['a0', 'a1', 'a2', 'a3']) await post('a', c);
    for (const c of ['b0', 'b1']) await post('b', c);
    for (let i = 0; i < 5; i++) { await sleep(30); finish.shift()?.(); }
    await sleep(50);
    // Planted fault, a FIFO queue, would start a0 a1 a2 a3 b0 b1.
    assert.deepEqual(order, ['a0', 'a1', 'b0', 'a2', 'b1', 'a3']);
  } finally { await rr.srv.close(); }
});

test('context checks have their own slots (429 when all are busy)', async () => {
  /** @type {Array<() => void>} */
  const done = [];
  const make = (/** @type {any} */ x) => ({ ...stubEngine(x), check: () => new Promise((r) => done.push(() => r({ ready: false, questions: [] }))) });
  const { srv } = await boot({ maxChecks: 2, makeEngine: async (/** @type {any} */ x) => make(x) });
  try {
    const check = () => req(srv.url, '/v1/t/default/maps/check', { method: 'POST', body: { context: 'x' } });
    const first = [check(), check()];
    await sleep(100);
    const third = await check();
    assert.equal(third.status, 429);
    assert.ok(third.headers['retry-after']);
    for (const f of done) f();
    assert.deepEqual((await Promise.all(first)).map((r) => r.status), [200, 200]);
    const again = check();
    await sleep(50);
    done.at(-1)?.();
    assert.equal((await again).status, 200);
  } finally { await srv.close(); }
});

test('an idle map gives back its engine and handler; one with an open stream keeps them', async () => {
  const IDLE = 300;
  const { srv, home } = await boot({ idleMs: IDLE });
  try {
    await seed(home, 'default', 'm1');
    await seed(home, 'default', 'm2', 'manga');
    await req(srv.url, '/v1/t/default/maps/m1/snapshot');
    const u = new URL(srv.url);
    const stream = http.get({ host: u.hostname, port: u.port, path: '/v1/t/default/maps/m2/events?from=99999' }, (res) => res.resume());
    await sleep(50);
    assert.equal(/** @type {any} */ (srv).stats().handlers, 2);
    await sleep(IDLE + 50);
    /** @type {any} */ (srv).sweep();
    await sleep(20);
    // Planted fault (no eviction) would still hold 2; evicting the streamed map would hold 0.
    assert.deepEqual(/** @type {any} */ (srv).stats(), { engines: 1, handlers: 1, sessions: 0 });
    stream.destroy();
    await sleep(IDLE + 50);
    /** @type {any} */ (srv).sweep();
    await sleep(20);
    assert.equal(/** @type {any} */ (srv).stats().handlers, 0);
    // A dropped map comes back on its next request.
    assert.equal((await req(srv.url, '/v1/t/default/maps/m1/snapshot')).status, 200);
  } finally { await srv.close(); }
});

test('at most N open streams plus waits per token (429)', async () => {
  const { srv, home, secrets } = await boot({ maxStreamsPerToken: 2, tokens: [{ name: 'r', scopes: ['read'] }, { name: 'o', scopes: ['read'] }] });
  try {
    await seed(home, 'default', 'm1');
    const u = new URL(srv.url);
    const open = (/** @type {string} */ who) => new Promise((resolve) => {
      const r = http.get({ host: u.hostname, port: u.port, path: '/v1/t/default/maps/m1/events?from=99999', headers: bearer(secrets[who]) }, (res) => { res.resume(); resolve({ status: res.statusCode, r }); });
    });
    const a = /** @type {any} */ (await open('r'));
    const b = /** @type {any} */ (await open('r'));
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal((await req(srv.url, '/v1/t/default/maps/m1/wait?timeout=0', { headers: bearer(secrets.r) })).status, 429);
    const c = /** @type {any} */ (await open('r'));
    assert.equal(c.status, 429);
    assert.equal((/** @type {any} */ (await open('o'))).status, 200); // another token is not affected
    a.r.destroy();
    await sleep(50);
    assert.equal((await req(srv.url, '/v1/t/default/maps/m1/wait?timeout=0', { headers: bearer(secrets.r) })).status, 200);
  } finally { await srv.close(); }
});

// ---------- 7. sessions per token ----------

test('sessions: at most 20 per token (its own oldest goes); another token\'s session survives a flood', async () => {
  const { srv, secrets, origin } = await boot({ tokens: [{ name: 'victim', tenant: 'a', scopes: ['read'] }, { name: 'att', tenant: 'b', scopes: ['read'] }] });
  try {
    const login = async (/** @type {string} */ t) => String((await req(srv.url, '/v1/session', { method: 'POST', body: { token: t }, headers: { origin } })).headers['set-cookie']).split(';')[0];
    const who = async (/** @type {string} */ cookie) => (await req(srv.url, '/v1/session', { headers: { cookie } })).status;
    const victim = await login(secrets.victim);
    const mine = [];
    for (let i = 0; i < 1000; i++) mine.push(await login(secrets.att));
    /** @param {{ victim: number, oldest: number, newest: number, total: number }} o */
    const floodProblems = (o) => [
      ...(o.victim !== 200 ? ['another token\'s session was pushed out'] : []),
      ...(o.oldest !== 401 ? ['the flooding token\'s oldest session was kept'] : []),
      ...(o.newest !== 200 ? ['the newest session does not work'] : []),
      ...(o.total > 21 ? [`${o.total} sessions held`] : []),
    ];
    const seen = { victim: await who(victim), oldest: await who(mine[0]), newest: await who(mine[999]), total: /** @type {any} */ (srv).stats().sessions };
    assert.deepEqual(floodProblems(seen), []);
    assert.equal((await who(mine[980])), 200);
    assert.equal((await who(mine[979])), 401);
    // Planted fault: what the global-only cap did (the probe saw the victim's session pushed out).
    assert.ok(floodProblems({ victim: 401, oldest: 401, newest: 200, total: 1000 }).length >= 2);
  } finally { await srv.close(); }
});

// ---------- 8. tokens created while running open ----------

test('tokens created after an open start: status says auth open, with a note to restart; one log line', async () => {
  const home = tempHome();
  /** @type {string[]} */
  const logs = [];
  const srv = await startService({ home, port: 0, watchTokensFile: tokensPath(home), log: (l) => logs.push(l), makeEngine: async (x) => stubEngine(x) });
  try {
    const st = async () => (await req(srv.url, '/v1/t/default/status')).json();
    const before = await st();
    assert.equal(before.auth, 'open');
    assert.equal(before.note, undefined); // planted fault: a note before any token would be noise
    createToken(tokensPath(home), { name: 'late' });
    const after = await st();
    assert.equal(after.auth, 'open');
    assert.equal(after.note, TOKENS_FOUND_NOTE);
    await st();
    assert.equal(logs.filter((l) => l.includes(TOKENS_FOUND_NOTE)).length, 1);
    // Still open: the new token is not required until a restart.
    assert.equal((await req(srv.url, '/v1/t/default/maps')).status, 200);
  } finally { await srv.close(); }
});

// ---------- 9. Host and Origin behind a proxy ----------

/** @param {{ allowOrigin: number, foreignOrigin: number, secureViaProxy: boolean, secureDirect: boolean, secureSpoofed: boolean }} o */
function proxyCookieProblems(o) {
  return [
    ...(o.allowOrigin === 403 ? ['a cookie POST from the --allow-host origin was refused'] : []),
    ...(o.foreignOrigin !== 403 ? ['a cookie POST from a foreign origin passed'] : []),
    ...(!o.secureViaProxy ? ['the cookie is not Secure behind an https proxy'] : []),
    ...(o.secureDirect ? ['the cookie is Secure on a plain direct request'] : []),
    ...(o.secureSpoofed ? ['X-Forwarded-Proto from a non-proxy Host made the cookie Secure'] : []),
  ];
}

test('behind a proxy: the --allow-host origin passes the cookie Origin check; the cookie is Secure only via the https proxy', async () => {
  const { srv, home, secrets } = await boot({ tokens: [{ name: 'me', scopes: ['build'] }], allowHosts: ['maps.example'] });
  try {
    await seed(home, 'default', 'm1');
    const login = async (/** @type {Record<string, string>} */ headers) => String((await req(srv.url, '/v1/session', { method: 'POST', body: { token: secrets.me }, headers })).headers['set-cookie']);
    const viaProxy = await login({ host: 'maps.example', 'x-forwarded-proto': 'https', origin: 'https://maps.example' });
    const direct = await login({});
    const spoofed = await login({ 'x-forwarded-proto': 'https' });
    const cookie = viaProxy.split(';')[0];
    const act = async (/** @type {string} */ origin) => (await req(srv.url, '/v1/t/default/maps/m1/actions', {
      method: 'POST', body: { type: 'focus', nodeId: 'x' }, headers: { cookie, origin, host: 'maps.example', 'x-forwarded-proto': 'https' },
    })).status;
    const seen = {
      allowOrigin: await act('https://maps.example'), foreignOrigin: await act('https://evil.example'),
      secureViaProxy: /; Secure/.test(viaProxy), secureDirect: /; Secure/.test(direct), secureSpoofed: /; Secure/.test(spoofed),
    };
    assert.deepEqual(proxyCookieProblems(seen), []);
    // Planted fault: an Origin check that only knows Host (the proxy's origin refused) is reported.
    assert.ok(proxyCookieProblems({ ...seen, allowOrigin: 403 }).length === 1);
  } finally { await srv.close(); }
});

test('ONTOLOGIZER_ALLOW_HOST is the env form of --allow-host (and needs tokens too)', async () => {
  const { main } = await import('../../src/cli/main.js');
  const cap = () => ({ out: '', write(/** @type {string} */ s) { this.out += s; return true; } });
  const home = tempHome();
  const env = { ...process.env, ONTOLOGIZER_ALLOW_HOST: 'maps.example, other.example' };
  const run = async (/** @type {string[]} */ args) => {
    const stdout = cap(); const stderr = cap();
    const code = await main(args, { home, stdout, stderr, env, interactive: false, openBrowser: async () => {}, onSignal: () => () => {}, keyring: { get: () => null, set() {}, delete: () => false } });
    return { code, stderr: stderr.out };
  };
  const refused = await run(['serve', '--port', '0', '--home', home]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Refusing --allow-host without tokens/);
  createToken(tokensPath(home), { name: 'me' });
  const running = run(['serve', '--port', '0', '--home', home, '--exit-after', '800']);
  const file = path.join(home, 'serve.json');
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await sleep(20);
  const { url, auth } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(auth, 'tokens');
  assert.equal((await req(url, '/v1/health/live', { headers: { host: 'other.example' } })).status, 200);
  assert.equal((await req(url, '/v1/health/live', { headers: { host: 'nope.example' } })).status, 403);
  assert.equal((await running).code, 0);
});

// ---------- 10. status paths for admins only ----------

test('HTTP status shows the home path only to admin', async () => {
  const { srv, secrets } = await boot({ tokens: [{ name: 'r', scopes: ['read'] }, { name: 'adm', scopes: ['admin'] }] });
  try {
    const st = async (/** @type {string} */ who) => (await req(srv.url, '/v1/t/default/status', { headers: bearer(secrets[who]) })).json();
    const r = await st('r');
    const a = await st('adm');
    assert.equal('home' in r, false);
    assert.equal(typeof a.home, 'string');
    assert.equal(r.auth, 'tokens');
  } finally { await srv.close(); }
});

// ---------- 11. the view page sends a browser to sign in ----------

/** @param {(p: string, headers: Record<string, string>) => Promise<{ status: number, location?: string }>} get */
async function redirectProblems(get) {
  const problems = [];
  const view = '/v1/t/default/maps/m1/view';
  const r = await get(view, { accept: 'text/html,application/xhtml+xml' });
  if (r.status !== 302 || r.location !== `/?next=${encodeURIComponent(view)}`) problems.push(`browser view: ${r.status} ${r.location}`);
  if ((await get(view, {})).status !== 401) problems.push('an API request was redirected');
  if ((await get('/v1/t/default/maps/m1/snapshot', { accept: 'text/html' })).status !== 401) problems.push('a non-view route was redirected');
  if ((await get(view, { accept: 'text/html', authorization: 'Bearer nope' })).status !== 401) problems.push('a bad Bearer was redirected');
  return problems;
}

test('GET .../view without a session: a browser gets 302 to /?next=<path>; API requests keep 401', async () => {
  const { srv, home } = await boot({ tokens: [{ name: 'me' }] });
  try {
    await seed(home, 'default', 'm1');
    const get = async (/** @type {string} */ p, /** @type {Record<string, string>} */ headers) => {
      const r = await req(srv.url, p, { headers });
      return { status: r.status, location: /** @type {string|undefined} */ (r.headers.location) };
    };
    assert.deepEqual(await redirectProblems(get), []);
    // Planted fault: a server that redirects every unauthenticated request is reported.
    const always = async () => ({ status: 302, location: '/?next=x' });
    assert.ok((await redirectProblems(always)).length >= 3);
  } finally { await srv.close(); }
});
