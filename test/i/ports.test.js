// @ts-check
// Epic I2: the identity, policy, store and model ports, and what status says about them.
// Every check is a function that returns a list of problems; a planted fault proves it can fail.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
process.env.ONTOLOGIZER_STUB_SPEED = '1000';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startService } from '../../src/server/service.js';
import { createToken, tokensPath } from '../../src/server/tokens.js';
import { createSources } from '../../src/server/sources.js';
import { openStore } from '../../src/core/store.js';
import { openPostgresStore } from '../../src/store-postgres/index.js';
import { buildStubServer } from './fixtures/stub-mcp.js';
import { req, stubEngine, tempHome, fixtureEvents } from './helpers-service.js';

const T = '/v1/t/default';
const BRIEF = () => fixtureEvents('plastic-modeling').find((e) => e.t === 'ontology.created').brief;

/**
 * Start a service directly. `tokens` rows are created in the home. @param {{ home?: string, host?: string, config?: any,
 *   tokens?: Array<{ name: string, scopes: string[], sources?: string[] }>, makeEngine?: any, configPath?: string, sources?: any }} [o]
 */
async function start({ home = tempHome(), host = '127.0.0.1', config = null, tokens = [], makeEngine, configPath, sources } = {}) {
  /** @type {Record<string, string>} */
  const secrets = {};
  for (const t of tokens) secrets[t.name] = createToken(tokensPath(home), t).token;
  const srv = await startService({
    home, host, port: 0, tokensFile: tokens.length ? tokensPath(home) : null,
    makeEngine: makeEngine ?? (async (/** @type {any} */ x) => stubEngine(x)), version: 'test',
    config, configPath: configPath ?? null, sources: sources ?? null,
  });
  return { home, srv, secrets };
}

/** @param {string} token */
const bearer = (token) => ({ authorization: `Bearer ${token}`, accept: 'application/json' });

/** @param {string} home @param {string} id */
async function readEvents(home, id) {
  const out = [];
  for await (const e of openStore(home).events(id)) out.push(e);
  return out;
}

// ---- 1. identity ----

/** The one malformed principal per `x-case`; a good one with `x-user`. */
const headerId = {
  name: 'header-id',
  authenticate: (/** @type {any} */ r) => {
    const c = r.headers['x-case'];
    if (c === 'noactor') return { tenant: 'default', scopes: ['read'], sources: [] };
    if (c === 'root') return { actor: { id: 'user:evil', kind: 'human' }, tenant: 'default', scopes: ['root'], sources: [] };
    if (c === 'kind') return { actor: { id: 'user:evil', kind: 'robot' }, tenant: 'default', scopes: ['read'], sources: [] };
    if (c === 'tenant') return { actor: { id: 'user:evil', kind: 'human' }, tenant: '../x', scopes: ['read'], sources: [] };
    if (c === 'throw') throw new Error('directory down');
    return r.headers['x-user']
      ? { actor: { id: 'user:' + r.headers['x-user'], kind: 'human' }, tenant: 'default', scopes: ['read', 'build'], sources: [] }
      : null;
  },
};

/** A malformed or failed principal must be refused (401), never trusted. @param {string} label @param {number} status */
const trustProblems = (label, status) => (status === 401 ? [] : [`${label}: answered ${status}, a malformed principal was trusted`]);

test('custom identity: 401 without it, 200 with it, no session sign-in, foreign Origin refused', async () => {
  const { srv } = await start({ config: { identity: headerId } });
  try {
    assert.equal((await req(srv.url, `${T}/maps`)).status, 401);
    assert.equal((await req(srv.url, `${T}/maps`, { headers: { 'x-user': 'ann' } })).status, 200);
    assert.equal((await req(srv.url, '/v1/session', { method: 'POST', body: { token: 'x' } })).status, 400);
    assert.match((await req(srv.url, '/v1/session', { method: 'POST', body: { token: 'x' } })).json().error, /identity port/);
    const foreign = await req(srv.url, `${T}/maps/check`, { method: 'POST', headers: { 'x-user': 'ann', origin: 'http://evil.example' }, body: { context: 'x' } });
    assert.equal(foreign.status, 403);
  } finally { await srv.close(); }
});

test('custom identity: a malformed principal is never trusted (planted fault: the check reports a trusting server)', async () => {
  const { srv } = await start({ config: { identity: headerId } });
  try {
    const problems = [];
    for (const c of ['noactor', 'root', 'kind', 'tenant', 'throw']) {
      const r = await req(srv.url, `${T}/maps`, { headers: { 'x-user': 'ann', 'x-case': c } });
      problems.push(...trustProblems(c, r.status));
    }
    assert.deepEqual(problems, []);
  } finally { await srv.close(); }
  assert.ok(trustProblems('noactor', 200).length === 1, 'the check let a trusted malformed principal through');
});

test('custom identity: a build\'s events carry the identity\'s actor', async () => {
  const { home, srv } = await start({ config: { identity: headerId } });
  /** @type {string} */ let id;
  try {
    const h = { 'x-user': 'ann' };
    const made = await req(srv.url, `${T}/maps`, { method: 'POST', headers: h, body: { brief: BRIEF() } });
    assert.equal(made.status, 202);
    id = made.json().id;
    assert.equal((await req(srv.url, `${T}/maps/${id}/wait?timeout=20000`, { headers: h })).json().state, 'idle');
  } finally { await srv.close(); }
  const events = await readEvents(home, id);
  assert.ok(events.length > 1);
  assert.deepEqual(events.filter((e) => JSON.stringify(e.actor) !== JSON.stringify({ id: 'user:ann', kind: 'human' })), []);
});

test('a custom identity may listen beyond loopback with no tokens; without one the server refuses', async () => {
  const { srv } = await start({ host: '0.0.0.0', config: { identity: headerId } });
  await srv.close();
  await assert.rejects(start({ host: '0.0.0.0', config: {} }), /Refusing to listen/); // planted: no identity, no tokens
});

// ---- 2. policy ----

/** A denied request is 403 and never a success. @param {string} label @param {number} status */
const deniedProblems = (label, status) => (status === 403 ? [] : [`${label}: answered ${status}, not 403`]);

test('custom policy: denying ask gives chat 403; a throwing or non-boolean policy denies (planted fault)', async () => {
  const mk = async (/** @type {any} */ can) => {
    const home = tempHome();
    openStore(home).importEvents('m', fixtureEvents('plastic-modeling'));
    return start({ home, config: { policy: { name: 'p', can } }, tokens: [{ name: 'u', scopes: ['admin'] }] });
  };
  {
    const { srv, secrets } = await mk((/** @type {any} */ _p, /** @type {string} */ a) => a !== 'ask');
    try {
      const h = bearer(secrets.u);
      assert.equal((await req(srv.url, `${T}/maps/m/snapshot`, { headers: h })).status, 200);
      assert.deepEqual(deniedProblems('chat', (await req(srv.url, `${T}/maps/m/chat`, { method: 'POST', headers: h, body: { message: 'hi' } })).status), []);
    } finally { await srv.close(); }
  }
  for (const [label, can] of /** @type {Array<[string, any]>} */ ([
    ['throws', () => { throw new Error('boom'); }],
    ['rejects', async () => { throw new Error('boom'); }],
    ['undefined', () => undefined],
    ['truthy string', () => 'yes'],
  ])) {
    const { srv, secrets } = await mk(can);
    try {
      const h = bearer(secrets.u);
      assert.deepEqual(deniedProblems(`${label}: list`, (await req(srv.url, `${T}/maps`, { headers: h })).status), []);
      assert.deepEqual(deniedProblems(`${label}: snapshot`, (await req(srv.url, `${T}/maps/m/snapshot`, { headers: h })).status), []);
    } finally { await srv.close(); }
  }
  assert.equal(deniedProblems('x', 200).length, 1, 'the check let an allowed request through');
});

// ---- 3. store port ----

test('store port: the server lists and serves maps from the config\'s store, and status names it', async () => {
  const other = tempHome();
  openStore(other).importEvents('other-map', fixtureEvents('plastic-modeling'));
  const run = async (/** @type {any} */ store) => {
    const home = tempHome();
    openStore(home).importEvents('home-map', fixtureEvents('plastic-modeling'));
    const { srv, secrets } = await start({ home, config: { store }, tokens: [{ name: 'a', scopes: ['admin'] }] });
    try {
      const h = bearer(secrets.a);
      const rows = (await req(srv.url, `${T}/maps`, { headers: h })).json();
      const snapOther = (await req(srv.url, `${T}/maps/other-map/snapshot`, { headers: h })).status;
      const snapHome = (await req(srv.url, `${T}/maps/home-map/snapshot`, { headers: h })).status;
      const status = (await req(srv.url, `${T}/status`, { headers: h })).json();
      return { ids: rows.map((/** @type {any} */ r) => r.id), snapOther, snapHome, status };
    } finally { await srv.close(); }
  };
  /** @param {{ ids: string[], snapOther: number, snapHome: number }} r */
  const problems = (r) => {
    const p = [];
    if (r.ids.join() !== 'other-map') p.push(`listed ${r.ids.join() || 'nothing'}, not other-map`);
    if (r.snapOther !== 200) p.push(`other-map snapshot ${r.snapOther}`);
    if (r.snapHome !== 404) p.push(`home-map snapshot ${r.snapHome}: the home's own store was used`);
    return p;
  };
  const arrow = await run((/** @type {string} */ tenant) => openStore(other, { tenant }));
  assert.deepEqual(problems(arrow), []);
  assert.equal(arrow.status.store, 'custom');
  assert.equal(arrow.status.ports.store, 'custom');
  const named = await run(function otherFiles(/** @type {string} */ tenant) { return openStore(other, { tenant }); });
  assert.deepEqual(problems(named), []);
  assert.equal(named.status.store, 'otherFiles');
  assert.equal(named.status.ports.store, 'otherFiles');
  // planted fault: a server that ignored the port (served the home) is reported.
  assert.ok(problems({ ids: ['home-map'], snapOther: 404, snapHome: 200 }).length === 3);
});

const PG_URL = process.env.ONTOLOGIZER_PG_URL;

test('store port: a build through a Postgres store lists and serves', { skip: PG_URL ? false : 'ONTOLOGIZER_PG_URL is not set' }, async () => {
  const tenant = `t${crypto.randomBytes(4).toString('hex')}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-ports-pg-'));
  /** @type {any} */ let pgStore = null;
  const { srv, secrets } = await start({
    config: { store: () => (pgStore ??= openPostgresStore({ url: PG_URL, tenant, root })) },
    tokens: [{ name: 'a', scopes: ['admin'] }],
  });
  try {
    const h = bearer(secrets.a);
    const made = await req(srv.url, `${T}/maps`, { method: 'POST', headers: h, body: { brief: BRIEF() } });
    assert.equal(made.status, 202);
    const id = made.json().id;
    assert.equal((await req(srv.url, `${T}/maps/${id}/wait?timeout=20000`, { headers: h })).json().state, 'idle');
    const rows = (await req(srv.url, `${T}/maps`, { headers: h })).json();
    assert.deepEqual(rows.map((/** @type {any} */ r) => r.id), [id]);
    const snap = await req(srv.url, `${T}/maps/${id}/snapshot`, { headers: h });
    assert.equal(snap.status, 200);
    assert.ok(Object.keys(snap.json().nodes).length > 0);
  } finally {
    await srv.close(); // flushes and closes the store
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: PG_URL, max: 1 });
    try {
      await pool.query('DELETE FROM ontologizer_events WHERE tenant = $1', [tenant]);
      await pool.query('DELETE FROM ontologizer_maps WHERE tenant = $1', [tenant]);
    } finally { await pool.end(); }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- 4. model port ----

/** @param {any[]} seen what each makeEngine call got as clientFor @param {any} expected */
function modelProblems(seen, expected) {
  const p = [];
  if (!seen.length) p.push('makeEngine was never called');
  for (const s of seen) if (s !== expected) p.push(`makeEngine got clientFor ${typeof s}, expected ${typeof expected}`);
  return p;
}

test('model port: makeEngine gets the config\'s model as clientFor, and none without one', async () => {
  const run = async (/** @type {any} */ config) => {
    /** @type {any[]} */ const seen = [];
    const { srv } = await start({ config, makeEngine: async (/** @type {any} */ x) => { seen.push(x.clientFor); return stubEngine(x); } });
    try {
      const r = await req(srv.url, `${T}/maps/check`, { method: 'POST', body: { context: 'plastic model kits' } });
      assert.equal(r.status, 200);
    } finally { await srv.close(); }
    return seen;
  };
  const model = () => ({});
  assert.deepEqual(modelProblems(await run({ model }), model), []);
  assert.deepEqual(modelProblems(await run({}), undefined), []);
  assert.deepEqual(modelProblems(await run(null), undefined), []);
  // planted fault: an engine that was handed the default client instead is reported, and so is "never called".
  assert.ok(modelProblems([() => {}], model).length === 1);
  assert.ok(modelProblems([], model).length === 1);
});

// ---- 5. status ----

/** Names only of ports and sources; no paths for non-admins. @param {any} s @param {boolean} admin */
function statusProblems(s, admin) {
  const p = [];
  if (!admin) {
    if ('config' in s) p.push('a non-admin sees config');
    if ('home' in s) p.push('a non-admin sees home');
  }
  return p;
}

test('status: ports, sources and config for an admin; held sources only for others; nothing without a config', async () => {
  const sources = [
    { name: 'wiki', url: 'https://wiki.example/mcp', visibility: 'private', allowTools: ['search'] },
    { name: 'docs', url: 'https://docs.example/mcp', visibility: 'public', allowTools: ['search'] },
    { name: 'down', url: 'https://down.example/mcp', visibility: 'public', allowTools: ['search'] },
  ];
  const connect = async (/** @type {any} */ e) => {
    if (e.name === 'down') throw new Error('refused');
    const [a, b] = InMemoryTransport.createLinkedPair();
    await buildStubServer({ name: e.name }).connect(b);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(a);
    return client;
  };
  const config = { sources };
  const tokens = [
    { name: 'boss', scopes: ['admin'] },
    { name: 'team', scopes: ['read', 'ask', 'build'], sources: ['wiki'] },
    { name: 'reader', scopes: ['read'] },
  ];
  const { srv, secrets } = await start({ config, configPath: '/etc/onto/ontologizer.config.js', tokens, sources: createSources(sources, { connect }) });
  try {
    const st = async (/** @type {string} */ who) => (await req(srv.url, `${T}/status`, { headers: bearer(secrets[who]) })).json();
    const boss = await st('boss');
    assert.deepEqual(boss.ports, { identity: 'tokens', policy: 'default', store: 'files', model: 'default' });
    assert.equal(boss.store, 'files');
    assert.equal(boss.config, '/etc/onto/ontologizer.config.js');
    assert.ok(boss.home);
    assert.deepEqual(boss.sources, [
      { name: 'wiki', visibility: 'private', reachable: true },
      { name: 'docs', visibility: 'public', reachable: true },
      { name: 'down', visibility: 'public', reachable: false },
    ]);
    assert.deepEqual(statusProblems(boss, true), []);

    const team = await st('team');
    assert.deepEqual(team.sources, [{ name: 'wiki', visibility: 'private', reachable: true }]);
    assert.deepEqual(statusProblems(team, false), []);
    assert.deepEqual(team.ports, boss.ports);
    const rows = Object.fromEntries(team.tokens.map((/** @type {any} */ r) => [r.name, r]));
    assert.deepEqual(rows.team.sources, ['wiki']);
    assert.equal('sources' in rows.reader, false);
    assert.equal('sources' in rows.boss, false);

    const reader = await st('reader');
    assert.deepEqual(reader.sources.map((/** @type {any} */ x) => x.name), ['docs', 'down']); // no list: the public ones
    assert.deepEqual(statusProblems(reader, false), []);
    // planted fault: an admin payload shown to a non-admin is reported.
    assert.equal(statusProblems(boss, false).length, 2);
  } finally { await srv.close(); }

  const plain = await start({ tokens: [{ name: 'boss', scopes: ['admin'] }] });
  try {
    const s = (await req(plain.srv.url, `${T}/status`, { headers: bearer(plain.secrets.boss) })).json();
    for (const k of ['ports', 'sources', 'config']) assert.equal(k in s, false, `status has ${k} without a config`);
    assert.equal(s.store, 'files');
    assert.equal(s.auth, 'tokens');
  } finally { await plain.srv.close(); }
});
