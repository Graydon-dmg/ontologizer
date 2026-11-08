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
 *   replay?: null | { speed: number }, webDir?: string }} opts
 * `webDir` is for tests only.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startServer({ store, engine, id, port = 0, replay = null, webDir }) {
  const webRoot = path.resolve(webDir ?? fileURLToPath(new URL('../../web/', import.meta.url)));
  const fixturesRoot = path.join(PKG_ROOT, 'fixtures');
  const coreRoot = path.join(PKG_ROOT, 'src', 'core');
  /** @type {Set<http.ServerResponse>} */
  const sseClients = new Set();
  /** @type {Set<any>} */
  const timers = new Set();
  let boundPort = 0;
  let closed = false;

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
    const viewEvent = (patch) => store.append(id, { t: 'view.changed', at: store.now(id), patch });
    switch (body.type) {
      case 'expand':
      case 'collapse': {
        if (!isId(body.nodeId)) return bad('nodeId must be a non-empty string');
        const cur = /** @type {string[]} */ (store.read(id).view.collapsed || []);
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
      default:
        return bad(`unknown action type: ${String(body.type)}`);
    }
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
          try { store.sessions.remove(id); } catch { /* ignore */ }
          await new Promise((res) => { server.close(() => res(undefined)); server.closeAllConnections?.(); });
        },
      });
    });
  });
}
