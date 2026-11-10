// @ts-check
// Epic I2: the read rule, list filtering, scope-then-read order, sources routes, and the actor on events.
// Every check is a function that returns a list of problems; a planted fault proves it can fail.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
process.env.ONTOLOGIZER_STUB_SPEED = '1000';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startService } from '../../src/server/service.js';
import { createToken, tokensPath } from '../../src/server/tokens.js';
import { createSources } from '../../src/server/sources.js';
import { ACTION_SCOPE } from '../../src/server/policy.js';
import { hasScope } from '../../src/server/tokens.js';
import { openStore } from '../../src/core/store.js';
import { buildStubServer } from './fixtures/stub-mcp.js';
import { boot, req, seed, stubEngine, tempHome, fixtureEvents } from './helpers-service.js';

const SOURCES = [
  { name: 'wiki', url: 'https://wiki.example/mcp', visibility: 'private', allowTools: ['search', 'get'] },
  { name: 'docs', url: 'https://docs.example/mcp', visibility: 'public', allowTools: ['search', 'get'] },
];
const T = '/v1/t/default';

/** An injectable connect serving the stub MCP server in memory (no child process). */
function memConnect() {
  return async (/** @type {any} */ e) => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await buildStubServer({ name: e.name }).connect(b);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(a);
    return client;
  };
}

/** The events of a map with `visibility.raised` for wiki (private), after ontology.created. */
function privateEvents() {
  const ev = fixtureEvents('plastic-modeling');
  ev.splice(1, 0, { t: 'visibility.raised', at: 0, to: 'private', reason: 'source', sources: ['wiki'] });
  return ev;
}

/**
 * A service with the config, three tokens plus a read-only one, a public and a private map.
 * @param {{ config?: any, withConfig?: boolean, tokens?: boolean }} [o]
 */
async function setup({ config, withConfig = true, tokens = true } = {}) {
  const home = tempHome();
  const store = openStore(home);
  store.importEvents('open-map', fixtureEvents('plastic-modeling'));
  store.importEvents('secret-map', privateEvents());
  /** @type {Record<string, string>} */
  const secrets = {};
  if (tokens) {
    const f = tokensPath(home);
    secrets.reader = createToken(f, { name: 'reader', scopes: ['read', 'ask', 'build'] }).token;
    secrets.team = createToken(f, { name: 'team', scopes: ['read', 'ask', 'build'], sources: ['wiki'] }).token;
    secrets.boss = createToken(f, { name: 'boss', scopes: ['admin'] }).token;
    secrets.viewer = createToken(f, { name: 'viewer', scopes: ['read'] }).token;
  }
  const cfg = withConfig ? { sources: SOURCES, ...(config ?? {}) } : null;
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, tokensFile: tokens ? tokensPath(home) : null,
    makeEngine: async (/** @type {any} */ x) => stubEngine(x), version: 'test',
    config: cfg, configPath: cfg ? '/etc/onto/ontologizer.config.js' : null,
    sources: cfg ? createSources(cfg.sources, { connect: memConnect() }) : null,
  });
  return { home, srv, secrets };
}

/** @param {string} token @param {Record<string, string>} [extra] */
const auth = (token, extra = {}) => ({ authorization: `Bearer ${token}`, accept: 'application/json', ...extra });

/** Every status of the secret map's routes for one caller, plus the two lists. @param {string} url @param {string} token */
async function probe(url, token) {
  const h = auth(token);
  const m = `${T}/maps/secret-map`;
  /** @type {Record<string, number>} */
  const statuses = {
    snapshot: (await req(url, `${m}/snapshot`, { headers: h })).status,
    events: (await req(url, `${m}/events`, { headers: h })).status,
    view: (await req(url, `${m}/view`, { headers: h })).status,
    wait: (await req(url, `${m}/wait?timeout=0`, { headers: h })).status,
    actions: (await req(url, `${m}/actions`, { method: 'POST', headers: h, body: { type: 'collapse', nodeId: 'x' } })).status,
    chat: (await req(url, `${m}/chat`, { method: 'POST', headers: h, body: { message: 'hi' } })).status,
    save: (await req(url, `${m}/save`, { method: 'POST', headers: h, body: { name: 'renamed' } })).status,
    'api/snapshot': (await req(url, `${m}/api/snapshot`, { headers: h })).status,
  };
  const listed = (await req(url, `${T}/maps`, { headers: h })).json().map((/** @type {any} */ r) => r.id);
  const picker = (await req(url, `${T}/maps/open-map/api/maps`, { headers: h })).json().map((/** @type {any} */ r) => r.id);
  return { statuses, listed, picker };
}

/**
 * The read rule seen by a principal that must NOT read secret-map: every route 404, absent from both
 * lists. @param {{ statuses: Record<string, number>, listed: string[], picker: string[] }} r
 */
function leakProblems(r) {
  const p = [];
  for (const [route, status] of Object.entries(r.statuses)) if (status !== 404) p.push(`${route} answered ${status}, not 404`);
  if (r.listed.includes('secret-map')) p.push('secret-map is in the maps list');
  if (r.picker.includes('secret-map')) p.push('secret-map is in the fuse picker');
  return p;
}

test('the read rule: a reader gets 404 everywhere on a private map, and does not see it listed', async () => {
  const { srv, secrets } = await setup();
  try {
    const r = await probe(srv.url, secrets.reader);
    assert.deepEqual(leakProblems(r), []);
    assert.deepEqual(r.listed, ['open-map']);
    assert.ok(r.picker.length === 0 || !r.picker.includes('secret-map'));
    const fuse = await req(srv.url, `${T}/maps/open-map/actions`, { method: 'POST', headers: auth(secrets.reader), body: { type: 'fuse', with: 'secret-map' } });
    assert.equal(fuse.status, 400);
    assert.equal(fuse.json().error, 'no map named "secret-map"');
    // The two that may read it: 200 on the snapshot, listed as private; the public map is listed public.
    for (const who of ['team', 'boss']) {
      const snap = await req(srv.url, `${T}/maps/secret-map/snapshot`, { headers: auth(secrets[who]) });
      assert.equal(snap.status, 200, who);
      const rows = (await req(srv.url, `${T}/maps`, { headers: auth(secrets[who]) })).json();
      const byId = Object.fromEntries(rows.map((/** @type {any} */ x) => [x.id, x]));
      assert.equal(byId['secret-map'].visibility, 'private', who);
      assert.equal(byId['open-map'].visibility, 'public', who);
      const picker = (await req(srv.url, `${T}/maps/open-map/api/maps`, { headers: auth(secrets[who]) })).json();
      assert.ok(picker.some((/** @type {any} */ x) => x.id === 'secret-map'), `${who}: fuse picker`);
    }
    // team reaches it with the wiki source it holds, and may act on it (the read rule passes, then the scope).
    const act = await req(srv.url, `${T}/maps/secret-map/actions`, { method: 'POST', headers: auth(secrets.team), body: { type: 'collapse', nodeId: 'x' } });
    assert.equal(act.status, 202);
  } finally { await srv.close(); }
});

test('planted fault: the leak check reports a reader that sees the map', () => {
  const leaked = { statuses: { snapshot: 200, events: 404 }, listed: ['open-map', 'secret-map'], picker: ['secret-map'] };
  const p = leakProblems(leaked);
  assert.ok(p.some((x) => /snapshot answered 200/.test(x)), p.join('; '));
  assert.ok(p.some((x) => /in the maps list/.test(x)) && p.some((x) => /fuse picker/.test(x)), p.join('; '));
});

test('planted fault: a read rule that checks only the scope leaks, and the check catches it', async () => {
  const scopesOnly = {
    name: 'scopes-only',
    can: (/** @type {any} */ p, /** @type {string} */ action) => hasScope(p.scopes, /** @type {any} */ (ACTION_SCOPE)[action]),
  };
  const { srv, secrets } = await setup({ config: { policy: scopesOnly } });
  try {
    const h = auth(secrets.reader);
    const r = {
      statuses: { snapshot: (await req(srv.url, `${T}/maps/secret-map/snapshot`, { headers: h })).status },
      listed: (await req(srv.url, `${T}/maps`, { headers: h })).json().map((/** @type {any} */ x) => x.id),
      picker: (await req(srv.url, `${T}/maps/open-map/api/maps`, { headers: h })).json().map((/** @type {any} */ x) => x.id),
    };
    const p = leakProblems(r);
    assert.ok(p.length >= 3, `the check missed the leak: ${p.join('; ')}`);
    assert.ok(p.some((x) => /snapshot answered 200/.test(x)));
  } finally { await srv.close(); }
});

/** I1's order on a map route: scope 403 before the read rule's 404, a missing map 404. @param {Record<string, number>} s */
function orderProblems(s) {
  const p = [];
  if (s.viewerActions !== 403) p.push(`read-only token's actions on a private map answered ${s.viewerActions}, not 403 (scope first)`);
  if (s.viewerMissing !== 404) p.push(`a missing map answered ${s.viewerMissing}, not 404`);
  if (s.viewerSnapshot !== 404) p.push(`a read-only token's snapshot of a private map answered ${s.viewerSnapshot}, not 404`);
  return p;
}

test('order: scope 403 first, then missing map 404, then the read rule 404', async () => {
  const { srv, secrets } = await setup();
  try {
    const h = auth(secrets.viewer);
    const s = {
      viewerActions: (await req(srv.url, `${T}/maps/secret-map/actions`, { method: 'POST', headers: h, body: { type: 'collapse', nodeId: 'x' } })).status,
      viewerMissing: (await req(srv.url, `${T}/maps/nope/snapshot`, { headers: h })).status,
      viewerSnapshot: (await req(srv.url, `${T}/maps/secret-map/snapshot`, { headers: h })).status,
    };
    assert.deepEqual(orderProblems(s), []);
    // planted fault: a router that applied the read rule before the scope would answer 404 here.
    const wrong = orderProblems({ ...s, viewerActions: 404 });
    assert.ok(wrong.some((x) => /scope first/.test(x)), wrong.join('; '));
  } finally { await srv.close(); }
});

test('no config at all: rows have no visibility key and every I1 behaviour holds', async () => {
  const { srv, secrets } = await setup({ withConfig: false });
  try {
    const rows = (await req(srv.url, `${T}/maps`, { headers: auth(secrets.reader) })).json();
    // Without a config the private event is still in the map's log, but nothing here reads it: both are listed.
    assert.ok(rows.length >= 1);
    for (const r of rows) {
      if (r.id === 'open-map') assert.equal('visibility' in r, false, 'visibility key on a row without a config');
    }
    assert.equal((await req(srv.url, `${T}/maps/open-map/snapshot`, { headers: auth(secrets.reader) })).status, 200);
    assert.equal((await req(srv.url, `${T}/maps/open-map/actions`, { method: 'POST', headers: auth(secrets.reader), body: { type: 'collapse', nodeId: 'x' } })).status, 202);
    assert.equal((await req(srv.url, `${T}/maps/open-map/actions`, { method: 'POST', headers: auth(secrets.viewer), body: { type: 'collapse', nodeId: 'x' } })).status, 403);
    assert.equal((await req(srv.url, `${T}/maps/nope/snapshot`, { headers: auth(secrets.reader) })).status, 404);
    assert.equal((await req(srv.url, `${T}/maps`)).status, 401);
    // planted fault: a default policy that adds a visibility key would be caught by this same test of the rows.
    assert.equal(rows.some((r) => 'visibility' in r), false);
  } finally { await srv.close(); }
});

test('GET sources: each caller sees the sources it holds; New map refuses one it does not', async () => {
  const { srv, secrets } = await setup();
  try {
    const names = async (/** @type {string} */ who) => (await req(srv.url, `${T}/sources`, { headers: auth(secrets[who]) })).json();
    assert.deepEqual(await names('reader'), [{ name: 'docs', visibility: 'public' }]);
    assert.deepEqual(await names('team'), [{ name: 'wiki', visibility: 'private' }]); // an explicit list means only those
    assert.deepEqual((await names('boss')).map((/** @type {any} */ x) => x.name).sort(), ['docs', 'wiki']);
    const brief = fixtureEvents('plastic-modeling').find((e) => e.t === 'ontology.created').brief;
    const no = await req(srv.url, `${T}/maps`, { method: 'POST', headers: auth(secrets.reader), body: { brief, sources: ['wiki'] } });
    assert.equal(no.status, 400);
    assert.match(no.json().error, /wiki/);
    const yes = await req(srv.url, `${T}/maps`, { method: 'POST', headers: auth(secrets.reader), body: { brief, sources: ['docs'] } });
    assert.equal(yes.status, 202);
    const w = await req(srv.url, `${T}/maps/${yes.json().id}/wait?timeout=20000`, { headers: auth(secrets.reader) });
    assert.equal(w.json().state, 'idle');
    // planted fault: a reader's list that shows wiki would fail the first assertion; a picker that took
    // any name would have answered 202 above.
  } finally { await srv.close(); }
});

/**
 * Every event carries the expected actor. @param {any[]} events @param {{ id: string, kind: string }} actor
 */
function actorProblems(events, actor) {
  const p = [];
  if (!events.length) p.push('no events');
  events.forEach((e, i) => {
    if (!e.actor) p.push(`event ${i} (${e.t}) has no actor`);
    else if (JSON.stringify(e.actor) !== JSON.stringify(actor)) p.push(`event ${i} (${e.t}) has actor ${JSON.stringify(e.actor)}`);
  });
  return p;
}

/** @param {string} home @param {string} id */
async function readEvents(home, id) {
  const out = [];
  for await (const e of openStore(home).events(id)) out.push(e);
  return out;
}

test('actor over HTTP: build, view action, research job and save all carry the token actor', async () => {
  const { home, srv, secrets } = await setup();
  const actor = { id: 'token:team', kind: 'service' };
  const h = auth(secrets.team);
  /** @type {string} */ let saved;
  try {
    const brief = fixtureEvents('plastic-modeling').find((e) => e.t === 'ontology.created').brief;
    const made = await req(srv.url, `${T}/maps`, { method: 'POST', headers: h, body: { brief } });
    assert.equal(made.status, 202);
    const id = made.json().id;
    assert.equal((await req(srv.url, `${T}/maps/${id}/wait?timeout=20000`, { headers: h })).json().state, 'idle');
    const node = Object.keys((await req(srv.url, `${T}/maps/${id}/snapshot`, { headers: h })).json().nodes)[0];
    assert.equal((await req(srv.url, `${T}/maps/${id}/actions`, { method: 'POST', headers: h, body: { type: 'collapse', nodeId: node } })).status, 202);
    assert.equal((await req(srv.url, `${T}/maps/${id}/actions`, { method: 'POST', headers: h, body: { type: 'research', nodeId: node, mode: 'general' } })).status, 202);
    assert.equal((await req(srv.url, `${T}/maps/${id}/wait?timeout=20000`, { headers: h })).json().state, 'idle');
    const sv = await req(srv.url, `${T}/maps/${id}/save`, { method: 'POST', headers: h, body: { name: 'team-saved' } });
    assert.equal(sv.status, 200);
    saved = sv.json().id;
  } finally { await srv.close(); }
  const events = await readEvents(home, saved);
  assert.deepEqual(actorProblems(events, actor), []);
  for (const t of ['ontology.created', 'view.changed', 'job.queued', 'job.done', 'ontology.renamed']) {
    assert.ok(events.some((e) => e.t === t), `no ${t} event: the test would not prove it`);
  }
  // planted fault: one event without an actor (and one with the wrong one) are reported.
  const lacking = events.map((e, i) => (i === 3 ? (({ actor: _a, ...rest }) => rest)(e) : e));
  assert.ok(actorProblems(lacking, actor).some((x) => /event 3 .* has no actor/.test(x)));
  const wrong = events.map((e, i) => (i === 4 ? { ...e, actor: { id: 'token:other', kind: 'service' } } : e));
  assert.ok(actorProblems(wrong, actor).some((x) => /event 4/.test(x)));
});

test('actor in open mode: a build carries { id: local, kind: human }', async () => {
  const { home, srv } = await boot();
  /** @type {string} */ let id;
  try {
    const brief = fixtureEvents('plastic-modeling').find((e) => e.t === 'ontology.created').brief;
    const made = await req(srv.url, `${T}/maps`, { method: 'POST', body: { brief } });
    assert.equal(made.status, 202);
    id = made.json().id;
    assert.equal((await req(srv.url, `${T}/maps/${id}/wait?timeout=20000`)).json().state, 'idle');
  } finally { await srv.close(); }
  assert.deepEqual(actorProblems(await readEvents(home, id), { id: 'local', kind: 'human' }), []);
});
