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
 * 'bearer' (Authorization header) or 'cookie' (a session from POST /v1/session). `hash` and `sid`
 * let a long request (an event stream) re-check that the token and session still stand.
 * @typedef {{ name: string|null, tenant: string|null, scopes: string[], via: 'open'|'bearer'|'cookie', hash?: string, sid?: string }} Principal
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
 *   makeEngine: (o: { store: any, id: string, tenant: string }) => Promise<any>,
 *   version?: string, webDir?: string, log?: (line: string) => void }} opts
 *   tokensFile: the tokens to load; null (or no rows) means none: loopback only, open, no --allow-host.
 *   watchTokensFile: when open, a tokens file to watch so status can say "restart serve to require them".
 *   maxBuilds: builds running at once. maxQueued: builds waiting per tenant (more: 429).
 *   maxChecks: context checks at once (more: 429). maxStreamsPerToken: event streams + waits per token.
 *   idleMs: a map's engine and handler with no streams and no work are dropped after this long.
 *   makeEngine: the engine for one map (the CLI passes engineFor with needKey false).
 */
export async function startService({
  home, host = '127.0.0.1', port = 8787, tokensFile = null, watchTokensFile = null, allowHosts = [],
  maxBuilds = 2, maxQueued = 10, maxChecks = 4, maxStreamsPerToken = 50, idleMs = 10 * 60 * 1000, pingMs,
  makeEngine, version = '', webDir, log = () => {},
}) {
  const webRoot = path.resolve(webDir ?? WEB_ROOT);
  const fixturesRoot = path.join(PKG_ROOT, 'fixtures');
  const coreRoot = path.join(PKG_ROOT, 'src', 'core');
  const startedAt = new Date().toISOString();
  const allow = allowHosts.map((a) => String(a).trim().toLowerCase()).filter(Boolean);

  // ---- tokens: read at start; re-read when the file changes (a revoke takes effect at once). ----
  let tokenRows = tokensFile ? readTokens(tokensFile) : [];
  // Whether auth is required is fixed at start: revoking every token never opens the server.
  const authRequired = tokenRows.length > 0;
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
  /** @param {string} tenant @param {boolean} create */
  function storeFor(tenant, create) {
    let s = stores.get(tenant);
    if (s) return s;
    if (!create && tenant !== 'default' && !fs.existsSync(path.join(home, 'tenants', tenant))) return null;
    s = openStore(home, { tenant });
    stores.set(tenant, s);
    return s;
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
      e = makeEngine({ store: storeFor(tenant, true), id, tenant });
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
  /** @param {string} tenant @param {string} id @param {any} brief @param {number|undefined} depth */
  function startBuild(tenant, id, brief, depth) {
    const key = `${tenant}/${id}`;
    const b = { state: /** @type {'queued'|'running'|'done'|'failed'} */ ('queued'), error: /** @type {string|undefined} */ (undefined) };
    builds.set(key, b);
    (async () => {
      await slot(tenant);
      try {
        if (closing) throw new Error('the server is stopping');
        b.state = 'running';
        const engine = await engineFor(tenant, id);
        await engine.build(brief, depth ? { depth } : undefined);
        b.state = 'done';
      } catch (err) {
        b.state = 'failed';
        b.error = errText(err);
        log(`build ${key} failed: ${b.error}`);
        const store = storeFor(tenant, true);
        // The page's jobs tray shows the failure.
        try { store.append(id, { t: 'job.failed', at: store.now(id), job: { id: `build-${process.pid}-${++buildSeq}`, kind: 'build', error: b.error } }); } catch { /* gone */ }
      } finally {
        lastUsed.set(key, Date.now());
        release();
        try { storeFor(tenant, true).flush(id); } catch { /* renamed or gone */ }
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
  /** @param {http.IncomingMessage} req @returns {Principal|null|'bad'} */
  function authenticate(req) {
    if (!authRequired) return { name: null, tenant: null, scopes: ['admin'], via: 'open' };
    const rows = currentTokens();
    const authz = req.headers.authorization;
    if (authz !== undefined) {
      const m = /^Bearer\s+(\S+)\s*$/i.exec(String(authz));
      const row = m ? checkToken(rows, m[1]) : null;
      return row ? { name: row.name, tenant: row.tenant, scopes: row.scopes, via: 'bearer', hash: row.hash } : 'bad';
    }
    const sid = cookieValue(req.headers.cookie, COOKIE);
    if (sid === null) return null;
    const s = sessions.get(sid);
    if (!s || s.expires < Date.now()) { if (s) sessions.delete(sid); return 'bad'; }
    const row = rows.find((r) => r.name === s.name && r.hash === s.hash); // revoked tokens end their sessions
    if (!row) { sessions.delete(sid); return 'bad'; }
    return { name: row.name, tenant: row.tenant, scopes: row.scopes, via: 'cookie', hash: row.hash, sid };
  }
  /** Whether a principal still stands (its token not revoked, its session not ended or expired). @param {Principal} p */
  function stillValid(p) {
    if (closing) return false;
    if (p.via === 'open') return true;
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
      const p = authenticate(req);
      if (p === null || p === 'bad') return fail(res, 401, 'Sign in with a token.');
      return json(res, 200, { ok: true, tenant: p.tenant ?? 'default', scopes: p.scopes, open: p.via === 'open' });
    }
    if (method === 'POST') {
      if (req.headers.origin !== undefined && !originMatches(req)) return fail(res, 403, 'forbidden origin');
      const body = await readBody(req, res, 4096);
      if (!body) return;
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
    const p = authenticate(req);
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
    if ((method === 'POST' || method === 'DELETE') && (p.via === 'cookie' ? !originMatches(req) : p.via === 'open' && req.headers.origin !== undefined && !originMatches(req))) {
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
      const store = storeFor(tenant, false);
      const note = checkOpenNote();
      return json(res, 200, {
        tenant,
        // The server's own paths are for admins only.
        ...(admin ? { home: store ? store.root : path.join(home, 'tenants', tenant) } : {}),
        store: 'files',
        auth: authRequired ? 'tokens' : 'open',
        ...(note ? { note } : {}),
        maps: store ? store.list({ drafts: true }).length : 0,
        tokens: currentTokens().filter((r) => r.tenant === tenant).map((r) => ({ name: r.name, tenant: r.tenant, scopes: [...r.scopes] })),
        server: { version, startedAt },
      });
    }
    if (!ownsTenant(p, tenant)) return fail(res, 404, 'not found'); // never reveal another tenant's maps
    if (rest[0] !== 'maps') return fail(res, 404, 'not found');

    // /v1/t/:tenant/maps
    if (rest.length === 1) {
      if (method === 'GET' || method === 'HEAD') {
        if (!has(p, 'read')) return fail(res, 403, 'This token needs the read scope.');
        const store = storeFor(tenant, false);
        const rows = store ? store.list({ drafts: true }).map((/** @type {any} */ m) => ({
          id: m.id, name: m.name, root: m.root, nodes: m.nodes, updatedAt: m.updatedAt, draft: Boolean(m.draft),
        })) : [];
        return json(res, 200, rows);
      }
      if (method === 'POST') {
        if (!has(p, 'build')) return fail(res, 403, 'This token needs the build scope.');
        const body = await readBody(req, res);
        if (!body) return;
        if (!body.brief || typeof body.brief !== 'object' || Array.isArray(body.brief)) return fail(res, 400, 'brief must be an object (from maps/check)');
        if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 120)) return fail(res, 400, 'name must be a string of at most 120 characters');
        if (body.depth !== undefined && !(Number.isInteger(body.depth) && body.depth >= 1 && body.depth <= 5)) return fail(res, 400, 'depth must be a whole number from 1 to 5');
        if (closing) return fail(res, 503, 'the server is stopping');
        if (running >= Math.max(1, maxBuilds) && waiting(tenant) >= maxQueued) {
          return fail(res, 429, `${maxQueued} builds are already waiting for this tenant: try again when one finishes.`, { 'Retry-After': '30' });
        }
        const store = storeFor(tenant, true);
        const id = store.createDraft(body.brief, body.name || undefined);
        startBuild(tenant, id, body.brief, body.depth);
        const base = mapBase(tenant, id);
        return json(res, 202, { id, viewUrl: `${base}/view`, eventsUrl: `${base}/events` });
      }
      return fail(res, 405, 'method not allowed');
    }
    // /v1/t/:tenant/maps/check
    if (rest.length === 2 && rest[1] === 'check') {
      if (!has(p, 'build')) return fail(res, 403, 'This token needs the build scope.');
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
        const r = await engine.check(context, answers);
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
    /** @type {Record<string, string>} */
    const SCOPE = { actions: 'build', save: 'build', 'api/action': 'build', chat: 'ask', 'api/chat': 'ask' };
    const scope = SCOPE[sub] ?? 'read';
    if (!has(p, scope)) return fail(res, 403, `This token needs the ${scope} scope.`);
    const store = storeFor(tenant, false);
    if (!store || !MAP_ID_RE.test(id) || !store.list({ drafts: true }).some((/** @type {any} */ m) => m.id === id)) {
      return fail(res, 404, 'not found');
    }
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
        const saved = store.save(id, body.name);
        return json(res, 200, { ok: true, id: saved, viewUrl: `${mapBase(tenant, saved)}/view` });
      } catch (err) {
        const msg = String(/** @type {Error} */ (err).message);
        return fail(res, /already exists/.test(msg) ? 409 : 400, msg);
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
      const handled = await h.handleApi(req, res, apiPath, query, { valid: () => stillValid(p) });
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
      if (!res.headersSent) plain(res, 500, 'server error');
      else res.end();
    });
  });

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
      for (const s of stores.values()) { try { s.flush(); } catch { /* best effort */ } }
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
