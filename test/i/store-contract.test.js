// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// One contract for the store interface, run on the file store and (with ONTOLOGIZER_PG_URL) on Postgres.
// Every check is a function that returns a list of problems; a planted fault proves it can fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../../src/core/store.js';
import { openPostgresStore } from '../../src/store-postgres/index.js';

/** @typedef {any} AnyStore */
/** @typedef {{ store: AnyStore, reopen: () => Promise<AnyStore>, cleanup: () => Promise<void>, shared: any }} Made */

const rnd = () => crypto.randomBytes(4).toString('hex');
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string} name */
const created = (name) => ({ t: 'ontology.created', at: 0, name, root: 'root', brief: { topic: name }, categories: [] });
/** @param {string} id @param {number} at */
const node = (id, at) => ({ t: 'node.added', at, node: { id, label: id, parent: 'root', category: 'c', summary: '', tags: [] } });

/** JSON with sorted keys: jsonb does not keep key order. @param {any} v @returns {string} */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** Drain an async generator. @param {AsyncIterable<any>} it */
async function drain(it) { const out = []; for await (const x of it) out.push(x); return out; }

/** @param {string[]} out @param {any} cond @param {string} msg */
const need = (out, cond, msg) => { if (!cond) out.push(msg); };
/** @param {() => any} fn @returns {string} */
const thrown = (fn) => { try { fn(); return ''; } catch (/** @type {any} */ e) { return String(e && e.message); } };

/** Drafts, appends, read, list, current, events, now. @param {AnyStore} s @returns {Promise<string[]>} */
async function draftProblems(s) {
  /** @type {string[]} */ const p = [];
  const a = s.createDraft({ topic: 'x' }, 'Plants');
  const b = s.createDraft({ topic: 'y' });
  need(p, /^draft-\d{8}-\d{6}(-\d+)?$/.test(a) && /^draft-\d{8}-\d{6}(-\d+)?$/.test(b), `draft ids look wrong: ${a} ${b}`);
  need(p, a !== b, 'two drafts got the same id');
  need(p, s.current() === b, `current should be the newest draft, got ${s.current()}`);
  need(p, s.list().length === 0, 'drafts must be hidden by default');
  const all = s.list({ drafts: true });
  need(p, all.length === 2 && all.every((/** @type {any} */ r) => r.draft === true), 'list({drafts:true}) should hold both drafts');
  const ra = all.find((/** @type {any} */ r) => r.id === a);
  need(p, ra && ra.name === 'Plants' && ra.root === '' && ra.nodes === 0 && typeof ra.updatedAt === 'number', `bad draft row ${JSON.stringify(ra)}`);
  need(p, all.find((/** @type {any} */ r) => r.id === b)?.name === b, 'unnamed draft takes its id as name');

  await sleep(5);
  s.append(a, created('Plants'));
  s.append(a, node('n1', 10));
  s.append(a, node('n2', 20));
  const o = s.read(a);
  need(p, o.name === 'Plants' && o.root === 'root' && Object.keys(o.nodes).join() === 'n1,n2', `read did not fold: ${JSON.stringify(Object.keys(o.nodes))}`);
  await s.flush(); // the file store refreshes its index row on a 500 ms throttle; flush forces it
  const row = s.list({ drafts: true }).find((/** @type {any} */ r) => r.id === a);
  need(p, row && row.nodes === 2 && row.root === 'root', `row not kept current by append: ${JSON.stringify(row)}`);
  need(p, s.list({ drafts: true })[0].id === a, 'list should put the most recently updated first');

  const all3 = await drain(s.events(a));
  need(p, all3.length === 3 && all3[0].t === 'ontology.created', 'events() should replay all events');
  const from = await drain(s.events(a, { from: 2 }));
  need(p, from.length === 1 && from[0].node.id === 'n2', 'events({from:2}) should yield only the third');
  need(p, (await drain(s.events(a, { from: 9 }))).length === 0, 'events past the end should be empty');

  const n1 = s.now(a); const n2 = s.now(a);
  need(p, n1 >= 20 && n2 >= n1, `now() must be monotonic and >= the last event (${n1}, ${n2})`);
  need(p, s.now(b) === 0, 'now() of an empty map is 0');

  need(p, s.read('draft-19990101-000000').name === '' || typeof s.read('draft-19990101-000000').nodes === 'object', 'read of an unknown id is an empty ontology');
  need(p, Object.keys(s.read('draft-19990101-000000').nodes).length === 0, 'read of an unknown id has no nodes');
  need(p, thrown(() => s.read('../evil')) === 'Invalid ontology id "../evil"', 'read of an invalid id must throw Invalid ontology id');
  need(p, typeof s.sessions.get === 'function' && s.sessions.get('nope') === null, 'sessions.get of nothing is null');
  s.sessions.set(a, { port: 1, pid: process.pid, startedAt: 1 });
  need(p, s.sessions.get(a)?.port === 1, 'sessions.set/get');
  s.sessions.remove(a);
  need(p, s.sessions.get(a) === null, 'sessions.remove');
  need(p, typeof s.root === 'string' && fs.existsSync(s.root), 'root should be an existing folder');
  return p;
}

/** save, resolve, importEvents. @param {AnyStore} s @returns {Promise<string[]>} */
async function namingProblems(s) {
  /** @type {string[]} */ const p = [];
  const d = s.createDraft({}, 'Whales');
  s.append(d, created('Whales'));
  s.append(d, node('w1', 5));
  need(p, s.resolve(d) === d, 'resolve exact id');
  need(p, s.resolve('Whales') === null, 'a draft is not resolved by its name');
  need(p, s.resolve('nothing') === null && s.resolve('') === null, 'resolve of nothing is null');

  need(p, s.save(d, 'whales') === 'whales', 'save returns the name');
  need(p, s.list().map((/** @type {any} */ r) => r.id).join() === 'whales', `after save only "whales" is listed, got ${s.list({ drafts: true }).map((/** @type {any} */ r) => r.id)}`);
  need(p, !s.list({ drafts: true }).some((/** @type {any} */ r) => r.id === d), 'the old draft id must be gone');
  need(p, s.current() === 'whales', 'save makes the map current');
  need(p, Object.keys(s.read('whales').nodes).join() === 'w1' && s.read('whales').name === 'whales', 'saved map keeps its nodes and takes the new name');
  const ev = await drain(s.events('whales'));
  need(p, ev.length === 3 && ev[2].t === 'ontology.renamed' && ev[2].name === 'whales' && typeof ev[2].at === 'number', 'save appends ontology.renamed');
  need(p, (await drain(s.events(d))).length === 0, 'events moved off the old id');
  need(p, s.resolve('whales') === 'whales', 'resolve a saved name');
  need(p, s.list()[0].draft === false && s.list()[0].nodes === 1, 'saved row is not a draft, has its nodes');

  const e1 = s.createDraft({}); s.append(e1, created('Whale songs')); s.save(e1, 'whale-songs');
  const r = s.resolve('whale');
  need(p, r && typeof r === 'object' && r.ambiguous.join() === 'whale-songs,whales', `ambiguous prefix, got ${JSON.stringify(r)}`);
  need(p, s.resolve('whale-s') === 'whale-songs', 'unique prefix');

  const f = s.createDraft({}); s.append(f, created('Other'));
  need(p, /"whales" already exists/.test(thrown(() => s.save(f, 'whales'))), 'save onto an existing name must refuse');
  need(p, s.list({ drafts: true }).some((/** @type {any} */ x) => x.id === f), 'a refused save leaves the draft');
  need(p, s.save(f, 'whales', { overwrite: true }) === 'whales', 'overwrite');
  need(p, s.read('whales').name === 'whales' && Object.keys(s.read('whales').nodes).length === 0, 'overwrite replaces the old map');
  need(p, (await drain(s.events('whales'))).length === 2, 'overwrite replaces the old events');
  need(p, s.list().filter((/** @type {any} */ x) => x.id === 'whales').length === 1, 'overwrite leaves exactly one row');
  need(p, /reserved name/.test(thrown(() => s.save(f, 'tenants'))), 'reserved name tenants');
  for (const bad of ['Bad Name', '-x', '', 'a/b', 'UPPER']) {
    need(p, /^Invalid name ".*": use lowercase letters, digits and hyphens \(kebab-case\)\.$/.test(thrown(() => s.save(d, bad))), `invalid name "${bad}"`);
  }

  const imp = [created('Imported'), node('i1', 3), node('i2', 4)];
  need(p, s.importEvents('imported', imp) === 'imported', 'importEvents returns the name');
  need(p, Object.keys(s.read('imported').nodes).join() === 'i1,i2', 'imported events fold');
  need(p, (await drain(s.events('imported'))).length === 3, 'imported events are all stored');
  need(p, s.list().find((/** @type {any} */ x) => x.id === 'imported')?.nodes === 2, 'imported row has its node count');
  need(p, s.resolve('imported') === 'imported', 'imported map resolves');
  need(p, thrown(() => s.importEvents('imported', imp)) === '"imported" already exists.', 'duplicate import');
  need(p, /reserved name/.test(thrown(() => s.importEvents('tenants', imp))), 'import under a reserved name');
  need(p, /^Invalid name/.test(thrown(() => s.importEvents('No Good', imp))), 'import under an invalid name');
  return p;
}

/** subscribe and unsubscribe. @param {AnyStore} s @returns {Promise<string[]>} */
async function subscribeProblems(s) {
  /** @type {string[]} */ const p = [];
  const id = s.createDraft({});
  /** @type {any[]} */ const seen = [];
  const off = s.subscribe(id, (/** @type {any} */ e, /** @type {number} */ i) => seen.push([e.t, i]));
  s.append(id, created('Subs'));
  need(p, seen.length === 1, 'subscriber must be called synchronously inside append');
  s.append(id, node('a', 1));
  need(p, JSON.stringify(seen) === '[["ontology.created",0],["node.added",1]]', `subscriber got ${JSON.stringify(seen)}`);
  off();
  s.append(id, node('b', 2));
  need(p, seen.length === 2, 'unsubscribe must stop further calls');
  return p;
}

/** Data survives a reopen. @param {AnyStore} s @param {() => Promise<AnyStore>} reopen @returns {Promise<string[]>} */
async function persistenceProblems(s, reopen) {
  /** @type {string[]} */ const p = [];
  const d = s.createDraft({ topic: 'k' }, 'Keep');
  s.append(d, created('Keep')); s.append(d, node('k1', 7));
  s.save(d, 'keep');
  const dr = s.createDraft({}, 'Scratch'); s.append(dr, created('Scratch'));
  s.importEvents('imp', [created('Imp'), node('m1', 1)]);
  const before = canon(s.read('keep'));
  const rowsBefore = s.list({ drafts: true }).map((/** @type {any} */ r) => [r.id, r.name, r.root, r.nodes, r.draft]);
  const cur = s.current();
  const s2 = await reopen();
  need(p, canon(s2.read('keep')) === before, 'read() differs after reopen');
  const rowsAfter = s2.list({ drafts: true }).map((/** @type {any} */ r) => [r.id, r.name, r.root, r.nodes, r.draft]);
  need(p, JSON.stringify(rowsAfter.sort()) === JSON.stringify(rowsBefore.sort()), `rows differ after reopen: ${JSON.stringify(rowsAfter)} vs ${JSON.stringify(rowsBefore)}`);
  need(p, s2.current() === cur, `current differs after reopen: ${s2.current()} vs ${cur}`);
  need(p, (await drain(s2.events('keep'))).length === 3, 'events differ after reopen');
  need(p, Object.keys(s2.read('imp').nodes).join() === 'm1', 'imported map differs after reopen');
  need(p, s2.resolve('kee') === 'keep', 'resolve after reopen');
  try {
    s2.append('keep', node('k2', 9));
    need(p, Object.keys(s2.read('keep').nodes).join() === 'k1,k2', 'append after reopen continues the sequence');
  } catch (/** @type {any} */ e) { p.push(`append after reopen failed: ${e.message}`); }
  await s2.flush();
  if (s2.close) await s2.close();
  return p;
}

/** Two tenants on one backing never see each other. @param {() => Promise<Made>} makeA @param {() => Promise<Made>} makeB @returns {Promise<string[]>} */
async function isolationProblems(makeA, makeB) {
  /** @type {string[]} */ const p = [];
  const A = await makeA(); const B = await makeB();
  const a = A.store; const b = B.store;
  const da = a.createDraft({}, 'Alpha'); a.append(da, created('Alpha')); a.append(da, node('a1', 1)); a.save(da, 'alpha');
  const db = b.createDraft({}, 'Beta'); b.append(db, created('Beta')); b.save(db, 'beta');
  const ids = (/** @type {AnyStore} */ s) => s.list({ drafts: true }).map((/** @type {any} */ r) => r.id).join();
  need(p, ids(a) === 'alpha', `tenant A lists "${ids(a)}"`);
  need(p, ids(b) === 'beta', `tenant B lists "${ids(b)}"`);
  need(p, a.resolve('beta') === null && a.resolve('bet') === null, 'tenant A resolves a name of tenant B');
  need(p, b.resolve('alpha') === null && b.resolve('alp') === null, 'tenant B resolves a name of tenant A');
  need(p, a.current() === 'alpha' && b.current() === 'beta', `current leaked: ${a.current()} / ${b.current()}`);
  need(p, Object.keys(b.read('alpha').nodes).length === 0, 'tenant B reads tenant A nodes');
  need(p, (await drain(b.events('alpha'))).length === 0, 'tenant B reads tenant A events');
  need(p, (await drain(a.events('beta'))).length === 0, 'tenant A reads tenant B events');
  // the same map name in both tenants stays separate, also after a reopen
  try {
  a.importEvents('shared-name', [created('A side'), node('x', 1)]);
  b.importEvents('shared-name', [created('B side')]);
  await a.flush(); await b.flush();
  need(p, Object.keys(a.read('shared-name').nodes).length === 1 && Object.keys(b.read('shared-name').nodes).length === 0, 'same-named maps mix their contents');
  const a2 = await A.reopen(); const b2 = await B.reopen();
  need(p, ids(a2) === 'alpha,shared-name' || ids(a2) === 'shared-name,alpha', `tenant A after reopen lists "${ids(a2)}"`);
  need(p, ids(b2).split(',').sort().join() === 'beta,shared-name', `tenant B after reopen lists "${ids(b2)}"`);
  need(p, a2.read('shared-name').name === 'A side' && b2.read('shared-name').name === 'B side', 'same-named maps mix after reopen');
  // saving with overwrite in one tenant must not delete the other tenant's map of that name
  const dd = a2.createDraft({}); a2.append(dd, created('Over')); a2.save(dd, 'shared-name', { overwrite: true });
  await a2.flush();
  const b3 = await B.reopen();
  need(p, b3.read('shared-name').name === 'B side', 'an overwrite in tenant A removed tenant B data');
  await a2.flush(); await b2.flush();
  } catch (/** @type {any} */ e) { p.push(`same-name step threw: ${e.message}`); }
  return p;
}

/** Register the same tests for one backend. @param {string} label @param {(shared?: any) => Promise<Made>} make @param {{ skip?: string }} [opts] */
function contract(label, make, opts = {}) {
  /** @param {(m: Made) => Promise<string[]>} fn */
  const run = (fn) => async () => {
    const m = await make();
    try {
      const problems = await fn(m);
      await m.store.flush();
      assert.deepEqual(problems, []);
    } finally { await m.cleanup(); }
  };
  test(`${label}: drafts, append, read, list, events, now`, opts, run((m) => draftProblems(m.store)));
  test(`${label}: save, resolve, import`, opts, run((m) => namingProblems(m.store)));
  test(`${label}: subscribe and unsubscribe`, opts, run((m) => subscribeProblems(m.store)));
  test(`${label}: data survives reopen`, opts, run((m) => persistenceProblems(m.store, m.reopen)));
  test(`${label}: tenants are isolated`, opts, async () => {
    const a = await make();
    const b = await make(a.shared);
    try {
      assert.deepEqual(await isolationProblems(async () => a, async () => b), []);
    } finally { await a.cleanup(); await b.cleanup(); }
  });
}

// ---- backends ----

/** @param {any} [shared] @returns {Promise<Made>} */
async function makeFile(shared) {
  const home = shared?.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'onto-contract-'));
  const tenant = `t${rnd()}`;
  const open = async () => openStore(home, { tenant });
  const store = await open();
  return {
    store, shared: { home }, reopen: open,
    cleanup: async () => { if (!shared) fs.rmSync(home, { recursive: true, force: true }); },
  };
}

const PG_URL = process.env.ONTOLOGIZER_PG_URL;

/** @param {any} [shared] @returns {Promise<Made>} */
async function makePg(shared) {
  const tenant = `t${rnd()}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-contract-pg-'));
  /** @type {AnyStore[]} */ const opened = [];
  const open = async () => {
    const s = openPostgresStore({ url: PG_URL, tenant, root });
    await s.ready;
    opened.push(s);
    return s;
  };
  const store = await open();
  return {
    store, shared: { tenant }, // One writer per tenant: the previous store must release its lock before a reopen.
    reopen: async () => { await store.flush(); for (const o of opened) await o.close(); return open(); },
    cleanup: async () => {
      for (const s of opened) { try { await s.flush(); } catch { /* reported by the test */ } }
      const pg = await import('pg');
      const pool = new pg.default.Pool({ connectionString: PG_URL, max: 1 });
      try {
        await pool.query('DELETE FROM ontologizer_events WHERE tenant = $1', [tenant]);
        await pool.query('DELETE FROM ontologizer_maps WHERE tenant = $1', [tenant]);
      } finally { await pool.end(); }
      for (const s of opened) await s.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

contract('file store', makeFile);
contract('postgres store', makePg, PG_URL ? {} : { skip: 'ONTOLOGIZER_PG_URL is not set' });

// ---- planted faults: each check must report a deliberately broken store ----

/** A store whose tenant filter is missing: both tenants get the same instance. @returns {() => Promise<Made>} */
function ignoresTenant() {
  /** @type {Promise<Made>|null} */ let one = null;
  return async () => { one ??= makeFile(); return one; };
}

/** Wrap a store with overrides, keeping every other method bound to the real one. @param {AnyStore} s @param {Record<string, any>} over */
function wrap(s, over) {
  const out = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'function' ? v.bind(s) : v]));
  return Object.assign(out, over);
}

test('planted fault: isolation check reports a store that ignores the tenant', async () => {
  const one = ignoresTenant();
  const problems = await isolationProblems(one, one);
  assert.ok(problems.length > 0, 'the isolation check let a tenant-blind store through');
  assert.ok(problems.some((x) => /tenant A lists/.test(x)), problems.join('; '));
});

test('planted fault: save that keeps the old id listed is reported', async () => {
  const m = await makeFile();
  const real = m.store;
  /** @type {any[]} */ const ghosts = [];
  const faulty = wrap(real, {
    save(/** @type {string} */ id, /** @type {string} */ name, /** @type {any} */ o) {
      const old = real.list({ drafts: true }).find((/** @type {any} */ r) => r.id === id);
      const out = real.save(id, name, o);
      if (old) ghosts.push(old);
      return out;
    },
    list(/** @type {any} */ o) { return [...real.list(o), ...ghosts]; },
  });
  try {
    const problems = await namingProblems(faulty);
    assert.ok(problems.some((x) => /old draft id must be gone|only "whales" is listed/.test(x)), problems.join('; '));
  } finally { await m.cleanup(); }
});

test('planted fault: unsubscribe that does not stop calls is reported', async () => {
  const m = await makeFile();
  const faulty = wrap(m.store, { subscribe(/** @type {string} */ id, /** @type {any} */ fn) { m.store.subscribe(id, fn); return () => {}; } });
  try {
    const problems = await subscribeProblems(faulty);
    assert.deepEqual(problems, ['unsubscribe must stop further calls']);
  } finally { await m.cleanup(); }
});

test('planted fault: a clock that runs backwards is reported by now()', async () => {
  const m = await makeFile();
  let n = 1000;
  const faulty = wrap(m.store, { now() { return (n -= 10); } });
  try {
    assert.ok((await draftProblems(faulty)).some((x) => /monotonic/.test(x)));
  } finally { await m.cleanup(); }
});

test('planted fault: a store that forgets everything on reopen is reported', async () => {
  const m = await makeFile();
  try {
    const problems = await persistenceProblems(m.store, async () => (await makeFile()).store);
    assert.ok(problems.length > 0);
  } finally { await m.cleanup(); }
});

// ---- Postgres store without a server: a recording pool ----

/** Every query must carry the tenant as its first parameter and name the tenant column. @param {{ sql: string, params: any[] }[]} log @param {string} tenant */
function scopeProblems(log, tenant) {
  /** @type {string[]} */ const p = [];
  for (const q of log) {
    if (/^\s*CREATE TABLE/i.test(q.sql)) continue;
    if (!/tenant/.test(q.sql)) p.push(`no tenant in: ${q.sql.replace(/\s+/g, ' ').slice(0, 70)}`);
    else if (q.params[0] !== tenant) p.push(`tenant is not the first parameter of: ${q.sql.replace(/\s+/g, ' ').slice(0, 70)}`);
    if (/\$\d/.test(q.sql) === false && q.params.length) p.push('parameters given but not used');
  }
  return p;
}

/** @param {(sql: string) => void} [failOn] */
function fakePool(failOn) {
  /** @type {{ sql: string, params: any[] }[]} */ const log = [];
  return {
    log,
    pool: {
      query: async (/** @type {string} */ sql, /** @type {any[]} */ params = []) => {
        log.push({ sql, params });
        if (failOn) failOn(sql);
        return { rows: [] };
      },
      end: async () => {},
    },
  };
}

test('postgres store: every query is scoped by tenant and parameterised', async () => {
  const { pool, log } = fakePool();
  const s = openPostgresStore({ pool, tenant: 'acme', root: fs.mkdtempSync(path.join(os.tmpdir(), 'onto-fake-')) });
  await s.ready;
  const d = s.createDraft({ topic: 'x' }, 'X'); s.append(d, created('X')); s.save(d, 'x');
  s.importEvents('y', [created('Y')]);
  const d2 = s.createDraft({}); s.append(d2, created('Z')); s.save(d2, 'y', { overwrite: true });
  await s.flush();
  assert.ok(log.length > 8);
  assert.deepEqual(scopeProblems(log, 'acme'), []);
  // planted fault: a query that forgot its tenant filter
  const bad = [...log, { sql: 'SELECT * FROM ontologizer_maps WHERE id = $1', params: ['x'] }];
  assert.ok(scopeProblems(bad, 'acme').length > 0);
  const bad2 = [...log, { sql: 'DELETE FROM ontologizer_events WHERE map_id = $2 AND tenant = $1', params: ['x', 'acme'] }];
  assert.ok(scopeProblems(bad2, 'acme').length > 0);
});

test('postgres store: a failed write rejects flush and goes to log', async () => {
  const { pool } = fakePool((sql) => { if (/^\s*INSERT INTO ontologizer_maps/.test(sql)) throw new Error('disk full'); });
  /** @type {string[]} */ const lines = [];
  const s = openPostgresStore({ pool, root: fs.mkdtempSync(path.join(os.tmpdir(), 'onto-fake-')), log: (l) => lines.push(l) });
  await s.ready;
  s.createDraft({});
  assert.equal(s.list({ drafts: true }).length, 1, 'memory is updated at once');
  await assert.rejects(s.flush(), /disk full/);
  assert.ok(lines.some((l) => /disk full/.test(l)));
});

test('postgres store: an invalid tenant is refused', () => {
  const { pool } = fakePool();
  assert.throws(() => openPostgresStore({ pool, tenant: 'Bad Tenant' }), /Invalid tenant "Bad Tenant": use lowercase letters, digits and hyphens \(at most 63 characters\)\./);
});

// ---- fail-stop, sync, transactions, lock and row visibility, without a server ----

/** A pool with `connect`: records every statement and which client ran it. @param {(sql: string, params: any[]) => any} [hook] */
function txPool(hook) {
  /** @type {string[]} */ const calls = [];
  /** @param {string} who */
  const run = (who) => async (/** @type {string} */ sql, /** @type {any[]} */ params = []) => {
    calls.push(`${who}: ${sql.replace(/\s+/g, ' ').trim().slice(0, 60)}`);
    if (hook) hook(sql, params);
    return { rows: /pg_try_advisory_lock/.test(sql) ? [{ ok: true }] : [] };
  };
  let n = 0;
  return { calls, pool: { query: run('pool'), connect: async () => { const who = `c${++n}`; return { query: run(who), release: () => calls.push(`${who}: release`) }; }, end: async () => {} } };
}

test('postgres store: after a failed write nothing else is written and every mutator throws STORE_FAILED', async () => {
  let inserts = 0;
  const { pool, log } = fakePool((sql) => { if (/^\s*INSERT INTO ontologizer_events/.test(sql) && ++inserts === 2) throw new Error('boom'); });
  /** @type {string[]} */ const lines = [];
  const s = openPostgresStore({ pool, root: fs.mkdtempSync(path.join(os.tmpdir(), 'onto-fake-')), log: (l) => lines.push(l) });
  await s.ready;
  assert.equal(s.failed, null);
  const d = s.createDraft({});
  s.append(d, created('A')); s.append(d, node('n1', 1)); s.append(d, node('n2', 2)); s.append(d, node('n3', 3));
  await assert.rejects(s.sync(), /^Error: The Postgres store stopped after a write failed: boom/);
  assert.equal(inserts, 2, 'no insert ran after the failure');
  assert.equal(log.filter((q) => /INSERT INTO ontologizer_events/.test(q.sql)).length, 2);
  assert.equal(s.failed?.message, 'boom');
  assert.equal(lines.length, 1);
  // Every mutator, and every read too: memory may hold events Postgres never stored, so a failed
  // store serves nothing. Planted fault: a read that still answers from memory (the failed write's node).
  for (const fn of [() => s.append(d, node('n4', 4)), () => s.createDraft({}), () => s.save(d, 'a'), () => s.importEvents('b', [created('B')]),
    () => s.read(d), () => s.list({ drafts: true }), () => s.resolve('a')]) {
    assert.throws(fn, (/** @type {any} */ e) => e.code === 'STORE_FAILED' && /^The Postgres store stopped after a write failed:/.test(e.message));
  }
  await assert.rejects(async () => { for await (const _ of s.events(d)) { /* nothing */ } }, (/** @type {any} */ e) => e.code === 'STORE_FAILED');
  await assert.rejects(s.flush(), (/** @type {any} */ e) => e.code === 'STORE_FAILED');
});

test('postgres store: save, createDraft and importEvents run in one transaction; the lock is taken and released', async () => {
  const { pool, calls } = txPool();
  const s = openPostgresStore({ pool, tenant: 'acme', root: fs.mkdtempSync(path.join(os.tmpdir(), 'onto-fake-')) });
  await s.ready;
  assert.match(calls[0], /^c1: SELECT pg_try_advisory_lock\(hashtext\('ontologizer:' \|\| \$1\)\)/);
  const d = s.createDraft({}); s.append(d, created('A')); s.save(d, 'a'); s.importEvents('b', [created('B')]);
  await s.sync();
  const tx = calls.filter((c) => /^c[2-9]/.test(c));
  const groups = []; let cur = null;
  for (const c of tx) { if (/BEGIN/.test(c)) cur = []; if (cur) cur.push(c); if (/COMMIT|ROLLBACK/.test(c) && cur) { groups.push(cur); cur = null; } }
  assert.equal(groups.length, 3, `expected 3 transactions, got ${JSON.stringify(calls)}`);
  assert.ok(groups.every((g) => new Set(g.map((c) => c.split(':')[0])).size === 1 && /COMMIT/.test(g[g.length - 1])), 'one client, committed');
  await s.close();
  assert.ok(calls.some((c) => /^c1: SELECT pg_advisory_unlock/.test(c)) && calls[calls.length - 1] === 'c1: release');
  // a failing last statement of save must end in ROLLBACK and never COMMIT
  const bad = txPool((sql) => { if (/draft = false, is_current = true/.test(sql)) throw new Error('nope'); });
  const s2 = openPostgresStore({ pool: bad.pool, root: fs.mkdtempSync(path.join(os.tmpdir(), 'onto-fake-')) });
  await s2.ready;
  const d2 = s2.createDraft({}); s2.append(d2, created('A')); s2.save(d2, 'a');
  await assert.rejects(s2.flush(), /nope/);
  const txCalls = bad.calls.filter((c) => /^c3/.test(c)); // the save's transaction (c2 is createDraft's)
  assert.ok(txCalls.some((c) => /ROLLBACK/.test(c)) && !txCalls.some((c) => /COMMIT/.test(c)), JSON.stringify(txCalls));
});

test('postgres store: a refused lock rejects ready and releases the client', async () => {
  const calls = /** @type {string[]} */ ([]);
  const pool = { query: async () => ({ rows: [] }), end: async () => {},
    connect: async () => ({ query: async () => ({ rows: [{ ok: false }] }), release: () => calls.push('release') }) };
  const s = openPostgresStore({ pool, tenant: 'acme', root: fs.mkdtempSync(path.join(os.tmpdir(), 'onto-fake-')) });
  await assert.rejects(s.ready, /^Error: Another process already has the Postgres store for tenant "acme" open \(one server per tenant\)\.$/);
  assert.deepEqual(calls, ['release']);
});

test('postgres store: rows carry visibility only when private, kept current by append', async () => {
  const { pool } = fakePool();
  const s = openPostgresStore({ pool, root: fs.mkdtempSync(path.join(os.tmpdir(), 'onto-fake-')) });
  await s.ready;
  const d = s.createDraft({}); s.append(d, created('V'));
  const row = () => s.list({ drafts: true })[0];
  assert.deepEqual(Object.keys(row()).sort(), ['draft', 'id', 'name', 'nodes', 'root', 'updatedAt']);
  s.append(d, { t: 'visibility.raised', at: 1, to: 'private', reason: 'source', sources: ['b', 'a'] });
  assert.equal(row().visibility, 'private');
  assert.deepEqual(row().privateSources, ['a', 'b']);
  // planted fault: a public row must not pass the same check
  const pub = s.list({ drafts: true })[0]; delete pub.visibility;
  assert.notEqual(pub.visibility, 'private');
});
