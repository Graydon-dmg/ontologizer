// @ts-check
// Layout: ~/.ontologizer/ (override with ONTOLOGIZER_HOME)
//   index.json        { current, ontologies: [{ id, name, root, nodes, updatedAt, draft }] }
//   sessions.json     { [id]: { port, pid, startedAt } }  (stale pids are ignored and cleaned up)
//   <id>/events.jsonl one event per line, append-only
//   <id>/snapshot.json foldAll(events), rewritten at most every 500 ms and on exit
//   <id>/brief.json
// A draft's id is "draft-<yyyymmdd-hhmmss>"; a saved ontology's id is its name.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { foldAll, fold } from './events.js';

/** @typedef {import('./schema.js').Ontology} Ontology */
/** @typedef {import('./events.js').OntoEvent} OntoEvent */
/** @typedef {{ id: string, name: string, root: string, nodes: number, updatedAt: number, draft: boolean,
 *             visibility?: 'private', privateSources?: string[] }} IndexRow
 *   visibility and privateSources are present only on a private map's row (a public row is as before),
 *   so service mode can filter the list without folding every map. */
/** @typedef {{ current: string|null, ontologies: IndexRow[] }} StoreIndex */
/** @typedef {{ onto: Ontology, count: number, lastAt: number, startedAt: number, dirty: boolean,
 *             timer: any, subs: Set<(e: OntoEvent, i: number) => void> }} Entry */

const THROTTLE_MS = 500;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** @type {Set<{ flushDirty: () => void }>} */
const liveStores = new Set();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const s of liveStores) {
      try { s.flushDirty(); } catch { /* best effort on exit */ }
    }
  });
}

/** Write a whole file so a crash leaves either nothing or all of it: temp file in the same
 *  directory, fsync, rename, then fsync the directory (best effort; not every platform allows it).
 *  @param {string} file @param {string} text */
function writeFileDurable(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  try {
    const dfd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* directory fsync is unsupported on some platforms (Windows) */ }
}

/** @param {string} file @param {any} data */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/** @param {string} file @param {any} fallback */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** @param {string} file @returns {OntoEvent[]} */
function readEventsFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  /** @type {OntoEvent[]} */
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

/** @param {Date} d */
function stamp(d) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** @param {number} pid */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (/** @type {any} */ err) {
    return err && err.code === 'EPERM';
  }
}

/** Names a map can never take: `tenants` is the folder that holds the other tenants' maps. */
export const RESERVED_NAMES = ['tenants'];

/** sessions.json keys for running servers (a map id never starts with ":"). */
const SERVER_KEY = ':server:';
/** Thrown to skip the open-time purge (never escapes openStore). */
const SKIP = Symbol('skip');

/** How long a deleted map stays in the trash before it is purged for good. */
export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A trash id: the map's id, "--", and the UTC time it was deleted ("sourdough--20261109-153012z", "-2" on a clash). */
export const TRASH_ID_RE = /^[a-z0-9][a-z0-9-]*--\d{8}-\d{6}z(?:-\d+)?$/;

/** @param {number} ms the deletion time, as a UTC stamp for a trash id */
export function trashStamp(ms) {
  const d = new Date(ms);
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}z`;
}

/** When a trash item was deleted, from its id (for an item whose trash.json cannot be read). @param {string} trashId */
export function trashIdTime(trashId) {
  const m = /--(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})z(?:-\d+)?$/.exec(trashId);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}

/** An error with a code the router and the CLI tell apart. @param {string} code @param {string} message */
function coded(code, message) {
  const err = new Error(message);
  /** @type {any} */ (err).code = code;
  return err;
}
export { coded as storeError };

/** @typedef {{ trashId: string, id: string, name: string, draft: boolean, deletedAt: number, deletedBy: any,
 *             root: string, nodes: number, visibility?: 'private', privateSources?: string[] }} TrashItem
 *   visibility and privateSources only on a private map's item, as on an index row. */

/**
 * One trash item, as listTrash() gives it (both stores), from what trash.json (or the trash table) holds.
 * @param {string} trashId @param {any} info @returns {TrashItem}
 */
export function trashRow(trashId, info) {
  const item = {
    trashId, id: String(info.id ?? ''), name: String(info.name ?? info.id ?? ''), draft: Boolean(info.draft),
    deletedAt: typeof info.deletedAt === 'number' ? info.deletedAt : trashIdTime(trashId), deletedBy: info.deletedBy ?? null,
    root: String(info.root ?? ''), nodes: Number.isInteger(info.nodes) ? info.nodes : 0,
  };
  return info.visibility === 'private'
    ? { ...item, visibility: 'private', privateSources: [...(Array.isArray(info.privateSources) ? info.privateSources : [])].map(String).sort() }
    : item;
}

/**
 * What a trash item records about the map it holds (trash.json, the Postgres trash row): its id, name,
 * draft flag, when and by whom it was deleted, and its visibility, so the trash list keeps a private
 * map private without folding it.
 * @param {IndexRow} row @param {Ontology} onto @param {{ actor: any, at: number }} o
 */
export function trashInfo(row, onto, { actor, at }) {
  return {
    id: row.id, name: row.name, draft: Boolean(row.draft), deletedAt: at, deletedBy: actor ?? null,
    root: onto.root ?? row.root ?? '', nodes: Object.keys(onto.nodes ?? {}).length,
    visibility: onto.visibility === 'private' ? 'private' : 'public',
    privateSources: onto.visibility === 'private' ? [...(onto.privateSources ?? [])].sort() : [],
  };
}

/** The message for a restore whose name is taken. @param {string} name */
export const takenForRestore = (name) => `"${name}" already exists: restore it under another name.`;

/** @param {string} name */
function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`Invalid name "${name}": use lowercase letters, digits and hyphens (kebab-case).`);
  }
  if (RESERVED_NAMES.includes(name)) {
    throw new Error(`"${name}" is a reserved name (it holds service mode's tenants). Pick another name.`);
  }
}

/**
 * Keep a row's visibility keys in step with its map: only a private map carries them.
 * @param {any} row @param {import('./schema.js').Ontology} onto
 */
function rowVisibility(row, onto) {
  if (onto.visibility === 'private') {
    row.visibility = 'private';
    row.privateSources = [...(onto.privateSources ?? [])].sort();
  } else {
    delete row.visibility;
    delete row.privateSources;
  }
  return row;
}

/** Valid tenant names: 'default' is the home itself; others live under <home>/tenants/<tenant>/. */
export const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Said by serve and status when <home>/tenants is a map, not the tenants folder. */
export const TENANTS_MAP_WARNING = "a map named 'tenants' exists; rename it to use multiple tenants";

/** @param {string} [home] */
const homeDir = (home) => home ?? process.env.ONTOLOGIZER_HOME ?? path.join(os.homedir(), '.ontologizer');

/**
 * Whether <home>/tenants is a saved map from before service mode (it holds events.jsonl). Then it
 * stays a map: no tenants are read from it and nothing is ever written inside it.
 * @param {string} [home]
 */
export function tenantsIsMap(home) {
  return fs.existsSync(path.join(homeDir(home), 'tenants', 'events.jsonl'));
}

/** The tenants of a home: 'default' first, then the folders under <home>/tenants/, sorted. @param {string} [home] */
export function listTenants(home) {
  if (tenantsIsMap(home)) return ['default'];
  /** @type {string[]} */
  const names = [];
  try {
    for (const e of fs.readdirSync(path.join(homeDir(home), 'tenants'), { withFileTypes: true })) {
      if (e.isDirectory() && TENANT_RE.test(e.name) && e.name !== 'default') names.push(e.name);
    }
  } catch { /* no tenants folder */ }
  return ['default', ...names.sort()];
}

/**
 * @param {string} [home]
 * @param {{ tenant?: string, repair?: boolean, log?: (line: string) => void }} [opts]
 *   repair (service mode): on open, give any index row that lacks it the visibility its events say
 *   (a crash between a raise and its index write). log: where index-write errors go (default stderr).
 */
export function openStore(home, { tenant = 'default', repair = false, log = (line) => { try { process.stderr.write(`${line}\n`); } catch { /* closed */ } } } = {}) {
  if (typeof tenant !== 'string' || !TENANT_RE.test(tenant)) {
    throw new Error(`Invalid tenant "${tenant}": use lowercase letters, digits and hyphens (at most 63 characters).`);
  }
  const base = homeDir(home);
  if (tenant !== 'default' && tenantsIsMap(base)) throw new Error(`Cannot open tenant "${tenant}": ${TENANTS_MAP_WARNING}.`);
  const root = tenant === 'default' ? base : path.join(base, 'tenants', tenant);
  fs.mkdirSync(root, { recursive: true });
  const indexFile = path.join(root, 'index.json');
  const sessionsFile = path.join(root, 'sessions.json');
  // Deleted maps: <root>/.trash/<trashId>/ is the map's folder as it was, plus trash.json. A dot
  // folder never matches a map id, so nothing that reads maps ever sees it.
  const trashRoot = path.join(root, '.trash');
  /** @param {string} trashId */
  const trashDir = (trashId) => {
    if (typeof trashId !== 'string' || !TRASH_ID_RE.test(trashId)) throw coded('NOT_FOUND', 'That item is not in the trash.');
    return path.join(trashRoot, trashId);
  };
  /** @param {string} id */
  const dir = (id) => {
    // ids become folder names: only drafts and kebab-case names, never a path.
    if (typeof id !== 'string' || !NAME_RE.test(id)) throw new Error(`Invalid ontology id "${id}"`);
    return path.join(root, id);
  };

  /** @type {Map<string, Entry>} */
  const cache = new Map();

  /** @returns {StoreIndex} */
  function readIndex() {
    const j = readJson(indexFile, null);
    return {
      current: j && typeof j.current === 'string' ? j.current : null,
      ontologies: j && Array.isArray(j.ontologies) ? j.ontologies : [],
    };
  }
  /** @param {StoreIndex} idx */
  function writeIndex(idx) {
    writeJsonAtomic(indexFile, idx);
  }

  // Every read-modify-write of index.json runs under a lock file, so two processes (two `load`s
  // importing at once, a session flushing while `save` runs) never lose each other's rows.
  const lockFile = `${indexFile}.lock`;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  /** @template T @param {(idx: StoreIndex) => T} fn @returns {T} */
  function updateIndex(fn) {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        fs.closeSync(fs.openSync(lockFile, 'wx'));
        break;
      } catch (/** @type {any} */ err) {
        if (err.code !== 'EEXIST') throw err;
        // A lock older than 5 s was left by a crashed process: take it over.
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > 5000) fs.rmSync(lockFile, { force: true });
        } catch { /* it just went away */ }
        if (Date.now() > deadline) throw new Error('index.json is locked by another ontologizer process');
        Atomics.wait(sleeper, 0, 0, 5);
      }
    }
    try {
      const idx = readIndex();
      const out = fn(idx);
      writeIndex(idx);
      return out;
    } finally {
      fs.rmSync(lockFile, { force: true });
    }
  }

  /** @param {string} id @returns {Entry} */
  function load(id) {
    let e = cache.get(id);
    if (e) return e;
    const events = readEventsFile(path.join(dir(id), 'events.jsonl'));
    const onto = foldAll(events);
    const created = events.find((x) => x.t === 'ontology.created');
    const lastAt = events.length ? Math.max(...events.map((x) => (typeof x.at === 'number' ? x.at : 0))) : 0;
    const startedAt = Date.now() - (created ? created.at : 0);
    e = { onto, count: events.length, lastAt, startedAt, dirty: false, timer: null, subs: new Set() };
    cache.set(id, e);
    return e;
  }

  /** @param {string} id @param {Entry} e */
  /**
   * Write a map's snapshot and index row now. An error is logged (never swallowed) and the map stays
   * dirty, so the next write (or the next flush) tries again.
   * @param {string} id @param {Entry} e
   */
  function writeRow(id, e) {
    try { writeSnapshotAndRow(id, e); } catch (err) {
      e.dirty = true;
      log(`ontologizer: could not update the index for ${id} (will retry on the next write): ${/** @type {any} */ (err)?.code ?? /** @type {any} */ (err)?.message ?? err}`);
    }
  }
  /** @param {string} id @param {Entry} e */
  function writeSnapshotAndRow(id, e) {
    if (!fs.existsSync(dir(id))) return;
    writeJsonAtomic(path.join(dir(id), 'snapshot.json'), e.onto);
    updateIndex((idx) => {
      const row = idx.ontologies.find((r) => r.id === id);
      if (row) {
        row.name = e.onto.name || row.name;
        row.root = e.onto.root;
        row.nodes = Object.keys(e.onto.nodes).length;
        row.updatedAt = Date.now();
        rowVisibility(row, e.onto);
      }
    });
    e.dirty = false;
  }

  /** @param {string} [id] */
  function flush(id) {
    const ids = id ? [id] : [...cache.keys()];
    for (const i of ids) {
      const e = cache.get(i);
      if (!e) continue;
      if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      if (id || e.dirty) writeSnapshotAndRow(i, e);
    }
  }

  function flushDirty() {
    for (const [i, e] of cache) if (e.dirty) flush(i);
  }
  const self = { flushDirty };
  liveStores.add(self);
  hookExit();

  // Repair: a row that lacks the visibility its events record (a crash between the raise and the
  // index write) is fixed from the events. Only maps whose log mentions a raise are folded.
  if (repair) {
    try {
      const rows = readIndex().ontologies.filter((r) => r.visibility !== 'private');
      for (const r of rows) {
        let text = '';
        try { text = fs.readFileSync(path.join(dir(r.id), 'events.jsonl'), 'utf8'); } catch { continue; }
        if (!text.includes('"visibility.raised"')) continue;
        const onto = foldAll(readEventsFile(path.join(dir(r.id), 'events.jsonl')));
        if (onto.visibility !== 'private') continue;
        updateIndex((idx) => { const row = idx.ontologies.find((x) => x.id === r.id); if (row) rowVisibility(row, onto); });
        log(`ontologizer: repaired the index row of ${r.id} (private)`);
      }
    } catch (err) { log(`ontologizer: index repair failed: ${/** @type {any} */ (err)?.message ?? err}`); }
  }

  /** @param {string} id */
  function now(id) {
    const e = load(id);
    if (!e.count) return 0;
    return Math.max(e.lastAt, Math.min(Date.now() - e.startedAt, e.lastAt + 1000));
  }

  /** @type {any} */
  const sessions = {
    /** @param {string} id */
    get(id) {
      const all = readJson(sessionsFile, {});
      const info = all[id];
      if (!info) return null;
      if (pidAlive(info.pid)) return info;
      delete all[id];
      writeJsonAtomic(sessionsFile, all);
      return null;
    },
    /** @param {string} id @param {{port:number,pid:number,startedAt:number}} info */
    set(id, info) {
      const all = readJson(sessionsFile, {});
      all[id] = info;
      writeJsonAtomic(sessionsFile, all);
    },
    /** @param {string} id */
    remove(id) {
      const all = readJson(sessionsFile, {});
      if (!(id in all)) return;
      delete all[id];
      writeJsonAtomic(sessionsFile, all);
    },
    /**
     * Register a running server on this home (service mode: `serve`, or `ontologizer mcp`'s in-process
     * one), under a key no map id can take. @param {{ pid: number, port: number, url: string, startedAt: number }} info
     * @returns {string} the key, for remove()
     */
    addServer(info) {
      const key = `${SERVER_KEY}${info.pid}:${info.port}`;
      this.set(key, info);
      return key;
    },
    /** The servers running on this home now; an entry whose process is gone is dropped. @returns {Array<{ pid: number, port: number, url: string, startedAt: number }>} */
    servers() {
      const all = readJson(sessionsFile, {});
      /** @type {any[]} */
      const out = [];
      let stale = false;
      for (const [k, v] of Object.entries(all)) {
        if (!k.startsWith(SERVER_KEY)) continue;
        if (v && pidAlive(v.pid)) out.push(v); else { delete all[k]; stale = true; }
      }
      if (stale) writeJsonAtomic(sessionsFile, all);
      return out;
    },
  };

  /** @returns {TrashItem[]} newest first; an item whose trash.json is unreadable is listed from its id */
  function listTrash() {
    /** @type {string[]} */
    let names = [];
    try { names = fs.readdirSync(trashRoot); } catch { return []; }
    /** @type {TrashItem[]} */
    const out = [];
    for (const trashId of names) {
      if (!TRASH_ID_RE.test(trashId)) continue;
      const info = readJson(path.join(trashRoot, trashId, 'trash.json'), null) ?? {};
      const id = typeof info.id === 'string' ? info.id : trashId.replace(/--\d{8}-\d{6}z(?:-\d+)?$/, '');
      out.push(trashRow(trashId, { ...info, id }));
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt || (a.trashId < b.trashId ? 1 : -1));
  }

  /**
   * Remove trash items deleted more than `olderThanDays` ago, for good. @returns {string[]} the purged trash ids
   * @param {{ olderThanDays?: number, now?: number }} [o]
   */
  function purgeTrash({ olderThanDays = TRASH_DAYS, now: at = Date.now() } = {}) {
    const cutoff = at - olderThanDays * DAY_MS;
    /** @type {string[]} */
    const gone = [];
    for (const item of listTrash()) {
      if (!(item.deletedAt < cutoff)) continue;
      try { fs.rmSync(path.join(trashRoot, item.trashId), { recursive: true, force: true }); gone.push(item.trashId); } catch (err) {
        log(`ontologizer: could not purge ${item.trashId} from the trash: ${/** @type {any} */ (err)?.code ?? err}`);
      }
    }
    return gone;
  }

  // On open: purge what is past its 30 days, and drop an index row a crash left behind after its map
  // folder had already moved to the trash (the folder is gone, and the trash holds that id). Not while
  // another process's server runs on this home: it owns the trash then (it purges once a day), and a
  // purge here could race its restore.
  try {
    if (sessions.servers().some((s) => s.pid !== process.pid)) throw SKIP;
    purgeTrash();
    const trashed = new Set(listTrash().map((t) => t.id));
    // A restore that crashed after its row and before its rename: that row too (it may be under `as`).
    for (const t of listTrash()) {
      const as = readJson(path.join(trashRoot, t.trashId, 'trash.json'), null)?.restoringAs;
      if (typeof as === 'string') trashed.add(as);
    }
    const stale = readIndex().ontologies.filter((r) => trashed.has(r.id) && !fs.existsSync(path.join(root, r.id)));
    if (stale.length) {
      updateIndex((idx) => {
        idx.ontologies = idx.ontologies.filter((r) => !stale.some((s) => s.id === r.id));
        if (idx.current && stale.some((s) => s.id === idx.current)) idx.current = null;
      });
    }
  } catch (err) { if (err !== SKIP) log(`ontologizer: could not tidy the trash: ${/** @type {any} */ (err)?.message ?? err}`); }

  return {
    root,
    sessions,
    now,
    flush,

    /** Write what is pending and forget this store (service mode closes idle tenants' stores). */
    close() {
      try { flushDirty(); } finally { liveStores.delete(self); }
    },

    /**
     * @param {any} brief @param {string} [suggestedName]
     * @param {{ events?: OntoEvent[] }} [opts] events written with the draft, in the same single file write
     *   (service mode: ontology.created and a picked private source's raise, so the draft is never public)
     * @returns {string}
     */
    createDraft(brief, suggestedName, { events = [] } = {}) {
      const base = `draft-${stamp(new Date())}`;
      let id = base;
      for (let n = 2; fs.existsSync(dir(id)); n++) id = `${base}-${n}`;
      fs.mkdirSync(dir(id), { recursive: true });
      fs.writeFileSync(path.join(dir(id), 'brief.json'), JSON.stringify(brief ?? {}));
      // Durable before the index row names it: a crash can never keep the row but lose the raise.
      writeFileDurable(path.join(dir(id), 'events.jsonl'), events.map((x) => JSON.stringify(x) + '\n').join(''));
      const onto = events.length ? foldAll(events) : null;
      updateIndex((idx) => {
        const row = { id, name: (onto && onto.name) || suggestedName || id, root: onto ? onto.root : '', nodes: onto ? Object.keys(onto.nodes).length : 0, updatedAt: Date.now(), draft: true };
        idx.ontologies.push(onto ? rowVisibility(row, onto) : row);
        idx.current = id;
      });
      return id;
    },

    /** @param {string} id @param {OntoEvent} event */
    append(id, event) {
      const e = load(id);
      fs.appendFileSync(path.join(dir(id), 'events.jsonl'), JSON.stringify(event) + '\n');
      if (event.t === 'ontology.created') e.startedAt = Date.now() - event.at;
      e.onto = fold(e.onto, event);
      if (typeof event.at === 'number') e.lastAt = Math.max(e.lastAt, event.at);
      const index = e.count++;
      e.dirty = true;
      if (!e.timer) {
        e.timer = setTimeout(() => {
          e.timer = null;
          writeRow(id, e);
        }, THROTTLE_MS);
        if (e.timer.unref) e.timer.unref();
      }
      // A raise reaches the index at once (not on the throttle), so the list is never stale about it.
      if (event.t === 'visibility.raised') {
        if (e.timer) { clearTimeout(e.timer); e.timer = null; }
        writeRow(id, e);
      }
      for (const fn of [...e.subs]) fn(event, index);
    },

    /** @param {string} id @returns {Ontology} */
    read(id) {
      return load(id).onto;
    },

    /** @param {string} id @param {{ from?: number }} [opts] */
    async *events(id, { from = 0 } = {}) {
      const all = readEventsFile(path.join(dir(id), 'events.jsonl'));
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
      assertName(name);
      const e = load(id);
      if (name !== id) {
        const taken = fs.existsSync(dir(name)) || readIndex().ontologies.some((r) => r.id === name);
        if (taken && !overwrite) throw new Error(`"${name}" already exists. Pick another name or overwrite it.`);
      }
      this.append(id, { t: 'ontology.renamed', at: now(id), name, ...(actor ? { actor } : {}) });
      flush(id);
      if (name !== id) {
        if (fs.existsSync(dir(name))) {
          cache.delete(name);
          fs.rmSync(dir(name), { recursive: true, force: true });
        }
        fs.renameSync(dir(id), dir(name));
        cache.delete(id);
        cache.set(name, e);
        if (e.timer) { clearTimeout(e.timer); e.timer = null; }
        const all = readJson(sessionsFile, {});
        if (id in all) {
          all[name] = all[id];
          delete all[id];
          writeJsonAtomic(sessionsFile, all);
        }
      }
      updateIndex((idx) => {
      const row = idx.ontologies.find((r) => r.id === id) ?? { id, name, root: '', nodes: 0, updatedAt: 0, draft: false };
      idx.ontologies = idx.ontologies.filter((r) => r.id !== id && r.id !== name);
      Object.assign(row, {
        id: name,
        name,
        root: e.onto.root,
        nodes: Object.keys(e.onto.nodes).length,
        updatedAt: Date.now(),
        draft: false,
      });
      rowVisibility(row, e.onto);
      idx.ontologies.push(row);
      idx.current = name;
      });
      return name;
    },

    /** @param {{ drafts?: boolean }} [opts] @returns {IndexRow[]} */
    list({ drafts = false } = {}) {
      return readIndex()
        .ontologies.filter((r) => drafts || !r.draft)
        // A map this store has in memory is shown as it is now, even if its row write is still due
        // (or failed and waits for a retry): visibility is never stale in the list.
        .map((r) => { const e = cache.get(r.id); return e ? rowVisibility({ ...r }, e.onto) : r; })
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },

    /** @param {string} nameOrPrefix @returns {string | null | { ambiguous: string[] }} */
    resolve(nameOrPrefix) {
      const rows = readIndex().ontologies;
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
      return readIndex().current;
    },

    /** @param {string} name @param {OntoEvent[]} events */
    importEvents(name, events) {
      assertName(name);
      if (readIndex().ontologies.some((r) => r.id === name)) throw new Error(`"${name}" already exists.`);
      if (fs.existsSync(path.join(dir(name), 'events.jsonl'))) {
        // Self-heal: the folder exists but its index row was lost. Re-register it from what is on
        // disk (its own events win over the ones offered) instead of refusing forever.
        const onto = foldAll(readEventsFile(path.join(dir(name), 'events.jsonl')));
        updateIndex((idx) => {
          if (idx.ontologies.some((r) => r.id === name)) return;
          idx.ontologies.push(rowVisibility({ id: name, name: onto.name || name, root: onto.root, nodes: Object.keys(onto.nodes).length, updatedAt: Date.now(), draft: false }, onto));
        });
        return name;
      }
      fs.mkdirSync(dir(name), { recursive: true });
      fs.writeFileSync(path.join(dir(name), 'events.jsonl'), events.map((x) => JSON.stringify(x) + '\n').join(''));
      const onto = foldAll(events);
      const brief = events.find((x) => x.t === 'ontology.created')?.brief ?? onto.brief;
      fs.writeFileSync(path.join(dir(name), 'brief.json'), JSON.stringify(brief));
      writeJsonAtomic(path.join(dir(name), 'snapshot.json'), onto);
      updateIndex((idx) => {
        idx.ontologies = idx.ontologies.filter((r) => r.id !== name);
        idx.ontologies.push(rowVisibility({ id: name, name: onto.name || name, root: onto.root, nodes: Object.keys(onto.nodes).length, updatedAt: Date.now(), draft: false }, onto));
      });
      return name;
    },

    /**
     * Move a map to the trash: its folder (events, snapshot, brief, attachments) goes to
     * <root>/.trash/<id>--<UTC stamp>/ with a trash.json, and its index row is removed. Refused while a
     * running one-map session serves it (sessions.json). @returns {string} the trash id
     * @param {string} id @param {{ actor?: any, now?: number }} [opts] now: the deletion time (tests)
     */
    trash(id, { actor = null, now: at = Date.now() } = {}) {
      dir(id);
      const row = readIndex().ontologies.find((r) => r.id === id);
      if (!row) throw coded('NOT_FOUND', `No map "${id}".`);
      const live = sessions.get(id);
      if (live && live.pid !== process.pid) throw coded('SERVED', `"${id}" is open in a running session (port ${live.port}): stop it first.`);
      // Its snapshot and row as they are now, so the trash holds the map exactly as it was.
      const e = load(id);
      if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      if (fs.existsSync(dir(id))) writeJsonAtomic(path.join(dir(id), 'snapshot.json'), e.onto);
      fs.mkdirSync(trashRoot, { recursive: true });
      const base = `${id}--${trashStamp(at)}`;
      let trashId = base;
      for (let n = 2; fs.existsSync(path.join(trashRoot, trashId)); n++) trashId = `${base}-${n}`;
      const info = trashInfo(row, e.onto, { actor, at });
      if (fs.existsSync(dir(id))) {
        writeJsonAtomic(path.join(dir(id), 'trash.json'), info);
        fs.renameSync(dir(id), path.join(trashRoot, trashId));
      } else {
        fs.mkdirSync(path.join(trashRoot, trashId), { recursive: true });
        writeJsonAtomic(path.join(trashRoot, trashId, 'trash.json'), info);
      }
      cache.delete(id);
      updateIndex((idx) => {
        idx.ontologies = idx.ontologies.filter((r) => r.id !== id);
        if (idx.current === id) idx.current = null;
      });
      return trashId;
    },

    /** The trash, newest first. @returns {TrashItem[]} */
    listTrash,

    /**
     * Bring a map back from the trash, under its own id or `as` (which also names a draft: it comes
     * back saved, with an ontology.renamed event as `save` writes). A taken id is refused (code TAKEN).
     * @param {string} trashId @param {{ as?: string|null, actor?: any }} [opts] @returns {string} the map's id
     */
    restore(trashId, { as = null, actor = null } = {}) {
      const from = trashDir(trashId);
      const info = readJson(path.join(from, 'trash.json'), null);
      if (!info || typeof info.id !== 'string' || !fs.existsSync(from)) throw coded('NOT_FOUND', 'That item is not in the trash.');
      if (as !== null && as !== undefined) assertName(as);
      const target = as ?? info.id;
      dir(target);
      if (fs.existsSync(dir(target)) || readIndex().ontologies.some((r) => r.id === target)) throw coded('TAKEN', takenForRestore(target));
      const renamed = target !== info.id;
      const draft = Boolean(info.draft) && !renamed;
      // The row first, from what the events say (its visibility and private sources come back with
      // them), and only then the folder: a crash between leaves a row with no folder whose name the
      // trash item records (restoringAs), which the tidy on open drops, so the map is still in the
      // trash. Folder first would leave a map that no list or trash shows.
      writeJsonAtomic(path.join(from, 'trash.json'), { ...info, restoringAs: target });
      const onto = foldAll(readEventsFile(path.join(from, 'events.jsonl')));
      updateIndex((idx) => {
        idx.ontologies = idx.ontologies.filter((r) => r.id !== target);
        idx.ontologies.push(rowVisibility({ id: target, name: onto.name || info.name || target, root: onto.root, nodes: Object.keys(onto.nodes).length, updatedAt: Date.now(), draft }, onto));
      });
      try { fs.renameSync(from, dir(target)); } catch (err) {
        updateIndex((idx) => { idx.ontologies = idx.ontologies.filter((r) => r.id !== target); });
        throw err;
      }
      fs.rmSync(path.join(dir(target), 'trash.json'), { force: true });
      cache.delete(target);
      if (renamed) {
        this.append(target, { t: 'ontology.renamed', at: now(target), name: target, ...(actor ? { actor } : {}) });
        flush(target);
      }
      return target;
    },

    purgeTrash,
  };
}
