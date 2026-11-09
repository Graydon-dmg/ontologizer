// @ts-check
// Small HTTP helpers shared by the one-map server (index.js) and the service router (service.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const WEB_ROOT = fileURLToPath(new URL('../../web/', import.meta.url));
export const MAX_BODY = 64 * 1024;

/** @type {Record<string, string>} */
export const TYPES = {
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

/**
 * Sent on every HTML page (both servers): no other site may frame it (clickjacking a paid build or
 * chat), and the browser must not guess another content type.
 */
export const PAGE_HEADERS = Object.freeze({
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
});

/** @param {import('node:http').ServerResponse} res @param {number} code @param {any} obj @param {Record<string, string|string[]>} [headers] */
export function json(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

/** @param {import('node:http').ServerResponse} res @param {number} code @param {string} msg */
export function plain(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(msg);
}

/** @param {import('node:http').ServerResponse} res @param {string} abs an already-contained absolute path */
export async function sendFile(res, abs) {
  try {
    const st = await fs.promises.stat(abs);
    if (!st.isFile()) return plain(res, 404, 'not found');
    const data = await fs.promises.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      ...(ext === '.html' || ext === '.htm' ? PAGE_HEADERS : {}),
    });
    res.end(data);
  } catch {
    plain(res, 404, 'not found');
  }
}

/** @param {import('node:http').ServerResponse} res @param {string} root @param {string} rel raw (still encoded) */
export async function serveFile(res, root, rel) {
  let dec;
  try { dec = decodeURIComponent(rel); } catch { return plain(res, 400, 'bad encoding'); }
  if (dec.includes('\0')) return plain(res, 400, 'bad path');
  const abs = path.resolve(root, '.' + path.sep + dec.replace(/^\/+/, ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) return plain(res, 404, 'not found');
  return sendFile(res, abs);
}

/** @param {string} s */
function attr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Send an HTML page from `webRoot`: the import map goes in for <!--importmap-->, and the page's base
 * path into <meta name="ontologizer-base" content=""> ("" leaves the page exactly as it is on disk).
 * @param {import('node:http').ServerResponse} res @param {string} webRoot @param {string} file relative to webRoot
 * @param {string} [base]
 */
export async function sendPage(res, webRoot, file, base = '') {
  try {
    let html = await fs.promises.readFile(path.join(webRoot, file), 'utf8');
    let map = '{}';
    try { map = await fs.promises.readFile(path.join(webRoot, 'shared', 'importmap.json'), 'utf8'); } catch { /* none */ }
    const tag = `<script type="importmap">${map.trim()}</script>`;
    html = html.split('<!--importmap-->').join(tag);
    if (base) html = html.split('<meta name="ontologizer-base" content="">').join(`<meta name="ontologizer-base" content="${attr(base)}">`);
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store', ...PAGE_HEADERS });
    return res.end(html);
  } catch {
    return plain(res, 404, 'not found');
  }
}

/**
 * Read a JSON object body of at most `max` bytes. On failure it answers (413 / 400) and returns null.
 * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {number} [max]
 */
export async function readBody(req, res, max = MAX_BODY) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) { plain(res, 413, 'body too large'); req.resume(); return null; }
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
