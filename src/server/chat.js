// @ts-check
// POST /api/chat (relay engine.ask() as SSE) and GET /api/attachments/<sha256>.
// Uploaded images are untrusted bytes: the type comes from the magic bytes only, sizes are capped
// while the body streams in, and files are named only by their own SHA-256.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_IMAGE = 5 * 1024 * 1024;
export const MAX_IMAGES = 4;
export const MAX_TEXT = 4000;
// Four max-size images as base64, the longest text as escaped JSON (6 bytes per character at
// worst), plus 64 KiB of slack for the rest of the JSON: the limits never contradict each other.
export const MAX_BODY = Math.ceil((MAX_IMAGES * MAX_IMAGE * 4) / 3) + MAX_TEXT * 6 + 64 * 1024;
export const TOO_LARGE = `The message is too large (over ${Math.ceil(MAX_BODY / 1024 / 1024)} MB).`;
export const IDLE_MS = 120_000;
export const TOTAL_MS = 5 * 60_000;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const HASH_RE = /^[0-9a-f]{64}$/;

/** ext -> mime, the only types ever stored or served. */
export const IMAGE_TYPES = /** @type {const} */ ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' });

/**
 * The real image type, from the magic bytes. The declared mime is never trusted.
 * @param {Buffer} b @returns {{ ext: keyof typeof IMAGE_TYPES, mime: string } | null}
 */
export function sniffImage(b) {
  const is = (/** @type {number[]} */ sig, at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
  /** @type {keyof typeof IMAGE_TYPES | null} */
  let ext = null;
  if (is([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ext = 'png';
  else if (is([0xff, 0xd8, 0xff])) ext = 'jpg';
  else if (is([0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) ext = 'gif';
  else if (is([0x52, 0x49, 0x46, 0x46]) && is([0x57, 0x45, 0x42, 0x50], 8)) ext = 'webp';
  return ext ? { ext, mime: IMAGE_TYPES[ext] } : null;
}

/**
 * Width and height from the image header, or null when it is not trivially readable.
 * Every read is bounds-checked; this never throws.
 * @param {Buffer} b @param {keyof typeof IMAGE_TYPES} ext @returns {{ w: number, h: number } | null}
 */
export function imageSize(b, ext) {
  try {
    if (ext === 'png' && b.length >= 24 && b.toString('latin1', 12, 16) === 'IHDR') {
      return ok(b.readUInt32BE(16), b.readUInt32BE(20));
    }
    if (ext === 'gif' && b.length >= 10) return ok(b.readUInt16LE(6), b.readUInt16LE(8));
    if (ext === 'webp' && b.length >= 30) {
      const chunk = b.toString('latin1', 12, 16);
      if (chunk === 'VP8X') return ok(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
      if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
        return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
      }
      if (chunk === 'VP8L' && b[20] === 0x2f) {
        const bits = b.readUInt32LE(21);
        return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
      }
      return null;
    }
    if (ext === 'jpg') {
      // Walk the markers to the first SOFn frame header.
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const m = b[i + 1];
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        const len = b.readUInt16BE(i + 2);
        if (len < 2) return null;
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
        i += 2 + len;
      }
    }
  } catch { /* fall through */ }
  return null;
}
/** @param {number} w @param {number} h */
function ok(w, h) {
  return w > 0 && h > 0 && w <= 100_000 && h <= 100_000 ? { w, h } : null;
}

/** A 400/409/413/415 to send as JSON. */
export class ChatError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Read a request body, refusing it as soon as it passes `max` bytes: never buffers more than that.
 * A Content-Length over the limit is refused before reading anything.
 * @param {import('node:http').IncomingMessage} req @param {number} max @returns {Promise<Buffer>}
 */
export function readCappedBody(req, max) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) return reject(new ChatError(413, TOO_LARGE));
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (/** @type {Buffer} */ c) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        chunks.length = 0;
        req.pause();
        return reject(new ChatError(413, TOO_LARGE));
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

/**
 * Read and discard a body up to `max` bytes (nothing is kept), so a refusal sent afterwards reaches
 * the browser as a message instead of a dropped connection. Resolves false if it passed the cap.
 * @param {import('node:http').IncomingMessage} req @param {number} max @returns {Promise<boolean>}
 */
export function drainCapped(req, max) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) return resolve(false);
    let size = 0;
    let done = false;
    const finish = (/** @type {boolean} */ v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (/** @type {Buffer} */ c) => {
      size += c.length;
      if (size > max) { req.pause(); finish(false); }
    });
    req.on('end', () => finish(true));
    req.on('error', () => finish(false));
  });
}

/**
 * Validate a parsed chat body. Returns the text, lens and decoded images (type from magic bytes).
 * @param {any} body
 * @returns {{ text: string, lens: string|null|undefined, images: { buf: Buffer, ext: keyof typeof IMAGE_TYPES, mime: string }[] }}
 */
export function validateChat(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ChatError(400, 'The body must be a JSON object.');
  if (body.text !== undefined && typeof body.text !== 'string') throw new ChatError(400, 'text must be a string.');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if ([...text].length > MAX_TEXT) throw new ChatError(400, `text must be at most ${MAX_TEXT} characters.`);
  if (body.lens !== undefined && body.lens !== null && (typeof body.lens !== 'string' || body.lens.length > 80)) {
    throw new ChatError(400, 'lens must be a lens id or null.');
  }
  const raw = body.images === undefined ? [] : body.images;
  if (!Array.isArray(raw)) throw new ChatError(400, 'images must be a list.');
  if (raw.length > MAX_IMAGES) throw new ChatError(400, `At most ${MAX_IMAGES} images per message.`);
  const images = raw.map((/** @type {any} */ im, /** @type {number} */ i) => {
    const n = i + 1;
    if (!im || typeof im !== 'object' || typeof im.data !== 'string') throw new ChatError(400, `Image ${n}: data must be base64 text.`);
    const data = im.data;
    // Size before decoding: base64 is 4 characters per 3 bytes.
    if (Math.floor((data.length * 3) / 4) > MAX_IMAGE + 2) throw new ChatError(400, `Image ${n} is larger than 5 MB.`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) throw new ChatError(400, `Image ${n}: data is not valid base64.`);
    const buf = Buffer.from(data, 'base64');
    if (buf.length > MAX_IMAGE) throw new ChatError(400, `Image ${n} is larger than 5 MB.`);
    if (buf.length === 0) throw new ChatError(400, `Image ${n} is empty.`);
    const kind = sniffImage(buf);
    if (!kind) throw new ChatError(400, `Image ${n} is not a PNG, JPEG, WebP or GIF image.`);
    return { buf, ...kind };
  });
  if (!text && images.length === 0) throw new ChatError(400, 'Type a message or add an image.');
  return { text, lens: body.lens, images };
}

/**
 * Store an image as <home>/<id>/attachments/<sha256>.<ext> (deduped by hash). Returns its hash.
 * @param {string} home @param {string} id @param {{ buf: Buffer, ext: string }} img
 */
export function storeAttachment(home, id, img) {
  if (!ID_RE.test(id)) throw new Error('invalid map id');
  const hash = crypto.createHash('sha256').update(img.buf).digest('hex');
  const dir = path.join(home, id, 'attachments');
  const file = path.join(dir, `${hash}.${img.ext}`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, img.buf);
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw err;
    }
  }
  return hash;
}

/**
 * The stored file for a hash, or null. The path is built only from the map id and a validated hash.
 * @param {string} home @param {string} id @param {string} hash
 * @returns {{ file: string, mime: string } | null}
 */
export function findAttachment(home, id, hash) {
  if (!ID_RE.test(id) || !HASH_RE.test(hash)) return null;
  for (const [ext, mime] of Object.entries(IMAGE_TYPES)) {
    const file = path.join(home, id, 'attachments', `${hash}.${ext}`);
    if (fs.existsSync(file)) return { file, mime };
  }
  return null;
}

/**
 * Relay engine.ask() items as SSE. Ends after a done or error item. engine.ask never throws (Epic C);
 * a throw is still turned into an error item, a 401 with the contract message. The browser going
 * away aborts the model call (the engine then records chat.failed "Stopped."). The engine appends
 * chat.asked / chat.answered / chat.failed itself; the server appends nothing.
 * @param {{ engine: any, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *           input: { text: string, images: any[], lens?: string|null }, askOpts?: any, sync?: () => Promise<void>,
 *           idleMs?: number, totalMs?: number }} o
 *   askOpts: the run options for engine.ask (actor, principal, tools) in service mode; none on the one-map server.
 *   sync: service mode with a store that writes behind (Postgres): the question (chat.asked) is stored
 *   before the stream's 200 goes out; a store that cannot store it answers 503 instead.
 *   allow: service mode: whether the asker may still read the map, checked before every chunk is sent;
 *   anything but true stops the answer there (the model call is aborted).
 */
export async function relayAsk({ engine, req, res, input, askOpts = {}, sync, allow, idleMs = IDLE_MS, totalMs = TOTAL_MS }) {
  const head = () => { if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); };
  if (!sync) head();
  const ctl = new AbortController();
  const onClose = () => ctl.abort();
  res.on('close', onClose);
  /** @param {any} item */
  const send = (item) => {
    if (!ctl.signal.aborted && !res.destroyed && !res.writableEnded) { head(); res.write(`data: ${JSON.stringify(item)}\n\n`); }
  };
  const started = Date.now();
  let ended = false; // a done or error item went out
  /** @type {any} */
  let it = null;
  try {
    if (typeof engine.ask !== 'function') throw new Error('chat: not built yet');
    it = engine.ask(input, { signal: ctl.signal, ...askOpts })[Symbol.asyncIterator]();
    if (sync) {
      try { await sync(); } catch {
        ctl.abort();
        if (!res.headersSent) { res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok: false, error: 'the store is not available' })); }
        return;
      }
      head();
    }
    for (;;) {
      // Never wait forever on an engine: no item for idleMs, or totalMs in all, stops the answer.
      const wait = Math.min(idleMs, totalMs - (Date.now() - started));
      /** @type {any} */
      let timer;
      const timeout = new Promise((r) => { timer = setTimeout(() => r(TIMEOUT), Math.max(0, wait)); });
      const next = await Promise.race([it.next(), timeout]).finally(() => clearTimeout(timer));
      if (next === TIMEOUT) {
        send({ type: 'error', error: 'The answer took too long and was stopped.' });
        ended = true;
        ctl.abort();
        Promise.resolve().then(() => it.return?.()).catch(() => {}); // don't await a stuck engine
        break;
      }
      if (next.done || ctl.signal.aborted) break;
      const item = next.value;
      // The asker must still be allowed to read the map before this chunk goes out.
      if (allow && (await allow()) !== true) { ctl.abort(); res.destroy(); break; }
      send(item);
      if (item && (item.type === 'done' || item.type === 'error')) { ended = true; break; }
    }
  } catch (/** @type {any} */ err) {
    const message = err && (err.status === 401 || err.name === 'AuthenticationError')
      ? 'Your Anthropic API key was rejected: run ontologizer key set'
      : String(err?.message ?? err);
    send({ type: 'error', error: message });
    ended = true;
  } finally {
    if (!ended) send({ type: 'error', error: 'No answer.' }); // the engine stopped without done or error
    res.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}
const TIMEOUT = Symbol('timeout');
