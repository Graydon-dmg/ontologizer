// @ts-check
// Dev harness server: serves web/, vendored packages, fixtures and src/core. Bound to 127.0.0.1.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveVendorPath } from '../src/core/vendor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const FIXTURES = path.join(ROOT, 'fixtures');
const CORE = path.join(ROOT, 'src', 'core');

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Join a url-relative path under root; null if it escapes.
 * @param {string} root
 * @param {string} rel
 * @returns {string|null}
 */
function safeJoin(root, rel) {
  if (rel.includes('\0') || rel.includes('\\') || rel.split('/').includes('..')) return null;
  const full = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

/** @param {string} pathname @returns {string|null} */
function mapPath(pathname) {
  if (pathname.startsWith('/vendor/')) return resolveVendorPath(pathname);
  if (pathname.startsWith('/fixtures/')) return safeJoin(FIXTURES, pathname.slice('/fixtures/'.length));
  if (pathname.startsWith('/src/core/')) return safeJoin(CORE, pathname.slice('/src/core/'.length));
  return safeJoin(WEB, pathname.slice(1));
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handle(req, res) {
  /** @param {number} code @param {string} msg */
  const fail = (code, msg) => {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(msg);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'Method not allowed');
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
  } catch {
    return fail(400, 'Bad request');
  }
  let file = mapPath(pathname);
  if (!file) return fail(404, 'Not found');
  try {
    let st = await stat(file);
    if (st.isDirectory()) {
      if (!pathname.endsWith('/')) {
        res.writeHead(301, { location: pathname + '/' + (new URL(req.url || '/', 'http://localhost').search), 'cache-control': 'no-store' });
        return res.end();
      }
      file = path.join(file, 'index.html');
      st = await stat(file);
    }
    if (!st.isFile()) return fail(404, 'Not found');
    let body = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    if (ext === '.html') {
      let text = body.toString('utf8');
      if (text.includes('<!--importmap-->')) {
        const map = await readFile(path.join(WEB, 'shared', 'importmap.json'), 'utf8');
        const safe = JSON.stringify(JSON.parse(map)).replace(/</g, '\\u003c');
        text = text.replaceAll('<!--importmap-->', () => `<script type="importmap">${safe}</script>`);
        body = Buffer.from(text);
      }
    }
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return fail(404, 'Not found');
    fail(500, 'Server error');
  }
}

/**
 * @param {{ port?: number }} [opts]
 * @returns {Promise<{ server: http.Server, url: string }>}
 */
export function startDevServer({ port = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ server, url: `http://localhost:${addr.port}` });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const want = process.env.PORT ? Number(process.env.PORT) : 5173;
  /** @type {{ server: http.Server, url: string }} */
  let started;
  try {
    started = await startDevServer({ port: want });
  } catch (err) {
    if (process.env.PORT || /** @type {NodeJS.ErrnoException} */ (err).code !== 'EADDRINUSE') throw err;
    started = await startDevServer({ port: 0 });
  }
  console.log(`Ontologizer dev harness: ${started.url}/dev/?view=none&fixture=plastic-modeling`);
}
