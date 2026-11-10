// @ts-check
// Review fixes for the service router: re-checks of a custom identity and policy on open streams,
// idle store eviction under --max-stores, token sources in status, and the policy's 'admin' answer.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startService } from '../../src/server/service.js';
import { createToken, tokensPath } from '../../src/server/tokens.js';
import { defaultPolicy } from '../../src/server/policy.js';
import { openStore } from '../../src/core/store.js';
import { req, stubEngine, tempHome, seed } from './helpers-service.js';

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { pingMs: 40, recheckMs: 40 };

/** @param {any} o */
async function start(o) {
  return startService({
    home: o.home ?? tempHome(), host: '127.0.0.1', port: 0, version: 'test',
    makeEngine: async (/** @type {any} */ x) => stubEngine(x), tokensFile: null, ...o,
  });
}

/** An open event stream: its data events, and whether it ended. @param {string} url @param {string} p @param {Record<string, string>} headers */
function openStream(url, p, headers) {
  const u = new URL(url);
  const t = { status: 0, events: /** @type {any[]} */ ([]), ended: false };
  let buf = '';
  const r = http.get({ host: u.hostname, port: u.port, path: p, headers }, (res) => {
    t.status = /** @type {number} */ (res.statusCode);
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const msg = buf.slice(0, i); buf = buf.slice(i + 2);
        if (msg.startsWith('data: ')) t.events.push(JSON.parse(msg.slice(6)));
      }
    });
    res.on('close', () => { t.ended = true; });
  });
  r.on('error', () => { t.ended = true; });
  return { t, close: () => r.destroy() };
}

/**
 * Wait until a stream has its answer (its status), at most `ms`: a fixed short sleep failed under heavy
 * parallel load (two full suites at once), when the answer took longer than the sleep.
 * @param {{ t: { status: number, ended: boolean } }} s @param {number} [ms]
 */
async function opened(s, ms = 3000) {
  const until = Date.now() + ms;
  while (s.t.status === 0 && !s.t.ended && Date.now() < until) await sleep(5);
}

/**
 * A home with map m1, and the one store the server uses for it (a config store port), so a test can
 * append events that open streams send.
 */
async function sharedHome() {
  const home = tempHome();
  await seed(home, 'default', 'm1');
  const store = openStore(home);
  return { home, store, port: (/** @type {string} */ t) => (t === 'default' ? store : null) };
}
/** An event appended to m1 (something a stream sends). @param {any} store */
const poke = (store) => store.append('m1', { t: 'ontology.renamed', at: store.now('m1'), name: `n${Math.random()}` });

/**
 * Open a stream as `x-user: ann`, check it flows, call `revoke`, and report what is wrong.
 * @param {any} srv @param {any} store @param {() => void} revoke
 */
async function revokeProblems(srv, store, revoke) {
  const problems = [];
  // From the map's current end, so only new events come.
  let n = 0;
  for await (const _ of store.events('m1')) n++;
  const s = openStream(srv.url, `/v1/t/default/maps/m1/events?from=${n}`, { 'x-user': 'ann' });
  try {
    await opened(s);
    if (s.t.status !== 200) return [`stream did not open (${s.t.status})`];
    poke(store);
    await sleep(80);
    if (!s.t.events.some((e) => e.t === 'ontology.renamed')) problems.push('no event before the revoke');
    revoke();
    await sleep(250); // several pings and re-checks
    const seen = s.t.events.length;
    poke(store);
    await sleep(120);
    if (!s.t.ended) problems.push('the stream is still open after the revoke');
    if (s.t.events.length !== seen) problems.push('an event was sent after the revoke');
  } finally { s.close(); }
  return problems;
}

/** An identity that reads x-user, and refuses anyone in `gone`. @param {Set<string>} gone @param {any} [extra] */
const identityOf = (gone, extra = {}) => ({
  name: 'hdr',
  authenticate: (/** @type {any} */ r) => {
    const u = r.headers['x-user'];
    return u && !gone.has(u) ? { actor: { id: `user:${u}`, kind: 'human' }, tenant: 'default', scopes: ['read'], sources: [] } : null;
  },
  ...extra,
});

test('identity port: a user removed mid-stream has the stream ended, no further events', async () => {
  const { home, store, port } = await sharedHome();
  const gone = new Set();
  const srv = await start({ home, ...FAST, config: { identity: identityOf(gone), policy: defaultPolicy, store: port } });
  try {
    // Planted fault first: a user who is NOT removed keeps the stream, and the same check reports it.
    assert.deepEqual(await revokeProblems(srv, store, () => {}), ['the stream is still open after the revoke', 'an event was sent after the revoke']);
    assert.deepEqual(await revokeProblems(srv, store, () => gone.add('ann')), []);
  } finally { await srv.close(); }
});

test('identity port: an optional stillValid(principal) hook that says no ends the stream', async () => {
  const { home, store, port } = await sharedHome();
  const ended = new Set();
  const asked = [];
  const ident = identityOf(new Set(), { stillValid: (/** @type {any} */ p) => { asked.push(p.actor.id); return !ended.has(p.actor.id); } });
  const srv = await start({ home, ...FAST, config: { identity: ident, store: port } });
  try {
    assert.deepEqual(await revokeProblems(srv, store, () => ended.add('user:ann')), []);
    assert.ok(asked.includes('user:ann'), 'stillValid was asked with the principal');
  } finally { await srv.close(); }
});

test('custom policy (async): a read revoked mid-stream ends the stream, though nothing it is shown changed', async () => {
  const { home, store, port } = await sharedHome();
  let allow = true;
  const policy = { name: 'flag', can: async (/** @type {any} */ p, /** @type {string} */ a, /** @type {any} */ c) => allow && defaultPolicy.can(p, /** @type {any} */ (a), c) };
  const srv = await start({ home, ...FAST, config: { identity: identityOf(new Set()), policy, store: port } });
  try {
    assert.deepEqual(await revokeProblems(srv, store, () => { allow = false; }), []);
  } finally { await srv.close(); }
});

test('custom policy with tokens: a revoked read ends a bearer stream too', async () => {
  const home = tempHome();
  await seed(home, 'default', 'm1');
  const secret = createToken(tokensPath(home), { name: 'r', scopes: ['read'] }).token;
  let allow = true;
  const policy = { name: 'flag', can: (/** @type {any} */ p, /** @type {any} */ a, /** @type {any} */ c) => allow && defaultPolicy.can(p, a, c) };
  const srv = await start({ home, ...FAST, tokensFile: tokensPath(home), config: { policy } });
  try {
    const s = openStream(srv.url, '/v1/t/default/maps/m1/events?from=99999', { authorization: `Bearer ${secret}` });
    await opened(s);
    assert.equal(s.t.status, 200);
    allow = false;
    await sleep(250);
    assert.equal(s.t.ended, true, 'the stream ended');
    s.close();
  } finally { await srv.close(); }
});

test('--max-stores: 18 file tenants opened one after another all answer 200 once idle stores are swept', async () => {
  const home = tempHome();
  const names = Array.from({ length: 18 }, (_, i) => `t${i}`);
  for (const t of names) await seed(home, t, 'm1');
  const srv = await start({ home, idleMs: 30 }); // maxStores: the default 16
  try {
    /** @type {string[]} */
    const problems = [];
    for (const t of names) {
      const r = await req(srv.url, `/v1/t/${t}/maps`, { headers: { accept: 'application/json' } });
      if (r.status !== 200 || r.json().length !== 1) problems.push(`${t}: ${r.status}`);
      await sleep(40);
      srv.sweep();
    }
    assert.deepEqual(problems, []);
    // A closed tenant opens again and still has its map.
    const again = await req(srv.url, '/v1/t/t0/maps', { headers: { accept: 'application/json' } });
    assert.equal(again.status, 200);
    assert.equal(again.json()[0].id, 'm1');
  } finally { await srv.close(); }
});

test('--max-stores: when every slot is busy (an open stream), a new tenant gets 503 with Retry-After', async () => {
  const home = tempHome();
  for (const t of ['ta', 'tb']) await seed(home, t, 'm1');
  const srv = await start({ home, idleMs: 20, maxStores: 2, pingMs: 1000 });
  try {
    // default is open from the start; ta takes the second slot and keeps a stream on it.
    const s = openStream(srv.url, '/v1/t/ta/maps/m1/events?from=99999', {});
    await opened(s);
    assert.equal(s.t.status, 200);
    // default is idle: swept, its slot is free for tb.
    await sleep(40); srv.sweep();
    assert.equal((await req(srv.url, '/v1/t/tb/maps', { headers: { accept: 'application/json' } })).status, 200);
    // Now tb is fresh (not idle) and ta has a stream: no slot for default.
    const full = await req(srv.url, '/v1/t/default/maps', { headers: { accept: 'application/json' } });
    assert.equal(full.status, 503);
    assert.equal(full.headers['retry-after'], '30');
    // The stream on ta is untouched by any sweep.
    await sleep(40); srv.sweep();
    await sleep(40);
    assert.equal(s.t.ended, false, 'the busy store was not closed');
    s.close();
  } finally { await srv.close(); }
});

test('status: other tokens\' sources are shown only to an admin; a token sees its own', async () => {
  const home = tempHome();
  const f = tokensPath(home);
  const sec = {
    a: createToken(f, { name: 'a', scopes: ['read'], sources: ['secret-hr'] }).token,
    b: createToken(f, { name: 'b', scopes: ['read'] }).token,
    boss: createToken(f, { name: 'boss', scopes: ['admin'] }).token,
  };
  const srv = await start({ home, tokensFile: f });
  try {
    const rowsAs = async (/** @type {string} */ t) => (await req(srv.url, '/v1/t/default/status', { headers: { authorization: `Bearer ${t}` } })).json().tokens;
    assert.equal((await rowsAs(sec.b)).find((/** @type {any} */ r) => r.name === 'a').sources, undefined);
    assert.deepEqual((await rowsAs(sec.a)).find((/** @type {any} */ r) => r.name === 'a').sources, ['secret-hr']);
    assert.deepEqual((await rowsAs(sec.boss)).find((/** @type {any} */ r) => r.name === 'a').sources, ['secret-hr']);
  } finally { await srv.close(); }
});

test('status: the admin-only fields follow the policy\'s answer for "admin"', async () => {
  const home = tempHome();
  const f = tokensPath(home);
  const boss = createToken(f, { name: 'boss', scopes: ['admin'] }).token;
  /** @type {string[]} */
  const asked = [];
  const policy = { name: 'no-admin', can: (/** @type {any} */ p, /** @type {any} */ a, /** @type {any} */ c) => { asked.push(a); return a !== 'admin' && defaultPolicy.can(p, a, c); } };
  const srv = await start({ home, tokensFile: f, config: { policy }, configPath: '/etc/onto.config.js' });
  try {
    const j = (await req(srv.url, '/v1/t/default/status', { headers: { authorization: `Bearer ${boss}` } })).json();
    assert.ok(asked.includes('admin'), 'the policy was asked about admin');
    assert.equal('home' in j, false);
    assert.equal('config' in j, false);
    // Another tenant's status is the admin's only: refused when the policy says no.
    assert.equal((await req(srv.url, '/v1/t/acme/status', { headers: { authorization: `Bearer ${boss}` } })).status, 404);
  } finally { await srv.close(); }
});
