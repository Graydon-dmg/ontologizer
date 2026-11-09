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
/** @typedef {{ id: string, name: string, root: string, nodes: number, updatedAt: number, draft: boolean }} IndexRow */
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

/** @param {string} name */
function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`Invalid name "${name}": use lowercase letters, digits and hyphens (kebab-case).`);
  }
}

/** Valid tenant names: 'default' is the home itself; others live under <home>/tenants/<tenant>/. */
export const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** @param {string} [home] @param {{ tenant?: string }} [opts] */
export function openStore(home, { tenant = 'default' } = {}) {
  if (typeof tenant !== 'string' || !TENANT_RE.test(tenant)) {
    throw new Error(`Invalid tenant "${tenant}": use lowercase letters, digits and hyphens (at most 63 characters).`);
  }
  const base = home ?? process.env.ONTOLOGIZER_HOME ?? path.join(os.homedir(), '.ontologizer');
  const root = tenant === 'default' ? base : path.join(base, 'tenants', tenant);
  fs.mkdirSync(root, { recursive: true });
  const indexFile = path.join(root, 'index.json');
  const sessionsFile = path.join(root, 'sessions.json');
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
  };

  return {
    root,
    sessions,
    now,
    flush,

    /** @param {any} brief @param {string} [suggestedName] @returns {string} */
    createDraft(brief, suggestedName) {
      const base = `draft-${stamp(new Date())}`;
      let id = base;
      for (let n = 2; fs.existsSync(dir(id)); n++) id = `${base}-${n}`;
      fs.mkdirSync(dir(id), { recursive: true });
      fs.writeFileSync(path.join(dir(id), 'brief.json'), JSON.stringify(brief ?? {}));
      fs.writeFileSync(path.join(dir(id), 'events.jsonl'), '');
      updateIndex((idx) => {
        idx.ontologies.push({ id, name: suggestedName || id, root: '', nodes: 0, updatedAt: Date.now(), draft: true });
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
          try { writeSnapshotAndRow(id, e); } catch { /* dir may have moved */ }
        }, THROTTLE_MS);
        if (e.timer.unref) e.timer.unref();
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

    /** @param {string} id @param {string} name @param {{ overwrite?: boolean }} [opts] */
    save(id, name, { overwrite = false } = {}) {
      assertName(name);
      const e = load(id);
      if (name !== id) {
        const taken = fs.existsSync(dir(name)) || readIndex().ontologies.some((r) => r.id === name);
        if (taken && !overwrite) throw new Error(`"${name}" already exists. Pick another name or overwrite it.`);
      }
      this.append(id, { t: 'ontology.renamed', at: now(id), name });
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
      idx.ontologies.push(row);
      idx.current = name;
      });
      return name;
    },

    /** @param {{ drafts?: boolean }} [opts] @returns {IndexRow[]} */
    list({ drafts = false } = {}) {
      return readIndex()
        .ontologies.filter((r) => drafts || !r.draft)
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
          idx.ontologies.push({ id: name, name: onto.name || name, root: onto.root, nodes: Object.keys(onto.nodes).length, updatedAt: Date.now(), draft: false });
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
        idx.ontologies.push({ id: name, name: onto.name || name, root: onto.root, nodes: Object.keys(onto.nodes).length, updatedAt: Date.now(), draft: false });
      });
      return name;
    },
  };
}
