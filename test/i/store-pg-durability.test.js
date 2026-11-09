// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// Postgres store durability: acknowledged writes survive kill -9, a failed write stops the store without
// leaving a gap, one writer per tenant, transactional save, visibility on the index rows.
// Every check is a function that returns problems; each has a planted fault proving it can fail.
// Needs ONTOLOGIZER_PG_URL (a throwaway database); skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openPostgresStore } from '../../src/store-postgres/index.js';

const PG_URL = process.env.ONTOLOGIZER_PG_URL;
const opts = PG_URL ? {} : { skip: 'ONTOLOGIZER_PG_URL is not set' };
const WRITER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pg-writer.js');

const rnd = () => crypto.randomBytes(4).toString('hex');
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-pg-dur-'));
/** @param {AsyncIterable<any>} it */
async function drain(it) { const out = []; for await (const x of it) out.push(x); return out; }

const created = (/** @type {string} */ name) => ({ t: 'ontology.created', at: 0, name, root: 'root', brief: { topic: name }, categories: [] });
const node = (/** @type {string} */ id, /** @type {number} */ at) => ({ t: 'node.added', at, node: { id, label: id, parent: 'root', category: 'c', summary: '', tags: [] } });

/** One tenant, its cleanup, and openers. */
async function tenantKit() {
  const tenant = `t${rnd()}`;
  const pg = await import('pg');
  const admin = new pg.default.Pool({ connectionString: PG_URL, max: 4 });
  /** @type {any[]} */ const stores = [];
  /** Open a store on its own pool (own connection, so its own lock session). */
  const open = async () => {
    const s = openPostgresStore({ url: PG_URL, tenant, root: tmp() });
    stores.push(s);
    await s.ready;
    return s;
  };
  /** Open on a given pool. @param {any} pool */
  const openOn = async (pool) => {
    const s = openPostgresStore({ pool, tenant, root: tmp() });
    stores.push(s);
    await s.ready;
    return s;
  };
  return {
    tenant, admin, open, openOn, pg,
    /** @param {string} sql @param {any[]} [params] */
    q: (sql, params = []) => admin.query(sql, params),
    async cleanup() {
      for (const s of stores) { try { await s.close(); } catch { /* reported by the test */ } }
      await admin.query('DELETE FROM ontologizer_events WHERE tenant = $1', [tenant]);
      await admin.query('DELETE FROM ontologizer_maps WHERE tenant = $1', [tenant]);
      await admin.end();
    },
  };
}

/** A pool over a real one whose queries (also the ones on pinned clients) first pass `before`.
 *  @param {any} real @param {(sql: string, params: any[]) => Promise<void>|void} before @param {{ connect?: boolean }} [o] */
function wrapPool(real, before, { connect = true } = {}) {
  /** @param {any} db */
  const guarded = (db) => async (/** @type {string} */ sql, /** @type {any[]} */ params = []) => { await before(sql, params); return db.query(sql, params); };
  /** @type {any} */
  const out = { query: guarded(real), end: async () => {} };
  if (connect) out.connect = async () => { const c = await real.connect(); return { query: guarded(c), release: () => c.release() }; };
  return out;
}

// ---- checks ----

/** Every acknowledged event index must be in the reloaded events, in order. @param {number[]} acked @param {any[]} reloaded @returns {string[]} */
function lostAcks(acked, reloaded) {
  /** @type {string[]} */ const p = [];
  for (const i of acked) {
    const e = reloaded[i];
    if (!e) { p.push(`acknowledged event ${i} is missing (only ${reloaded.length} stored)`); continue; }
    const ok = i === 0 ? e.t === 'ontology.created' : e.t === 'node.added' && e.node.id === `n${i}`;
    if (!ok) p.push(`event ${i} is out of order or wrong: ${JSON.stringify(e).slice(0, 60)}`);
  }
  return p;
}

/** Rows as stored ({ seq }): any event stored after a missing seq is a leak past a gap. @param {{ seq: number }[]} rows @returns {string[]} */
function leakedAfterGap(rows) {
  /** @type {string[]} */ const p = [];
  const seqs = rows.map((r) => r.seq).sort((a, b) => a - b);
  let want = 0;
  for (const s of seqs) {
    if (s !== want) p.push(`seq ${s} is stored but seq ${want} is missing`);
    want = s + 1;
  }
  return p;
}

/** The second opener must be refused while the first lives; a third works after the first closes.
 *  @param {() => Promise<any>} openA @param {() => Promise<any>} openB @returns {Promise<string[]>} */
async function twoWriterProblems(openA, openB) {
  /** @type {string[]} */ const p = [];
  const a = await openA();
  try {
    /** @type {any} */ let b = null; /** @type {any} */ let err = null;
    try { b = await openB(); } catch (e) { err = e; }
    if (b) { p.push('a second store opened on the same tenant while the first was open'); await b.close(); }
    else if (!/^Another process already has the Postgres store for tenant ".+" open \(one server per tenant\)\.$/.test(err && err.message)) p.push(`wrong refusal: ${err && err.message}`);
  } finally { await a.close(); }
  try {
    const c = await openB();
    await c.close();
  } catch (/** @type {any} */ e) { p.push(`a store could not open after the first closed: ${e.message}`); }
  return p;
}

/** A failed save must leave Postgres as it was. @param {Record<string, number>} before @param {Record<string, number>} after @returns {string[]} */
function txProblems(before, after) {
  /** @type {string[]} */ const p = [];
  for (const k of Object.keys(before)) if (after[k] !== before[k]) p.push(`${k}: ${before[k]} before, ${after[k]} after the failed save`);
  return p;
}

// ---- kill -9 ----

/** Run pg-writer, SIGKILL it at ack N-1, reopen and report lost acknowledgements. @param {'sync'|'early'} mode */
async function killScenario(mode) {
  const kit = await tenantKit();
  const N = 8;
  try {
    const child = spawn(process.execPath, [WRITER], {
      env: { ...process.env, WRITER_TENANT: kit.tenant, WRITER_N: String(N), WRITER_MODE: mode, WRITER_ROOT: tmp() },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let buf = ''; let id = ''; /** @type {number[]} */ const acked = [];
    const exited = new Promise((r) => child.on('exit', r));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('writer timed out')); }, 20000);
      child.on('exit', () => { clearTimeout(timer); resolve(undefined); });
      child.stdout.on('data', (d) => {
        buf += d;
        const lines = buf.split('\n'); buf = lines.pop() ?? '';
        for (const l of lines) {
          if (l.startsWith('draft ')) id = l.slice(6);
          const m = /^ack (\d+)$/.exec(l);
          if (m) { acked.push(Number(m[1])); if (Number(m[1]) === N - 1) child.kill('SIGKILL'); }
        }
      });
    });
    await exited;
    // The dead child's connection may need a moment to free the tenant lock.
    /** @type {any} */ let s = null;
    for (let i = 0; i < 50 && !s; i++) {
      try { s = await kit.open(); } catch (/** @type {any} */ e) { if (!/Another process/.test(e.message)) throw e; await sleep(100); }
    }
    assert.ok(s, 'could not reopen the tenant after the kill');
    const reloaded = await drain(s.events(id));
    return { acked, problems: lostAcks(acked, reloaded), reloaded: reloaded.length };
  } finally { await kit.cleanup(); }
}

test('postgres durability: every write acknowledged after sync() survives kill -9', opts, async () => {
  const r = await killScenario('sync');
  assert.equal(r.acked.length, 8, 'the writer should acknowledge all 8');
  assert.deepEqual(r.problems, []);
});

test('planted fault: acknowledging before sync() loses events on kill -9 and lostAcks reports it', opts, async () => {
  const r = await killScenario('early');
  assert.ok(r.reloaded < 8, `the fault did not bite: ${r.reloaded} events stored`);
  assert.ok(r.problems.length > 0 && /is missing/.test(r.problems[0]), r.problems.join('; '));
});

// ---- fail-stop ----

test('postgres durability: a failed raise INSERT stops the store and leaves no gap', opts, async () => {
  const kit = await tenantKit();
  try {
    let failed = 0;
    const pool = wrapPool(kit.admin, (sql, params) => {
      if (/^\s*INSERT INTO ontologizer_events/.test(sql) && /visibility\.raised/.test(String(params[3])) && !failed++) throw new Error('injected: raise INSERT');
    });
    /** @type {string[]} */ const lines = [];
    const s = openPostgresStore({ pool, tenant: kit.tenant, root: tmp(), log: (l) => lines.push(l) });
    await s.ready;
    const id = s.createDraft({});
    s.append(id, created('Gap'));
    s.append(id, { t: 'visibility.raised', at: 1, to: 'private', reason: 'source', sources: ['crm'] });
    s.append(id, node('secret', 2));
    await assert.rejects(s.flush(), /The Postgres store stopped after a write failed: injected: raise INSERT/);
    await assert.rejects(s.sync(), (/** @type {any} */ e) => e.code === 'STORE_FAILED');
    assert.ok(s.failed instanceof Error && /injected/.test(s.failed.message));
    assert.equal(lines.length, 1, 'logged once');
    const before = s.list({ drafts: true }).length;
    for (const fn of [() => s.append(id, node('later', 3)), () => s.createDraft({}), () => s.save(id, 'gap'), () => s.importEvents('imp', [created('I')])]) {
      assert.throws(fn, (/** @type {any} */ e) => e.code === 'STORE_FAILED' && /^The Postgres store stopped after a write failed:/.test(e.message));
    }
    assert.equal(s.list({ drafts: true }).length, before, 'refused calls do not change memory');
    assert.ok(!('later' in s.read(id).nodes));

    const stored = (await kit.q('SELECT seq FROM ontologizer_events WHERE tenant = $1 AND map_id = $2 ORDER BY seq', [kit.tenant, id])).rows;
    assert.deepEqual(leakedAfterGap(stored), []);
    await s.close();
    const s2 = await kit.open();
    assert.ok(!('secret' in s2.read(id).nodes), 'the private node leaked into the reloaded map');
    assert.deepEqual(Object.keys(s2.read(id).nodes), []);
  } finally { await kit.cleanup(); }
});

test('planted fault: leakedAfterGap reports what the old swallowing behaviour stored', () => {
  assert.deepEqual(leakedAfterGap([{ seq: 0 }, { seq: 1 }, { seq: 2 }]), []);
  const problems = leakedAfterGap([{ seq: 0 }, { seq: 2 }, { seq: 3 }]);
  assert.ok(problems.length > 0 && /seq 2 is stored but seq 1 is missing/.test(problems[0]), problems.join('; '));
});

// ---- one writer per tenant ----

test('postgres durability: a second process on the same tenant is refused', opts, async () => {
  const kit = await tenantKit();
  try {
    assert.deepEqual(await twoWriterProblems(kit.open, kit.open), []);
  } finally { await kit.cleanup(); }
});

test('planted fault: an opener that never takes the lock is reported by twoWriterProblems', async () => {
  const fake = async () => ({ ready: Promise.resolve(), close: async () => {} });
  const problems = await twoWriterProblems(fake, fake);
  assert.ok(problems.some((x) => /second store opened/.test(x)), problems.join('; '));
});

// ---- transactions ----

/** Overwrite-save whose rename UPDATE fails; counts rows before and after. @param {boolean} withConnect */
async function failedSave(withConnect) {
  const kit = await tenantKit();
  try {
    let armed = false;
    const pool = wrapPool(kit.admin, (sql) => { if (armed && /^\s*UPDATE ontologizer_maps SET id/.test(sql)) throw new Error('injected: rename UPDATE'); }, { connect: withConnect });
    const s = await kit.openOn(pool);
    s.importEvents('target', [created('Target'), node('t1', 1)]);
    const d = s.createDraft({}); s.append(d, created('Draft')); s.append(d, node('d1', 1));
    await s.sync();
    const count = async () => {
      const ev = (await kit.q('SELECT map_id, count(*)::int AS n FROM ontologizer_events WHERE tenant = $1 GROUP BY map_id', [kit.tenant])).rows;
      const mp = (await kit.q('SELECT id FROM ontologizer_maps WHERE tenant = $1', [kit.tenant])).rows;
      /** @type {Record<string, number>} */ const o = {};
      for (const r of ev) o[`events of ${r.map_id}`] = r.n;
      for (const r of mp) o[`map row ${r.id}`] = 1;
      return o;
    };
    const before = await count();
    // save() appends ontology.renamed with its own INSERT, outside the transaction; that one event stays
    // on the old id either way, so expect exactly one more there. Everything else must be untouched.
    before[`events of ${d}`] += 1;
    armed = true;
    s.save(d, 'target', { overwrite: true });
    await assert.rejects(s.flush(), /injected: rename UPDATE/);
    const after = await count();
    return { before, after };
  } finally { await kit.cleanup(); }
}

test('postgres durability: a save whose rename fails leaves Postgres unchanged', opts, async () => {
  const { before, after } = await failedSave(true);
  const draftKey = Object.keys(before).find((k) => k.startsWith('events of draft-'));
  assert.ok(before['events of target'] === 2 && draftKey && before[draftKey] === 3, JSON.stringify(before));
  assert.deepEqual(txProblems(before, after), []);
});

test('planted fault: without a transaction the failed save loses the target and txProblems reports it', opts, async () => {
  const { before, after } = await failedSave(false);
  const problems = txProblems(before, after);
  assert.ok(problems.some((x) => /events of target|map row target/.test(x)), problems.join('; '));
});

// ---- visibility on rows ----

test('postgres durability: index rows carry visibility and privateSources, also after a reopen', opts, async () => {
  const kit = await tenantKit();
  try {
    const s = await kit.open();
    const pub = s.createDraft({}); s.append(pub, created('Pub')); s.save(pub, 'pub');
    const d = s.createDraft({}); s.append(d, created('Priv'));
    const row = () => s.list({ drafts: true }).find((/** @type {any} */ r) => r.id === d);
    assert.deepEqual(Object.keys(row()).sort(), ['draft', 'id', 'name', 'nodes', 'root', 'updatedAt']);
    s.append(d, { t: 'visibility.raised', at: 1, to: 'private', reason: 'source', sources: ['b', 'a'] });
    assert.equal(row().visibility, 'private');
    assert.deepEqual(row().privateSources, ['a', 'b']);
    s.append(d, { t: 'visibility.raised', at: 2, to: 'private', reason: 'source', sources: ['c'] });
    assert.deepEqual(row().privateSources, ['a', 'b', 'c']);
    s.save(d, 'priv');
    const check = (/** @type {any} */ st) => {
      const rows = st.list();
      const priv = rows.find((/** @type {any} */ r) => r.id === 'priv'); const pb = rows.find((/** @type {any} */ r) => r.id === 'pub');
      assert.equal(priv.visibility, 'private');
      assert.deepEqual(priv.privateSources, ['a', 'b', 'c']);
      assert.ok(!('visibility' in pb) && !('privateSources' in pb), 'a public row has neither key');
      assert.deepEqual(Object.keys(pb).sort(), ['draft', 'id', 'name', 'nodes', 'root', 'updatedAt']);
    };
    check(s);
    s.importEvents('imp', [created('Imp'), { t: 'visibility.raised', at: 1, to: 'private', reason: 'fuse', sources: ['z'] }]);
    assert.deepEqual(s.list().find((/** @type {any} */ r) => r.id === 'imp').privateSources, ['z']);
    await s.sync(); await s.close();
    const s2 = await kit.open();
    check(s2);
    assert.deepEqual(s2.list().find((/** @type {any} */ r) => r.id === 'imp').privateSources, ['z']);
  } finally { await kit.cleanup(); }
});
