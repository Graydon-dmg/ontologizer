// @ts-check
// Postgres store: the same interface and behaviour as openStore (src/core/store.js).
//
// One server process per tenant writes a Postgres store. The whole tenant (map rows and events) is
// loaded into memory by `ready`; every read is served from memory and stays synchronous. Writes
// update memory at once and go to Postgres in order through one promise chain (write-behind):
// `flush()` / `sync()` resolve when everything so far is stored (the router awaits `sync()` before
// it answers a write).
//
// Fail-stop: the first failed write marks the store failed. Queued writes after it are skipped (so
// Postgres never holds later events behind a gap) and every mutating call throws STORE_FAILED.
// One writer per tenant is enforced with a Postgres advisory lock taken in `ready`. Multi-statement
// writes (save, createDraft, importEvents) run in one transaction.
//
// Tables (created if missing), every query scoped by tenant:
//   ontologizer_events (tenant, map_id, seq, event jsonb)            primary key (tenant, map_id, seq)
//   ontologizer_maps   (tenant, id, name, root, nodes, updated_at, draft, brief jsonb, is_current)
import os from 'node:os';
import path from 'node:path';
import { foldAll, fold } from '../core/events.js';
import { RESERVED_NAMES, TENANT_RE } from '../core/store.js';

/** @typedef {import('../core/schema.js').Ontology} Ontology */
/** @typedef {import('../core/events.js').OntoEvent} OntoEvent */
/** @typedef {{ id: string, name: string, root: string, nodes: number, updatedAt: number, draft: boolean,
 *             visibility?: 'private', privateSources?: string[] }} IndexRow */
/** @typedef {{ events: OntoEvent[], onto: Ontology, lastAt: number, startedAt: number,
 *             subs: Set<(e: OntoEvent, i: number) => void> }} Entry */

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
// The tenant lock uses the two-key advisory lock form: (this fixed namespace, hashtext of the tenant),
// so ontologizer's locks never share a key space with another app's single-key bigint locks on the
// same database. 0x4f4e544f is "ONTO"; it fits a signed 32-bit int.
const PG_LOCK_NAMESPACE = 0x4f4e544f;

/** @param {Date} d */
function stamp(d) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** @param {string} name */
function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`Invalid name "${name}": use lowercase letters, digits and hyphens (kebab-case).`);
  }
  if (RESERVED_NAMES.includes(name)) {
    throw new Error(`"${name}" is a reserved name (it holds service mode's tenants). Pick another name.`);
  }
}

/** @param {Ontology} o */
const countNodes = (o) => Object.keys(o.nodes).length;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ontologizer_events (
     tenant text NOT NULL, map_id text NOT NULL, seq integer NOT NULL, event jsonb NOT NULL,
     PRIMARY KEY (tenant, map_id, seq))`,
  `CREATE TABLE IF NOT EXISTS ontologizer_maps (
     tenant text NOT NULL, id text NOT NULL, name text NOT NULL, root text NOT NULL DEFAULT '',
     nodes integer NOT NULL DEFAULT 0, updated_at bigint NOT NULL DEFAULT 0, draft boolean NOT NULL DEFAULT false,
     brief jsonb, is_current boolean NOT NULL DEFAULT false,
     PRIMARY KEY (tenant, id))`,
];

/**
 * @param {{ url?: string, tenant?: string, root?: string, pool?: any, log?: (line: string) => void }} [opts]
 */
export function openPostgresStore({ url, tenant = 'default', root, pool: givenPool, log } = {}) {
  if (typeof tenant !== 'string' || !TENANT_RE.test(tenant)) {
    throw new Error(`Invalid tenant "${tenant}": use lowercase letters, digits and hyphens (at most 63 characters).`);
  }
  // Chat image attachments live here. Nothing is created at open: the folder appears with the first
  // attachment (storeAttachment makes it), so a store that never stores an image leaves no trace on disk.
  const localRoot = root ?? path.join(process.env.ONTOLOGIZER_HOME ?? path.join(os.homedir(), '.ontologizer'), 'pg', tenant);

  /** @type {any} */
  let pool = givenPool ?? null;
  let ownPool = false;
  let closed = false;
  /** Dedicated client holding the tenant's advisory lock for the store's life. @type {any} */
  let lockClient = null;
  /** @type {IndexRow[]} */
  let rows = [];
  /** @type {string|null} */
  let currentId = null;
  /** @type {Map<string, Entry>} */
  const cache = new Map();
  /** @type {Record<string, any>} */
  const sessionMap = {};

  /** @param {string} id */
  const check = (id) => {
    if (typeof id !== 'string' || !NAME_RE.test(id)) throw new Error(`Invalid ontology id "${id}"`);
    return id;
  };

  /** @param {OntoEvent[]} events @returns {Entry} */
  function makeEntry(events) {
    const created = events.find((x) => x.t === 'ontology.created');
    const lastAt = events.length ? Math.max(...events.map((x) => (typeof x.at === 'number' ? x.at : 0))) : 0;
    return { events, onto: foldAll(events), lastAt, startedAt: Date.now() - (created ? created.at : 0), subs: new Set() };
  }

  // ---- write-behind chain ----
  /** @type {Error|null} */
  let firstError = null;
  /** @type {Promise<void>} */
  let chain = Promise.resolve();
  /** @param {(db: any) => Promise<any>} fn */
  function enqueue(fn) {
    chain = chain.then(() => {
      if (firstError) return undefined; // fail-stop: never write behind a gap
      return fn(pool);
    }).then(() => {}, (/** @type {any} */ err) => {
      if (!firstError) {
        firstError = err instanceof Error ? err : new Error(String(err));
        if (log) log(`postgres store write failed: ${firstError.message}`);
      }
    });
  }
  /** @param {string} [_id] */
  async function flush(_id) {
    await chain;
    if (firstError) throw storeFailed();
  }
  /** The error every call gets once a write has failed. @returns {Error} */
  function storeFailed() {
    const e = /** @type {any} */ (new Error(`The Postgres store stopped after a write failed: ${firstError && firstError.message}`));
    e.code = 'STORE_FAILED';
    e.cause = firstError;
    return e;
  }
  function assertWritable() {
    if (firstError) throw storeFailed();
  }

  /** Run `fn` in one transaction on one client. A pool without `connect` (a test double with only
   *  `query`) has no way to pin a connection, so the statements run without a transaction there.
   *  @param {(db: any) => Promise<any>} fn */
  async function inTx(fn) {
    if (!pool || typeof pool.connect !== 'function') return fn(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* the original error matters */ }
        throw err;
      }
    } finally { client.release(); }
  }

  /** Keep visibility keys on a row: only a private map carries them. @param {IndexRow} row @param {Ontology} onto */
  function applyVisibility(row, onto) {
    if (onto.visibility === 'private') {
      row.visibility = 'private';
      row.privateSources = [...(onto.privateSources ?? [])].sort();
    } else {
      delete row.visibility;
      delete row.privateSources;
    }
  }

  const ready = (async () => {
    if (!pool) {
      /** @type {any} */
      let pg;
      try {
        pg = await import('pg');
      } catch {
        throw new Error('openPostgresStore needs the pg package: npm install pg@8');
      }
      const Pool = pg.Pool ?? pg.default?.Pool;
      pool = new Pool({ connectionString: url, max: 4, keepAlive: true });
      ownPool = true;
      // An idle pooled connection that dies emits 'error' on the pool: never let it crash the host.
      pool.on('error', (/** @type {any} */ err) => { if (log) log(`postgres pool connection lost: ${err?.code ?? err?.name ?? 'error'}`); });
    }
    // One writer per tenant: a session-level advisory lock on a dedicated client, held until close().
    // A pool without `connect` (a test double with only `query`) cannot pin a session, so no lock there.
    if (typeof pool.connect === 'function') {
      const client = await pool.connect();
      let granted = false;
      try {
        const r = await client.query(`SELECT pg_try_advisory_lock(${PG_LOCK_NAMESPACE}, hashtext('ontologizer:' || $1)) AS ok`, [tenant]);
        granted = !!(r.rows[0] && r.rows[0].ok);
      } catch (err) {
        client.release();
        throw err;
      }
      if (!granted) {
        client.release();
        if (ownPool && !closed) { closed = true; try { await pool.end(); } catch { /* ignore */ } }
        throw new Error(`Another process already has the Postgres store for tenant "${tenant}" open (one server per tenant).`);
      }
      lockClient = client;
      // The lock lives on this connection. If it dies (pg_terminate_backend, a restart, a proxy idle
      // timeout), the lock is gone and another process may open the tenant: this store stops at once
      // (every write, and every read, is refused) and the host never crashes.
      if (typeof client.on === 'function') client.on('error', (/** @type {any} */ err) => {
        if (!firstError) {
          firstError = new Error(`the tenant lock connection was lost (${err?.code ?? err?.name ?? 'error'})`);
          if (log) log(`postgres store write failed: ${firstError.message}`);
        }
        // Give the dead connection back, destroyed, so close() (pool.end) never waits on it.
        if (lockClient === client) { lockClient = null; try { client.release(err instanceof Error ? err : new Error('lost')); } catch { /* already released */ } }
      });
    }
    for (const sql of SCHEMA) await pool.query(sql);
    const maps = await pool.query(
      'SELECT id, name, root, nodes, updated_at, draft, is_current FROM ontologizer_maps WHERE tenant = $1 ORDER BY updated_at, id', [tenant]);
    const evs = await pool.query(
      'SELECT map_id, event FROM ontologizer_events WHERE tenant = $1 ORDER BY map_id, seq', [tenant]);
    /** @type {Map<string, OntoEvent[]>} */
    const byMap = new Map();
    for (const r of evs.rows) {
      if (!byMap.has(r.map_id)) byMap.set(r.map_id, []);
      /** @type {OntoEvent[]} */ (byMap.get(r.map_id)).push(r.event);
    }
    rows = maps.rows.map((/** @type {any} */ r) => ({
      id: r.id, name: r.name, root: r.root, nodes: r.nodes, updatedAt: Number(r.updated_at), draft: r.draft,
    }));
    currentId = maps.rows.find((/** @type {any} */ r) => r.is_current)?.id ?? null;
    cache.clear();
    for (const [id, events] of byMap) cache.set(id, makeEntry(events));
    for (const r of rows) { const en = cache.get(r.id); if (en) applyVisibility(r, en.onto); }
  })();
  ready.catch(() => {});
  // Writes wait for the tables.
  chain = ready.then(() => {}, () => {});

  /** @param {string} id @returns {Entry} */
  function load(id) {
    check(id);
    let e = cache.get(id);
    if (!e) { e = makeEntry([]); cache.set(id, e); }
    return e;
  }

  /** @param {string} id */
  function now(id) {
    const e = load(id);
    if (!e.events.length) return 0;
    return Math.max(e.lastAt, Math.min(Date.now() - e.startedAt, e.lastAt + 1000));
  }

  /** Queue one row refresh per map row until it runs; it stores the row as it is in memory then.
   *  Keyed by the row object, not the id: an id can be reused after a save moves it. @type {WeakSet<IndexRow>} */
  const rowPending = new WeakSet();
  /** @param {IndexRow} row */
  function queueRow(row) {
    if (rowPending.has(row)) return;
    rowPending.add(row);
    enqueue(async (db) => {
      rowPending.delete(row);
      if (!rows.includes(row)) return; // replaced meanwhile: the write that replaced it carries the final values
      await db.query(
        'UPDATE ontologizer_maps SET name = $3, root = $4, nodes = $5, updated_at = $6 WHERE tenant = $1 AND id = $2',
        [tenant, row.id, row.name, row.root, row.nodes, row.updatedAt]);
    });
  }

  const sessions = {
    /** @param {string} id */
    get(id) { return sessionMap[id] ?? null; },
    /** @param {string} id @param {{port:number,pid:number,startedAt:number}} info */
    set(id, info) { sessionMap[id] = info; },
    /** @param {string} id */
    remove(id) { delete sessionMap[id]; },
  };

  /** @param {string} id */
  const rowOf = (id) => rows.find((r) => r.id === id);

  return {
    root: localRoot,
    sessions,
    ready,
    now,
    flush,
    /** Resolves when every write so far is stored; rejects once the store has failed. */
    sync() { return flush(); },
    /** The first write error, or null. */
    get failed() { return firstError; },

    /** Releases the tenant lock, then ends the pool (when this store made it), after the pending writes. */
    async close() {
      try { await chain; } finally {
        try {
          if (lockClient) {
            const c = lockClient; lockClient = null;
            try { await c.query(`SELECT pg_advisory_unlock(${PG_LOCK_NAMESPACE}, hashtext('ontologizer:' || $1))`, [tenant]); } finally { c.release(); }
          }
        } finally {
          if (pool && ownPool && !closed) { closed = true; await pool.end(); }
        }
      }
    },

    /** @param {any} brief @param {string} [suggestedName] @returns {string} */
    /**
     * @param {any} brief @param {string} [suggestedName]
     * @param {{ events?: OntoEvent[] }} [opts] events stored with the draft in the same transaction
     *   (ontology.created and a picked private source's raise: a crash can never leave it public)
     */
    createDraft(brief, suggestedName, { events = [] } = {}) {
      assertWritable();
      const base = `draft-${stamp(new Date())}`;
      let id = base;
      for (let n = 2; rowOf(id) || cache.has(id); n++) id = `${base}-${n}`;
      const entry = makeEntry(events.slice());
      /** @type {IndexRow} */
      const row = { id, name: entry.onto.name || suggestedName || id, root: entry.onto.root || '', nodes: countNodes(entry.onto), updatedAt: Date.now(), draft: true };
      applyVisibility(row, entry.onto);
      rows.push(row);
      cache.set(id, entry);
      currentId = id;
      const b = JSON.stringify(brief ?? {});
      const evJson = JSON.stringify(events);
      enqueue(() => inTx(async (db) => {
        await db.query('UPDATE ontologizer_maps SET is_current = false WHERE tenant = $1 AND is_current', [tenant]);
        await db.query(
          `INSERT INTO ontologizer_maps (tenant, id, name, root, nodes, updated_at, draft, brief, is_current)
           VALUES ($1, $2, $3, $4, $5, $6, true, $7::jsonb, true)`,
          [tenant, id, row.name, row.root, row.nodes, row.updatedAt, b]);
        if (events.length) {
          await db.query(
            `INSERT INTO ontologizer_events (tenant, map_id, seq, event)
             SELECT $1, $2, (t.n - 1)::integer, t.e FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS t(e, n)`,
            [tenant, id, evJson]);
        }
      }));
      return id;
    },

    /** @param {string} id @param {OntoEvent} event */
    append(id, event) {
      assertWritable();
      const e = load(id);
      const row = rowOf(id);
      if (!row) throw new Error(`Unknown ontology "${id}"`);
      if (event.t === 'ontology.created') e.startedAt = Date.now() - event.at;
      e.onto = fold(e.onto, event);
      if (typeof event.at === 'number') e.lastAt = Math.max(e.lastAt, event.at);
      const index = e.events.length;
      e.events.push(event);
      row.name = e.onto.name || row.name;
      row.root = e.onto.root;
      row.nodes = countNodes(e.onto);
      row.updatedAt = Date.now();
      applyVisibility(row, e.onto);
      const json = JSON.stringify(event);
      enqueue((db) => db.query(
        'INSERT INTO ontologizer_events (tenant, map_id, seq, event) VALUES ($1, $2, $3, $4::jsonb)',
        [tenant, id, index, json]));
      queueRow(row);
      for (const fn of [...e.subs]) fn(event, index);
    },

    /** @param {string} id @returns {Ontology} */
    read(id) {
      assertWritable(); // a failed store serves nothing: memory may hold an event Postgres never stored
      return load(id).onto;
    },

    /** @param {string} id @param {{ from?: number }} [opts] */
    async *events(id, { from = 0 } = {}) {
      assertWritable();
      const all = load(id).events.slice();
      for (let i = from; i < all.length; i++) yield all[i];
    },

    /** @param {string} id @param {(e: OntoEvent, i: number) => void} fn */
    subscribe(id, fn) {
      const e = load(id);
      e.subs.add(fn);
      return () => { e.subs.delete(fn); };
    },

    /** @param {string} id @param {string} name @param {{ overwrite?: boolean, actor?: any }} [opts]
     *  actor: stamped on the ontology.renamed event (service mode); without it the event is as before. */
    save(id, name, { overwrite = false, actor = null } = {}) {
      assertWritable();
      assertName(name);
      const e = load(id);
      if (name !== id) {
        const taken = cache.has(name) || rows.some((r) => r.id === name);
        if (taken && !overwrite) throw new Error(`"${name}" already exists. Pick another name or overwrite it.`);
      }
      this.append(id, { t: 'ontology.renamed', at: now(id), name, ...(actor ? { actor } : {}) });
      const row = rowOf(id) ?? { id, name, root: '', nodes: 0, updatedAt: 0, draft: false };
      const hadTarget = name !== id && (cache.has(name) || rows.some((r) => r.id === name));
      if (name !== id) {
        cache.delete(name);
        cache.delete(id);
        cache.set(name, e);
        if (id in sessionMap) { sessionMap[name] = sessionMap[id]; delete sessionMap[id]; }
      }
      rows = rows.filter((r) => r.id !== id && r.id !== name);
      Object.assign(row, { id: name, name, root: e.onto.root, nodes: countNodes(e.onto), updatedAt: Date.now(), draft: false });
      applyVisibility(row, e.onto);
      rows.push(row);
      currentId = name;
      const snap = { ...row };
      enqueue(() => inTx(async (db) => {
        if (name !== id) {
          if (hadTarget) {
            await db.query('DELETE FROM ontologizer_events WHERE tenant = $1 AND map_id = $2', [tenant, name]);
            await db.query('DELETE FROM ontologizer_maps WHERE tenant = $1 AND id = $2', [tenant, name]);
          }
          await db.query('UPDATE ontologizer_events SET map_id = $3 WHERE tenant = $1 AND map_id = $2', [tenant, id, name]);
          await db.query('UPDATE ontologizer_maps SET id = $3 WHERE tenant = $1 AND id = $2', [tenant, id, name]);
        }
        await db.query('UPDATE ontologizer_maps SET is_current = false WHERE tenant = $1 AND is_current', [tenant]);
        await db.query(
          `UPDATE ontologizer_maps SET name = $3, root = $4, nodes = $5, updated_at = $6, draft = false, is_current = true
           WHERE tenant = $1 AND id = $2`,
          [tenant, name, snap.name, snap.root, snap.nodes, snap.updatedAt]);
      }));
      return name;
    },

    /** @param {{ drafts?: boolean }} [opts] @returns {IndexRow[]} */
    list({ drafts = false } = {}) {
      assertWritable();
      return rows
        .filter((r) => drafts || !r.draft)
        .map((r) => ({ ...r }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },

    /** @param {string} nameOrPrefix @returns {string | null | { ambiguous: string[] }} */
    resolve(nameOrPrefix) {
      assertWritable();
      const exact = rows.find((r) => r.id === nameOrPrefix) ?? rows.find((r) => !r.draft && r.name === nameOrPrefix);
      if (exact) return exact.id;
      if (!nameOrPrefix) return null;
      const hits = [...new Set(rows.filter((r) => r.id.startsWith(nameOrPrefix) || (!r.draft && r.name.startsWith(nameOrPrefix))).map((r) => r.id))].sort();
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return { ambiguous: hits };
      return null;
    },

    /** @returns {string | null} */
    current() {
      return currentId;
    },

    /** @param {string} name @param {OntoEvent[]} events */
    importEvents(name, events) {
      assertWritable();
      assertName(name);
      if (rows.some((r) => r.id === name)) throw new Error(`"${name}" already exists.`);
      const onto = foldAll(events);
      const brief = events.find((x) => x.t === 'ontology.created')?.brief ?? onto.brief;
      const row = { id: name, name: onto.name || name, root: onto.root, nodes: countNodes(onto), updatedAt: Date.now(), draft: false };
      applyVisibility(row, onto);
      rows.push(row);
      cache.set(name, makeEntry(events.slice()));
      const evJson = JSON.stringify(events);
      const briefJson = JSON.stringify(brief ?? {});
      enqueue(() => inTx(async (db) => {
        await db.query('DELETE FROM ontologizer_events WHERE tenant = $1 AND map_id = $2', [tenant, name]);
        await db.query(
          `INSERT INTO ontologizer_maps (tenant, id, name, root, nodes, updated_at, draft, brief, is_current)
           VALUES ($1, $2, $3, $4, $5, $6, false, $7::jsonb, false)`,
          [tenant, name, row.name, row.root, row.nodes, row.updatedAt, briefJson]);
        await db.query(
          `INSERT INTO ontologizer_events (tenant, map_id, seq, event)
           SELECT $1, $2, (t.n - 1)::integer, t.e FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS t(e, n)`,
          [tenant, name, evJson]);
      }));
      return name;
    },
  };
}

/** One small pool per url for existence checks (one connection at most). @type {Map<string, any>} */
const existsPools = new Map();

/**
 * Whether a tenant has any map in a Postgres database, without opening its store or taking its lock.
 * For a config's `store.exists`: the server then never opens (and locks) a store for a tenant that
 * does not exist. False when the tables are not there yet.
 * @param {{ url?: string, pool?: any, tenant: string }} o
 * @returns {Promise<boolean>}
 */
export async function postgresTenantExists({ url, pool, tenant }) {
  if (typeof tenant !== 'string' || !TENANT_RE.test(tenant)) return false;
  let db = pool;
  if (!db) {
    db = existsPools.get(String(url));
    if (!db) {
      const pg = /** @type {any} */ (await import('pg'));
      const Pool = pg.Pool ?? pg.default?.Pool;
      db = new Pool({ connectionString: url, max: 1, idleTimeoutMillis: 5000, allowExitOnIdle: true });
      db.on('error', () => { /* an idle connection died: the next query reconnects */ });
      existsPools.set(String(url), db);
    }
  }
  try {
    const r = await db.query('SELECT 1 FROM ontologizer_maps WHERE tenant = $1 LIMIT 1', [tenant]);
    return r.rows.length > 0;
  } catch (/** @type {any} */ err) {
    if (err && err.code === '42P01') return false; // the tables do not exist yet
    throw err;
  }
}

/**
 * The config store port for Postgres, with `exists` set: `store: postgresStorePort({ url })`.
 * root: a folder for chat image attachments, one subfolder per tenant (default <home>/pg/<tenant>).
 * @param {{ url: string, root?: string }} o
 */
export function postgresStorePort({ url, root }) {
  /** @param {string} tenant */
  const port = (tenant) => openPostgresStore({ url, tenant, ...(root ? { root: path.join(root, tenant) } : {}) });
  port.exists = (/** @type {string} */ tenant) => postgresTenantExists({ url, tenant });
  return port;
}
