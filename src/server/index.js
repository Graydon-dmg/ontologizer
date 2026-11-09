// @ts-check
// The one-map server (ontologizer new / load): one map on 127.0.0.1, its /api/* routes at the root.
import http from 'node:http';
import path from 'node:path';
import { resolveVendorPath } from '../core/vendor.js';
import { PKG_ROOT, WEB_ROOT, plain, sendFile, serveFile, sendPage } from './http.js';
import { createMapHandler } from './map.js';

/**
 * @param {{ store: any, engine: any, id: string, port?: number,
 *   replay?: null | { speed: number }, webDir?: string,
 *   makeEngine?: null | ((id: string) => Promise<any>), chatTimeouts?: { idleMs?: number, totalMs?: number } }} opts
 * chatTimeouts is for tests only.
 * makeEngine builds the engine for another map (a fused draft); without it, fuse is refused.
 * `webDir` is for tests only.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startServer({ store, engine, id, port = 0, replay = null, webDir, makeEngine = null, chatTimeouts = {} }) {
  const webRoot = path.resolve(webDir ?? WEB_ROOT);
  const fixturesRoot = path.join(PKG_ROOT, 'fixtures');
  const coreRoot = path.join(PKG_ROOT, 'src', 'core');
  let boundPort = 0;
  const hostOk = () => [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
  // A fused draft gets its own server in this process; it closes with this one.
  const openDraft = makeEngine
    ? async (/** @type {string} */ draftId) => startServer({ store, engine: await makeEngine(draftId), id: draftId, webDir, makeEngine })
    : null;
  const map = createMapHandler({
    store, engine, id, replay, openDraft, chatTimeouts,
    originOk: (origin) => origin === undefined || hostOk().map((h) => `http://${h}`).includes(origin),
  });

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handle(req, res) {
    if (!hostOk().includes(String(req.headers.host))) return plain(res, 403, 'forbidden host');
    const raw = req.url || '/';
    const q = raw.indexOf('?');
    const rawPath = q < 0 ? raw : raw.slice(0, q);
    const query = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
    const method = req.method || 'GET';

    if (rawPath === '/api/action' || rawPath === '/api/chat') return map.handleApi(req, res, rawPath, query);
    if (method !== 'GET' && method !== 'HEAD') return plain(res, 405, 'method not allowed');

    if (rawPath === '/') return sendPage(res, webRoot, 'index.html');
    // The tab icon, even before the page's <link> loads.
    if (rawPath === '/favicon.ico') return sendFile(res, path.join(webRoot, 'shared', 'brand', 'favicon-32.png'));
    if (rawPath.startsWith('/api/') && await map.handleApi(req, res, rawPath, query)) return;
    for (const p of ['shell', 'shared', 'views', 'dev', 'dist']) {
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

  let closed = false;
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
          await map.close();
          try { store.sessions.remove(id); } catch { /* ignore */ }
          await new Promise((res) => { server.close(() => res(undefined)); server.closeAllConnections?.(); });
        },
      });
    });
  });
}
