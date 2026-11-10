// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// Store recovery: a draft is written with its events in one step, a crash between a raise and its index
// write is repaired (service mode only), list() never shows a stale visibility, the Postgres draft is
// transactional, a lost lock connection stops the store without crashing the host, and the existence check.
// Every check is a function that returns problems; each has a planted fault proving it can fail.
// The Postgres parts need ONTOLOGIZER_PG_URL (a throwaway database); they are skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../../src/core/store.js';
import { foldAll, makeEvent } from '../../src/core/events.js';
import { openPostgresStore, postgresTenantExists, postgresStorePort } from '../../src/store-postgres/index.js';

const PG_URL = process.env.ONTOLOGIZER_PG_URL;
const pgOpts = PG_URL ? {} : { skip: 'ONTOLOGIZER_PG_URL is not set' };

const rnd = () => crypto.randomBytes(4).toString('hex');
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-recovery-'));
/** @param {string} dir */
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });
/** @param {string} file */
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const BRIEF = { context: 'glue', subject: 'Glue', scope: 's', purpose: 'p', level: 'beginner' };
const created = () => makeEvent('ontology.created', { name: 'Glue Map', root: 'glue', brief: BRIEF, categories: [] }, 0);
const raise = () => makeEvent('visibility.raised', { to: 'private', reason: 'sources-picked', sources: ['wiki', 'docs'] }, 0);
const nodeEv = (/** @type {string} */ id) => makeEvent('node.added', { node: { id, label: id, parent: 'glue', category: 'c', depth: 1, summary: '', hook: '', sources: [], article: null, status: 'done', origin: 'context', createdBy: 'wave1' } }, 5);

// ---- checks (files) ----

/** Problems in a draft's row: name and root from ontology.created, private with its sources when raised.
 *  @param {any} row @param {boolean} raised */
function draftRowProblems(row, raised) {
  /** @type {string[]} */ const p = [];
  if (!row) return ['no row'];
  if (row.name !== 'Glue Map') p.push(`name is ${row.name}`);
  if (row.root !== 'glue') p.push(`root is ${row.root}`);
  if (raised) {
    if (row.visibility !== 'private') p.push('a draft with a raise has no visibility');
    if (JSON.stringify(row.privateSources) !== '["docs","wiki"]') p.push(`privateSources is ${JSON.stringify(row.privateSources)}`);
  } else if ('visibility' in row || 'privateSources' in row) p.push('a public draft carries visibility');
  return p;
}

/** Rows (in one tenant root) whose events say private while the row lacks it. @param {string} root @returns {string[]} */
function staleRows(root) {
  /** @type {string[]} */ const p = [];
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
  for (const r of idx.ontologies) {
    const evs = readLines(path.join(root, r.id, 'events.jsonl'));
    if (foldAll(evs).visibility === 'private' && r.visibility !== 'private') p.push(`${r.id}: events are private, the row is not`);
  }
  return p;
}
const diskRow = (/** @type {string} */ root, /** @type {string} */ id) => JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8')).ontologies.find((/** @type {any} */ r) => r.id === id);

test('files createDraft with events: the log has them from the start, the row says private', () => {
  const home = tmp();
  try {
    const s = openStore(home);
    const evs = [created(), raise()];
    const id = s.createDraft(BRIEF, 'x', { events: evs });
    const logged = readLines(path.join(s.root, id, 'events.jsonl'));
    assert.deepEqual(logged, evs);
    assert.deepEqual(draftRowProblems(diskRow(s.root, id), true), []);
    assert.deepEqual(staleRows(s.root), []);
    assert.equal(s.read(id).visibility, 'private');

    // a draft with only ontology.created is a public row
    const id2 = s.createDraft(BRIEF, 'x', { events: [created()] });
    assert.deepEqual(draftRowProblems(diskRow(s.root, id2), false), []);

    // planted fault: a row without visibility for a draft with a raise is reported
    const { visibility, privateSources, ...bare } = diskRow(s.root, id);
    assert.ok(draftRowProblems(bare, true).length >= 1);
    // planted fault: the row the old (create empty, then append) path left is reported
    assert.ok(draftRowProblems({ ...bare, name: id, root: '' }, true).length >= 2);
  } finally { rm(home); }
});

test('files repair: a raise in the log but not in the row is fixed with repair only', () => {
  const home = tmp();
  try {
    const id = openStore(home).createDraft(BRIEF, 'x', { events: [created(), nodeEv('glue')] });
    const root = openStore(home).root;
    // the crash: the raise reached events.jsonl, the index write never ran
    fs.appendFileSync(path.join(root, id, 'events.jsonl'), JSON.stringify(raise()) + '\n');
    assert.equal(staleRows(root).length, 1);   // planted fault: the stale row is reported

    openStore(home);   // the CLI path: no repair
    assert.equal(staleRows(root).length, 1);
    assert.equal(diskRow(root, id).visibility, undefined);

    /** @type {string[]} */ const logged = [];
    openStore(home, { repair: true, log: (l) => logged.push(l) });
    assert.deepEqual(staleRows(root), []);
    assert.equal(diskRow(root, id).visibility, 'private');
    assert.deepEqual(diskRow(root, id).privateSources, ['docs', 'wiki']);
    assert.equal(logged.filter((l) => /repaired/.test(l) && l.includes(id)).length, 1);
    // a second repair has nothing to fix and says nothing
    /** @type {string[]} */ const again = [];
    openStore(home, { repair: true, log: (l) => again.push(l) });
    assert.deepEqual(again, []);
  } finally { rm(home); }
});

test('files list(): a raise shows at once even when the index write fails, and the next append retries', async () => {
  const home = tmp();
  const realRename = fs.renameSync;
  try {
    /** @type {string[]} */ const logged = [];
    const s = openStore(home, { log: (l) => logged.push(l) });
    const id = s.createDraft(BRIEF, 'x', { events: [created(), nodeEv('glue')] });
    s.read(id);   // load it into memory
    const indexTmp = (/** @type {any} */ f) => /index\.json\..*\.tmp$/.test(String(f));
    // @ts-ignore test double
    fs.renameSync = (from, to) => { if (indexTmp(from)) throw Object.assign(new Error('EIO boom'), { code: 'EIO' }); return realRename(from, to); };
    try { s.append(id, raise()); } finally { fs.renameSync = realRename; }

    assert.equal(logged.length, 1, `logged ${JSON.stringify(logged)}`);
    assert.match(logged[0], /could not update the index/);
    assert.equal(diskRow(s.root, id).visibility, undefined);          // the disk is stale
    const row = s.list({ drafts: true }).find((r) => r.id === id);
    assert.equal(row?.visibility, 'private');                         // the list is not
    assert.deepEqual(row?.privateSources, ['docs', 'wiki']);

    // planted fault: a list that reads only the disk row shows it public
    const diskOnly = JSON.parse(fs.readFileSync(path.join(s.root, 'index.json'), 'utf8')).ontologies.find((/** @type {any} */ r) => r.id === id);
    assert.notEqual(diskOnly.visibility, 'private');

    s.append(id, nodeEv('more'));   // the next append retries (throttled)
    await sleep(900);
    assert.equal(diskRow(s.root, id).visibility, 'private');
    assert.equal(logged.length, 1);
    s.flush(id);
  } finally { fs.renameSync = realRename; rm(home); }
});

// ---- checks (postgres) ----

/** Rows the tenant holds; a draft written with a raise must have its map row, its events, or neither: never a row without them.
 *  @param {{ maps: number, events: number }} c @param {number} expectEvents @returns {string[]} */
function atomicProblems(c, expectEvents) {
  /** @type {string[]} */ const p = [];
  if (c.maps === 0 && c.events !== 0) p.push(`${c.events} events without a map row`);
  if (c.maps > 0 && c.events !== expectEvents) p.push(`a map row with ${c.events} of ${expectEvents} events (it would reload as a public draft)`);
  return p;
}

/** After the lock is lost the store must write nothing: the row counts must not move. @param {{ maps: number, events: number }} before @param {{ maps: number, events: number }} after @returns {string[]} */
function writesAfterLoss(before, after) {
  /** @type {string[]} */ const p = [];
  if (after.maps !== before.maps) p.push(`maps went from ${before.maps} to ${after.maps}`);
  if (after.events !== before.events) p.push(`events went from ${before.events} to ${after.events}`);
  return p;
}

/** @returns {Promise<{ tenant: string, admin: any, pg: any, count: () => Promise<{maps:number,events:number}>, cleanup: () => Promise<void>, track: (s:any)=>any }>} */
async function kit() {
  const tenant = `r${rnd()}`;
  const pg = await import('pg');
  const admin = new pg.default.Pool({ connectionString: PG_URL, max: 4 });
  /** @type {any[]} */ const stores = [];
  return {
    tenant, admin, pg,
    track: (s) => { stores.push(s); return s; },
    async count() {
      const m = await admin.query('SELECT count(*)::int AS n FROM ontologizer_maps WHERE tenant = $1', [tenant]);
      const e = await admin.query('SELECT count(*)::int AS n FROM ontologizer_events WHERE tenant = $1', [tenant]);
      return { maps: m.rows[0].n, events: e.rows[0].n };
    },
    async cleanup() {
      for (const s of stores) { try { await s.close(); } catch { /* the test reports it */ } }
      try {
        await admin.query('DELETE FROM ontologizer_events WHERE tenant = $1', [tenant]);
        await admin.query('DELETE FROM ontologizer_maps WHERE tenant = $1', [tenant]);
      } catch { /* the tables may not exist */ }
      await admin.end();
    },
  };
}

test('postgres createDraft with events is one transaction: a failed events insert leaves nothing', pgOpts, async () => {
  const k = await kit();
  try {
    const real = new k.pg.default.Pool({ connectionString: PG_URL, max: 4 });
    const guarded = (/** @type {any} */ db) => async (/** @type {string} */ sql, /** @type {any[]} */ params = []) => {
      if (/INSERT INTO ontologizer_events/.test(sql)) throw new Error('injected: events insert failed');
      return db.query(sql, params);
    };
    const wrapped = { query: guarded(real), end: async () => {}, connect: async () => { const c = await real.connect(); return { query: guarded(c), release: () => c.release() }; } };
    /** @type {string[]} */ const logged = [];
    const a = k.track(openPostgresStore({ pool: wrapped, tenant: k.tenant, root: tmp(), log: (l) => logged.push(l) }));
    await a.ready;
    a.createDraft(BRIEF, 'x', { events: [created(), raise()] });
    await assert.rejects(() => a.sync(), /injected|stopped/);
    assert.equal(a.failed instanceof Error, true);
    await a.close();
    await real.end();

    assert.deepEqual(atomicProblems(await k.count(), 2), []);
    // a clean store sees no draft, public or private
    const b = k.track(openPostgresStore({ url: PG_URL, tenant: k.tenant, root: tmp() }));
    await b.ready;
    assert.deepEqual(b.list({ drafts: true }), []);
    assert.equal(b.current(), null);
    await b.close();

    // planted fault: what a non-transactional write leaves (a map row with no raise) is reported
    assert.equal(atomicProblems({ maps: 1, events: 0 }, 2).length, 1);
    assert.equal(atomicProblems({ maps: 1, events: 1 }, 2).length, 1);
    // and a good write is clean
    const c = k.track(openPostgresStore({ url: PG_URL, tenant: k.tenant, root: tmp() }));
    await c.ready;
    const id = c.createDraft(BRIEF, 'x', { events: [created(), raise()] });
    await c.sync();
    assert.deepEqual(atomicProblems(await k.count(), 2), []);
    assert.equal(c.list({ drafts: true }).find((r) => r.id === id)?.visibility, 'private');
  } finally { await k.cleanup(); }
});

test('postgres lost lock connection: no crash, the store fails, reads and writes throw, another store opens, nothing more is written', pgOpts, async () => {
  const k = await kit();
  let uncaught = 0;
  const spy = () => { uncaught++; };
  process.on('uncaughtException', spy);
  try {
    /** @type {string[]} */ const logged = [];
    const a = k.track(openPostgresStore({ url: PG_URL, tenant: k.tenant, root: tmp(), log: (l) => logged.push(l) }));
    await a.ready;
    const id = a.createDraft(BRIEF, 'x', { events: [created()] });
    a.append(id, nodeEv('glue'));
    await a.sync();
    assert.equal(a.failed, null);

    const lock = await k.admin.query(
      "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 1 AND objid = (hashtext('ontologizer:' || $1)::bigint & 4294967295)::oid",
      [k.tenant]);
    assert.equal(lock.rows.length, 1, 'the advisory lock backend is found');
    await k.admin.query('SELECT pg_terminate_backend($1)', [lock.rows[0].pid]);
    for (let i = 0; i < 100 && !a.failed; i++) await sleep(20);

    assert.ok(a.failed, 'failed is set');
    assert.match(a.failed.message, /lock connection was lost/);
    for (const fn of [
      () => a.append(id, nodeEv('late')), () => a.read(id), () => a.list(), () => a.resolve('x'),
      () => a.events(id).next(),
    ]) {
      /** @type {any} */ let err = null;
      try { await fn(); } catch (e) { err = e; }
      assert.equal(err && err.code, 'STORE_FAILED');
    }

    // a second store on the same tenant now opens, and A writes nothing more
    const before = await k.count();
    const c = k.track(openPostgresStore({ url: PG_URL, tenant: k.tenant, root: tmp() }));
    await c.ready;
    assert.equal(c.failed, null);
    assert.equal(c.list({ drafts: true }).length, 1);
    try { a.append(id, nodeEv('attempt')); } catch { /* refused */ }
    await sleep(100);
    const after = await k.count();
    assert.deepEqual(writesAfterLoss(before, after), []);
    await c.close();

    // planted fault: a store that kept writing after losing its lock is reported
    assert.equal(writesAfterLoss(before, { maps: before.maps, events: before.events + 1 }).length, 1);
    assert.equal(uncaught, 0, 'no uncaughtException');
  } finally {
    process.off('uncaughtException', spy);
    await k.cleanup();
  }
});

test('postgres postgresTenantExists and postgresStorePort', pgOpts, async () => {
  const k = await kit();
  const schema = `rec_${rnd()}`;
  try {
    const s = k.track(openPostgresStore({ url: PG_URL, tenant: k.tenant, root: tmp() }));
    await s.ready;   // the tables exist now
    assert.equal(await postgresTenantExists({ pool: k.admin, tenant: k.tenant }), false);
    s.createDraft(BRIEF, 'x', { events: [created()] });
    await s.sync();
    assert.equal(await postgresTenantExists({ pool: k.admin, tenant: k.tenant }), true);
    assert.equal(await postgresTenantExists({ url: PG_URL, tenant: k.tenant }), true);
    assert.equal(await postgresTenantExists({ pool: k.admin, tenant: 'Not Valid' }), false);

    // the tables do not exist: a fresh schema on a dedicated pool
    await k.admin.query(`CREATE SCHEMA ${schema}`);
    const bare = new k.pg.default.Pool({ connectionString: PG_URL, max: 1, options: `-c search_path=${schema}` });
    try { assert.equal(await postgresTenantExists({ pool: bare, tenant: k.tenant }), false); } finally { await bare.end(); }

    const port = postgresStorePort({ url: PG_URL });
    assert.equal(typeof port, 'function');
    assert.equal(typeof port.exists, 'function');
    assert.equal(await port.exists(k.tenant), true);
    assert.equal(await port.exists(`z${rnd()}`), false);

    // planted fault: an existence check that answers true for an empty tenant is reported
    const wrongTrue = (/** @type {boolean} */ got, /** @type {boolean} */ want) => (got === want ? [] : [`exists is ${got}, expected ${want}`]);
    assert.equal(wrongTrue(true, false).length, 1);
  } finally {
    await k.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await k.cleanup();
  }
});
