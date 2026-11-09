// @ts-check
// Service mode (ontologizer serve): one server for every map in a home, by tenant, with tokens.
// The per-map routes are the one-map server's own handlers (map.js), mounted under each map's base
// /v1/t/<tenant>/maps/<id>, so the map page works there unchanged.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { resolveVendorPath } from '../core/vendor.js';
import { openStore, TENANT_RE } from '../core/store.js';
import { readTokens, checkToken, hasScope } from './tokens.js';
import { PKG_ROOT, WEB_ROOT, json, plain, sendFile, serveFile, sendPage, readBody } from './http.js';
import { createMapHandler } from './map.js';
import { defaultPolicy, actionFor, ACTION_SCOPE } from './policy.js';
import { createSources, heldSources } from './sources.js';
import { portNames } from './config.js';
import { slug } from '../core/engine/ids.js';

export const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
export const COOKIE = 'ontologizer_session';
export const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip'];
export const TOKENS_FOUND_NOTE = 'tokens found: restart serve to require them';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;
const MAX_SESSIONS_PER_TOKEN = 20;
const WAIT_DEFAULT = 30000;
const WAIT_MAX = 300000;
const MAP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const VIEW_RE = /^\/v1\/t\/[a-z0-9][a-z0-9-]{0,62}\/maps\/[a-z0-9][a-z0-9-]*\/view$/;
const CHECK_KEY = 'draft-pending'; // the engine that answers maps/check (it writes nothing)
const REJECTED = 'Your Anthropic API key was rejected: run ontologizer key set';
const MAX_STORES = 16;           // default cap on tenants with an open store at once (each Postgres store holds connections)
const REACH_MS = 30000;          // how long a source's reachability is remembered for status

/** A --host that is loopback. @param {string} host */
export const isLoopback = (host) => LOOPBACK.includes(String(host).replace(/^\[|\]$/g, ''));

/** @param {string} tenant @param {string} id */
export const mapBase = (tenant, id) => `/v1/t/${tenant}/maps/${id}`;

/**
 * What still runs on a map: its build, its unfinished jobs, and a chat answer being written. Save,
 * wait and idle eviction all go by this list; a map with anything on it is never renamed or dropped.
 * @param {{ state: string } | undefined} build @param {Record<string, any>} snapshotJobs @param {boolean} chatting
 */
export function activeWork(build, snapshotJobs, chatting) {
  /** @type {any[]} */
  const jobs = [];
  if (build && (build.state === 'queued' || build.state === 'running')) jobs.push({ id: 'build', kind: 'build', state: build.state });
  for (const j of Object.values(snapshotJobs || {})) {
    if (j && (j.state === 'queued' || j.state === 'running')) jobs.push({ id: j.id, kind: j.kind, state: j.state, ...(j.nodeId ? { nodeId: j.nodeId } : {}) });
  }
  if (chatting) jobs.push({ id: 'chat', kind: 'chat', state: 'running' });
  return jobs;
}

/**
 * Who is calling. `via` is how they proved it: 'open' (no tokens loaded, loopback only),
 * 'bearer' (Authorization header), 'cookie' (a session from POST /v1/session) or 'identity' (the
 * config's identity port). `hash` and `sid` let a long request (an event stream) re-check that the
 * token and session still stand. `actor` is stamped on the events the request causes; `sources` are
 * the configured sources it holds.
 * @typedef {{ name: string|null, tenant: string|null, scopes: string[], via: 'open'|'bearer'|'cookie'|'identity', hash?: string, sid?: string,
 *   actor: { id: string, kind: string, via?: string }, sources: string[] }} Principal
 */

/** @param {any} err */
const errText = (err) => (err && (err.status === 401 || err.name === 'AuthenticationError') ? REJECTED : String(err?.message ?? err));

/** A Refusing error that `serve` turns into exit 1. @param {string} message */
function refusal(message) {
  const err = new Error(message);
  /** @type {any} */ (err).code = 'NO_TOKENS';
  return err;
}

/**
 * @param {{ home: string, host?: string, port?: number, tokensFile?: string|null, watchTokensFile?: string|null,
 *   allowHosts?: string[], maxBuilds?: number, maxQueued?: number, maxChecks?: number, maxStreamsPerToken?: number,
 *   idleMs?: number, pingMs?: number,
 *   makeEngine: (o: { store: any, id: string, tenant: string, clientFor?: any }) => Promise<any>,
 *   version?: string, webDir?: string, log?: (line: string) => void,
 *   config?: any, configPath?: string|null, sources?: ReturnType<typeof createSources>|null }} opts
 *   tokensFile: the tokens to load; null (or no rows) means none: loopback only, open, no --allow-host.
 *   watchTokensFile: when open, a tokens file to watch so status can say "restart serve to require them".
 *   maxBuilds: builds running at once. maxQueued: builds waiting per tenant (more: 429).
 *   maxChecks: context checks at once (more: 429). maxStreamsPerToken: event streams + waits per token.
 *   idleMs: a map's engine and handler with no streams and no work are dropped after this long.
 *   makeEngine: the engine for one map (the CLI passes engineFor with needKey false); clientFor is the
 *   config's model port, when it has one.
 *   config: the loaded ontologizer.config.js (or null: exactly I1). configPath: shown to admins.
 *   sources: a createSources() instance (tests inject one); default: made from config.sources.
 */
export async function startService({
  home, host = '127.0.0.1', port = 8787, tokensFile = null, watchTokensFile = null, allowHosts = [],
  maxBuilds = 2, maxQueued = 10, maxChecks = 4, maxStreamsPerToken = 50, idleMs = 10 * 60 * 1000, pingMs, maxStores = MAX_STORES,
  makeEngine, version = '', webDir, log = () => {}, config = null, configPath = null, sources: givenSources = null,
}) {
  // ---- ports: each one is the config's, or I1's own behaviour ----
  const identity = config?.identity ?? null;
  const policy = config?.policy ?? defaultPolicy;
  const ports = portNames(config);
  const srcs = givenSources ?? (Array.isArray(config?.sources) && config.sources.length ? createSources(config.sources, { log }) : null);
  const entries = srcs ? srcs.entries : [];
  const webRoot = path.resolve(webDir ?? WEB_ROOT);
  const fixturesRoot = path.join(PKG_ROOT, 'fixtures');
  const coreRoot = path.join(PKG_ROOT, 'src', 'core');
  const startedAt = new Date().toISOString();
  const allow = allowHosts.map((a) => String(a).trim().toLowerCase()).filter(Boolean);

  // ---- tokens: read at start; re-read when the file changes (a revoke takes effect at once). ----
  let tokenRows = tokensFile ? readTokens(tokensFile) : [];
  // Whether auth is required is fixed at start: revoking every token never opens the server.
  // A custom identity port always requires a principal.
  const authRequired = tokenRows.length > 0 || identity !== null;
  // Say where it looked, and the exact command that fixes it.
  const where = tokensFile ?? watchTokensFile ?? path.join(home, 'tokens.json');
  const fix = `Create one with \`ontologizer token create --name <name> --home ${shellQuote(home)}\`, then run serve again with the same --home.`;
  if (!authRequired && !isLoopback(host)) {
    throw refusal(`Refusing to listen on ${host}: no tokens in ${where}. ${fix}`);
  }
  if (!authRequired && allow.length) {
    throw refusal(`Refusing --allow-host: no tokens in ${where}, and a server behind a proxy must require tokens. ${fix}`);
  }
  let tokensStamp = stamp(tokensFile);
  function currentTokens() {
    if (!tokensFile) return tokenRows;
    const s = stamp(tokensFile);
    if (s !== tokensStamp) {
      tokensStamp = s;
      try { tokenRows = readTokens(tokensFile); } catch (err) {
        tokenRows = []; // unreadable: nobody gets in until it is fixed
        log(`tokens file unreadable, refusing every token: ${/** @type {Error} */ (err).message}`);
      }
    }
    return tokenRows;
  }
  // Open, but tokens appear (or were there, empty, and gain a row): say so; never switch modes live.
  const watched = authRequired ? null : (tokensFile ?? watchTokensFile);
  let watchedStamp = '';
  let openNote = '';
  function checkOpenNote() {
    if (!watched || openNote) return openNote;
    const s = stamp(watched);
    if (s === watchedStamp) return openNote;
    watchedStamp = s;
    try {
      if (readTokens(watched).length) {
        openNote = TOKENS_FOUND_NOTE;
        log(`${TOKENS_FOUND_NOTE} (this server is still open on loopback)`);
      }
    } catch { /* unreadable: nothing to say yet */ }
    return openNote;
  }
  checkOpenNote();

  /** @type {Map<string, { name: string, hash: string, expires: number }>} */
  const sessions = new Map();

  // ---- stores, engines and map handlers, by tenant ----
  /** @type {Map<string, any>} */
  const stores = new Map();
  /**
   * A tenant's store, opened on first use (the existence check is readyStore's). Without `create`, a
   * files tenant whose folder is not there is null and opens nothing.
   * @param {string} tenant @param {boolean} create
   */
  function storeFor(tenant, create) {
    let s = stores.get(tenant);
    if (s) return s;
    if (config?.store) {
      s = config.store(tenant);
      if (!s) return null;
      stores.set(tenant, s);
      return s;
    }
    if (!create && tenant !== 'default' && !fs.existsSync(path.join(home, 'tenants', tenant))) return null;
    s = openStore(home, { tenant, repair: true, log });
    stores.set(tenant, s);
    return s;
  }
  /** Close a store and forget it (a failed one is never kept). @param {string} tenant @param {any} s */
  function dropStore(tenant, s) {
    if (stores.get(tenant) === s) stores.delete(tenant);
    try { Promise.resolve(s?.close?.()).catch(() => {}); } catch { /* best effort */ }
  }
  /**
   * A tenant's store once it is ready (a Postgres store loads first), null when the tenant has no
   * store, 'down' when it cannot load.
   * @param {string} tenant @param {boolean} create @returns {Promise<any>}
   */
  async function readyStore(tenant, create) {
    const open = stores.get(tenant);
    if (open) {
      if (open.failed) return 'down';                     // a failed store serves nothing (503)
      if (open.ready) { try { await open.ready; } catch { return 'down'; } }
      return open;
    }
    // A config store's optional exists(tenant) (sync or async) decides before anything is opened.
    if (config?.store && !create && typeof config.store.exists === 'function') {
      let there = false;
      try { there = (await config.store.exists(tenant)) === true; } catch { return 'down'; }
      if (!there) return null;
    }
    // At most maxStores tenants open at once: one more is refused, never opened.
    if (stores.size >= Math.max(1, maxStores)) { log(`too many tenants open (${maxStores}): ${tenant} refused`); return 'down'; }
    const s = storeFor(tenant, create);
    if (!s) return s;
    if (s.ready) {
      try { await s.ready; } catch (err) {
        // Never keep a store whose ready failed: it would hold its slot (and maybe connections) for nothing.
        dropStore(tenant, s);
        log(`store for tenant ${tenant} is not available: ${String(/** @type {any} */ (err)?.message ?? err).split('\n')[0]}`);
        return 'down';
      }
    }
    markInterrupted(tenant, s);
    return s;
  }
  /**
   * A tenant's store for a look only (another tenant's status): an open one, or for files a read-only
   * view of its index on disk. Never opens a config store, never creates a folder.
   * @param {string} tenant @returns {any}
   */
  function peekStore(tenant) {
    const open = stores.get(tenant);
    if (open) return open.failed ? 'down' : open;
    if (config?.store) return null;
    const file = tenant === 'default' ? path.join(home, 'index.json') : path.join(home, 'tenants', tenant, 'index.json');
    /** @type {any[]} */
    let rows = [];
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); rows = Array.isArray(j?.ontologies) ? j.ontologies : []; } catch { return null; }
    return { root: path.dirname(file), list: () => rows };
  }
  /**
   * Builds lost to a restart: a draft that has its ontology.created (written when the build was asked
   * for) but no node and no failure was waiting or starting when the server stopped. It is marked
   * failed, so it shows in the jobs tray instead of vanishing. Runs once, when the tenant's store opens.
   * @param {string} tenant @param {any} store
   */
  function markInterrupted(tenant, store) {
    try {
      for (const row of store.list({ drafts: true })) {
        if (!row.draft || builds.has(`${tenant}/${row.id}`)) continue;
        const o = store.read(row.id);
        if (!o.root || Object.keys(o.nodes).length) continue;
        if (Object.values(o.jobs).some((j) => j && j.kind === 'build' && j.state === 'failed')) continue;
        store.append(row.id, { t: 'job.failed', at: store.now(row.id), job: { id: `build-interrupted-${++buildSeq}`, kind: 'build', error: 'Interrupted by a restart' } });
        log(`build ${tenant}/${row.id} was interrupted by a restart: marked failed`);
      }
    } catch (err) { log(`could not check ${tenant} for interrupted builds: ${/** @type {any} */ (err)?.code ?? /** @type {any} */ (err)?.message ?? err}`); }
  }
  /** Wait until every write so far is stored (a Postgres store's sync; the file store has none). @param {any} store */
  const durable = async (store) => { if (store && typeof store.sync === 'function') await store.sync(); };

  /**
   * What the read rule sees of a map in a list: its index row's visibility (no fold).
   * @param {string} _tenant @param {string} _id @param {any} m an index row or a folded map
   */
  function visibilityOf(_tenant, _id, m) {
    if (m?.visibility !== 'private') return { visibility: 'public', privateSources: [] };
    return { visibility: 'private', privateSources: [...(Array.isArray(m.privateSources) ? m.privateSources : [])].sort() };
  }
  /** The map as policies see it on a map route: the folded map. @param {string} _tenant @param {string} id @param {any} store */
  function mapFor(_tenant, id, store) {
    return store.read(id);
  }

  /** Last use of each map's engine or handler, for idle eviction. @type {Map<string, number>} */
  const lastUsed = new Map();
  /** Requests using an engine right now (checks), so it is not evicted under them. @type {Map<string, number>} */
  const inflight = new Map();
  /** @type {Map<string, Promise<any>>} */
  const engines = new Map();
  /** @param {string} tenant @param {string} id */
  function engineFor(tenant, id) {
    const key = `${tenant}/${id}`;
    lastUsed.set(key, Date.now());
    let e = engines.get(key);
    if (!e) {
      e = makeEngine({ store: storeFor(tenant, true), id, tenant, ...(config?.model ? { clientFor: config.model } : {}) });
      e.catch(() => engines.delete(key));
      engines.set(key, e);
    }
    return e;
  }
  /** @type {Map<string, Promise<ReturnType<typeof createMapHandler>>>} */
  const handlers = new Map();
  /** The handlers that are ready, by key (busy() and eviction read them synchronously). @type {Map<string, ReturnType<typeof createMapHandler>>} */
  const live = new Map();
  /** @param {string} tenant @param {string} id */
  function handlerFor(tenant, id) {
    const key = `${tenant}/${id}`;
    lastUsed.set(key, Date.now());
    let h = handlers.get(key);
    if (!h) {
      h = engineFor(tenant, id).then((engine) => {
        const made = createMapHandler({
          store: storeFor(tenant, true), engine, id, ...(pingMs ? { pingMs } : {}),
          // Fuse makes the draft a new map in this process: its URL is its view, no new server or port.
          openDraft: async (draftId) => ({ url: `${mapBase(tenant, draftId)}/view`, close: async () => {} }),
        });
        if (handlers.get(key) === h) live.set(key, made);
        return made;
      });
      h.catch(() => handlers.delete(key));
      handlers.set(key, h);
    }
    return h;
  }
  /** Drop a map's handler (ending its streams and any chat) and its engine. @param {string} key */
  async function drop(key) {
    const h = handlers.get(key);
    handlers.delete(key);
    engines.delete(key);
    live.delete(key);
    lastUsed.delete(key);
    if (h) await (await h.catch(() => null))?.close();
  }

  // ---- builds: at most maxBuilds at once; waiting builds queue per tenant, started round-robin ----
  /** @type {Map<string, { state: 'queued'|'running'|'done'|'failed', error?: string }>} */
  const builds = new Map();
  let running = 0;
  /** @type {Map<string, Array<() => void>>} */
  const queues = new Map();
  /** Tenants with waiting builds, in turn order. @type {string[]} */
  const turn = [];
  /** @param {string} tenant */
  const waiting = (tenant) => queues.get(tenant)?.length ?? 0;
  /** @param {string} tenant */
  const slot = (tenant) => new Promise((resolve) => {
    if (running < Math.max(1, maxBuilds)) { running++; resolve(undefined); return; }
    const q = queues.get(tenant) ?? [];
    q.push(() => { running++; resolve(undefined); });
    queues.set(tenant, q);
    if (!turn.includes(tenant)) turn.push(tenant);
  });
  const release = () => {
    running--;
    const tenant = turn.shift();
    if (tenant === undefined) return;
    const q = /** @type {Array<() => void>} */ (queues.get(tenant));
    const next = q.shift();
    if (q.length) turn.push(tenant); else queues.delete(tenant);
    if (next) next();
  };
  let buildSeq = 0;
  /**
   * @param {string} tenant @param {string} id @param {any} brief @param {number|undefined} depth
   * @param {Principal} p @param {string[]} names the sources this build may use
   */
  function startBuild(tenant, id, brief, depth, p, names, picked = null) {
    const key = `${tenant}/${id}`;
    const b = { state: /** @type {'queued'|'running'|'done'|'failed'} */ ('queued'), error: /** @type {string|undefined} */ (undefined) };
    builds.set(key, b);
    (async () => {
      await slot(tenant);
      try {
        if (closing) throw new Error('the server is stopping');
        b.state = 'running';
        const engine = await engineFor(tenant, id);
        const principal = publicPrincipal(p, tenant);
        const tools = srcs && names.length ? await srcs.toolset(principal, names) : null;
        // picked: the sources chosen in New map (the build is told to search them for every category).
        await engine.build(brief, { ...(depth ? { depth } : {}), actor: p.actor, principal, tools, ...(picked ? { picked } : {}) });
        b.state = 'done';
      } catch (err) {
        b.state = 'failed';
        b.error = errText(err);
        log(`build ${key} failed: ${b.error}`);
        const store = storeFor(tenant, true);
        // The page's jobs tray shows the failure.
        try { store.append(id, { t: 'job.failed', at: store.now(id), job: { id: `build-${process.pid}-${++buildSeq}`, kind: 'build', error: b.error }, actor: p.actor }); } catch { /* gone */ }
      } finally {
        lastUsed.set(key, Date.now());
        release();
        try { Promise.resolve(storeFor(tenant, true).flush(id)).catch(() => {}); } catch { /* renamed or gone */ }
      }
    })();
  }

  /** @param {string} tenant @param {string} id */
  function busy(tenant, id) {
    const key = `${tenant}/${id}`;
    return activeWork(builds.get(key), storeFor(tenant, true).read(id).jobs, Boolean(live.get(key)?.chatting()));
  }

  // ---- idle eviction: a map nobody watches and nothing runs on gives back its engine ----
  function sweep() {
    const now = Date.now();
    for (const key of new Set([...engines.keys(), ...handlers.keys()])) {
      if (now - (lastUsed.get(key) ?? 0) < idleMs) continue;
      if ((inflight.get(key) ?? 0) > 0) continue;
      if (handlers.has(key) && !live.has(key)) continue; // still being made
      const h = live.get(key);
      if (h && h.streams() > 0) continue;
      const [tenant, id] = key.split('/');
      if (id !== CHECK_KEY) {
        let work;
        try { work = busy(tenant, id); } catch { work = []; }
        if (work.length) continue;
      }
      drop(key).catch(() => {});
    }
  }
  const sweeper = setInterval(sweep, Math.max(10, Math.min(idleMs, 60000)));
  sweeper.unref?.();

  // ---- per-token limits on long requests (event streams and waits) ----
  /** @type {Map<string, number>} */
  const longByToken = new Map();
  let checksRunning = 0;
  /**
   * Count a long request against its token; false when the token is at its cap. Released when the
   * response closes. Open mode has no tokens and no cap.
   * @param {Principal} p @param {http.ServerResponse} res
   */
  function holdLong(p, res) {
    if (p.via === 'open' || !p.name) return true;
    const n = longByToken.get(p.name) ?? 0;
    if (n >= maxStreamsPerToken) return false;
    longByToken.set(p.name, n + 1);
    res.once('close', () => {
      const m = (longByToken.get(/** @type {string} */ (p.name)) ?? 1) - 1;
      if (m > 0) longByToken.set(/** @type {string} */ (p.name), m); else longByToken.delete(/** @type {string} */ (p.name));
    });
    return true;
  }

  // ---- host and origin ----
  let boundPort = 0;
  const wildcard = host === '0.0.0.0' || host === '::';
  /** @param {string|undefined} h a Host header */
  function allowedName(h) {
    if (!h) return false;
    const v = String(h).toLowerCase();
    const name = v.replace(/:\d+$/, '');
    return allow.some((a) => a === v || a === name);
  }
  /** @param {string|undefined} h */
  function hostOk(h) {
    if (!h) return false;
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(h);
    if (!m) return false;
    const name = m[1].toLowerCase();
    const p = m[2] ? Number(m[2]) : null;
    if (allowedName(h)) return true;
    const bare = name.replace(/^\[|\]$/g, '');
    // Loopback names on any port (a container's -p 9000:8787): a DNS-rebinding page cannot send them.
    if (LOOPBACK.includes(bare)) return true;
    if (p !== boundPort) return false;
    if (bare === host.replace(/^\[|\]$/g, '')) return true;
    // Bound to every interface: this machine's own addresses, as IP literals (a DNS-rebinding page
    // can only send a host name, never one of these).
    return wildcard && ownAddresses().includes(bare);
  }
  /** The Origin is the server's own: the Host it was reached by, or an --allow-host name. @param {http.IncomingMessage} req */
  function originMatches(req) {
    const o = req.headers.origin;
    if (typeof o !== 'string') return false;
    const h = String(req.headers.host);
    if (o === `http://${h}` || o === `https://${h}`) return true;
    let u;
    try { u = new URL(o); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return allow.some((a) => a === u.host.toLowerCase() || a === u.hostname.toLowerCase());
  }

  // ---- auth ----
  /** A token's principal: actor "token:<name>", the sources it holds. @param {import('./tokens.js').TokenRow} row */
  const tokenPrincipal = (row) => ({
    name: row.name, tenant: row.tenant, scopes: row.scopes,
    actor: { id: `token:${row.name}`, kind: 'service' },
    sources: heldSources(entries, { scopes: row.scopes, sources: row.sources }),
  });
  /**
   * Who is calling: I1's tokens and sessions, or the config's identity port.
   * @param {http.IncomingMessage} req @returns {Promise<Principal|null|'bad'>}
   */
  async function authenticate(req) {
    if (identity) return fromIdentity(req);
    if (!authRequired) return { name: null, tenant: null, scopes: ['admin'], via: 'open', actor: { id: 'local', kind: 'human' }, sources: entries.map((e) => e.name) };
    const rows = currentTokens();
    const authz = req.headers.authorization;
    if (authz !== undefined) {
      const m = /^Bearer\s+(\S+)\s*$/i.exec(String(authz));
      const row = m ? checkToken(rows, m[1]) : null;
      return row ? { ...tokenPrincipal(row), via: 'bearer', hash: row.hash } : 'bad';
    }
    const sid = cookieValue(req.headers.cookie, COOKIE);
    if (sid === null) return null;
    const s = sessions.get(sid);
    if (!s || s.expires < Date.now()) { if (s) sessions.delete(sid); return 'bad'; }
    const row = rows.find((r) => r.name === s.name && r.hash === s.hash); // revoked tokens end their sessions
    if (!row) { sessions.delete(sid); return 'bad'; }
    return { ...tokenPrincipal(row), via: 'cookie', hash: row.hash, sid };
  }
  /**
   * The identity port's principal, checked: an actor with a string id and a known kind, a valid
   * tenant, scopes from the ladder. Anything else (or a throw) is refused, never half-trusted.
   * @param {http.IncomingMessage} req @returns {Promise<Principal|null|'bad'>}
   */
  async function fromIdentity(req) {
    let got;
    try { got = await /** @type {any} */ (identity).authenticate(req); } catch (err) {
      log(`identity port failed: ${String(/** @type {any} */ (err)?.message ?? err).split('\n')[0]}`);
      return 'bad';
    }
    if (got === null || got === undefined) return null;
    const a = got?.actor;
    const ok = a && typeof a.id === 'string' && a.id && ['human', 'agent', 'service'].includes(a.kind)
      && typeof got.tenant === 'string' && TENANT_RE.test(got.tenant)
      && Array.isArray(got.scopes) && got.scopes.every((/** @type {any} */ s) => ['read', 'ask', 'build', 'admin'].includes(s));
    if (!ok) { log('identity port returned a principal without a valid actor, tenant or scopes: refused'); return 'bad'; }
    const actor = { id: a.id, kind: a.kind, ...(typeof a.via === 'string' ? { via: a.via } : {}) };
    const scopes = [...got.scopes];
    const sources = heldSources(entries, { scopes, sources: Array.isArray(got.sources) ? got.sources : undefined });
    return { name: actor.id, tenant: got.tenant, scopes, via: 'identity', actor, sources };
  }
  /** What ports see of a principal (never the token hash or the session id). @param {Principal} p */
  /** @param {Principal} p @param {string} [tenant] the request's tenant (open mode reaches every tenant) */
  const publicPrincipal = (p, tenant) => ({ actor: p.actor, tenant: p.tenant ?? tenant ?? 'default', scopes: [...p.scopes], sources: [...p.sources] });
  /**
   * The policy port, never throwing: a failing custom policy denies.
   * @param {Principal} p @param {import('./policy.js').Action} action @param {{ tenant: string, mapId?: string|null, map?: any }} ctx
   */
  async function can(p, action, ctx) {
    try { return (await policy.can(publicPrincipal(p, ctx.tenant), action, { mapId: null, map: null, ...ctx })) === true; } catch (err) {
      log(`policy port failed: ${String(/** @type {any} */ (err)?.message ?? err).split('\n')[0]}`);
      return false;
    }
  }
  /**
   * The principal as it stands now: its token row re-read (a revoke, or sources rewritten in
   * tokens.json, take effect here), or null when it no longer stands.
   * @param {Principal} p @returns {Principal|null}
   */
  function currentPrincipal(p) {
    if (!stillValid(p)) return null;
    if (p.via !== 'bearer' && p.via !== 'cookie') return p;
    const row = currentTokens().find((r) => r.name === p.name && r.hash === p.hash);
    return row ? { ...p, ...tokenPrincipal(row) } : null;
  }
  /**
   * Whether a stream (or a chat) may go on: called on every ping, before every event a stream sends and
   * before every chunk a chat sends. It re-checks the principal (its token row as it is now) and the
   * read rule against the map as it is now. The answer is remembered until either changes (the
   * principal's scopes or sources, the map's visibility or private sources), so the common case costs
   * a file stat and a comparison. A policy that answers with a Promise gets a Promise back: the stream
   * waits for it, in order (map.js), and only a true lets the event out.
   * @param {Principal} p @param {string} tenant @param {string} id @param {any} store
   * @returns {(ev?: any) => boolean|Promise<boolean>}
   */
  function streamValid(p, tenant, id, store) {
    /** @type {string|null} */ let memoKey = null;
    let memo = false;
    return (_ev) => {
      if (store.failed) return false;
      const cur = currentPrincipal(p);
      if (!cur) return false;
      let map;
      try { map = mapFor(tenant, id, store); } catch { return false; }
      const key = JSON.stringify([cur.scopes, cur.sources, map?.visibility ?? 'public', map?.privateSources ?? []]);
      if (key === memoKey) return memo;
      let r;
      try { r = policy.can(publicPrincipal(cur, tenant), 'read', { tenant, mapId: id, map }); } catch { return false; }
      if (r && typeof (/** @type {any} */ (r)).then === 'function') {
        return Promise.resolve(r).then((v) => { memoKey = key; memo = v === true; return memo; }, () => false);
      }
      memoKey = key;
      memo = r === true;
      return memo;
    };
  }
  /** Reachability of sources for status, remembered for 30 s per source. @type {Map<string, { at: number, reachable: boolean }>} */
  const reach = new Map();
  /** @param {string[]} names @param {any} principal */
  async function reachability(names, principal) {
    if (!srcs) return [];
    const now = Date.now();
    const stale = names.filter((n) => !(reach.get(n) && now - /** @type {any} */ (reach.get(n)).at < REACH_MS));
    if (stale.length) {
      for (const s of await srcs.status({ names: stale, principal })) reach.set(s.name, { at: now, reachable: s.reachable });
    }
    return entries.filter((e) => names.includes(e.name))
      .map((e) => ({ name: e.name, visibility: e.visibility, reachable: Boolean(reach.get(e.name)?.reachable) }));
  }
  /** The page a browser gets for a map it cannot see: no name, no hint whether it exists. @param {http.ServerResponse} res */
  function sendNotFoundPage(res) {
    let html;
    try { html = fs.readFileSync(path.join(webRoot, 'home', 'not-found.html')); } catch { return plain(res, 404, 'not found'); }
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(html);
  }
  /**
   * The sources a run on a map may use: a build's picks; for a job or ask, the principal's public
   * sources plus the private ones the map is already private for (a click never adds a private source).
   * @param {Principal} p @param {any} map
   */
  function jobSources(p, map) {
    const already = new Set(Array.isArray(map?.privateSources) ? map.privateSources : []);
    return p.sources.filter((n) => entries.find((e) => e.name === n)?.visibility === 'public' || already.has(n));
  }
  /** Whether a principal still stands (its token not revoked, its session not ended or expired). @param {Principal} p */
  function stillValid(p) {
    if (closing) return false;
    if (p.via === 'open' || p.via === 'identity') return true;
    if (!currentTokens().some((r) => r.name === p.name && r.hash === p.hash)) return false;
    if (p.via === 'cookie') {
      const s = sessions.get(/** @type {string} */ (p.sid));
      if (!s || s.expires < Date.now()) return false;
    }
    return true;
  }
  /** @param {Principal} p @param {string} scope */
  const has = (p, scope) => hasScope(p.scopes, scope);
  /** @param {Principal} p @param {string} tenant */
  const ownsTenant = (p, tenant) => p.via === 'open' || p.tenant === tenant;

  // ---- routes ----
  /** @param {http.ServerResponse} res @param {number} code @param {string} error @param {Record<string, string>} [headers] */
  const fail = (res, code, error, headers) => json(res, code, { ok: false, error }, headers);

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} method */
  async function session(req, res, method) {
    if (method === 'GET' || method === 'HEAD') {
      const p = await authenticate(req);
      if (p === null || p === 'bad') return fail(res, 401, 'Sign in with a token.');
      return json(res, 200, { ok: true, tenant: p.tenant ?? 'default', scopes: p.scopes, open: p.via === 'open' });
    }
    if (method === 'POST') {
      if (req.headers.origin !== undefined && !originMatches(req)) return fail(res, 403, 'forbidden origin');
      const body = await readBody(req, res, 4096);
      if (!body) return;
      if (identity) return fail(res, 400, 'This server signs in through its identity port.');
      if (!authRequired) return fail(res, 400, 'This server has no tokens: no sign-in needed.');
      const row = checkToken(currentTokens(), body.token);
      if (!row) return fail(res, 401, 'That token was not accepted.');
      const now = Date.now();
      for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
      // At most MAX_SESSIONS_PER_TOKEN per token (its own oldest goes), so one token cannot push others out.
      const mine = [...sessions].filter(([, v]) => v.name === row.name);
      if (mine.length >= MAX_SESSIONS_PER_TOKEN) sessions.delete(mine[0][0]);
      if (sessions.size >= MAX_SESSIONS) sessions.delete(/** @type {string} */ (sessions.keys().next().value));
      const sid = crypto.randomBytes(32).toString('base64url');
      sessions.set(sid, { name: row.name, hash: row.hash, expires: now + SESSION_MS });
      // Secure when it came through an --allow-host proxy over https (the proxy says so).
      const secure = allowedName(req.headers.host) && String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https';
      return json(res, 200, { ok: true, tenant: row.tenant, scopes: row.scopes },
        { 'Set-Cookie': `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}` });
    }
    if (method === 'DELETE') {
      const sid = cookieValue(req.headers.cookie, COOKIE);
      if (sid !== null && !originMatches(req)) return fail(res, 403, 'forbidden origin');
      if (sid !== null) sessions.delete(sid);
      return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    return fail(res, 405, 'method not allowed');
  }

  /**
   * Every /v1/t/ route: authenticate first (401), then the Origin of a cookie POST (403), then the
   * tenant (404), then the scope (403).
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} rawPath @param {URLSearchParams} query
   */
  async function tenantRoute(req, res, rawPath, query) {
    const method = req.method || 'GET';
    const p = await authenticate(req);
    if (p === null || p === 'bad') {
      // A browser opening a map link without a session: to the home page's sign-in, then back.
      const browser = (method === 'GET' || method === 'HEAD') && req.headers.authorization === undefined
        && String(req.headers.accept ?? '').includes('text/html') && VIEW_RE.test(rawPath);
      if (browser) {
        res.writeHead(302, { Location: `/?next=${encodeURIComponent(rawPath)}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      return fail(res, 401, p === null ? 'Sign in with a token.' : 'That token was not accepted.');
    }
    // A principal from the identity port may ride on a browser cookie (a sign-in proxy): a POST that
    // carries a foreign Origin is refused, as in open mode.
    if ((method === 'POST' || method === 'DELETE') && (p.via === 'cookie' ? !originMatches(req)
      : (p.via === 'open' || p.via === 'identity') && req.headers.origin !== undefined && !originMatches(req))) {
      return fail(res, 403, 'forbidden origin');
    }
    const parts = rawPath.split('/'); // ['', 'v1', 't', tenant, ...rest]
    const tenant = parts[3] ?? '';
    const rest = parts.slice(4);
    if (!TENANT_RE.test(tenant)) return fail(res, 404, 'not found');
    const admin = has(p, 'admin');
    // Status: your own tenant with read; any tenant with admin.
    if (rest.length === 1 && rest[0] === 'status') {
      if (!ownsTenant(p, tenant) && !admin) return fail(res, 404, 'not found');
      if (!has(p, 'read')) return fail(res, 403, 'This token needs the read scope.');
      if (method !== 'GET' && method !== 'HEAD') return fail(res, 405, 'method not allowed');
      // Another tenant's status (an admin's) never opens its store or takes its lock: only an open
      // store, or for files the tenant's index on disk, is read.
      const own = (p.tenant ?? 'default') === tenant;
      const store = own ? await readyStore(tenant, false) : peekStore(tenant);
      if (store === 'down') return fail(res, 503, 'the store is not available');
      const note = checkOpenNote();
      // Sources: every configured one for an admin, the ones it holds for anyone else. Names only.
      const shown = srcs ? (admin ? srcs.names() : p.sources) : [];
      const sourceRows = srcs ? await reachability(shown, publicPrincipal(p, tenant)) : null;
      // Only the maps this caller may read are counted.
      let count = 0;
      for (const m of store ? store.list({ drafts: true }) : []) {
        if (await can(p, 'read', { tenant, mapId: m.id, map: visibilityOf(tenant, m.id, m) })) count++;
      }
      return json(res, 200, {
        tenant,
        // The server's own paths are for admins only.
        ...(admin ? { home: store && store.root ? store.root : config?.store ? null : (tenant === 'default' ? home : path.join(home, 'tenants', tenant)) } : {}),
        ...(admin && configPath ? { config: configPath } : {}),
        store: ports.store,
        auth: identity ? 'identity' : authRequired ? 'tokens' : 'open',
        ...(note ? { note } : {}),
        maps: store ? count : (config?.store && !own ? null : 0),
        tokens: currentTokens().filter((r) => r.tenant === tenant)
          .map((r) => ({ name: r.name, tenant: r.tenant, scopes: [...r.scopes], ...(r.sources ? { sources: [...r.sources] } : {}) })),
        server: { version, startedAt },
        ...(config ? { ports } : {}),
        ...(sourceRows ? { sources: sourceRows } : {}),
      });
    }
    if (!ownsTenant(p, tenant)) return fail(res, 404, 'not found'); // never reveal another tenant's maps
    /** @param {import('./policy.js').Action} action */
    const needs = (action) => `This token needs the ${ACTION_SCOPE[action] ?? action} scope.`;

    // /v1/t/:tenant/sources: the sources the caller holds, for the New map picker.
    if (rest.length === 1 && rest[0] === 'sources') {
      if (method !== 'GET' && method !== 'HEAD') return fail(res, 405, 'method not allowed');
      if (!await can(p, 'read', { tenant })) return fail(res, 403, needs('read'));
      return json(res, 200, entries.filter((e) => p.sources.includes(e.name)).map((e) => ({ name: e.name, visibility: e.visibility })));
    }
    if (rest[0] !== 'maps') return fail(res, 404, 'not found');

    // /v1/t/:tenant/maps
    if (rest.length === 1) {
      if (method === 'GET' || method === 'HEAD') {
        if (!await can(p, 'read', { tenant })) return fail(res, 403, needs('read'));
        const store = await readyStore(tenant, false);
        if (store === 'down') return fail(res, 503, 'the store is not available');
        /** @type {any[]} */
        const rows = [];
        for (const m of store ? store.list({ drafts: true }) : []) {
          // From the index row (no fold per map). A map the caller may not read is left out.
          const map = visibilityOf(tenant, m.id, m);
          if (!await can(p, 'read', { tenant, mapId: m.id, map })) continue;
          rows.push({ id: m.id, name: m.name, root: m.root, nodes: m.nodes, updatedAt: m.updatedAt, draft: Boolean(m.draft),
            ...(map?.visibility === 'private' ? { visibility: 'private' } : srcs ? { visibility: 'public' } : {}) });
        }
        return json(res, 200, rows);
      }
      if (method === 'POST') {
        if (!await can(p, 'build', { tenant })) return fail(res, 403, needs('build'));
        const body = await readBody(req, res);
        if (!body) return;
        if (!body.brief || typeof body.brief !== 'object' || Array.isArray(body.brief)) return fail(res, 400, 'brief must be an object (from maps/check)');
        if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 120)) return fail(res, 400, 'name must be a string of at most 120 characters');
        if (body.depth !== undefined && !(Number.isInteger(body.depth) && body.depth >= 1 && body.depth <= 5)) return fail(res, 400, 'depth must be a whole number from 1 to 5');
        if (body.sources !== undefined && (!Array.isArray(body.sources) || body.sources.length > 50 || body.sources.some((/** @type {any} */ s) => typeof s !== 'string'))) {
          return fail(res, 400, 'sources must be a list of source names');
        }
        // Only sources the caller holds; with no list, every one it holds.
        const notHeld = (body.sources ?? []).filter((/** @type {string} */ s) => !p.sources.includes(s));
        if (notHeld.length) return fail(res, 400, `You do not hold the source "${String(notHeld[0]).slice(0, 40)}".`);
        const names = body.sources ? [...new Set(/** @type {string[]} */ (body.sources))] : [...p.sources];
        if (closing) return fail(res, 503, 'the server is stopping');
        if (running >= Math.max(1, maxBuilds) && waiting(tenant) >= maxQueued) {
          return fail(res, 429, `${maxQueued} builds are already waiting for this tenant: try again when one finishes.`, { 'Retry-After': '30' });
        }
        const store = await readyStore(tenant, true);
        if (store === 'down' || !store) return fail(res, 503, 'the store is not available');
        // When private sources were picked, the draft is written with its ontology.created and their
        // raise, in one write (one transaction on Postgres), stored before the 202: a queued private
        // build is private from the start, and stays so across a crash or a restart. (Other builds
        // write their own log, exactly as before.)
        const privatePicked = names.filter((n) => entries.find((e) => e.name === n)?.visibility === 'private').sort();
        const subject = String(body.brief.subject ?? '');
        /** @type {any[]} */
        const first = privatePicked.length ? [
          { t: 'ontology.created', at: 0, name: subject, root: slug(subject), brief: body.brief, categories: [], actor: p.actor },
          { t: 'visibility.raised', at: 0, to: 'private', reason: 'sources-picked', sources: privatePicked, actor: p.actor },
        ] : [];
        const id = store.createDraft(body.brief, body.name || undefined, { events: first });
        try { await durable(store); } catch { return fail(res, 503, 'the store is not available'); }
        startBuild(tenant, id, body.brief, body.depth, p, names, Array.isArray(body.sources) ? names : null);
        const base = mapBase(tenant, id);
        return json(res, 202, { id, viewUrl: `${base}/view`, eventsUrl: `${base}/events` });
      }
      return fail(res, 405, 'method not allowed');
    }
    // /v1/t/:tenant/maps/check
    if (rest.length === 2 && rest[1] === 'check') {
      if (!await can(p, 'build', { tenant })) return fail(res, 403, needs('build'));
      if (method !== 'POST') return fail(res, 405, 'method not allowed');
      const body = await readBody(req, res);
      if (!body) return;
      const context = typeof body.context === 'string' ? body.context.trim() : '';
      if (!context || context.length > 4000) return fail(res, 400, 'context must be a non-empty string of at most 4000 characters');
      const answers = body.answers === undefined ? [] : body.answers;
      if (!Array.isArray(answers) || answers.length > 30) return fail(res, 400, 'answers must be a list');
      if (checksRunning >= Math.max(1, maxChecks)) return fail(res, 429, 'Too many context checks at once: try again shortly.', { 'Retry-After': '5' });
      const key = `${tenant}/${CHECK_KEY}`;
      checksRunning++;
      inflight.set(key, (inflight.get(key) ?? 0) + 1);
      try {
        const engine = await engineFor(tenant, CHECK_KEY);
        const r = await engine.check(context, answers, { principal: publicPrincipal(p, tenant) });
        return json(res, 200, {
          ready: Boolean(r?.ready),
          ...(r?.brief ? { brief: r.brief } : {}), ...(r?.name ? { name: r.name } : {}),
          ...(r?.questions ? { questions: r.questions } : {}),
        });
      } catch (err) {
        return fail(res, 502, errText(err));
      } finally {
        checksRunning--;
        const n = (inflight.get(key) ?? 1) - 1;
        if (n > 0) inflight.set(key, n); else inflight.delete(key);
        lastUsed.set(key, Date.now());
      }
    }
    // /v1/t/:tenant/maps/:id/...
    const id = rest[1];
    const sub = rest.slice(2).join('/');
    const isApi = rest[2] === 'api';
    const action = actionFor(sub);
    if (!await can(p, action, { tenant, mapId: id })) return fail(res, 403, needs(action));
    const store = await readyStore(tenant, false);
    if (store === 'down') return fail(res, 503, 'the store is not available');
    // A browser opening a map it cannot see gets a small page, never JSON; the same 404 either way.
    const notFound = () => (sub === 'view' && (method === 'GET' || method === 'HEAD') && String(req.headers.accept ?? '').includes('text/html')
      ? sendNotFoundPage(res) : fail(res, 404, 'not found'));
    if (!store || !MAP_ID_RE.test(id) || !store.list({ drafts: true }).some((/** @type {any} */ m) => m.id === id)) return notFound();
    // The read rule: a map the caller may not read does not exist for it (404, never 403).
    const map = mapFor(tenant, id, store);
    if (!await can(p, 'read', { tenant, mapId: id, map })) return notFound();
    if (action !== 'read' && !await can(p, action, { tenant, mapId: id, map })) return fail(res, 403, needs(action));
    const key = `${tenant}/${id}`;
    const base = mapBase(tenant, id);
    if (sub === 'view') {
      if (method !== 'GET' && method !== 'HEAD') return fail(res, 405, 'method not allowed');
      return sendPage(res, webRoot, 'index.html', base);
    }
    if (sub === 'wait') {
      if (method !== 'GET' && method !== 'HEAD') return fail(res, 405, 'method not allowed');
      if (!holdLong(p, res)) return fail(res, 429, `This token already has ${maxStreamsPerToken} open streams and waits.`);
      const t = Number.parseInt(query.get('timeout') ?? '', 10);
      const timeout = Math.min(WAIT_MAX, Math.max(0, Number.isFinite(t) ? t : WAIT_DEFAULT));
      const until = Date.now() + timeout;
      let gone = false;
      res.on('close', () => { gone = true; });
      for (;;) {
        const jobs = busy(tenant, id);
        if (!jobs.length || Date.now() >= until || gone || closing) {
          const b = builds.get(key);
          return json(res, 200, { state: jobs.length ? 'busy' : 'idle', jobs, ...(b?.state === 'failed' ? { error: b.error } : {}) });
        }
        await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, until - Date.now()))));
      }
    }
    if (sub === 'save') {
      if (method !== 'POST') return fail(res, 405, 'method not allowed');
      const body = await readBody(req, res);
      if (!body) return;
      if (typeof body.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.name)) {
        return fail(res, 400, 'name must be lowercase letters, digits and hyphens');
      }
      if (busy(tenant, id).length) return fail(res, 409, 'The map is still being built, has jobs running, or a chat answer is being written: wait for it, then save.');
      // The map's id changes: end its streams and drop its engine first.
      await drop(key);
      builds.delete(key);
      try {
        const saved = store.save(id, body.name, { actor: p.actor });
        try { await durable(store); } catch { return fail(res, 503, 'the store is not available'); }
        return json(res, 200, { ok: true, id: saved, viewUrl: `${mapBase(tenant, saved)}/view` });
      } catch (err) {
        if (/** @type {any} */ (err)?.code === 'STORE_FAILED' || store.failed) return fail(res, 503, 'the store is not available');
        const msg = String(/** @type {Error} */ (err).message);
        // Never say whether another map holds the name (it may be one this caller cannot see).
        if (/already exists/.test(msg)) return fail(res, 409, 'That name is not available.');
        return fail(res, 400, msg);
      }
    }
    // The map's own routes: today's /api/* under its base, and their /v1 names.
    /** @type {Record<string, string>} */
    const alias = { snapshot: '/api/snapshot', events: '/api/events', actions: '/api/action', chat: '/api/chat' };
    const apiPath = isApi ? `/${sub}` : alias[sub];
    if (apiPath) {
      const stream = apiPath === '/api/events' && (method === 'GET' || method === 'HEAD');
      if (stream && !holdLong(p, res)) return fail(res, 429, `This token already has ${maxStreamsPerToken} open streams and waits.`);
      const h = await handlerFor(tenant, id);
      const principal = publicPrincipal(p, tenant);
      const handled = await h.handleApi(req, res, apiPath, query, {
        // Re-checked on every ping and before every event sent: the token (or session), its current
        // sources, and the read rule on the map as it is now (a raise ends the stream before it is sent).
        valid: streamValid(p, tenant, id, store),
        sync: () => durable(store),
        actor: p.actor,
        principal,
        // A job's or an ask's source tools, made only when one runs.
        tools: async () => {
          const names = srcs ? jobSources(p, mapFor(tenant, id, store)) : [];
          return names.length && srcs ? srcs.toolset(principal, names) : null;
        },
        // Other maps this caller may read (the fuse picker and fuse's `with`).
        canRead: async (/** @type {string} */ other) => {
          const row = store.list({ drafts: true }).find((/** @type {any} */ m) => m.id === other);
          return row ? can(p, 'read', { tenant, mapId: other, map: visibilityOf(tenant, other, row) }) : false;
        },
        // Whether a map is private (fuse keeps a private map's id out of another map's log).
        isPrivate: (/** @type {string} */ other) => visibilityOf(tenant, other, store.list({ drafts: true }).find((/** @type {any} */ m) => m.id === other)).visibility === 'private',
      });
      lastUsed.set(key, Date.now());
      if (handled) return;
    }
    return fail(res, 404, 'not found');
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handle(req, res) {
    if (!hostOk(req.headers.host)) return plain(res, 403, 'forbidden host');
    // Open (no tokens) means this machine only: a request that came through a proxy is refused.
    if (!authRequired && PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) {
      return plain(res, 403, 'This server has no tokens; proxied requests need tokens.');
    }
    const raw = req.url || '/';
    const q = raw.indexOf('?');
    const rawPath = q < 0 ? raw : raw.slice(0, q);
    const query = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
    const method = req.method || 'GET';

    if (rawPath.startsWith('/v1/t/')) return tenantRoute(req, res, rawPath, query);
    if (rawPath === '/v1/session') return session(req, res, method);
    if (rawPath === '/v1/health/live') return json(res, 200, { ok: true });
    if (rawPath === '/v1/health/ready') {
      // Not ready while any open store has failed (its tenant answers 503 until a restart).
      if ([...stores.values()].some((s) => s && s.failed)) return fail(res, 503, 'a store has failed');
      try { fs.accessSync(home, fs.constants.R_OK); return json(res, 200, { ok: true }); }
      catch { return fail(res, 503, 'the home is not readable'); }
    }
    if (rawPath.startsWith('/v1/')) return fail(res, 404, 'not found');
    if (method !== 'GET' && method !== 'HEAD') return plain(res, 405, 'method not allowed');
    if (rawPath === '/') return sendPage(res, webRoot, path.join('home', 'index.html'));
    if (rawPath === '/favicon.ico') return sendFile(res, path.join(webRoot, 'shared', 'brand', 'favicon-32.png'));
    for (const p of ['shell', 'shared', 'views', 'home', 'dist']) {
      if (rawPath.startsWith(`/${p}/`)) return serveFile(res, webRoot, rawPath.slice(1));
    }
    if (rawPath.startsWith('/fixtures/')) return serveFile(res, fixturesRoot, rawPath.slice('/fixtures/'.length));
    if (rawPath.startsWith('/src/core/')) return serveFile(res, coreRoot, rawPath.slice('/src/core/'.length));
    if (rawPath.startsWith('/vendor/')) {
      let file = null;
      try { file = resolveVendorPath(rawPath); } catch { file = null; }
      if (!file) return plain(res, 404, 'not found');
      return sendFile(res, file);
    }
    return plain(res, 404, 'not found');
  }

  let closing = false;
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`request failed: ${req.method} ${String(req.url).split('?')[0]}: ${/** @type {Error} */ (err)?.message ?? err}`);
      if (!res.headersSent) {
        if (/** @type {any} */ (err)?.code === 'STORE_FAILED') fail(res, 503, 'the store is not available');
        else plain(res, 500, 'server error');
      }
      else res.end();
    });
  });

  // With files, the home tenant opens at start, so builds a restart interrupted are marked failed at
  // once. A config store opens on first use (and is checked then).
  if (!config?.store) { try { await readyStore('default', true); } catch { /* reported on first use */ } }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  }).catch((err) => { clearInterval(sweeper); throw err; });
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  boundPort = addr.port;
  const shown = wildcard ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${shown}:${boundPort}/`,
    port: boundPort,
    host,
    tokensLoaded: authRequired,
    /** For tests: how many engines and handlers are held, and a sweep now. */
    stats: () => ({ engines: engines.size, handlers: handlers.size, sessions: sessions.size }),
    sweep,
    /** Stop accepting, end the streams and chats, flush the stores. */
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(sweeper);
      const done = new Promise((r) => server.close(() => r(undefined)));
      for (const h of handlers.values()) {
        try { await (await h).close(); } catch { /* never built */ }
      }
      for (const s of stores.values()) {
        try { await s.flush(); } catch { /* best effort */ }
        try { await s.close?.(); } catch { /* best effort */ }
      }
      try { await srcs?.close(); } catch { /* best effort */ }
      server.closeAllConnections?.();
      await done;
    },
  };
}

/** A path as it would be typed in a shell: quoted only when it needs to be. @param {string} p */
export function shellQuote(p) {
  return /^[A-Za-z0-9_./~:@%+=,-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/** This machine's interface addresses (lowercase), for a server bound to every interface. */
function ownAddresses() {
  try {
    return Object.values(os.networkInterfaces()).flat().map((a) => String(a?.address ?? '').toLowerCase().replace(/%.*$/, '')).filter(Boolean);
  } catch { return []; }
}

/** @param {string|null} file @returns {string} */
function stamp(file) {
  if (!file) return '';
  try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return 'missing'; }
}

/** @param {string|undefined} header @param {string} name @returns {string|null} */
export function cookieValue(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : null;
    }
  }
  return null;
}
