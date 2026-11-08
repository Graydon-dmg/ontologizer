// @ts-check
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVendorPath } from '../core/vendor.js';

const PKG_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAX_BODY = 64 * 1024;
const PING_MS = 15000;

/** @type {Record<string, string>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** @param {number} ms @param {{ timers: Set<any> }} c */
function sleep(ms, c) {
  return new Promise((res) => {
    const t = setTimeout(() => { c.timers.delete(t); res(undefined); }, ms);
    c.timers.add(t);
  });
}

/**
 * @param {{ store: any, engine: any, id: string, port?: number,
 *   replay?: null | { speed: number }, webDir?: string,
 *   makeEngine?: null | ((id: string) => Promise<any>) }} opts
 * makeEngine builds the engine for another map (a fused draft); without it, fuse is refused.
 * `webDir` is for tests only.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startServer({ store, engine, id, port = 0, replay = null, webDir, makeEngine = null }) {
  const webRoot = path.resolve(webDir ?? fileURLToPath(new URL('../../web/', import.meta.url)));
  const fixturesRoot = path.join(PKG_ROOT, 'fixtures');
  const coreRoot = path.join(PKG_ROOT, 'src', 'core');
  /** @type {Set<http.ServerResponse>} */
  const sseClients = new Set();
  /** @type {Set<any>} */
  const timers = new Set();
  let boundPort = 0;
  let closed = false;
  // Replay sessions never write view actions to the store (a rehearsal must not change the saved
  // demo): they keep the view here and push view.changed straight to this session's open streams.
  /** @type {Set<(ev: any) => void>} */
  const liveSenders = new Set();
  /** @type {any} */
  let replayView = null;
  /** Running rosetta runs on this map, by normalized persona. @type {Map<string, { jobId: string, lensId: string|null }>} */
  const rosettaRuns = new Map();
  let rosettaSeq = 0;
  /** Running fuses, by "with|into". @type {Map<string, { jobId: string, draftId: string|null, url: string|null }>} */
  const fuseRuns = new Map();
  let fuseSeq = 0;
  /** Servers started for fused drafts; they close with this one. @type {Set<{ url: string, close: () => Promise<void> }>} */
  const children = new Set();
  const currentView = () => (replay ? (replayView ??= structuredClone(store.read(id).view)) : store.read(id).view);

  /** @param {http.ServerResponse} res @param {number} code @param {any} obj */
  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
    res.end(body);
  }
  /** @param {http.ServerResponse} res @param {number} code @param {string} msg */
  function plain(res, code, msg) {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(msg);
  }

  /** @param {http.ServerResponse} res @param {string} root @param {string} rel raw (still encoded) */
  async function serveFile(res, root, rel) {
    let dec;
    try { dec = decodeURIComponent(rel); } catch { return plain(res, 400, 'bad encoding'); }
    if (dec.includes('\0')) return plain(res, 400, 'bad path');
    const abs = path.resolve(root, '.' + path.sep + dec.replace(/^\/+/, ''));
    if (abs !== root && !abs.startsWith(root + path.sep)) return plain(res, 404, 'not found');
    try {
      const st = await fs.promises.stat(abs);
      if (!st.isFile()) return plain(res, 404, 'not found');
      const data = await fs.promises.readFile(abs);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      plain(res, 404, 'not found');
    }
  }

  /** @param {http.ServerResponse} res @param {string} abs an already-contained absolute path */
  async function sendFile(res, abs) {
    try {
      const st = await fs.promises.stat(abs);
      if (!st.isFile()) return plain(res, 404, 'not found');
      const data = await fs.promises.readFile(abs);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      plain(res, 404, 'not found');
    }
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {number} from */
  function sse(req, res, from) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': open\n\n');
    sseClients.add(res);
    const conn = { timers: new Set(), gone: false };
    /** @type {Array<[any, number]>} */
    const buffer = [];
    let live = false;
    let nextIdx = from;
    /** @param {any} ev */
    const send = (ev) => { if (!conn.gone) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
    /** @param {any} ev */
    const sendLive = (ev) => send(ev);
    liveSenders.add(sendLive);
    // In replay, live appends (the reader's own clicks) go out at once instead of waiting for the
    // paced replay to finish; the replay loop then skips any index already sent live.
    /** @type {Set<number>} */
    const sentLive = new Set();
    const unsubscribe = store.subscribe(id, (/** @type {any} */ ev, /** @type {number} */ idx) => {
      if (conn.gone) return;
      if (replay) { if (idx >= from) { sentLive.add(idx); send(ev); } return; }
      if (!live) { buffer.push([ev, idx]); return; }
      if (idx >= nextIdx) { nextIdx = idx + 1; send(ev); }
    });
    const ping = setInterval(() => { if (!conn.gone) res.write(': ping\n\n'); }, PING_MS);
    const cleanup = () => {
      if (conn.gone) return;
      conn.gone = true;
      clearInterval(ping);
      for (const t of conn.timers) clearTimeout(t);
      try { unsubscribe(); } catch { /* ignore */ }
      sseClients.delete(res);
      liveSenders.delete(sendLive);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);

    (async () => {
      let prevAt = null;
      let i = from;
      for await (const ev of store.events(id, { from })) {
        if (conn.gone) return;
        if (replay && prevAt !== null) {
          const wait = (Number(ev.at) - prevAt) / (replay.speed || 1);
          if (wait > 0) await sleep(wait, conn);
          if (conn.gone) return;
        }
        prevAt = Number(ev.at);
        if (replay) { if (!sentLive.has(i)) send(ev); }
        else if (i >= nextIdx) { nextIdx = i + 1; send(ev); }
        i++;
      }
      if (conn.gone) return;
      for (const [ev, idx] of buffer) {
        if (idx >= nextIdx) { nextIdx = idx + 1; send(ev); }
      }
      buffer.length = 0;
      live = true;
    })().catch(() => cleanup());
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function readBody(req, res) {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) { plain(res, 413, 'body too large'); req.resume(); return null; }
      chunks.push(c);
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
      json(res, 400, { ok: false, error: 'invalid JSON' }); return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      json(res, 400, { ok: false, error: 'body must be a JSON object' }); return null;
    }
    return parsed;
  }

  /** @param {any} v */
  const isId = (v) => typeof v === 'string' && v.length > 0;

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function action(req, res) {
    const body = await readBody(req, res);
    if (!body) return;
    /** @param {string} error */
    const bad = (error) => json(res, 400, { ok: false, error });
    /** @param {Record<string, any>} patch */
    const viewEvent = (patch) => {
      const ev = { t: 'view.changed', at: store.now(id), patch };
      if (!replay) return store.append(id, ev);
      const v = currentView();
      replayView = { ...v, ...patch, filter: patch.filter ? { ...v.filter, ...patch.filter } : v.filter };
      for (const send of liveSenders) send(ev);
    };
    switch (body.type) {
      case 'expand':
      case 'collapse': {
        if (!isId(body.nodeId)) return bad('nodeId must be a non-empty string');
        const cur = /** @type {string[]} */ (currentView().collapsed || []);
        const rest = cur.filter((n) => n !== body.nodeId);
        const collapsed = body.type === 'collapse' ? [...rest, body.nodeId] : rest;
        viewEvent({ collapsed });
        return json(res, 202, { ok: true });
      }
      case 'focus':
        if (!isId(body.nodeId)) return bad('nodeId must be a non-empty string');
        viewEvent({ focus: body.nodeId });
        return json(res, 202, { ok: true });
      case 'layout':
        if (!isId(body.value)) return bad('value must be a non-empty string');
        viewEvent({ layout: body.value });
        return json(res, 202, { ok: true });
      case 'lens':
        if (body.value !== null && !isId(body.value)) return bad('value must be a string or null');
        viewEvent({ lens: body.value });
        return json(res, 202, { ok: true });
      case 'filter':
        if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) {
          return bad('value must be an object');
        }
        viewEvent({ filter: body.value });
        return json(res, 202, { ok: true });
      case 'research':
      case 'explain':
      case 'sources': {
        if (!isId(body.nodeId)) return bad('nodeId must be a non-empty string');
        /** @type {Record<string, any>} */
        let job = { kind: body.type, nodeId: body.nodeId };
        if (body.type === 'research') {
          if (body.mode !== 'context' && body.mode !== 'general') return bad("mode must be 'context' or 'general'");
          job = { kind: 'research', nodeId: body.nodeId, mode: body.mode };
        }
        const r = await engine.enqueue(job, { priority: 10 });
        const jobId = typeof r === 'string' ? r : (r?.jobId ?? r?.id);
        return json(res, 202, jobId === undefined ? { ok: true } : { ok: true, jobId });
      }
      case 'rosetta': {
        const persona = typeof body.persona === 'string' ? body.persona.trim() : '';
        if (!persona || persona.length > 120) return bad('persona must be a non-empty string of at most 120 characters');
        if (body.name !== undefined && body.name !== null &&
            (typeof body.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.name))) {
          return bad('name must be lowercase letters, digits and hyphens, at most 40 characters');
        }
        const name = typeof body.name === 'string' ? body.name : undefined;
        const key = persona.toLowerCase();
        const running = rosettaRuns.get(key);
        if (running) return json(res, 202, { ok: true, jobId: running.jobId, ...(running.lensId ? { lensId: running.lensId } : {}) });
        return json(res, 202, await startRosetta(persona, name, key));
      }
      case 'fuse': {
        if (typeof body.with !== 'string' || !body.with.trim()) return bad('with must be a map id or name');
        const r = store.resolve(body.with.trim());
        if (r === null) return bad(`no map named "${body.with}"`);
        if (typeof r === 'object') return bad(`"${body.with}" is ambiguous: ${r.ambiguous.join(', ')}`);
        if (r === id) return bad('fuse needs a different map than this one');
        if (body.into !== undefined && body.into !== null &&
            (typeof body.into !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.into))) {
          return bad('into must be lowercase letters, digits and hyphens, at most 40 characters');
        }
        if (!makeEngine) return bad('fuse is not available in this session');
        const into = typeof body.into === 'string' ? body.into : undefined;
        const key = `${r}|${into ?? ''}`;
        const running = fuseRuns.get(key);
        if (running) return json(res, 202, fuseReply(running));
        return json(res, 202, await startFuse(r, into, key));
      }
      default:
        return bad(`unknown action type: ${String(body.type)}`);
    }
  }

  /**
   * Start engine.rosetta without waiting for it to finish (it runs batch after batch). It is wrapped
   * in job events so the shell's jobs tray shows it and its errors. Answers with the lensId as soon as
   * the lens.added event appears (at most 3 s), which engine.rosetta emits first.
   * @param {string} persona @param {string|undefined} name @param {string} key
   */
  async function startRosetta(persona, name, key) {
    const jobId = `rosetta-${process.pid}-${++rosettaSeq}`;
    const job = { id: jobId, kind: 'rosetta' };
    const run = { jobId, lensId: /** @type {string|null} */ (null) };
    rosettaRuns.set(key, run);
    /** @type {(v: any) => void} */
    let gotLens = () => {};
    const lensSeen = new Promise((r) => { gotLens = r; });
    const off = store.subscribe(id, (/** @type {any} */ ev) => {
      if (ev.t === 'lens.added' && ev.lens?.id && !run.lensId && ev.lens.persona?.trim().toLowerCase() === key) {
        run.lensId = ev.lens.id;
        gotLens(ev.lens.id);
      }
    });
    store.append(id, { t: 'job.queued', at: store.now(id), job });
    store.append(id, { t: 'job.started', at: store.now(id), job });
    const finished = Promise.resolve()
      .then(() => engine.rosetta(id, persona, { name }))
      .then(
        (lensId) => {
          if (!run.lensId && typeof lensId === 'string') run.lensId = lensId;
          try { store.append(id, { t: 'job.done', at: store.now(id), job }); } catch { /* store gone */ }
        },
        (/** @type {any} */ err) => {
          const error = err && (err.status === 401 || err.name === 'AuthenticationError')
            ? 'Your Anthropic API key was rejected: run ontologizer key set'
            : String(err?.message ?? err);
          try { store.append(id, { t: 'job.failed', at: store.now(id), job: { ...job, error } }); } catch { /* store gone */ }
        },
      )
      .finally(() => { off(); rosettaRuns.delete(key); gotLens(null); })
      .catch(() => {}); // never an unhandled rejection: errors are already job.failed events
    /** @type {any} */
    let t;
    await Promise.race([lensSeen, finished, new Promise((r) => { t = setTimeout(r, 3000); })]);
    clearTimeout(t);
    return { ok: true, jobId, ...(run.lensId ? { lensId: run.lensId } : {}) };
  }

  /** @param {{ jobId: string, draftId: string|null, url: string|null }} run */
  function fuseReply(run) {
    return { ok: true, jobId: run.jobId, ...(run.draftId ? { draftId: run.draftId } : {}), ...(run.url ? { url: run.url } : {}) };
  }

  /**
   * Fuse this map with `withId` into a new draft, served by a second server in this process. The run
   * is wrapped in job events on THIS map (kind 'fuse'); job.done carries draftId and url. Answers as
   * soon as the draft's server is up (engine.fuse's onDraft), or after at most 5 s.
   * @param {string} withId @param {string|undefined} into @param {string} key
   */
  async function startFuse(withId, into, key) {
    const jobId = `fuse-${process.pid}-${++fuseSeq}`;
    const job = { id: jobId, kind: 'fuse', with: withId, ...(into ? { into } : {}) };
    const run = { jobId, draftId: /** @type {string|null} */ (null), url: /** @type {string|null} */ (null) };
    fuseRuns.set(key, run);
    /** @type {(v: any) => void} */
    let ready = () => {};
    const served = new Promise((r) => { ready = r; });
    /** @type {Promise<void>|null} */
    let serving = null;
    let failed = false;
    /** @type {{ url: string, close: () => Promise<void> } | null} */
    let childServer = null;
    /** Start the draft's server once. @param {string} draftId */
    const serveDraft = (draftId) => {
      if (serving || closed) return serving;
      run.draftId = draftId;
      serving = (async () => {
        const child = await startServer({ store, engine: await makeEngine(draftId), id: draftId, webDir, makeEngine });
        if (closed || failed) { await child.close(); return; }
        children.add(child);
        run.url = child.url;
        ready(child.url);
        childServer = child;
      })().catch(() => { ready(null); });
      return serving;
    };
    store.append(id, { t: 'job.queued', at: store.now(id), job });
    store.append(id, { t: 'job.started', at: store.now(id), job });
    const finished = Promise.resolve()
      .then(() => engine.fuse(id, withId, { into, onDraft: (/** @type {string} */ d) => { serveDraft(d); } }))
      .then(async (draftId) => {
        if (typeof draftId === 'string') await serveDraft(draftId); // an engine without onDraft
        try {
          store.append(id, { t: 'job.done', at: store.now(id),
            job: { ...job, ...(run.draftId ? { draftId: run.draftId } : {}), ...(run.url ? { url: run.url } : {}) } });
        } catch { /* store gone */ }
      }, async (/** @type {any} */ err) => {
        // A failed fuse leaves no server behind for its half-made draft.
        failed = true;
        if (serving) await serving;
        if (childServer) { children.delete(childServer); await childServer.close().catch(() => {}); }
        run.url = null;
        const error = err && (err.status === 401 || err.name === 'AuthenticationError')
          ? 'Your Anthropic API key was rejected: run ontologizer key set'
          : String(err?.message ?? err);
        try { store.append(id, { t: 'job.failed', at: store.now(id), job: { ...job, error } }); } catch { /* store gone */ }
      })
      .finally(() => { fuseRuns.delete(key); ready(null); })
      .catch(() => {}); // never an unhandled rejection: errors are already job.failed events
    /** @type {any} */
    let t;
    await Promise.race([served, finished, new Promise((r) => { t = setTimeout(r, 5000); })]);
    clearTimeout(t);
    return fuseReply(run);
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handle(req, res) {
    const hostOk = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
    if (!hostOk.includes(String(req.headers.host))) return plain(res, 403, 'forbidden host');
    const raw = req.url || '/';
    const q = raw.indexOf('?');
    const rawPath = q < 0 ? raw : raw.slice(0, q);
    const query = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
    const method = req.method || 'GET';

    if (rawPath === '/api/action') {
      if (method !== 'POST') return plain(res, 405, 'method not allowed');
      const origin = req.headers.origin;
      if (origin !== undefined && !hostOk.map((h) => `http://${h}`).includes(origin)) {
        return plain(res, 403, 'forbidden origin');
      }
      return action(req, res);
    }
    if (method !== 'GET' && method !== 'HEAD') return plain(res, 405, 'method not allowed');

    if (rawPath === '/') {
      try {
        const html = await fs.promises.readFile(path.join(webRoot, 'index.html'), 'utf8');
        let map = '{}';
        try { map = await fs.promises.readFile(path.join(webRoot, 'shared', 'importmap.json'), 'utf8'); } catch { /* none */ }
        const tag = `<script type="importmap">${map.trim()}</script>`;
        res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
        return res.end(html.split('<!--importmap-->').join(tag));
      } catch {
        return plain(res, 404, 'not found');
      }
    }
    // The tab icon, even before the page's <link> loads.
    if (rawPath === '/favicon.ico') return sendFile(res, path.join(webRoot, 'shared', 'brand', 'favicon-32.png'));
    if (rawPath === '/api/maps') {
      // Every other map, for the Fuse picker: saved maps first, then drafts (newest first in each).
      const rows = store.list({ drafts: true })
        .filter((/** @type {any} */ m) => m.id !== id)
        .map((/** @type {any} */ m) => ({ id: m.id, name: m.name, nodes: m.nodes, updatedAt: m.updatedAt, draft: Boolean(m.draft) }));
      rows.sort((a, b) => Number(a.draft) - Number(b.draft) || b.updatedAt - a.updatedAt);
      return json(res, 200, rows);
    }
    if (rawPath === '/api/snapshot') return json(res, 200, store.read(id));
    if (rawPath === '/api/events') {
      const from = Math.max(0, Number.parseInt(query.get('from') || '0', 10) || 0);
      return sse(req, res, from);
    }
    for (const p of ['shell', 'shared', 'views', 'dev']) {
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

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) plain(res, 500, 'server error');
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      boundPort = addr.port;
      store.sessions.set(id, { port: boundPort, pid: process.pid, startedAt: Date.now() });
      resolve({
        url: `http://127.0.0.1:${boundPort}/`,
        async close() {
          if (closed) return;
          closed = true;
          for (const t of timers) clearTimeout(t);
          for (const r of sseClients) r.end();
          await Promise.all([...children].map((c) => c.close().catch(() => {})));
          children.clear();
          try { store.sessions.remove(id); } catch { /* ignore */ }
          await new Promise((res) => { server.close(() => res(undefined)); server.closeAllConnections?.(); });
        },
      });
    });
  });
}
