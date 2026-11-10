// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// I5 · delete, trash and restore over HTTP, on the REAL engine with a scripted model (the stub engine
// once hid a regression). Who may delete (a draft: build; a named map: admin), the read rule (a hidden
// map answers exactly as a missing one, and never shows in the trash), busy maps (409), open streams
// (they end with `event: deleted`), the Origin rule for a cookie DELETE or POST, and the check order.
// Every check returns a list of problems; a planted fault proves each one can fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startService, BUSY } from '../../src/server/service.js';
import { createEngine } from '../../src/core/engine/index.js';
import { createToken, tokensPath, hasScope } from '../../src/server/tokens.js';
import { createSources } from '../../src/server/sources.js';
import { ACTION_SCOPE, canRead } from '../../src/server/policy.js';
import { openStore } from '../../src/core/store.js';
import { createFakeClient, lines } from '../c/fake.js';
import { req, tempHome, fixtureEvents } from './helpers-service.js';

const SOURCES = [
  { name: 'wiki', url: 'https://wiki.example/mcp', visibility: 'private', allowTools: ['search'] },
  { name: 'docs', url: 'https://docs.example/mcp', visibility: 'public', allowTools: ['search'] },
];
const T = '/v1/t/default';
const DAY = 24 * 60 * 60 * 1000;
const BRIEF = { context: 'glue', subject: 'Glue', scope: 'sticking things', purpose: 'learn', level: 'beginner' };
const raise = { t: 'visibility.raised', at: 0, to: 'private', reason: 'source', sources: ['wiki'] };
const sysOf = (/** @type {any} */ p) => (typeof p.system === 'string' ? p.system : p.system.map((/** @type {any} */ b) => b.text).join('\n'));

/**
 * A model that answers a build's waves; `hold` delays the first call (a build that is still running).
 * @param {{ hold?: number }} [o]
 */
function buildModel({ hold = 0 } = {}) {
  let n = 0;
  return createFakeClient({
    chunkMs: 0,
    respond: (params) => {
      const delayMs = n++ === 0 ? hold : 0;
      const sys = sysOf(params);
      const prompt = typeof params.messages[0].content === 'string' ? params.messages[0].content : '';
      if (sys.includes('top-level categories')) return { delayMs, text: lines(['Types', 'Uses'].map((label) => ({ label, summary: 's', hook: 'h' }))) };
      if (sys.includes('children of one category')) {
        const label = /The category to expand: (.+)/.exec(prompt)?.[1] ?? 'X';
        return { delayMs, text: lines([{ label: `${label} One`, parent: label }]) };
      }
      return { delayMs, text: '' };
    },
  });
}

/**
 * A service on a temp home: tokens reader (read), builder (build, no sources), team (build + wiki),
 * boss (admin); maps "named" (public), "secret" (private: wiki), a public draft and a private draft.
 * @param {{ policy?: any, hold?: number }} [o]
 */
async function start({ policy, hold = 0 } = {}) {
  const home = tempHome();
  const s = openStore(home);
  s.importEvents('named', fixtureEvents('plastic-modeling'));
  const priv = fixtureEvents('plastic-modeling');
  priv.splice(1, 0, raise);
  s.importEvents('secret', priv);
  const draft = s.createDraft(BRIEF, 'Rough');
  s.append(draft, { t: 'ontology.created', at: 0, name: 'Rough', root: 'rough', brief: BRIEF, categories: [] });
  const hidden = s.createDraft(BRIEF, 'Hush');
  s.append(hidden, { t: 'ontology.created', at: 0, name: 'Hush', root: 'hush', brief: BRIEF, categories: [] });
  s.append(hidden, raise);
  s.flush();
  const f = tokensPath(home);
  /** @type {Record<string, string>} */
  const secrets = {
    reader: createToken(f, { name: 'reader', scopes: ['read'] }).token,
    builder: createToken(f, { name: 'builder', scopes: ['read', 'ask', 'build'] }).token,
    team: createToken(f, { name: 'team', scopes: ['read', 'ask', 'build'], sources: ['wiki'] }).token,
    boss: createToken(f, { name: 'boss', scopes: ['admin'] }).token,
  };
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, tokensFile: f, pingMs: 100, version: 'test',
    makeEngine: async ({ store, id }) => createEngine({ store, id, client: buildModel({ hold }) }),
    config: { sources: SOURCES, ...(policy ? { policy } : {}) },
    sources: createSources(SOURCES, { connect: async () => { throw new Error('no network in tests'); } }),
  });
  const url = srv.url.replace(/\/$/, '');
  /** @param {string} who @param {string} method @param {string} p @param {any} [body] @param {Record<string, string>} [headers] */
  const call = async (who, method, p, body, headers = {}) => {
    const r = await req(url, p, { method, ...(body !== undefined ? { body } : {}), headers: { ...(who ? { authorization: `Bearer ${secrets[who]}` } : {}), ...headers } });
    let j = null;
    try { j = JSON.parse(r.body); } catch { /* text */ }
    return { status: r.status, body: r.body, json: j };
  };
  return { home, srv, url, secrets, draft, hidden, call };
}

/** @param {Array<[string, number, number]>} rows [what, got, want] @returns {string[]} */
const statusProblems = (rows) => rows.filter(([, got, want]) => got !== want).map(([what, got, want]) => `${what}: ${got}, want ${want}`);

/** Delete and restore, by scope and by kind of map. @param {Awaited<ReturnType<typeof start>>} x */
async function permissionRows(x) {
  const { call, draft } = x;
  /** @type {Array<[string, number, number]>} */
  const rows = [];
  const del = (/** @type {string} */ who, /** @type {string} */ id) => call(who, 'DELETE', `${T}/maps/${id}`);
  rows.push(['reader deletes a draft', (await del('reader', draft)).status, 403]);
  rows.push(['builder deletes a named map', (await del('builder', 'named')).status, 403]);
  const d = await del('builder', draft);
  rows.push(['builder deletes a draft', d.status, 200]);
  const n = await del('boss', 'named');
  rows.push(['boss deletes a named map', n.status, 200]);
  const restore = (/** @type {string} */ who, /** @type {string} */ trashId) => call(who, 'POST', `${T}/trash/${trashId}/restore`, {});
  rows.push(['reader restores a draft', (await restore('reader', d.json?.trashId)).status, 403]);
  rows.push(['builder restores a named map', (await restore('builder', n.json?.trashId)).status, 403]);
  rows.push(['builder restores a draft', (await restore('builder', d.json?.trashId)).status, 200]);
  rows.push(['boss restores a named map', (await restore('boss', n.json?.trashId)).status, 200]);
  rows.push(['the named map is back', (await call('builder', 'GET', `${T}/maps/named/snapshot`)).status, 200]);
  rows.push(['reader lists the trash', (await call('reader', 'GET', `${T}/trash`)).status, 403]);
  return rows;
}

test('a draft is deleted and restored with build; a named map needs admin', async () => {
  const x = await start();
  try { assert.deepEqual(statusProblems(await permissionRows(x)), []); } finally { await x.srv.close(); }
});

test('planted fault: a policy that lets build delete a named map is reported', async () => {
  // The I1 scope ladder alone (delete: build), without the named-map rule.
  const loose = { name: 'loose', can: (/** @type {any} */ p, /** @type {string} */ a, /** @type {any} */ ctx) => hasScope(p.scopes, /** @type {any} */ (ACTION_SCOPE)[a]) && canRead(p, ctx?.map ?? null) };
  const x = await start({ policy: loose });
  try {
    const problems = statusProblems(await permissionRows(x));
    assert.ok(problems.some((p) => p.startsWith('builder deletes a named map: 200')), problems.join('\n'));
  } finally { await x.srv.close(); }
});

/**
 * A reader who may not read a map: its delete and restore answer exactly as for a missing one, and
 * the trash list never shows it. @param {Awaited<ReturnType<typeof start>>} x @returns {Promise<string[]>}
 */
async function hiddenProblems(x) {
  const { call, hidden } = x;
  /** @type {string[]} */ const p = [];
  /** @param {{ status: number, body: string }} a @param {{ status: number, body: string }} b @param {string} what */
  const same = (a, b, what) => { if (a.status !== b.status || a.body !== b.body) p.push(`${what}: ${a.status} ${a.body} vs missing ${b.status} ${b.body}`); };
  same(await call('builder', 'DELETE', `${T}/maps/secret`), await call('builder', 'DELETE', `${T}/maps/no-such-map`), 'builder deletes a hidden named map');
  same(await call('builder', 'DELETE', `${T}/maps/${hidden}`), await call('builder', 'DELETE', `${T}/maps/draft-19990101-000000`), 'builder deletes a hidden draft');
  const gone = await call('boss', 'DELETE', `${T}/maps/secret`);
  const goneDraft = await call('team', 'DELETE', `${T}/maps/${hidden}`);
  if (gone.status !== 200 || goneDraft.status !== 200) { p.push(`setup: deletes answered ${gone.status} ${goneDraft.status}`); return p; }
  const ids = async (/** @type {string} */ who) => ((await call(who, 'GET', `${T}/trash`)).json ?? []).map((/** @type {any} */ t) => t.trashId).sort();
  const builderSees = await ids('builder');
  if (builderSees.includes(gone.json.trashId) || builderSees.includes(goneDraft.json.trashId)) p.push(`builder's trash shows hidden items: ${builderSees}`);
  const teamSees = await ids('team');
  if (JSON.stringify(teamSees) !== JSON.stringify([goneDraft.json.trashId])) p.push(`team's trash: ${teamSees} (want only its private draft; the named map needs admin)`);
  const bossSees = await ids('boss');
  if (JSON.stringify(bossSees) !== JSON.stringify([gone.json.trashId, goneDraft.json.trashId].sort())) p.push(`boss's trash: ${bossSees}`);
  const teamRow = ((await call('team', 'GET', `${T}/trash`)).json ?? [])[0];
  if (teamRow?.visibility !== 'private') p.push(`a private item is listed without its badge: ${JSON.stringify(teamRow)}`);
  same(await call('builder', 'POST', `${T}/trash/${goneDraft.json.trashId}/restore`, {}), await call('builder', 'POST', `${T}/trash/nothing--20260101-000000z/restore`, {}), 'builder restores a hidden draft');
  const back = await call('team', 'POST', `${T}/trash/${goneDraft.json.trashId}/restore`, {});
  if (back.status !== 200) p.push(`team could not restore its private draft: ${back.status} ${back.body}`);
  const row = ((await call('team', 'GET', `${T}/maps`)).json ?? []).find((/** @type {any} */ m) => m.id === hidden);
  if (row?.visibility !== 'private') p.push(`the restored draft is not private: ${JSON.stringify(row)}`);
  if (((await call('builder', 'GET', `${T}/maps`)).json ?? []).some((/** @type {any} */ m) => m.id === hidden)) p.push('builder now sees the restored private draft');
  return p;
}

test('a hidden map: delete and restore answer as for a missing one; the trash never shows it', async () => {
  const x = await start();
  try { assert.deepEqual(await hiddenProblems(x), []); } finally { await x.srv.close(); }
});

test('planted fault: a policy without the read rule leaks hidden maps and is reported', async () => {
  const blind = { name: 'blind', can: (/** @type {any} */ p, /** @type {string} */ a, /** @type {any} */ ctx) =>
    hasScope(p.scopes, /** @type {any} */ (ACTION_SCOPE)[a]) && !((a === 'delete' || a === 'restore') && ctx?.draft === false && !hasScope(p.scopes, 'admin')) };
  const x = await start({ policy: blind });
  try {
    const problems = await hiddenProblems(x);
    assert.ok(problems.some((p) => p.startsWith('builder deletes a hidden draft')), problems.join('\n'));
  } finally { await x.srv.close(); }
});

/** A map that is being built is refused (409) until it is idle, then deleted; restore brings it back intact. @param {any} r */
function busyProblems(r) {
  /** @type {string[]} */ const p = [];
  if (r.building.status !== 409 || r.building.json?.error !== BUSY) p.push(`delete while building: ${r.building.status} ${r.building.body}`);
  if (r.idle.status !== 200) p.push(`delete when idle: ${r.idle.status} ${r.idle.body}`);
  if (r.nodesBefore < 3) p.push(`the build made ${r.nodesBefore} nodes`);
  if (r.restored.status !== 200 || r.eventsAfter !== r.eventsBefore || r.nodesAfter !== r.nodesBefore) {
    p.push(`restore: ${r.restored.status}, events ${r.eventsBefore} -> ${r.eventsAfter}, nodes ${r.nodesBefore} -> ${r.nodesAfter}`);
  }
  return p;
}

test('a busy map (its build running) gets 409; once idle it is deleted, and restored intact (real engine)', async () => {
  const x = await start({ hold: 600 });
  try {
    const b = await x.call('builder', 'POST', `${T}/maps`, { brief: BRIEF, name: 'Glue' });
    assert.equal(b.status, 202, b.body);
    const id = b.json.id;
    const building = await x.call('builder', 'DELETE', `${T}/maps/${id}`);
    const w = await x.call('builder', 'GET', `${T}/maps/${id}/wait?timeout=20000`);
    assert.equal(w.json?.state, 'idle', w.body);
    const snap = (await x.call('builder', 'GET', `${T}/maps/${id}/snapshot`)).json;
    const count = () => fs.readFileSync(path.join(x.home, id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    const eventsBefore = count();
    const idle = await x.call('builder', 'DELETE', `${T}/maps/${id}`);
    const restored = await x.call('builder', 'POST', `${T}/trash/${idle.json?.trashId}/restore`, {});
    const after = (await x.call('builder', 'GET', `${T}/maps/${id}/snapshot`)).json;
    const r = { building, idle, restored, eventsBefore, eventsAfter: count(), nodesBefore: Object.keys(snap.nodes).length, nodesAfter: Object.keys(after?.nodes ?? {}).length };
    assert.deepEqual(busyProblems(r), []);
    // Planted fault: a router that deleted it while it was building.
    assert.ok(busyProblems({ ...r, building: idle }).length > 0);
  } finally { await x.srv.close(); }
});


/**
 * Open a raw event stream and keep everything it sends until it ends.
 * @param {string} url @param {string} p @param {Record<string, string>} headers
 * @returns {Promise<{ status: number, text: () => string, ended: Promise<boolean> }>}
 */
function openStream(url, p, headers) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    let text = '';
    const r = http.get({ host: u.hostname, port: u.port, path: p, headers }, (res) => {
      res.setEncoding('utf8');
      const ended = new Promise((done) => { res.on('end', () => done(true)); res.on('close', () => done(true)); setTimeout(() => done(false), 5000).unref(); });
      res.on('data', (c) => { text += c; });
      resolve({ status: /** @type {number} */ (res.statusCode), text: () => text, ended });
    });
    r.on('error', reject);
  });
}

/** Each stream ended, and its last message is `event: deleted`. @param {Array<{ text: string, ended: boolean }>} streams */
function streamProblems(streams) {
  /** @type {string[]} */ const p = [];
  streams.forEach((s, i) => {
    if (!s.ended) p.push(`stream ${i} is still open`);
    const last = s.text.trim().split('\n\n').at(-1) ?? '';
    if (!/^event: deleted\ndata: /.test(last)) p.push(`stream ${i} ended without the deleted event: ${JSON.stringify(last.slice(0, 60))}`);
  });
  return p;
}

test('on delete every open stream of the map ends with the deleted event; the map is gone after', async () => {
  const x = await start();
  try {
    const h = { authorization: `Bearer ${x.secrets.boss}` };
    const a = await openStream(x.url, `${T}/maps/named/events`, h);
    const b = await openStream(x.url, `${T}/maps/named/api/events?from=0`, h);
    assert.equal(a.status, 200);
    await new Promise((r) => setTimeout(r, 200)); // both have their backlog
    const d = await x.call('boss', 'DELETE', `${T}/maps/named`);
    assert.equal(d.status, 200, d.body);
    const endedA = await a.ended;
    const endedB = await b.ended;
    const streams = [{ text: a.text(), ended: endedA }, { text: b.text(), ended: endedB }];
    assert.deepEqual(streamProblems(streams), []);
    assert.ok(a.text().includes('"t":"node.added"'), 'the stream had sent the map first');
    assert.equal((await x.call('boss', 'GET', `${T}/maps/named/events`)).status, 404);
    // Planted faults: a stream ended plainly (no deleted event), and one left open.
    const plain = streams.map((s) => ({ ...s, text: s.text.replace(/event: deleted\ndata: .*\n\n$/, '') }));
    assert.equal(streamProblems(plain).length, 2);
    assert.equal(streamProblems([{ ...streams[0], ended: false }]).length, 1);
  } finally { await x.srv.close(); }
});

/** A cookie DELETE or POST must carry this server's Origin. @param {Record<string, number>} got */
function originProblems(got) {
  const want = { 'delete, foreign Origin': 403, 'delete, no Origin': 403, 'restore, foreign Origin': 403, 'delete, own Origin': 200, 'restore, own Origin': 200 };
  return Object.entries(want).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k}: ${got[k]}, want ${v}`);
}

test('a cookie DELETE or restore POST with a foreign Origin (or none) gets 403', async () => {
  const x = await start();
  try {
    const own = x.url;
    const login = await req(x.url, '/v1/session', { method: 'POST', body: { token: x.secrets.boss }, headers: { origin: own } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    /** @type {Record<string, number>} */
    const got = {};
    got['delete, foreign Origin'] = (await x.call('', 'DELETE', `${T}/maps/named`, undefined, { cookie, origin: 'http://evil.example' })).status;
    got['delete, no Origin'] = (await x.call('', 'DELETE', `${T}/maps/named`, undefined, { cookie })).status;
    const d = await x.call('', 'DELETE', `${T}/maps/named`, undefined, { cookie, origin: own });
    got['delete, own Origin'] = d.status;
    got['restore, foreign Origin'] = (await x.call('', 'POST', `${T}/trash/${d.json?.trashId}/restore`, {}, { cookie, origin: 'http://evil.example' })).status;
    got['restore, own Origin'] = (await x.call('', 'POST', `${T}/trash/${d.json?.trashId}/restore`, {}, { cookie, origin: own })).status;
    assert.deepEqual(originProblems(got), []);
    // Planted fault: a router that took the foreign Origin.
    assert.deepEqual(originProblems({ ...got, 'delete, foreign Origin': 200 }), ['delete, foreign Origin: 200, want 403']);
  } finally { await x.srv.close(); }
});

test('the check order: 401, tenant 404, scope 403, then a missing map 404', async () => {
  const x = await start();
  try {
    /** @type {Array<[string, number, number]>} */
    const rows = [
      ['no token', (await x.call('', 'DELETE', `${T}/maps/named`)).status, 401],
      ['another tenant', (await x.call('boss', 'DELETE', '/v1/t/other/maps/named')).status, 404],
      ['another tenant\'s trash', (await x.call('boss', 'GET', '/v1/t/other/trash')).status, 404],
      ['read scope on a missing map', (await x.call('reader', 'DELETE', `${T}/maps/no-such-map`)).status, 403],
      ['read scope restoring a missing item', (await x.call('reader', 'POST', `${T}/trash/nothing--20260101-000000z/restore`, {})).status, 403],
      ['build scope on a missing map', (await x.call('builder', 'DELETE', `${T}/maps/no-such-map`)).status, 404],
      ['restore a missing item', (await x.call('builder', 'POST', `${T}/trash/nothing--20260101-000000z/restore`, {})).status, 404],
      ['restore with a GET', (await x.call('builder', 'GET', `${T}/trash/nothing--20260101-000000z/restore`)).status, 405],
    ];
    assert.deepEqual(statusProblems(rows), []);
    // Planted fault: a scope check after the missing-map check (read scope would see 404).
    assert.equal(statusProblems([['read scope on a missing map', 404, 403]]).length, 1);
  } finally { await x.srv.close(); }
});

test('restore to a taken name is 409 and names "as"; restore with as; the daily purge removes only expired items', async () => {
  const x = await start();
  try {
    const d = await x.call('boss', 'DELETE', `${T}/maps/named`);
    openStore(x.home).importEvents('named', fixtureEvents('plastic-modeling')); // the name is taken again
    const taken = await x.call('boss', 'POST', `${T}/trash/${d.json.trashId}/restore`, {});
    assert.equal(taken.status, 409);
    assert.equal(taken.json.error, 'That name is not available: restore it under another name (as).');
    assert.equal((await x.call('boss', 'POST', `${T}/trash/${d.json.trashId}/restore`, { as: 'Bad Name' })).status, 400);
    const as = await x.call('boss', 'POST', `${T}/trash/${d.json.trashId}/restore`, { as: 'named-2' });
    assert.deepEqual(as.json, { ok: true, id: 'named-2', viewUrl: `${T}/maps/named-2/view` });
    // The daily purge: an item past 30 days goes, a recent one stays.
    const s = openStore(x.home);
    const old = s.trash('named-2', { now: Date.now() - 31 * DAY });
    const recent = (await x.call('boss', 'DELETE', `${T}/maps/named`)).json.trashId;
    x.srv.purgeTrash();
    const left = ((await x.call('boss', 'GET', `${T}/trash`)).json ?? []).map((/** @type {any} */ t) => t.trashId);
    assert.deepEqual(left, [recent]);
    assert.ok(!left.includes(old));
    const row = (await x.call('boss', 'GET', `${T}/trash`)).json[0];
    assert.equal(row.purgeAt - row.deletedAt, 30 * DAY);
    assert.equal(row.deletedBy, 'token:boss');
  } finally { await x.srv.close(); }
});
