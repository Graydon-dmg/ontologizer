// @ts-check
// Epic I2: private maps in service mode. Streams re-check the read rule, picked private sources hide
// a map from the start, acknowledgments wait for the store, names never leak, fuse is masked, the
// list never folds, unknown tenants open nothing, an empty privateSources is admin only, reachability
// is cached, and a browser gets one 404 page.
// Every check is a function that returns a list of problems; a planted fault proves it can fail.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
process.env.ONTOLOGIZER_STUB_SPEED = '1000';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startService } from '../../src/server/service.js';
import { createToken, tokensPath, readTokens, writeTokens } from '../../src/server/tokens.js';
import { createSources } from '../../src/server/sources.js';
import { openStore } from '../../src/core/store.js';
import { buildStubServer } from './fixtures/stub-mcp.js';
import { req, stubEngine, tempHome, fixtureEvents } from './helpers-service.js';

const SOURCES = [
  { name: 'wiki', url: 'https://wiki.example/mcp', visibility: 'private', allowTools: ['search', 'get'] },
  { name: 'docs', url: 'https://docs.example/mcp', visibility: 'public', allowTools: ['search', 'get'] },
];
const T = '/v1/t/default';
const BRIEF = () => fixtureEvents('plastic-modeling').find((e) => e.t === 'ontology.created').brief;
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @param {string} token @param {Record<string, string>} [extra] */
const auth = (token, extra = {}) => ({ authorization: `Bearer ${token}`, accept: 'application/json', ...extra });

/** @param {() => any} cond @param {number} [ms] */
async function waitFor(cond, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (cond()) return true; await sleep(15); }
  return Boolean(cond());
}

/** The plastic-modeling events with wiki raised right after ontology.created. */
function privateEvents(sources = ['wiki']) {
  const ev = fixtureEvents('plastic-modeling');
  ev.splice(1, 0, { t: 'visibility.raised', at: 0, to: 'private', reason: 'source', sources });
  return ev;
}

/** Wrap a store: every function runs on the real store (this = the wrapper); `over` replaces members. @param {any} real @param {Record<string, any>} over */
function wrapStore(real, over) {
  return new Proxy(real, {
    get(t, k, r) {
      if (typeof k === 'string' && k in over) return over[k];
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(r) : v;
    },
  });
}

function memConnect(/** @type {{ connect: Record<string, number>, list: Record<string, number> }} */ counts = { connect: {}, list: {} }) {
  return async (/** @type {any} */ e) => {
    counts.connect[e.name] = (counts.connect[e.name] ?? 0) + 1;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await buildStubServer({ name: e.name }).connect(b);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(a);
    const orig = client.listTools.bind(client);
    /** @type {any} */ (client).listTools = (/** @type {any[]} */ ...args) => { counts.list[e.name] = (counts.list[e.name] ?? 0) + 1; return /** @type {any} */ (orig)(...args); };
    return client;
  };
}

/** The stub engine with a quick ask. @param {any} x */
const quickEngine = (x) => ({ ...stubEngine(x), async *ask() { yield { type: 'done' }; } });

/**
 * A service with sources wiki (private) and docs (public), tokens team, reader and boss, and a store
 * we hold: `real` is the server's own instance (config.store returns `wrapped`).
 * @param {{ maps?: Record<string, any[]>, makeEngine?: any, maxBuilds?: number, over?: Record<string, any>,
 *   fileStore?: boolean, storeFn?: (tenant: string) => any, exists?: (t: string) => boolean, connect?: any }} [o]
 */
async function start({ maps = {}, makeEngine, maxBuilds = 2, over = {}, fileStore = false, storeFn, exists, connect } = {}) {
  const home = tempHome();
  const real = openStore(home);
  for (const [id, ev] of Object.entries(maps)) real.importEvents(id, ev);
  const wrapped = wrapStore(real, over);
  const f = tokensPath(home);
  /** @type {Record<string, string>} */
  const secrets = {
    reader: createToken(f, { name: 'reader', scopes: ['read', 'ask', 'build'] }).token,
    team: createToken(f, { name: 'team', scopes: ['read', 'ask', 'build'], sources: ['wiki'] }).token,
    boss: createToken(f, { name: 'boss', scopes: ['admin'] }).token,
  };
  /** @type {any} */
  const config = { sources: SOURCES };
  if (!fileStore) {
    config.store = storeFn ?? (() => wrapped);
    if (exists) config.store.exists = exists;
  }
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, tokensFile: f, maxBuilds, pingMs: 100,
    makeEngine: makeEngine ?? (async (/** @type {any} */ x) => quickEngine(x)), version: 'test',
    config, configPath: '/etc/onto/ontologizer.config.js',
    sources: createSources(SOURCES, { connect: connect ?? memConnect() }),
  });
  return { home, real, srv, secrets, url: srv.url.replace(/\/$/, '') };
}

/** Rewrite one token's sources in tokens.json (same hash, atomic rename). @param {string} home @param {string} name @param {string[]} sources */
function setSources(home, name, sources) {
  const f = tokensPath(home);
  writeTokens(f, readTokens(f).map((r) => (r.name === name ? { ...r, sources } : r)));
}

/** An open event stream: its events as they arrive and whether it has ended. @param {string} url @param {string} p @param {Record<string, string>} headers */
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

/** A node.added event holding SECRET. */
function secretNode() {
  const base = fixtureEvents('plastic-modeling').find((e) => e.t === 'node.added' && e.node.parent);
  return { ...base, at: 9000, node: { ...base.node, id: 'plastic-modeling/secret', label: 'Secret', category: base.node.category, summary: 'SECRET merger terms' } };
}

// ---------- 1a. a stream on a public map ends when the map turns private ----------

/**
 * What a reader's stream must show after the map turned private: it ended, and carries neither the
 * raise nor the node. @param {{ events: any[], ended: boolean }} t @param {number} before events sent before the raise
 */
function readerStreamProblems(t, before) {
  const p = [];
  if (!t.ended) p.push('the stream is still open');
  const after = t.events.slice(before);
  for (const e of after) p.push(`received after the raise: ${e.t}${e.node ? ` (${e.node.summary})` : ''}`);
  if (t.events.some((e) => e.t === 'visibility.raised')) p.push('received the raise');
  if (JSON.stringify(t.events).includes('SECRET')) p.push('received SECRET');
  return p;
}

test('a reader\'s stream on a public map ends at the raise and gets neither it nor the node; a team stream gets both', async () => {
  const total = fixtureEvents('plastic-modeling').length;
  // Planted fault: the old stream: the raise and the node went out to the reader, and it stayed open.
  const old = { ended: false, events: [...fixtureEvents('plastic-modeling'), { t: 'visibility.raised', to: 'private' }, secretNode()] };
  assert.ok(readerStreamProblems(old, total).length >= 3);
  assert.deepEqual(readerStreamProblems({ ended: true, events: fixtureEvents('plastic-modeling') }, total), []);

  const { srv, real, secrets, url } = await start({ maps: { 'open-map': fixtureEvents('plastic-modeling') } });
  const streams = [];
  try {
    const reader = openStream(url, `${T}/maps/open-map/events`, auth(secrets.reader)); streams.push(reader);
    const team = openStream(url, `${T}/maps/open-map/events`, auth(secrets.team)); streams.push(team);
    assert.ok(await waitFor(() => reader.t.events.length >= total && team.t.events.length >= total), 'both streams replayed the map');
    real.append('open-map', { t: 'visibility.raised', at: real.now('open-map'), to: 'private', reason: 'source', sources: ['wiki'] });
    real.append('open-map', secretNode());
    assert.ok(await waitFor(() => reader.t.ended), 'the reader\'s stream ended');
    assert.ok(await waitFor(() => team.t.events.length >= total + 2), 'team received both');
    assert.deepEqual(readerStreamProblems(reader.t, total), []);
    const got = team.t.events.slice(total);
    assert.equal(got[0].t, 'visibility.raised');
    assert.match(got[1].node.summary, /SECRET/);
    assert.equal(team.t.ended, false);
  } finally { streams.forEach((s) => s.close()); await srv.close(); }
});

// ---------- 1b. sources rewritten in tokens.json ----------

/** After team's sources were rewritten, the next event must not reach it and the stream must end. @param {{ events: any[], ended: boolean }} t @param {number} before */
function revokedStreamProblems(t, before) {
  const p = [];
  if (t.events.length > before) p.push(`still received ${t.events.length - before} event(s) after the rewrite: ${t.events.slice(before).map((e) => e.t).join(', ')}`);
  if (!t.ended) p.push('the stream is still open');
  return p;
}

test('rewriting a token\'s sources ends its stream on a private map before the next event is sent', async () => {
  // Planted fault: team still receiving after the rewrite.
  assert.ok(revokedStreamProblems({ ended: false, events: [1, 2, 3, { t: 'view.changed' }] }, 3).length === 2);
  const { srv, home, secrets, url } = await start({ maps: { 'secret-map': privateEvents() } });
  let s;
  try {
    const total = privateEvents().length;
    s = openStream(url, `${T}/maps/secret-map/events`, auth(secrets.team));
    assert.ok(await waitFor(() => s.t.events.length >= total), 'team replayed the private map');
    setSources(home, 'team', ['docs']);
    const act = await req(url, `${T}/maps/secret-map/actions`, { method: 'POST', headers: auth(secrets.boss), body: { type: 'focus', nodeId: 'plastic-modeling' } });
    assert.equal(act.status, 202);
    assert.ok(await waitFor(() => s.t.ended), 'the stream ended');
    assert.deepEqual(revokedStreamProblems(s.t, total), []);
  } finally { s?.close(); await srv.close(); }
});

// ---------- 1c. a chat ends when the asker loses the map ----------

/** @param {{ endedAfterMs: number|null, gotDone: boolean }} r */
function chatEndProblems(r) {
  const p = [];
  if (r.endedAfterMs === null || r.endedAfterMs > 2500) p.push(`the chat answer was still going ${r.endedAfterMs ?? 'forever'} ms after the rewrite`);
  if (r.gotDone) p.push('the answer ran to its end');
  return p;
}

test('a chat answer stops within about 2 s when the asker\'s sources are rewritten', async () => {
  // Planted fault: a chat that ran on (and finished) after the rewrite.
  assert.equal(chatEndProblems({ endedAfterMs: 9000, gotDone: true }).length, 2);
  const slow = async (/** @type {any} */ x) => ({
    ...stubEngine(x),
    async *ask(/** @type {any} */ _i, /** @type {any} */ o) {
      for (let i = 0; i < 40; i++) { await sleep(250); if (o?.signal?.aborted) return; yield { type: 'text', text: 'x' }; }
      yield { type: 'done' };
    },
  });
  const { srv, home, secrets, url } = await start({ maps: { 'secret-map': privateEvents() }, makeEngine: slow });
  try {
    const u = new URL(url);
    let chunks = '';
    let closedAt = 0;
    const r = http.request({ host: u.hostname, port: u.port, path: `${T}/maps/secret-map/chat`, method: 'POST', headers: { ...auth(secrets.team), 'content-type': 'application/json' } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => { chunks += c; });
      res.on('close', () => { closedAt = Date.now(); });
      res.on('error', () => { closedAt = closedAt || Date.now(); });
    });
    r.on('error', () => { closedAt = closedAt || Date.now(); });
    r.end(JSON.stringify({ text: 'what are the terms?' }));
    assert.ok(await waitFor(() => chunks.includes('"text"')), 'the answer started');
    const at = Date.now();
    setSources(home, 'team', ['docs']);
    await waitFor(() => closedAt > 0, 4000);
    assert.deepEqual(chatEndProblems({ endedAfterMs: closedAt ? closedAt - at : null, gotDone: chunks.includes('"done"') }), []);
  } finally { await srv.close(); }
});

// ---------- 2. picked private sources hide the map from the start ----------

/** What a caller who may not read the queued map sees. @param {any[]} list @param {string} id @param {number} snapshotStatus */
function hiddenProblems(list, id, snapshotStatus) {
  const p = [];
  if (list.some((r) => r.id === id)) p.push('the queued map is listed');
  if (JSON.stringify(list).includes('project-x')) p.push('the name project-x is listed');
  if (snapshotStatus !== 404) p.push(`snapshot answered ${snapshotStatus}`);
  return p;
}

/** @param {any[]} events */
function pickedOrderProblems(events) {
  const p = [];
  if (events[0]?.t !== 'ontology.created') p.push(`first event is ${events[0]?.t}`);
  if (events[1]?.t !== 'visibility.raised' || events[1]?.reason !== 'sources-picked') p.push(`second event is ${events[1]?.t}/${events[1]?.reason}`);
  if (events[2]?.t !== 'node.added' || events[2]?.node?.parent !== null) p.push(`third event is ${events[2]?.t}, not the root node`);
  return p;
}

test('a build that picks a private source is hidden (id, name, snapshot) while queued, and raises first', async () => {
  // Planted fault: the list as the old code returned it, the queued draft named project-x shown to the reader.
  assert.ok(hiddenProblems([{ id: 'draft-1', name: 'project-x' }], 'draft-1', 200).length === 3);
  assert.deepEqual(pickedOrderProblems([{ t: 'ontology.created' }, { t: 'node.added', node: { parent: null } }]).length, 2);

  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((r) => { release = () => r(undefined); });
  const eng = async (/** @type {any} */ x) => {
    const e = quickEngine(x);
    return { ...e, async build(/** @type {any} */ brief, /** @type {any} */ o) { if (brief.hold) await gate; return e.build(brief, o); } };
  };
  const { srv, real, secrets, url } = await start({ makeEngine: eng, maxBuilds: 1 });
  try {
    const first = await req(url, `${T}/maps`, { method: 'POST', headers: auth(secrets.reader), body: { brief: { ...BRIEF(), hold: true }, sources: [] } });
    assert.equal(first.status, 202);
    assert.ok(await waitFor(() => srv.stats().engines >= 1));
    const mine = await req(url, `${T}/maps`, { method: 'POST', headers: auth(secrets.team), body: { brief: BRIEF(), sources: ['wiki'], name: 'project-x' } });
    assert.equal(mine.status, 202);
    const id = mine.json().id;
    // Queued: the slot is taken.
    const list = (await req(url, `${T}/maps`, { headers: auth(secrets.reader) })).json();
    const snap = await req(url, `${T}/maps/${id}/snapshot`, { headers: auth(secrets.reader) });
    assert.deepEqual(hiddenProblems(list, id, snap.status), []);
    assert.ok(list.some((r) => r.id === first.json().id), 'the reader still sees the public build');
    const teamRow = (await req(url, `${T}/maps`, { headers: auth(secrets.team) })).json().find((/** @type {any} */ r) => r.id === id);
    assert.ok(teamRow, 'team lists its own queued map');
    assert.notEqual(teamRow.name, 'project-x');
    assert.equal(teamRow.visibility, 'private');
    release();
    const w = await req(url, `${T}/maps/${id}/wait?timeout=20000`, { headers: auth(secrets.team) });
    assert.equal(w.json().state, 'idle');
    const events = [];
    for await (const e of real.events(id)) events.push(e);
    assert.deepEqual(pickedOrderProblems(events), []);
  } finally { release(); await srv.close(); }
});

// ---------- 3. durable acknowledgments ----------

/** @param {string} label @param {string[]} order */
function ackOrderProblems(label, order) {
  const sync = order.indexOf('sync-called'); const done = order.indexOf('sync-resolved'); const resp = order.indexOf('response');
  const p = [];
  if (sync < 0) p.push(`${label}: sync was never called`);
  if (resp < 0) p.push(`${label}: no response`);
  else if (done < 0 || resp < done) p.push(`${label}: the response came before sync resolved (${order.join(' > ')})`);
  return p;
}

test('POST maps, an action, save and a chat answer 2xx only after sync resolved; a failing sync is 503', async () => {
  // Planted fault: the response came before sync.
  assert.equal(ackOrderProblems('x', ['sync-called', 'response', 'sync-resolved']).length, 1);
  assert.deepEqual(ackOrderProblems('x', ['sync-called', 'sync-resolved', 'response']), []);

  const ctl = { mode: 'ok', calls: 0, failAppend: false, /** @type {string[]} */ order: [], /** @type {Array<() => void>} */ releases: [] };
  const sync = () => {
    ctl.calls++;
    ctl.order.push('sync-called');
    if (ctl.mode === 'fail') return Promise.reject(new Error('store down'));
    if (ctl.mode === 'failcode') return Promise.reject(Object.assign(new Error('store down'), { code: 'STORE_FAILED' }));
    if (ctl.mode === 'hold') return new Promise((r) => { ctl.releases.push(() => r(undefined)); });
    return Promise.resolve();
  };
  /** @type {any} */
  let realRef = null;
  const over = {
    sync,
    append(/** @type {string} */ id, /** @type {any} */ ev) {
      if (ctl.failAppend) { const e = new Error('disk full'); /** @type {any} */ (e).code = 'STORE_FAILED'; throw e; }
      return realRef.append(id, ev);
    },
  };
  const m = () => fixtureEvents('plastic-modeling');
  const { srv, real, secrets, url } = await start({ over, maps: { 'map-a': m(), 'map-b': m(), 'map-c': m(), 'map-d': m() } });
  realRef = real;
  const h = auth(secrets.reader);
  /** @type {Record<string, () => Promise<any>>} */
  const ops = {
    'POST maps': (id) => req(url, `${T}/maps`, { method: 'POST', headers: h, body: { brief: BRIEF(), sources: [] } }),
    action: (id) => req(url, `${T}/maps/${id}/actions`, { method: 'POST', headers: h, body: { type: 'focus', nodeId: 'plastic-modeling' } }),
    save: (id) => req(url, `${T}/maps/${id}/save`, { method: 'POST', headers: h, body: { name: `${id}-saved` } }),
    chat: (id) => req(url, `${T}/maps/${id}/chat`, { method: 'POST', headers: h, body: { text: 'hello' } }),
  };
  try {
    for (const [label, op] of Object.entries(ops)) {
      ctl.mode = 'hold'; ctl.order = []; const before = ctl.calls;
      const pending = /** @type {any} */ (op)(label === 'save' ? 'map-a' : 'map-b').then((/** @type {any} */ r) => { ctl.order.push('response'); return r; });
      assert.ok(await waitFor(() => ctl.calls > before), `${label}: sync was called`);
      await sleep(150);
      ctl.order.push('sync-resolved');
      ctl.releases.splice(0).forEach((r) => r());
      const r = await pending;
      assert.ok(r.status >= 200 && r.status < 300, `${label}: ${r.status}`);
      assert.deepEqual(ackOrderProblems(label, ctl.order), []);
    }
    // sync rejects: 503 on each.
    ctl.mode = 'fail';
    const targets = { 'POST maps': 'map-c', action: 'map-c', save: 'map-c', chat: 'map-d' };
    for (const [label, op] of Object.entries(ops)) {
      const r = await op(/** @type {any} */ (targets)[label]);
      assert.equal(r.status, 503, `${label}: a failing sync answered ${r.status} ${r.body.slice(0, 120)}`);
    }
    ctl.mode = 'failcode';
    // (The failed save above already renamed map-c in memory: the coded rejection is tried on the new id.)
    const savedFail = await ops.save('map-c-saved');
    assert.equal(savedFail.status, 503, `save with a STORE_FAILED sync answered ${savedFail.status}`);
    // append throws STORE_FAILED: 503, not 500.
    ctl.mode = 'ok'; ctl.failAppend = true;
    const failed = await req(url, `${T}/maps/map-d/actions`, { method: 'POST', headers: h, body: { type: 'focus', nodeId: 'plastic-modeling' } });
    assert.equal(failed.status, 503);
    ctl.failAppend = false;
  } finally { ctl.mode = 'ok'; ctl.releases.splice(0).forEach((r) => r()); await srv.close(); }
});

// ---------- 4. names don't leak ----------

/** @param {string[]} texts what the caller was told @param {string} secret */
function nameProblems(texts, secret) {
  return texts.filter((t) => t.includes(secret)).map((t) => `names ${secret}: ${t.slice(0, 80)}`);
}
/** @param {number} got @param {number} want */
const countProblems = (got, want) => (got === want ? [] : [`status counts ${got} maps, the caller may read ${want}`]);
/** @param {number} status @param {string} error */
const conflictProblems = (status, error) => [
  ...(status === 409 ? [] : [`save answered ${status}`]),
  ...(error === 'That name is not available.' ? [] : [`409 text is "${error}"`]),
];

test('fuse ambiguity, the status count and a name conflict never name a map the caller cannot read', async () => {
  // Planted faults: the review's probe-names outputs.
  assert.equal(nameProblems(['"s" is ambiguous: sample-public, secret-merger'], 'secret-merger').length, 1);
  assert.equal(conflictProblems(409, '"secret-merger" already exists. Pick another name or overwrite it.').length, 1);
  assert.equal(countProblems(3, 2).length, 1);
  assert.deepEqual(conflictProblems(409, 'That name is not available.'), []);

  const { srv, secrets, url } = await start({ maps: {
    'open-map': fixtureEvents('plastic-modeling'), 'sample-public': fixtureEvents('plastic-modeling'), 'secret-merger': privateEvents(),
  } });
  try {
    const h = auth(secrets.reader);
    const status = async (/** @type {string} */ who) => (await req(url, `${T}/status`, { headers: auth(secrets[who]) })).json().maps;
    assert.deepEqual(countProblems(await status('reader'), 2), []);
    assert.equal(await status('boss'), 3);
    assert.equal(await status('team'), 3);
    const act = (/** @type {any} */ body) => req(url, `${T}/maps/open-map/actions`, { method: 'POST', headers: h, body });
    const none = await act({ type: 'fuse', with: 'secret' });
    assert.equal(none.status, 400);
    assert.deepEqual(nameProblems([none.body], 'secret-merger'), []);
    const s = await act({ type: 'fuse', with: 's' });
    assert.ok(s.status === 202 || s.status === 400, `status ${s.status}`);
    assert.deepEqual(nameProblems([s.body], 'secret-merger'), []);
    if (s.status === 202) assert.ok(s.json().draftId, 'resolved to sample-public: a fuse started');
    const save = await req(url, `${T}/maps/open-map/save`, { method: 'POST', headers: h, body: { name: 'secret-merger' } });
    assert.deepEqual(conflictProblems(save.status, save.json().error), []);
  } finally { await srv.close(); }
});

// ---------- 5. fuse masking ----------

/** @param {any[]} events map A's log @param {{ b: string, bName: string, draftId: string, url: string }} v */
function maskProblems(events, v) {
  const text = JSON.stringify(events);
  const p = [];
  for (const [what, s] of Object.entries({ id: v.b, name: v.bName, draftId: v.draftId, url: v.url })) {
    if (s && text.includes(s)) p.push(`A's log holds B's ${what}`);
  }
  const fuses = events.filter((e) => e.job?.kind === 'fuse');
  if (!fuses.length) p.push('no fuse job in the log');
  for (const e of fuses) if (e.job.with !== 'a private map') p.push(`${e.t} says with: ${e.job.with}`);
  return p;
}

test('fusing a public map with a private one writes only "a private map" to the public map\'s log', async () => {
  const { srv, real, secrets, url } = await start({ maps: { 'open-map': fixtureEvents('plastic-modeling'), 'secret-merger': privateEvents().map((e) => (e.t === 'ontology.created' ? { ...e, name: 'Hidden merger terms' } : e)) } });
  try {
    const r = await req(url, `${T}/maps/open-map/actions`, { method: 'POST', headers: auth(secrets.team), body: { type: 'fuse', with: 'secret-merger' } });
    assert.equal(r.status, 202);
    const reply = r.json();
    assert.ok(reply.draftId, 'team gets the draftId');
    assert.ok(reply.url, 'team gets the url');
    const bName = real.read('secret-merger').name;
    /** @type {any[]} */
    let events = [];
    const read = async () => { const out = []; for await (const e of real.events('open-map')) out.push(e); return out; };
    for (let i = 0; i < 100; i++) { events = await read(); if (events.some((e) => e.t === 'job.done' && e.job?.kind === 'fuse')) break; await sleep(30); }
    const v = { b: 'secret-merger', bName, draftId: reply.draftId, url: reply.url };
    assert.deepEqual(maskProblems(events, v), []);
    // Planted fault: A's events as the old code wrote them.
    const old = events.map((e) => (e.job?.kind === 'fuse' ? { ...e, job: { ...e.job, with: 'secret-merger', draftId: reply.draftId, url: reply.url } } : e));
    assert.ok(maskProblems(old, v).length >= 3);
  } finally { await srv.close(); }
});

// ---------- 6. the list never folds ----------

/** @param {number} reads @param {number} listed */
const foldProblems = (reads, listed) => (reads === 0 ? [] : [`${reads} store.read call(s) to list ${listed} maps`]);

test('GET maps and the fuse picker list from the index: no store.read per map, private maps still hidden', async () => {
  // Planted fault: a list that reads every map.
  const m = { reads: 0 };
  const badList = (/** @type {any} */ store) => store.list({ drafts: true }).map((/** @type {any} */ r) => { m.reads++; return store.read(r.id).name; });
  const probe = openStore(tempHome());
  probe.importEvents('a-map', fixtureEvents('plastic-modeling'));
  badList(wrapStore(probe, { read: (/** @type {string} */ id) => { m.reads++; return probe.read(id); } }));
  assert.ok(foldProblems(m.reads, 1).length > 0);

  /** @type {string[]} */
  const reads = [];
  /** @type {any} */
  let realRef = null;
  const over = { read: (/** @type {string} */ id) => { reads.push(id); return realRef.read(id); } };
  const { srv, real, secrets, url } = await start({ over, maps: {
    'open-map': fixtureEvents('plastic-modeling'), 'other-public': fixtureEvents('plastic-modeling'), 'secret-merger': privateEvents(), 'secret-two': privateEvents(),
  } });
  realRef = real;
  try {
    const h = auth(secrets.reader);
    reads.length = 0;
    const list = (await req(url, `${T}/maps`, { headers: h })).json();
    assert.deepEqual(foldProblems(reads.length, list.length), []);
    assert.deepEqual(list.map((/** @type {any} */ r) => r.id).sort(), ['open-map', 'other-public']);
    // The picker: the read rule reads the current map once; no other map is read.
    reads.length = 0;
    const picker = (await req(url, `${T}/maps/open-map/api/maps`, { headers: h })).json();
    assert.deepEqual(picker.map((/** @type {any} */ r) => r.id), ['other-public']);
    assert.deepEqual(foldProblems(reads.filter((id) => id !== 'open-map').length, picker.length), []);
    assert.ok(reads.length <= 1, `the picker read ${reads.length} times: ${reads.join(', ')}`);
    // The team sees the private ones, still without a fold per map.
    reads.length = 0;
    const teamList = (await req(url, `${T}/maps`, { headers: auth(secrets.team) })).json();
    assert.equal(teamList.length, 4);
    assert.deepEqual(foldProblems(reads.length, teamList.length), []);
  } finally { await srv.close(); }
});

// ---------- 7. an unknown tenant opens nothing ----------

test('an admin\'s status for an unknown tenant opens no store and creates no folder', async () => {
  // Planted fault: a status that opens a store for it.
  const probeHome = tempHome();
  openStore(probeHome, { tenant: 'nope-123' });
  assert.ok(fs.existsSync(path.join(probeHome, 'tenants', 'nope-123')), 'opening a store creates the folder (what the fault does)');

  const a = await start({ fileStore: true });
  try {
    const r = await req(a.url, '/v1/t/nope-123/status', { headers: auth(a.secrets.boss) });
    assert.equal(r.status, 200);
    assert.equal(r.json().maps, 0);
    assert.equal(fs.existsSync(path.join(a.home, 'tenants', 'nope-123')), false, 'no tenant folder was created');
  } finally { await a.srv.close(); }

  let calls = 0;
  const b = await start({ storeFn: () => { calls++; return openStore(tempHome()); }, exists: () => false });
  try {
    const r = await req(b.url, '/v1/t/nope-123/status', { headers: auth(b.secrets.boss) });
    assert.equal(r.status, 200);
    assert.equal(calls, 0, 'the store function was called for a tenant that does not exist');
  } finally { await b.srv.close(); }
});

// ---------- 8. an empty privateSources is admin only ----------

/** @param {Record<string, number>} got */
function emptySourcesProblems(got) {
  const p = [];
  if (got.team !== 404) p.push(`team gets ${got.team}`);
  if (got.reader !== 404) p.push(`reader gets ${got.reader}`);
  if (got.boss !== 200) p.push(`boss gets ${got.boss}`);
  return p;
}

test('a map raised with sources: [] is readable by admin only', async () => {
  // Planted fault: the rule that let anyone read a private map naming no source.
  assert.equal(emptySourcesProblems({ team: 200, reader: 200, boss: 200 }).length, 2);
  const { srv, secrets, url } = await start({ maps: { 'no-source': (() => { const ev = fixtureEvents('plastic-modeling'); ev.splice(1, 0, { t: 'visibility.raised', at: 0, to: 'private', sources: [] }); return ev; })() } });
  try {
    /** @type {Record<string, number>} */
    const got = {};
    for (const who of ['team', 'reader', 'boss']) got[who] = (await req(url, `${T}/maps/no-source/snapshot`, { headers: auth(secrets[who]) })).status;
    assert.deepEqual(emptySourcesProblems(got), []);
    for (const who of ['team', 'reader']) {
      const list = (await req(url, `${T}/maps`, { headers: auth(secrets[who]) })).json();
      assert.equal(list.some((/** @type {any} */ r) => r.id === 'no-source'), false, `${who} lists it`);
    }
  } finally { await srv.close(); }
});

// ---------- 9. reachability is cached ----------

/** @param {{ connect: Record<string, number>, list: Record<string, number> }} c */
function reachProblems(c) {
  const p = [];
  for (const n of ['wiki', 'docs']) {
    if (c.connect[n] !== 1) p.push(`${n}: ${c.connect[n]} connects`);
    if (c.list[n] !== 1) p.push(`${n}: ${c.list[n]} listings`);
  }
  return p;
}

test('two status calls within 30 s connect to and list each source once', async () => {
  // Planted fault: no cache, so the second call lists again.
  assert.equal(reachProblems({ connect: { wiki: 1, docs: 1 }, list: { wiki: 2, docs: 2 } }).length, 2);
  const counts = { connect: {}, list: {} };
  const { srv, secrets, url } = await start({ connect: memConnect(counts) });
  try {
    const one = (await req(url, `${T}/status`, { headers: auth(secrets.boss) })).json();
    const two = (await req(url, `${T}/status`, { headers: auth(secrets.boss) })).json();
    assert.deepEqual(one.sources.map((/** @type {any} */ s) => [s.name, s.reachable]).sort(), [['docs', true], ['wiki', true]]);
    assert.deepEqual(two.sources, one.sources);
    assert.deepEqual(reachProblems(counts), []);
  } finally { await srv.close(); }
});

// ---------- 10. the browser 404 page ----------

/** @param {any} r the browser's answer @param {string[]} secrets what it must not hold */
function pageProblems(r, secrets) {
  const p = [];
  if (r.status !== 404) p.push(`status ${r.status}`);
  if (!String(r.headers['content-type']).startsWith('text/html')) p.push(`content-type ${r.headers['content-type']}`);
  if (!r.body.includes("Not found, or you don't have access")) p.push('the words are missing');
  if (!r.body.includes('href="/"')) p.push('no link to /');
  for (const s of secrets) if (s && r.body.toLowerCase().includes(s.toLowerCase())) p.push(`the page holds "${s}"`);
  return p;
}

test('a browser gets the same 404 page for a private map and a missing one; the API keeps JSON', async () => {
  // Planted fault: a page that names the map.
  assert.ok(pageProblems({ status: 404, headers: { 'content-type': 'text/html' }, body: `Not found, or you don't have access <a href="/">x</a> secret-map` }, ['secret-map']).length === 1);
  const { srv, real, secrets, url } = await start({ maps: { 'secret-map': privateEvents() } });
  try {
    const name = real.read('secret-map').name;
    const browser = { authorization: `Bearer ${secrets.reader}`, accept: 'text/html' };
    const hidden = await req(url, `${T}/maps/secret-map/view`, { headers: browser });
    const missing = await req(url, `${T}/maps/no-such-map/view`, { headers: browser });
    assert.deepEqual(pageProblems(hidden, ['secret-map', name]), []);
    assert.deepEqual(pageProblems(missing, ['no-such-map']), []);
    assert.equal(hidden.body, missing.body);
    const api = await req(url, `${T}/maps/secret-map/view`, { headers: auth(secrets.reader) });
    assert.equal(api.status, 404);
    assert.match(String(api.headers['content-type']), /json/);
    assert.deepEqual(api.json(), { ok: false, error: 'not found' });
    const apiSnap = await req(url, `${T}/maps/secret-map/snapshot`, { headers: { ...browser } });
    assert.match(String(apiSnap.headers['content-type']), /json/, 'a non-view route stays JSON even for a browser');
  } finally { await srv.close(); }
});
