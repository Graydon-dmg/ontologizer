// @ts-check
// Service mode (ontologizer serve): one server for every map in a home, by tenant, with tokens.
// The per-map routes are the one-map server's own handlers (map.js), mounted under each map's base
// /v1/t/<tenant>/maps/<id>, so the map page works there unchanged.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveVendorPath } from '../core/vendor.js';
import { openStore, TENANT_RE } from '../core/store.js';
import { readTokens, checkToken } from './tokens.js';
import { PKG_ROOT, WEB_ROOT, json, plain, sendFile, serveFile, sendPage, readBody } from './http.js';
import { createMapHandler } from './map.js';

export const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
export const COOKIE = 'ontologizer_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;
const WAIT_DEFAULT = 30000;
const WAIT_MAX = 300000;
const MAP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const REJECTED = 'Your Anthropic API key was rejected: run ontologizer key set';

/** A --host that is loopback. @param {string} host */
export const isLoopback = (host) => LOOPBACK.includes(String(host).replace(/^\[|\]$/g, ''));

/** @param {string} tenant @param {string} id */
export const mapBase = (tenant, id) => `/v1/t/${tenant}/maps/${id}`;

/**
 * Who is calling. `via` is how they proved it: 'open' (no tokens loaded, loopback only),
 * 'bearer' (Authorization header) or 'cookie' (a session from POST /v1/session).
 * @typedef {{ name: string|null, tenant: string|null, scopes: string[], via: 'open'|'bearer'|'cookie' }} Principal
 */

/** @param {any} err */
const errText = (err) => (err && (err.status === 401 || err.name === 'AuthenticationError') ? REJECTED : String(err?.message ?? err));

/**
 * @param {{ home: string, host?: string, port?: number, tokensFile?: string|null, allowHosts?: string[],
 *   maxBuilds?: number, makeEngine: (o: { store: any, id: string, tenant: string }) => Promise<any>,
 *   version?: string, webDir?: string, log?: (line: string) => void }} opts
 *   tokensFile: the tokens to load; null (or a missing file) means none.
 *   makeEngine: the engine for one map (the CLI passes engineFor with needKey false).
 * @returns {Promise<{ url: string, port: number, host: string, tokensLoaded: boolean, close: () => Promise<void> }>}
 */
export async function startService({
  home, host = '127.0.0.1', port = 8787, tokensFile = null, allowHosts = [], maxBuilds = 2,
  makeEngine, version = '', webDir, log = () => {},
}) {
  const webRoot = path.resolve(webDir ?? WEB_ROOT);
  const fixturesRoot = path.join(PKG_ROOT, 'fixtures');
  const coreRoot = path.join(PKG_ROOT, 'src', 'core');
  const startedAt = new Date().toISOString();

  // ---- tokens: read at start; re-read when the file changes (a revoke takes effect at once). ----
  let tokenRows = tokensFile ? readTokens(tokensFile) : [];
  // Whether auth is required is fixed at start: revoking every token never opens the server.
  const authRequired = tokenRows.length > 0;
  if (!authRequired && !isLoopback(host)) {
    const err = new Error(`Refusing to listen on ${host} without tokens: create one with \`ontologizer token create\`, or pass --tokens.`);
    /** @type {any} */ (err).code = 'NO_TOKENS';
    throw err;
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
  /** @type {Map<string, Promise<any>>} */
  const engines = new Map();
  /** @param {string} tenant @param {string} id */
  function engineFor(tenant, id) {
    const key = `${tenant}/${id}`;
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
  /** @param {string} tenant @param {string} id */
  function handlerFor(tenant, id) {
    const key = `${tenant}/${id}`;
    let h = handlers.get(key);
    if (!h) {
      h = engineFor(tenant, id).then((engine) => createMapHandler({
        store: storeFor(tenant, true), engine, id,
        // Fuse makes the draft a new map in this process: its URL is its view, no new server or port.
        openDraft: async (draftId) => ({ url: `${mapBase(tenant, draftId)}/view`, close: async () => {} }),
      }));
      h.catch(() => handlers.delete(key));
      handlers.set(key, h);
    }
    return h;
  }

  // ---- builds: at most maxBuilds at once; the rest wait in a queue ----
  /** @type {Map<string, { state: 'queued'|'running'|'done'|'failed', error?: string }>} */
  const builds = new Map();
  let running = 0;
  /** @type {Array<() => void>} */
  const queue = [];
  const slot = () => new Promise((resolve) => {
    if (running < Math.max(1, maxBuilds)) { running++; resolve(undefined); } else queue.push(() => { running++; resolve(undefined); });
  });
  const release = () => { running--; const next = queue.shift(); if (next) next(); };
  let buildSeq = 0;
  /** @param {string} tenant @param {string} id @param {any} brief @param {number|undefined} depth */
  function startBuild(tenant, id, brief, depth) {
    const key = `${tenant}/${id}`;
    const b = { state: /** @type {'queued'|'running'|'done'|'failed'} */ ('queued'), error: /** @type {string|undefined} */ (undefined) };
    builds.set(key, b);
    (async () => {
      await slot();
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
        release();
        try { storeFor(tenant, true).flush(id); } catch { /* renamed or gone */ }
      }
    })();
  }

  /** @param {string} tenant @param {string} id */
  function busy(tenant, id) {
    const b = builds.get(`${tenant}/${id}`);
    /** @type {any[]} */
    const jobs = [];
    if (b && (b.state === 'queued' || b.state === 'running')) jobs.push({ id: 'build', kind: 'build', state: b.state });
    const snap = storeFor(tenant, true).read(id);
    for (const j of Object.values(snap.jobs || {})) {
      const job = /** @type {any} */ (j);
      if (job.state === 'queued' || job.state === 'running') jobs.push({ id: job.id, kind: job.kind, state: job.state, ...(job.nodeId ? { nodeId: job.nodeId } : {}) });
    }
    return jobs;
  }

  // ---- host and origin ----
  let boundPort = 0;
  const wildcard = host === '0.0.0.0' || host === '::';
  /** @param {string|undefined} h */
  function hostOk(h) {
    if (!h) return false;
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(h);
    if (!m) return false;
    const name = m[1].toLowerCase();
    const p = m[2] ? Number(m[2]) : null;
    if (allowHosts.some((a) => a.toLowerCase() === name || a.toLowerCase() === h.toLowerCase())) return true;
    if (p !== boundPort) return false;
    const bare = name.replace(/^\[|\]$/g, '');
    if (bare === host.replace(/^\[|\]$/g, '')) return true;
    // Bound to loopback or every interface: the loopback names reach it too.
    return (isLoopback(host) || wildcard) && LOOPBACK.includes(bare);
  }
  /** @param {http.IncomingMessage} req */
  function originMatches(req) {
    const o = req.headers.origin;
    const h = String(req.headers.host);
    return o === `http://${h}` || o === `https://${h}`;
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
      return row ? { name: row.name, tenant: row.tenant, scopes: row.scopes, via: 'bearer' } : 'bad';
    }
    const sid = cookieValue(req.headers.cookie, COOKIE);
    if (sid === null) return null;
    const s = sessions.get(sid);
    if (!s || s.expires < Date.now()) { if (s) sessions.delete(sid); return 'bad'; }
    const row = rows.find((r) => r.name === s.name && r.hash === s.hash); // revoked tokens end their sessions
    if (!row) { sessions.delete(sid); return 'bad'; }
    return { name: row.name, tenant: row.tenant, scopes: row.scopes, via: 'cookie' };
  }
  /** @param {Principal} p @param {string} scope */
  const has = (p, scope) => p.scopes.includes('admin') || p.scopes.includes(scope);
  /** @param {Principal} p @param {string} tenant */
  const ownsTenant = (p, tenant) => p.via === 'open' || p.tenant === tenant;

  // ---- routes ----
  /** @param {http.ServerResponse} res @param {number} code @param {string} error */
  const fail = (res, code, error) => json(res, code, { ok: false, error });

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
      if (sessions.size >= MAX_SESSIONS) sessions.delete(/** @type {string} */ (sessions.keys().next().value));
      const sid = crypto.randomBytes(32).toString('base64url');
      sessions.set(sid, { name: row.name, hash: row.hash, expires: now + SESSION_MS });
      return json(res, 200, { ok: true, tenant: row.tenant, scopes: row.scopes },
        { 'Set-Cookie': `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/` });
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
   * Every /v1/t/ route: authenticate first (401), then the tenant (404), then the scope (403).
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} rawPath @param {URLSearchParams} query
   */
  async function tenantRoute(req, res, rawPath, query) {
    const method = req.method || 'GET';
    const p = authenticate(req);
    if (p === null) return fail(res, 401, 'Sign in with a token.');
    if (p === 'bad') return fail(res, 401, 'That token was not accepted.');
    if ((method === 'POST' || method === 'DELETE') && (p.via === 'cookie' ? !originMatches(req) : p.via === 'open' && req.headers.origin !== undefined && !originMatches(req))) {
      return fail(res, 403, 'forbidden origin');
    }
    const parts = rawPath.split('/'); // ['', 'v1', 't', tenant, ...rest]
    const tenant = parts[3] ?? '';
    const rest = parts.slice(4);
    if (!TENANT_RE.test(tenant)) return fail(res, 404, 'not found');
    // Status: your own tenant with read; any tenant with admin.
    if (rest.length === 1 && rest[0] === 'status') {
      if (!ownsTenant(p, tenant) && !p.scopes.includes('admin')) return fail(res, 404, 'not found');
      if (!has(p, 'read')) return fail(res, 403, 'This token needs the read scope.');
      if (method !== 'GET' && method !== 'HEAD') return fail(res, 405, 'method not allowed');
      const store = storeFor(tenant, false);
      return json(res, 200, {
        tenant,
        home: store ? store.root : path.join(home, 'tenants', tenant),
        store: 'files',
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
      try {
        const engine = await engineFor(tenant, 'draft-pending'); // check writes nothing
        const r = await engine.check(context, answers);
        return json(res, 200, {
          ready: Boolean(r?.ready),
          ...(r?.brief ? { brief: r.brief } : {}), ...(r?.name ? { name: r.name } : {}),
          ...(r?.questions ? { questions: r.questions } : {}),
        });
      } catch (err) {
        return fail(res, 502, errText(err));
      }
    }
    // /v1/t/:tenant/maps/:id/...
    const id = rest[1];
    const sub = rest.slice(2).join('/');
    const isApi = rest[2] === 'api';
    const scope = sub === 'actions' || sub === 'save' || sub === 'api/action' ? 'build' : 'read';
    if (!has(p, scope)) return fail(res, 403, `This token needs the ${scope} scope.`);
    const store = storeFor(tenant, false);
    if (!store || !MAP_ID_RE.test(id) || !store.list({ drafts: true }).some((/** @type {any} */ m) => m.id === id)) {
      return fail(res, 404, 'not found');
    }
    const base = mapBase(tenant, id);
    if (sub === 'view') {
      if (method !== 'GET' && method !== 'HEAD') return fail(res, 405, 'method not allowed');
      return sendPage(res, webRoot, 'index.html', base);
    }
    if (sub === 'wait') {
      if (method !== 'GET' && method !== 'HEAD') return fail(res, 405, 'method not allowed');
      const t = Number.parseInt(query.get('timeout') ?? '', 10);
      const timeout = Math.min(WAIT_MAX, Math.max(0, Number.isFinite(t) ? t : WAIT_DEFAULT));
      const until = Date.now() + timeout;
      let gone = false;
      res.on('close', () => { gone = true; });
      for (;;) {
        const jobs = busy(tenant, id);
        if (!jobs.length || Date.now() >= until || gone || closing) {
          const b = builds.get(`${tenant}/${id}`);
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
      if (busy(tenant, id).length) return fail(res, 409, 'The map is still being built or has jobs running: wait for it, then save.');
      // The map's id changes: end its streams and drop its engine first.
      const key = `${tenant}/${id}`;
      const h = handlers.get(key);
      handlers.delete(key);
      engines.delete(key);
      builds.delete(key);
      if (h) await (await h.catch(() => null))?.close();
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
      const h = await handlerFor(tenant, id);
      if (await h.handleApi(req, res, apiPath, query)) return;
    }
    return fail(res, 404, 'not found');
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handle(req, res) {
    if (!hostOk(req.headers.host)) return plain(res, 403, 'forbidden host');
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
    for (const p of ['shell', 'shared', 'views', 'home']) {
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
  });
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  boundPort = addr.port;
  const shown = wildcard ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${shown}:${boundPort}/`,
    port: boundPort,
    host,
    tokensLoaded: authRequired,
    /** Stop accepting, end the streams, flush the stores. */
    async close() {
      if (closing) return;
      closing = true;
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
