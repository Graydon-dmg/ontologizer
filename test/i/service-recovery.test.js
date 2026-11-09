// @ts-check
// Recovery and hardening in service mode: ghost tenants open nothing, a failed store answers 503 without
// crashing the server, an async policy is honoured in streams, a queued private build survives a restart
// as private, a chat stops before the next chunk, and a private source's error text never reaches the log.
// Every check is a function that returns a list of problems; a planted fault proves it can fail.
// Postgres parts run only when ONTOLOGIZER_PG_URL is set.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
process.env.ONTOLOGIZER_STUB_SPEED = '1000';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startService } from '../../src/server/service.js';
import { defaultPolicy } from '../../src/server/policy.js';
import { createToken, tokensPath, readTokens, writeTokens } from '../../src/server/tokens.js';
import { createSources } from '../../src/server/sources.js';
import { openStore } from '../../src/core/store.js';
import { postgresStorePort, openPostgresStore } from '../../src/store-postgres/index.js';
import { req, stubEngine, tempHome, fixtureEvents } from './helpers-service.js';

const PG_URL = process.env.ONTOLOGIZER_PG_URL;
const pgOpts = PG_URL ? {} : { skip: 'ONTOLOGIZER_PG_URL is not set' };
const T = '/v1/t/default';
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => crypto.randomBytes(4).toString('hex');
const BRIEF = () => fixtureEvents('plastic-modeling').find((e) => e.t === 'ontology.created').brief;
/** @param {string} token @param {Record<string, string>} [extra] */
const auth = (token, extra = {}) => ({ authorization: `Bearer ${token}`, accept: 'application/json', ...extra });
const quickEngine = (/** @type {any} */ x) => ({ ...stubEngine(x), async *ask() { yield { type: 'done' }; } });

/** @param {() => any} cond @param {number} [ms] */
async function waitFor(cond, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (cond()) return true; await sleep(15); }
  return Boolean(cond());
}

const SOURCES = [
  { name: 'wiki', url: 'https://wiki.example/mcp', visibility: 'private', allowTools: ['search'] },
  { name: 'docs', url: 'https://docs.example/mcp', visibility: 'public', allowTools: ['search'] },
];

/**
 * A service. `tokens` maps a name to a token spec; none means open mode (loopback).
 * @param {{ home?: string, tokens?: Record<string, any>, config?: any, makeEngine?: any, maxBuilds?: number }} [o]
 */
async function start({ home = tempHome(), tokens, config, makeEngine, maxBuilds = 2, maxStores } = {}) {
  /** @type {Record<string, string>} */
  const secrets = {};
  const f = tokensPath(home);
  for (const [name, spec] of Object.entries(tokens ?? {})) secrets[name] = createToken(f, { name, ...spec }).token;
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, maxBuilds, pingMs: 100, version: 'test', ...(maxStores ? { maxStores } : {}),
    tokensFile: tokens ? f : null,
    makeEngine: makeEngine ?? (async (/** @type {any} */ x) => quickEngine(x)),
    ...(config ? { config, configPath: '/etc/onto/ontologizer.config.js' } : {}),
  });
  return { home, srv, secrets, url: srv.url.replace(/\/$/, '') };
}

/** An open event stream. @param {string} url @param {string} p @param {Record<string, string>} headers */
function openStream(url, p, headers) {
  const u = new URL(url);
  /** @type {{ status: number, events: any[], ended: boolean }} */
  const t = { status: 0, events: [], ended: false };
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
    res.on('end', () => { t.ended = true; });
  });
  r.on('error', () => { t.ended = true; });
  return { t, close: () => r.destroy() };
}

// ---------- N1. ghost tenants ----------

/** What a ghost probe must show: no store opened, no stores held, the default tenant answering. @param {{ probes: number, factoryCalls: number, statuses: number[], defaultStatus: number }} r */
function ghostProblems(r) {
  const p = [];
  if (r.factoryCalls > 0) p.push(`${r.factoryCalls} store(s) were opened for ${r.probes} made-up tenants`);
  const bad = r.statuses.filter((s) => s >= 500);
  if (bad.length) p.push(`${bad.length} probe(s) answered ${bad[0]}`);
  if (r.defaultStatus !== 200) p.push(`the default tenant answered ${r.defaultStatus}`);
  return p;
}

test('N1: 110 ghost tenants (status, no exists hook) open no store; the default tenant still answers', async () => {
  // Planted fault: the old probe result, one store opened per made-up tenant.
  assert.ok(ghostProblems({ probes: 110, factoryCalls: 110, statuses: [], defaultStatus: 200 }).length === 1);
  assert.ok(ghostProblems({ probes: 110, factoryCalls: 0, statuses: [200, 503], defaultStatus: 503 }).length === 2);

  const other = tempHome();
  let calls = 0;
  const factory = (/** @type {string} */ tenant) => { calls++; return openStore(other, { tenant }); };
  const { srv, secrets, url } = await start({ tokens: { boss: { scopes: ['admin'] } }, config: { store: factory } });
  try {
    const statuses = [];
    for (let i = 0; i < 110; i++) statuses.push((await req(url, `/v1/t/ghost-${i}-${rnd()}/status`, { headers: auth(secrets.boss) })).status);
    const factoryCalls = calls;
    assert.equal(srv.stats().handlers, 0);
    const d = await req(url, `${T}/status`, { headers: auth(secrets.boss) });
    assert.deepEqual(ghostProblems({ probes: 110, factoryCalls, statuses, defaultStatus: d.status }), []);
  } finally { await srv.close(); }
});

test('N1: with an exists hook that says no, map routes for an unknown tenant never call the factory', async () => {
  const other = tempHome();
  let calls = 0; let asked = 0;
  const factory = /** @type {any} */ ((/** @type {string} */ tenant) => { calls++; return openStore(other, { tenant }); });
  factory.exists = async () => { asked++; return false; };
  const { srv, url } = await start({ config: { store: factory } });
  try {
    const routes = ['maps', 'maps/nope/snapshot', 'maps/nope/events', 'maps/nope/wait?timeout=100'];
    for (const r of routes) {
      const res = await req(url, `/v1/t/ghost-${rnd()}/${r}`, { headers: { accept: 'application/json' } });
      assert.ok(res.status < 500, `${r} answered ${res.status}`);
    }
    assert.equal(calls, 0, 'the factory was never called');
    assert.ok(asked >= 1, 'the exists hook was asked');
  } finally { await srv.close(); }
});

test('N1: maxStores 2 refuses a third tenant with 503 and opens nothing for it', async () => {
  const other = tempHome();
  const opened = [];
  const factory = (/** @type {string} */ tenant) => { opened.push(tenant); return openStore(other, { tenant }); };
  const { srv, url } = await start({ config: { store: factory }, maxStores: 2 });
  try {
    const h = { accept: 'application/json' };
    assert.equal((await req(url, '/v1/t/ta/maps', { headers: h })).status, 200);
    assert.equal((await req(url, '/v1/t/tb/maps', { headers: h })).status, 200);
    const before = opened.length;
    assert.equal((await req(url, '/v1/t/tc/maps', { headers: h })).status, 503);
    assert.equal(opened.length, before, 'no store was opened for the third tenant');
    assert.equal((await req(url, '/v1/t/ta/maps', { headers: h })).status, 200, 'an open tenant still answers');
  } finally { await srv.close(); }
});

test('N1: a store whose ready rejects is 503, not kept, and the next request opens a fresh one', async () => {
  const other = tempHome();
  let calls = 0;
  const factory = (/** @type {string} */ tenant) => {
    calls++;
    const real = openStore(other, { tenant });
    if (calls > 1) return real;
    const ready = Promise.reject(new Error('cannot load'));
    ready.catch(() => {});
    return new Proxy(real, { get(t, k) { if (k === 'ready') return ready; const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v; } });
  };
  const { srv, url } = await start({ config: { store: factory } });
  try {
    const h = { accept: 'application/json' };
    assert.equal((await req(url, '/v1/t/ta/maps', { headers: h })).status, 503);
    assert.equal(calls, 1);
    assert.equal((await req(url, '/v1/t/ta/maps', { headers: h })).status, 200);
    assert.equal(calls, 2, 'the failed store was not cached');
    assert.equal((await req(url, '/v1/t/ta/maps', { headers: h })).status, 200);
    assert.equal(calls, 2, 'the good one is');
  } finally { await srv.close(); }
});

test('N1 (Postgres): 110 ghost tenants add at most 4 connections', pgOpts, async () => {
  const pg = await import('pg');
  const admin = new pg.default.Pool({ connectionString: PG_URL, max: 2 });
  const conns = async () => Number((await admin.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = 'postgres'")).rows[0].n);
  const { srv, secrets, url } = await start({ tokens: { boss: { scopes: ['admin'] } }, config: { store: postgresStorePort({ url: /** @type {string} */ (PG_URL), root: fs.mkdtempSync(path.join(os.tmpdir(), 'onto-rec-pg-')) }) } });
  try {
    const before = await conns();
    const statuses = [];
    for (let i = 0; i < 110; i++) statuses.push((await req(url, `/v1/t/g${rnd()}${i}/status`, { headers: auth(secrets.boss) })).status);
    const after = await conns();
    const extra = after - before;
    // Planted fault: one connection per ghost.
    assert.ok(110 > 4);
    assert.ok(statuses.every((s) => s < 500), `a probe answered ${statuses.find((s) => s >= 500)}`);
    assert.ok(extra <= 4, `${extra} more Postgres connections after 110 ghosts`);
  } finally { await srv.close(); await admin.end(); }
});

// ---------- N2. a failed store ----------

/** @param {{ failedStatus: number, readStatus: number, ready: number, otherStatus: number, up: boolean, crashed: boolean }} r */
function failedStoreProblems(r) {
  const p = [];
  if (r.crashed) p.push('the process saw an uncaught exception');
  if (r.failedStatus !== 503) p.push(`the failed tenant's list answered ${r.failedStatus}`);
  if (r.readStatus !== 503) p.push(`the failed tenant's map read answered ${r.readStatus}`);
  if (r.ready !== 503) p.push(`/v1/health/ready answered ${r.ready}`);
  if (r.otherStatus !== 200) p.push(`another tenant answered ${r.otherStatus}`);
  if (!r.up) p.push('the server is down');
  return p;
}

test('N2: a store with failed set answers 503 (reads too), health is not ready, another tenant and the server are fine', async () => {
  // Planted fault: the crash / the failed tenant still answering 200.
  assert.equal(failedStoreProblems({ failedStatus: 200, readStatus: 200, ready: 200, otherStatus: 200, up: true, crashed: true }).length, 4);
  assert.deepEqual(failedStoreProblems({ failedStatus: 503, readStatus: 503, ready: 503, otherStatus: 200, up: true, crashed: false }), []);

  const other = tempHome();
  /** @type {{ failed: any }} */
  const ctl = { failed: undefined };
  const factory = (/** @type {string} */ tenant) => {
    const real = openStore(other, { tenant });
    if (tenant === 'ta') real.importEvents('m1', fixtureEvents('plastic-modeling'));
    const over = { get failed() { return tenant === 'ta' ? ctl.failed : undefined; } };
    return new Proxy(real, { get(t, k) { if (k === 'failed') return over.failed; const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v; } });
  };
  const { srv, url } = await start({ config: { store: factory } });
  const crashed = [];
  const spy = (/** @type {any} */ e) => crashed.push(e);
  process.on('uncaughtException', spy);
  try {
    const h = { accept: 'application/json' };
    assert.equal((await req(url, '/v1/t/ta/maps', { headers: h })).status, 200);
    assert.equal((await req(url, '/v1/t/tb/maps', { headers: h })).status, 200);
    assert.equal((await req(url, '/v1/health/ready')).status, 200);
    ctl.failed = new Error('write failed');
    const r = {
      failedStatus: (await req(url, '/v1/t/ta/maps', { headers: h })).status,
      readStatus: (await req(url, '/v1/t/ta/maps/m1/snapshot', { headers: h })).status,
      ready: (await req(url, '/v1/health/ready')).status,
      otherStatus: (await req(url, '/v1/t/tb/maps', { headers: h })).status,
      up: (await req(url, '/v1/health/live')).status === 200,
      crashed: crashed.length > 0,
    };
    assert.deepEqual(failedStoreProblems(r), []);
  } finally { process.off('uncaughtException', spy); ctl.failed = undefined; await srv.close(); }
});

test('N2 (Postgres): terminating the lock backend fails the tenant (503) without a crash; another tenant keeps serving', pgOpts, async () => {
  const pg = await import('pg');
  const admin = new pg.default.Pool({ connectionString: PG_URL, max: 2 });
  const ta = `t${rnd()}`; const tb = `t${rnd()}`;
  const pgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-rec-pg-'));
  const { srv, url } = await start({ config: { store: (/** @type {string} */ tenant) => openPostgresStore({ url: /** @type {string} */ (PG_URL), tenant, root: path.join(pgRoot, tenant) }) } });
  const crashed = [];
  const spy = (/** @type {any} */ e) => crashed.push(e);
  process.on('uncaughtException', spy);
  try {
    const h = { accept: 'application/json' };
    assert.equal((await req(url, `/v1/t/${ta}/maps`, { headers: h })).status, 200);
    assert.equal((await req(url, `/v1/t/${tb}/maps`, { headers: h })).status, 200);
    // The lock key is hashtext(...) widened to bigint: a negative hash sets the high 32 bits (classid),
    // so match only the low 32 bits (objid).
    const lock = await admin.query(
      "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 1 AND objid::bigint = (hashtext('ontologizer:' || $1)::bigint & 4294967295)", [ta]);
    assert.equal(lock.rows.length, 1, 'found the lock backend');
    await admin.query('SELECT pg_terminate_backend($1)', [lock.rows[0].pid]);
    let st = 0;
    assert.ok(await waitFor(() => { req(url, `/v1/t/${ta}/maps`, { headers: h }).then((x) => { st = x.status; }); return st === 503; }, 4000), 'the tenant answers 503');
    await sleep(100);
    const r = {
      failedStatus: (await req(url, `/v1/t/${ta}/maps`, { headers: h })).status,
      readStatus: (await req(url, `/v1/t/${ta}/maps/none/snapshot`, { headers: h })).status,
      ready: (await req(url, '/v1/health/ready')).status,
      otherStatus: (await req(url, `/v1/t/${tb}/maps`, { headers: h })).status,
      up: (await req(url, '/v1/health/live')).status === 200,
      crashed: crashed.length > 0,
    };
    assert.deepEqual(failedStoreProblems(r), []);
  } finally {
    process.off('uncaughtException', spy);
    await srv.close();
    for (const t of [ta, tb]) {
      await admin.query('DELETE FROM ontologizer_events WHERE tenant = $1', [t]).catch(() => {});
      await admin.query('DELETE FROM ontologizer_maps WHERE tenant = $1', [t]).catch(() => {});
    }
    await admin.end();
  }
});

// ---------- N3. an async policy in streams ----------

/** @param {string} who @param {{ events: any[], ended: boolean }} t @param {number} total @param {string[]} tail ids/types expected after the replay */
function seesAllProblems(who, t, total, tail) {
  const p = [];
  const got = t.events.slice(total).map((e) => e.t === 'node.added' ? e.node.id : e.t);
  if (JSON.stringify(got) !== JSON.stringify(tail)) p.push(`${who} got [${got.join(', ')}] after the replay, wanted [${tail.join(', ')}]`);
  if (t.ended) p.push(`${who}'s stream ended`);
  return p;
}
/** @param {{ events: any[], ended: boolean }} t @param {number} total */
function cutProblems(t, total) {
  const p = [];
  if (!t.ended) p.push('the reader\'s stream is still open');
  if (t.events.length > total) p.push(`the reader received ${t.events.length - total} event(s) after the raise`);
  return p;
}

test('N3: with an async policy, team and boss see the raise and every event after it in order; the reader is cut', async () => {
  // Planted fault: the old behaviour, team and boss cut at the raise.
  const total = fixtureEvents('plastic-modeling').length;
  const tail = ['visibility.raised', 'plastic-modeling/a1', 'plastic-modeling/a2', 'plastic-modeling/a3'];
  assert.equal(seesAllProblems('team', { ended: true, events: new Array(total).fill({ t: 'x' }) }, total, tail).length, 2);
  assert.ok(cutProblems({ ended: false, events: new Array(total + 2).fill({}) }, total).length === 2);

  const defaultCan = defaultPolicy.can;
  const policy = { name: 'async', can: async (/** @type {any} */ p, /** @type {any} */ a, /** @type {any} */ c) => { await sleep(5); return defaultCan(p, a, c); } };
  const home = tempHome();
  const real = openStore(home);
  real.importEvents('open-map', fixtureEvents('plastic-modeling'));
  const { srv, secrets, url } = await start({
    home, config: { sources: SOURCES, policy, store: () => real },
    tokens: {
      reader: { scopes: ['read', 'ask', 'build'] },
      team: { scopes: ['read', 'ask', 'build'], sources: ['wiki'] },
      boss: { scopes: ['admin'] },
    },
  });
  /** @type {Array<() => void>} */ const closers = [];
  try {
    const mk = (/** @type {string} */ who) => { const s = openStream(url, `${T}/maps/open-map/events`, auth(secrets[who])); closers.push(s.close); return s.t; };
    const reader = mk('reader'); const team = mk('team'); const boss = mk('boss');
    assert.ok(await waitFor(() => reader.events.length >= total && team.events.length >= total && boss.events.length >= total), 'all replayed the public map');
    const base = fixtureEvents('plastic-modeling').find((e) => e.t === 'node.added' && e.node.parent);
    real.append('open-map', { t: 'visibility.raised', at: real.now('open-map'), to: 'private', reason: 'source', sources: ['wiki'] });
    for (let i = 1; i <= 3; i++) real.append('open-map', { ...base, at: 9000 + i, node: { ...base.node, id: `plastic-modeling/a${i}`, label: `A${i}`, summary: `a${i}` } });
    assert.ok(await waitFor(() => team.events.length >= total + 4 && boss.events.length >= total + 4), 'team and boss received the raise and the three events');
    assert.ok(await waitFor(() => reader.ended), 'the reader\'s stream ended');
    assert.deepEqual([...seesAllProblems('team', team, total, tail), ...seesAllProblems('boss', boss, total, tail), ...cutProblems(reader, total)], []);
  } finally { closers.forEach((c) => c()); await srv.close(); }
});

// ---------- N4. a queued private build and a restart ----------

/** @param {{ events: string[], failures: number, error: string|undefined, visibility: string, listed: boolean, snapshot: number }} r @param {number} failures */
function restartProblems(r, failures) {
  const p = [];
  if (r.failures !== failures) p.push(`${r.failures} build failure(s) recorded, wanted ${failures}`);
  if (failures && r.error !== 'Interrupted by a restart') p.push(`the failure says ${JSON.stringify(r.error)}`);
  if (r.visibility !== 'private') p.push(`the draft is ${r.visibility}`);
  if (r.listed) p.push('the reader lists the draft');
  if (r.snapshot !== 404) p.push(`the reader's snapshot answered ${r.snapshot}`);
  return p;
}

/** The events a queued private build leaves on disk straight after the 202. @param {string[]} types @param {any} second */
function onDiskProblems(types, second) {
  const p = [];
  if (JSON.stringify(types) !== JSON.stringify(['ontology.created', 'visibility.raised'])) p.push(`events on disk: [${types.join(', ')}]`);
  else if (second?.reason !== 'sources-picked') p.push(`the raise says ${second?.reason}`);
  return p;
}

test('N4: a queued private build is private on disk before the 202 and after every restart, with one "Interrupted" failure', async () => {
  // Planted fault: the old behaviour, a queued draft with no events, public, and listed for the reader.
  assert.equal(restartProblems({ events: [], failures: 0, error: undefined, visibility: 'public', listed: true, snapshot: 200 }, 1).length, 5);
  assert.equal(onDiskProblems([], undefined).length, 1);

  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((r) => { release = () => r(undefined); });
  const eng = async (/** @type {any} */ x) => {
    const e = quickEngine(x);
    return { ...e, async build(/** @type {any} */ brief, /** @type {any} */ o) { if (brief.hold) await gate; return e.build(brief, o); } };
  };
  const tokens = { reader: { scopes: ['read', 'ask', 'build'] }, team: { scopes: ['read', 'ask', 'build'], sources: ['wiki'] }, boss: { scopes: ['admin'] } };
  const { srv, home, secrets, url } = await start({ tokens, makeEngine: eng, maxBuilds: 1, config: { sources: SOURCES } });
  const snap = tempHome();
  try {
    const first = await req(url, `${T}/maps`, { method: 'POST', headers: auth(secrets.reader), body: { brief: { ...BRIEF(), hold: true }, sources: [] } });
    assert.equal(first.status, 202);
    assert.ok(await waitFor(() => srv.stats().engines >= 1));
    const mine = await req(url, `${T}/maps`, { method: 'POST', headers: auth(secrets.team), body: { brief: BRIEF(), sources: ['wiki'], name: 'project-x' } });
    assert.equal(mine.status, 202);
    const id = mine.json().id;
    // Simulate a kill: take what is on disk right now.
    fs.cpSync(home, snap, { recursive: true });
    const onDisk = openStore(snap);
    const evs = []; for await (const e of onDisk.events(id)) evs.push(e);
    assert.deepEqual(onDiskProblems(evs.map((e) => e.t), evs[1]), []);
    const rows = (await req(url, `${T}/maps`, { headers: auth(secrets.reader) })).json();
    assert.ok(!rows.some((/** @type {any} */ r) => r.id === id), 'the reader cannot list it while queued');
    assert.equal((await req(url, `${T}/maps/${id}/snapshot`, { headers: auth(secrets.reader) })).status, 404);

    const readerTok = secrets.reader;
    const restart = async (/** @type {number} */ failures) => {
      const s2 = await startWithTokens(snap);
      let list; let snapStatus;
      try {
        list = (await req(s2.url, `${T}/maps`, { headers: auth(readerTok) })).json();
        snapStatus = (await req(s2.url, `${T}/maps/${id}/snapshot`, { headers: auth(readerTok) })).status;
      } finally { await s2.srv.close(); }
      return { o: openStoreView(snap, id), list, snapStatus, failures };
    };
    for (const [n, failures] of [[1, 1], [2, 1]]) {
      const x = await restart(failures);
      const fails = Object.values(x.o.jobs).filter((j) => j && j.kind === 'build' && j.state === 'failed');
      assert.deepEqual(restartProblems({
        events: [], failures: fails.length, error: /** @type {any} */ (fails[0])?.error, visibility: x.o.visibility ?? 'public',
        listed: x.list.some((/** @type {any} */ r) => r.id === id), snapshot: x.snapStatus,
      }, x.failures), [], `after restart ${n}`);
    }
  } finally { release(); await srv.close(); }
});

/** A service over a home with its tokens file as is. @param {string} home */
async function startWithTokens(home) {
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, maxBuilds: 1, pingMs: 100, version: 'test', tokensFile: tokensPath(home),
    makeEngine: async (/** @type {any} */ x) => quickEngine(x), config: { sources: SOURCES }, configPath: '/etc/onto/ontologizer.config.js',
  });
  return { srv, url: srv.url.replace(/\/$/, '') };
}

/** The folded map, read from a closed home. @param {string} home @param {string} id */
function openStoreView(home, id) {
  const s = openStore(home);
  try { return /** @type {any} */ (s.read(id)); } finally { try { s.close?.(); } catch { /* read only */ } }
}

// ---------- N5. a chat cut before the next chunk ----------

/** @param {{ deltasAfter: number, endedAfterMs: number|null }} r */
function chatCutProblems(r) {
  const p = [];
  if (r.deltasAfter > 1) p.push(`${r.deltasAfter} delta(s) were sent after the rewrite`);
  if (r.endedAfterMs === null || r.endedAfterMs > 1000) p.push(`the answer ended ${r.endedAfterMs ?? 'never'} ms after the rewrite`);
  return p;
}

test('N5: a chat answer stops before the next chunk when the asker\'s sources are rewritten', async () => {
  // Planted fault: the old 1 s timer, many deltas after the rewrite and a late end.
  assert.equal(chatCutProblems({ deltasAfter: 40, endedAfterMs: 1100 }).length, 2);
  assert.deepEqual(chatCutProblems({ deltasAfter: 1, endedAfterMs: 30 }), []);

  const slow = async (/** @type {any} */ x) => ({
    ...stubEngine(x),
    async *ask(/** @type {any} */ _i, /** @type {any} */ o) {
      for (let i = 0; i < 150; i++) { await sleep(20); if (o?.signal?.aborted) return; yield { type: 'text', text: 'x' }; }
      yield { type: 'done' };
    },
  });
  const ev = fixtureEvents('plastic-modeling');
  ev.splice(1, 0, { t: 'visibility.raised', at: 0, to: 'private', reason: 'source', sources: ['wiki'] });
  const home = tempHome();
  const real = openStore(home);
  real.importEvents('secret-map', ev);
  const { srv, secrets, url } = await start({
    home, makeEngine: slow, config: { sources: SOURCES, store: () => real },
    tokens: { team: { scopes: ['read', 'ask', 'build'], sources: ['wiki'] } },
  });
  try {
    const u = new URL(url);
    let deltas = 0; let closedAt = 0;
    const r = http.request({ host: u.hostname, port: u.port, path: `${T}/maps/secret-map/chat`, method: 'POST', headers: { ...auth(secrets.team), 'content-type': 'application/json' } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => { deltas += (String(c).match(/"type":"text"/g) ?? []).length; });
      res.on('close', () => { closedAt = closedAt || Date.now(); });
      res.on('error', () => { closedAt = closedAt || Date.now(); });
    });
    r.on('error', () => { closedAt = closedAt || Date.now(); });
    r.end(JSON.stringify({ text: 'what are the terms?' }));
    assert.ok(await waitFor(() => deltas >= 3), 'the answer started');
    const f = tokensPath(home);
    const at = Date.now(); const before = deltas;
    writeTokens(f, readTokens(f).map((x) => (x.name === 'team' ? { ...x, sources: ['docs'] } : x)));
    assert.ok(await waitFor(() => closedAt > 0, 3000), 'the answer ended');
    assert.deepEqual(chatCutProblems({ deltasAfter: deltas - before, endedAfterMs: closedAt ? closedAt - at : null }), []);
  } finally { await srv.close(); }
});

// ---------- N7. private error text never reaches the log ----------

/** @param {string[]} lines */
function logProblems(lines) {
  const p = [];
  for (const l of lines) if (l.includes('SECRET')) p.push(`log line carries SECRET: ${l}`);
  if (!lines.some((l) => l.includes('wiki'))) p.push('no log line names the source wiki');
  return p;
}

test('N7: a private source\'s error text never reaches the log; a public source\'s still does', async () => {
  // Planted fault: a log line with the private error text.
  assert.equal(logProblems(['source wiki call failed: SECRET-BRAVO payroll']).length, 1);
  assert.deepEqual(logProblems(['source wiki call failed: Error']), []);

  const flags = { listBoom: false };
  const connect = async () => ({
    async listTools() {
      if (flags.listBoom) throw new Error('SECRET-CHARLIE tools');
      return { tools: [{ name: 'search', description: 'd', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] };
    },
    async callTool() { throw new Error('SECRET-BRAVO payroll'); },
    async close() {},
  });
  const principal = { name: 'team', scopes: ['read'], sources: ['wiki', 'docs'] };
  /** @type {string[]} */ const lines = [];
  const mkConnect = (/** @type {string} */ msg) => async (/** @type {any} */ e) => {
    const c = await connect();
    return e.name === 'docs' ? { ...c, async callTool() { throw new Error(msg); } } : c;
  };
  const sources = createSources(SOURCES, { connect: mkConnect('PUBLIC-OOPS visible'), log: (l) => lines.push(l) });
  try {
    const ts = /** @type {any} */ (await sources.toolset(principal, ['wiki', 'docs']));
    assert.ok(ts, 'the toolset was built');
    const priv = await ts.call('wiki__search', { q: 'x' });
    assert.ok(!JSON.stringify(priv).includes('SECRET'), 'the result carries no SECRET');
    const pub = await ts.call('docs__search', { q: 'x' });
    assert.match(pub.text, /PUBLIC-OOPS visible/);
    assert.ok(lines.some((l) => l.includes('wiki') && l.includes('Error')), 'the call failure names wiki and a kind');
    assert.ok(lines.some((l) => l.includes('docs') && l.includes('PUBLIC-OOPS')) || pub.text.includes('PUBLIC-OOPS'), 'the public error is reported with its message');
    // A toolset build whose listTools throws.
    const lines2 = [];
    flags.listBoom = true;
    const s2 = createSources(SOURCES, { connect: mkConnect('x'), log: (l) => lines2.push(l) });
    const built = await s2.toolset(principal, ['wiki']);
    assert.equal(built, null);
    assert.ok(lines2.some((l) => l.includes('wiki') && l.includes('Error')), 'the build log names wiki and a kind');
    assert.deepEqual(logProblems([...lines, ...lines2]), []);
    await s2.close();
  } finally { await sources.close(); }
});
