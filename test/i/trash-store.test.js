// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// I5 · the trash, as a store contract run on the file store and (with ONTOLOGIZER_PG_URL) on Postgres:
// trash and restore round-trip a map intact (events, snapshot, brief, attachments), the index has no
// row while it is in the trash, a taken name is refused, purge removes only what has expired, and a
// private map stays private all the way. Every check returns a list of problems; a planted fault
// proves each one can fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, TRASH_ID_RE } from '../../src/core/store.js';
import { openPostgresStore } from '../../src/store-postgres/index.js';

/** @typedef {any} AnyStore */
/** @typedef {{ store: AnyStore, reopen: () => Promise<AnyStore>, brief: (id: string) => Promise<any>, cleanup: () => Promise<void> }} Made */

const DAY = 24 * 60 * 60 * 1000;
const rnd = () => crypto.randomBytes(4).toString('hex');
const ACTOR = { id: 'token:ci', kind: 'service' };
/** @param {string} name */
const created = (name) => ({ t: 'ontology.created', at: 0, name, root: 'root', brief: { topic: name }, categories: [] });
/** @param {string} id @param {number} at */
const node = (id, at) => ({ t: 'node.added', at, node: { id, label: id, parent: 'root', category: 'c', summary: '', tags: [] } });
const raise = { t: 'visibility.raised', at: 5, to: 'private', reason: 'source', sources: ['wiki'] };
/** JSON with sorted keys (jsonb does not keep key order). @param {any} v @returns {string} */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
/** @param {AsyncIterable<any>} it */
async function drain(it) { const out = []; for await (const x of it) out.push(x); return out; }
/** @param {string[]} out @param {any} cond @param {string} msg */
const need = (out, cond, msg) => { if (!cond) out.push(msg); };
/** @param {() => any} fn @returns {any} the error thrown, or null */
const thrown = (fn) => { try { fn(); return null; } catch (e) { return e; } };
/** @param {AnyStore} s @param {string} id */
const row = (s, id) => s.list({ drafts: true }).find((/** @type {any} */ r) => r.id === id);

/** A built map with an attachment, made through the store's own calls. @param {AnyStore} s @param {string} name @param {any[]} [extra] */
function makeMap(s, name, extra = []) {
  const d = s.createDraft({ topic: name, context: `about ${name}` }, name);
  s.append(d, created(name));
  for (const e of extra) s.append(d, e);
  s.append(d, node('n1', 10));
  s.append(d, node('n2', 20));
  return s.save(d, name);
}
/** Chat attachments live in <store.root>/<id>/attachments on both stores. @param {AnyStore} s @param {string} id */
function attach(s, id) {
  const dir = path.join(s.root, id, 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${'a'.repeat(64)}.png`), 'png-bytes');
}
/** @param {AnyStore} s @param {string} id */
const attachment = (s, id) => { try { return fs.readFileSync(path.join(s.root, id, 'attachments', `${'a'.repeat(64)}.png`), 'utf8'); } catch { return null; } };

/** Trash and restore round-trip the map intact; no row while it is in the trash. @param {Made} m @returns {Promise<string[]>} */
async function roundTripProblems(m) {
  /** @type {string[]} */ const p = [];
  const s = m.store;
  const id = makeMap(s, 'sourdough');
  attach(s, id);
  await s.flush();
  const events = canonical(await drain(s.events(id)));
  const snap = canonical(s.read(id));
  const brief = canonical(await m.brief(id));
  const trashId = s.trash(id, { actor: ACTOR });
  await s.flush();
  need(p, TRASH_ID_RE.test(trashId) && trashId.startsWith(`${id}--`), `trash id looks wrong: ${trashId}`);
  need(p, !row(s, id), 'the index still has a row for the trashed map');
  need(p, s.resolve(id) === null, 'a trashed map still resolves');
  need(p, attachment(s, id) === null, 'the attachment stayed behind');
  const item = s.listTrash().find((/** @type {any} */ t) => t.trashId === trashId);
  need(p, item && item.id === id && item.name === 'sourdough' && item.draft === false && item.nodes === 2, `bad trash item ${JSON.stringify(item)}`);
  need(p, item && item.deletedBy?.id === ACTOR.id && typeof item.deletedAt === 'number' && Math.abs(item.deletedAt - Date.now()) < 60000, 'deletedBy or deletedAt is wrong');
  need(p, item && item.visibility === undefined, 'a public map\'s item claims a visibility');
  // It survives a reopen (a restart) and is still listed there.
  const s2 = await m.reopen();
  need(p, s2.listTrash().some((/** @type {any} */ t) => t.trashId === trashId), 'the trash item is gone after a reopen');
  need(p, !row(s2, id), 'the row came back after a reopen');
  const back = s2.restore(trashId, { actor: ACTOR });
  await s2.flush();
  need(p, back === id, `restored as ${back}`);
  need(p, row(s2, id) && row(s2, id).draft === false && row(s2, id).nodes === 2, `bad row after restore ${JSON.stringify(row(s2, id))}`);
  need(p, canonical(await drain(s2.events(id))) === events, 'the events changed in the trash');
  need(p, canonical(s2.read(id)) === snap, 'the folded map changed in the trash');
  need(p, canonical(await m.brief(id)) === brief, 'the brief changed in the trash');
  need(p, attachment(s2, id) === 'png-bytes', 'the attachment did not come back');
  need(p, s2.listTrash().length === 0, 'the item is still in the trash after its restore');
  const s3 = await m.reopen();
  need(p, row(s3, id) && canonical(await drain(s3.events(id))) === events, 'the restore did not survive a reopen');
  // Drafts come back as drafts.
  const d = s3.createDraft({ topic: 'x' }, 'Rough');
  s3.append(d, created('Rough'));
  const dt = s3.trash(d, { actor: ACTOR });
  need(p, s3.listTrash().find((/** @type {any} */ t) => t.trashId === dt)?.draft === true, 'a draft\'s item is not marked draft');
  s3.restore(dt);
  need(p, row(s3, d)?.draft === true, 'a draft came back as a saved map');
  // Unknown ids.
  need(p, thrown(() => s3.trash('no-such-map'))?.code === 'NOT_FOUND', 'trash of a missing map is not NOT_FOUND');
  need(p, thrown(() => s3.restore('nothing--20260101-000000z'))?.code === 'NOT_FOUND', 'restore of a missing item is not NOT_FOUND');
  need(p, thrown(() => s3.restore('../../etc'))?.code === 'NOT_FOUND', 'restore of a path is not refused');
  await s3.flush();
  return p;
}

/** A taken name is refused; `as` restores under a new name (a draft comes back saved). @param {Made} m @returns {Promise<string[]>} */
async function takenProblems(m) {
  /** @type {string[]} */ const p = [];
  const s = m.store;
  const id = makeMap(s, 'alpha');
  const trashId = s.trash(id, { actor: ACTOR });
  makeMap(s, 'alpha'); // someone made a new "alpha" meanwhile
  const e = thrown(() => s.restore(trashId));
  need(p, e?.code === 'TAKEN' && /restore it under another name/.test(e.message), `restore over a taken name: ${e?.code} ${e?.message}`);
  if (p.length) return p; // the item is gone: nothing further to check
  need(p, s.listTrash().some((/** @type {any} */ t) => t.trashId === trashId), 'a refused restore lost the item');
  need(p, Object.keys(s.read('alpha').nodes).length === 2, 'a refused restore touched the new map');
  need(p, thrown(() => s.restore(trashId, { as: 'Bad Name' })) !== null, 'an invalid as was taken');
  need(p, thrown(() => s.restore(trashId, { as: 'tenants' })) !== null, 'the reserved name was taken');
  const back = s.restore(trashId, { as: 'alpha-2', actor: ACTOR });
  await s.flush();
  need(p, back === 'alpha-2' && row(s, 'alpha-2')?.draft === false, `restore as: ${back} ${JSON.stringify(row(s, 'alpha-2'))}`);
  const last = (await drain(s.events('alpha-2'))).at(-1);
  need(p, last?.t === 'ontology.renamed' && last.name === 'alpha-2' && last.actor?.id === ACTOR.id, `no renamed event after restore as: ${JSON.stringify(last)}`);
  need(p, s.read('alpha-2').name === 'alpha-2' && row(s, 'alpha-2')?.name === 'alpha-2', 'the name did not follow');
  const d = s.createDraft({}, 'Rough'); s.append(d, created('Rough'));
  const dt = s.trash(d);
  s.restore(dt, { as: 'rough' });
  need(p, row(s, 'rough')?.draft === false && !row(s, d), 'a draft restored with a name is not saved');
  await s.flush();
  return p;
}

/** Purge removes only what is past its days. @param {Made} m @returns {Promise<string[]>} */
async function purgeProblems(m) {
  /** @type {string[]} */ const p = [];
  const s = m.store;
  const now = Date.now();
  const oldId = s.trash(makeMap(s, 'old'), { actor: ACTOR, now: now - 31 * DAY });
  attach(s, makeMap(s, 'young'));
  const youngId = s.trash('young', { actor: ACTOR, now: now - 29 * DAY });
  const freshId = s.trash(makeMap(s, 'fresh'), { actor: ACTOR });
  await s.flush();
  const gone = s.purgeTrash({ olderThanDays: 30 });
  await s.flush();
  need(p, JSON.stringify(gone) === JSON.stringify([oldId]), `purged ${JSON.stringify(gone)}`);
  const left = s.listTrash().map((/** @type {any} */ t) => t.trashId).sort();
  need(p, JSON.stringify(left) === JSON.stringify([freshId, youngId].sort()), `left in the trash: ${JSON.stringify(left)}`);
  need(p, thrown(() => s.restore(oldId))?.code === 'NOT_FOUND', 'a purged item can still be restored');
  const s2 = await m.reopen();
  need(p, !s2.listTrash().some((/** @type {any} */ t) => t.trashId === oldId), 'the purged item came back after a reopen');
  need(p, s2.listTrash().length === 2, `after a reopen the trash holds ${s2.listTrash().length}`);
  need(p, !thrown(() => s2.restore(youngId)) && attachment(s2, 'young') === 'png-bytes', 'an unexpired item lost its attachment');
  await s2.flush();
  return p;
}

/** A private map stays private in the trash and after its restore. @param {Made} m @returns {Promise<string[]>} */
async function privateProblems(m) {
  /** @type {string[]} */ const p = [];
  const s = m.store;
  const id = makeMap(s, 'secret', [raise]);
  await s.flush();
  need(p, row(s, id)?.visibility === 'private', 'setup: the map is not private');
  const trashId = s.trash(id, { actor: ACTOR });
  const item = s.listTrash().find((/** @type {any} */ t) => t.trashId === trashId);
  need(p, item?.visibility === 'private' && JSON.stringify(item?.privateSources) === '["wiki"]', `the trash item lost its privacy: ${JSON.stringify(item)}`);
  const s2 = await m.reopen();
  const again = s2.listTrash().find((/** @type {any} */ t) => t.trashId === trashId);
  need(p, again?.visibility === 'private' && JSON.stringify(again?.privateSources) === '["wiki"]', 'the trash item lost its privacy on reopen');
  s2.restore(trashId);
  await s2.flush();
  const r = row(s2, id);
  need(p, r?.visibility === 'private' && JSON.stringify(r?.privateSources) === '["wiki"]', `restored row is not private: ${JSON.stringify(r)}`);
  need(p, s2.read(id).visibility === 'private', 'restored map does not fold private');
  const s3 = await m.reopen();
  need(p, row(s3, id)?.visibility === 'private', 'restored map is public after a reopen');
  return p;
}

// ---- backends ----

/** @returns {Promise<Made>} */
async function makeFile() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-trash-'));
  const tenant = `t${rnd()}`;
  const open = async () => openStore(home, { tenant });
  const store = await open();
  return {
    store, reopen: open,
    brief: async (id) => JSON.parse(fs.readFileSync(path.join(store.root, id, 'brief.json'), 'utf8')),
    cleanup: async () => { fs.rmSync(home, { recursive: true, force: true }); },
  };
}

const PG_URL = process.env.ONTOLOGIZER_PG_URL;

/** @returns {Promise<Made>} */
async function makePg() {
  const tenant = `t${rnd()}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-trash-pg-'));
  /** @type {AnyStore[]} */ const opened = [];
  const pg = await import('pg');
  const admin = new pg.default.Pool({ connectionString: PG_URL, max: 1 });
  const open = async () => {
    for (const o of opened.splice(0)) { await o.flush(); await o.close(); }
    const s = openPostgresStore({ url: PG_URL, tenant, root });
    await s.ready;
    opened.push(s);
    return s;
  };
  let store;
  try { store = await open(); } catch (err) { await admin.end(); fs.rmSync(root, { recursive: true, force: true }); throw err; }
  return {
    store, reopen: open,
    brief: async (id) => { await opened.at(-1).flush(); return (await admin.query('SELECT brief FROM ontologizer_maps WHERE tenant = $1 AND id = $2', [tenant, id])).rows[0]?.brief; },
    cleanup: async () => {
      for (const s of opened) { try { await s.flush(); } catch { /* reported by the test */ } await s.close(); }
      for (const t of ['ontologizer_events', 'ontologizer_maps', 'ontologizer_trash']) await admin.query(`DELETE FROM ${t} WHERE tenant = $1`, [tenant]);
      await admin.end();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** @param {(m: Made) => Promise<string[]>} fn @param {() => Promise<Made>} make @param {(s: AnyStore) => AnyStore} [fault] */
async function runOn(fn, make, fault) {
  const m = await make();
  try {
    if (fault) {
      const reopen = m.reopen;
      m.store = fault(m.store);
      m.reopen = async () => /** @type {AnyStore} */ (fault(await reopen()));
    }
    return await fn(m);
  } finally { await m.cleanup(); }
}

for (const [label, make, opts] of /** @type {Array<[string, () => Promise<Made>, any]>} */ ([
  ['file store', makeFile, {}],
  ['postgres store', makePg, PG_URL ? {} : { skip: 'ONTOLOGIZER_PG_URL is not set' }],
])) {
  test(`${label}: trash and restore round-trip a map intact; no index row while it is in the trash`, opts, async () => {
    assert.deepEqual(await runOn(roundTripProblems, make), []);
  });
  test(`${label}: restore to a taken name is refused; as restores under a new one`, opts, async () => {
    assert.deepEqual(await runOn(takenProblems, make), []);
  });
  test(`${label}: purge removes only expired items`, opts, async () => {
    assert.deepEqual(await runOn(purgeProblems, make), []);
  });
  test(`${label}: a private map stays private in the trash and after its restore`, opts, async () => {
    assert.deepEqual(await runOn(privateProblems, make), []);
  });
}

// ---- planted faults: each check must report a deliberately broken store ----

/** Wrap a store with overrides, keeping every other method bound to the real one. @param {AnyStore} s @param {(real: AnyStore) => Record<string, any>} over */
function wrap(s, over) {
  const out = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'function' ? v.bind(s) : v]));
  return Object.assign(out, over(s));
}

test('planted fault: a trash that leaves the index row is reported', async () => {
  const problems = await runOn(roundTripProblems, makeFile, (s) => {
    /** @type {any[]} */ const kept = [];
    return wrap(s, (real) => ({
      trash(/** @type {string} */ id, /** @type {any} */ o) { const r = row(real, id); const t = real.trash(id, o); kept.push(r); return t; },
      list(/** @type {any} */ o) { return [...real.list(o), ...kept.filter((r) => !real.list({ drafts: true }).some((/** @type {any} */ x) => x.id === r.id))]; },
    }));
  });
  assert.ok(problems.includes('the index still has a row for the trashed map'), problems.join('\n'));
});

test('planted fault: a restore that drops privateSources is reported', async () => {
  const problems = await runOn(privateProblems, makeFile, (s) => wrap(s, (real) => ({
    list(/** @type {any} */ o) { return real.list(o).map((/** @type {any} */ r) => { const { visibility, privateSources, ...rest } = r; return rest; }); },
  })));
  assert.ok(problems.some((x) => /restored row is not private/.test(x)), problems.join('\n'));
  // and a trash item that forgets the sources
  const p2 = await runOn(privateProblems, makeFile, (s) => wrap(s, (real) => ({
    listTrash() { return real.listTrash().map((/** @type {any} */ t) => ({ ...t, privateSources: [] })); },
  })));
  assert.ok(p2.some((x) => /trash item lost its privacy/.test(x)), p2.join('\n'));
});

test('planted fault: a purge that deletes everything is reported', async () => {
  const problems = await runOn(purgeProblems, makeFile, (s) => wrap(s, (real) => ({
    purgeTrash() { return real.purgeTrash({ olderThanDays: -1 }); },
  })));
  assert.ok(problems.some((x) => /^purged /.test(x)) && problems.some((x) => /^left in the trash/.test(x)), problems.join('\n'));
});

test('planted fault: a restore to a taken name that overwrites is reported', async () => {
  const problems = await runOn(takenProblems, makeFile, (s) => wrap(s, (real) => ({
    restore(/** @type {string} */ trashId, /** @type {any} */ o = {}) {
      const item = real.listTrash().find((/** @type {any} */ t) => t.trashId === trashId);
      if (!o.as && item && row(real, item.id)) real.trash(item.id); // clears the way, then restores over it
      return real.restore(trashId, o);
    },
  })));
  assert.ok(problems.some((x) => /restore over a taken name/.test(x)), problems.join('\n'));
});

test('file store: the trash is a dot folder under the tenant root; an open purges it and drops a row a crash left behind', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-trash-'));
  try {
    const s = openStore(home);
    const id = makeMap(s, 'gone');
    const trashId = s.trash(id, { now: Date.now() - 40 * DAY });
    assert.ok(fs.existsSync(path.join(home, '.trash', trashId, 'events.jsonl')));
    const info = JSON.parse(fs.readFileSync(path.join(home, '.trash', trashId, 'trash.json'), 'utf8'));
    assert.deepEqual(Object.keys(info).sort(), ['deletedAt', 'deletedBy', 'draft', 'id', 'name', 'nodes', 'privateSources', 'root', 'visibility']);
    // A crash between the folder's move and the index write: the row is still there, the folder is gone.
    const kept = s.trash(makeMap(s, 'half'));
    const idx = JSON.parse(fs.readFileSync(path.join(home, 'index.json'), 'utf8'));
    idx.ontologies.push({ id: 'half', name: 'half', root: 'root', nodes: 2, updatedAt: 1, draft: false });
    fs.writeFileSync(path.join(home, 'index.json'), JSON.stringify(idx));
    const s2 = openStore(home); // the open purges the 40-day-old item and tidies the stale row
    assert.equal(fs.existsSync(path.join(home, '.trash', trashId)), false);
    assert.deepEqual(s2.listTrash().map((/** @type {any} */ t) => t.trashId), [kept]);
    assert.equal(row(s2, 'half'), undefined);
    assert.equal(s2.restore(kept), 'half');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('file store: a map a running session serves is refused (sessions.json)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-trash-'));
  try {
    const s = openStore(home);
    const id = makeMap(s, 'busy');
    s.sessions.set(id, { port: 4321, pid: process.ppid, startedAt: Date.now() });
    const e = thrown(() => s.trash(id));
    assert.equal(e?.code, 'SERVED');
    assert.match(e.message, /running session \(port 4321\)/);
    assert.ok(row(s, id), 'the refused map is still listed');
    s.sessions.remove(id);
    assert.ok(TRASH_ID_RE.test(s.trash(id)));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('postgres store (no server): every trash query is scoped by tenant and parameterised', async () => {
  /** @type {{ sql: string, params: any[] }[]} */ const log = [];
  const pool = { query: async (/** @type {string} */ sql, /** @type {any[]} */ params = []) => { log.push({ sql, params }); return { rows: [] }; }, end: async () => {} };
  const s = openPostgresStore({ pool, tenant: 'acme', root: fs.mkdtempSync(path.join(os.tmpdir(), 'onto-fake-')) });
  await s.ready;
  const id = makeMap(s, 'x');
  const t1 = s.trash(id);
  s.restore(t1, { as: 'y' });
  s.trash('y', { now: Date.now() - 40 * DAY });
  s.purgeTrash();
  await s.flush();
  const trashSql = log.filter((q) => /ontologizer_trash/.test(q.sql) && !/^\s*CREATE/.test(q.sql));
  assert.ok(trashSql.length >= 5, `trash queries seen: ${trashSql.length}`);
  /** @param {{ sql: string, params: any[] }[]} qs */
  const problems = (qs) => qs.filter((q) => !/tenant = \$1/.test(q.sql) || q.params[0] !== 'acme').map((q) => q.sql.replace(/\s+/g, ' ').slice(0, 80));
  assert.deepEqual(problems(trashSql), []);
  // planted fault: a trash query without its tenant filter
  assert.equal(problems([...trashSql, { sql: 'DELETE FROM ontologizer_trash WHERE trash_id = $1', params: ['x'] }]).length, 1);
});

test('postgres store (no server): two processes creating the tables at once is not a failure; another error is', async () => {
  /** @param {string} code */
  const racing = (code) => {
    let failed = false;
    return { query: async (/** @type {string} */ sql) => {
      // The other process created the type first: IF NOT EXISTS still fails once, with this code.
      if (/^\s*CREATE TABLE/.test(sql) && !failed) { failed = true; throw Object.assign(new Error('duplicate key value violates unique constraint "pg_type_typname_nsp_index"'), { code }); }
      return { rows: [] };
    }, end: async () => {} };
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-fake-'));
  await openPostgresStore({ pool: racing('23505'), tenant: 'acme', root }).ready;
  await openPostgresStore({ pool: racing('42P07'), tenant: 'acme', root }).ready;
  // planted fault: any other error still stops the store
  await assert.rejects(openPostgresStore({ pool: racing('XX000'), tenant: 'acme', root }).ready);
});

/** Whether opening a store purged an expired item. @param {(home: string) => any} open @param {boolean} serverRuns @returns {Promise<boolean>} */
async function purgedOnOpen(open, serverRuns) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-trash-'));
  try {
    const s = openStore(home);
    const old = s.trash(makeMap(s, 'old'), { now: Date.now() - 40 * DAY });
    if (serverRuns) s.sessions.addServer({ pid: process.ppid, port: 8787, url: 'http://127.0.0.1:8787/', startedAt: Date.now() });
    open(home);
    return !fs.existsSync(path.join(home, '.trash', old));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('file store: opening a store does not purge the trash while another process\'s server runs on the home', async () => {
  assert.equal(await purgedOnOpen(openStore, false), true, 'no server: the open purges');
  assert.equal(await purgedOnOpen(openStore, true), false, 'a server runs: it owns the purge');
  // Planted fault: a store that purges on open whatever runs (it could race the server's restore).
  const { openStore: eager } = await import('./helpers-fault.js').then((m) => m.faultyModule('src/core/store.js',
    [['    if (sessions.servers().some((s) => s.pid !== process.pid)) throw SKIP;\n', '']]));
  assert.equal(await purgedOnOpen(eager, true), true);
});
