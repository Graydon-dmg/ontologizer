// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openStore } from '../../src/core/store.js';
import { startServer } from '../../src/server/index.js';
import { sniffImage, imageSize, MAX_BODY } from '../../src/server/chat.js';
import { tempHome, fixtureEvents } from './helpers.js';

// Tiny image headers (enough for type and size; the server never decodes pixels).
const PNG = (/** @type {number} */ w, /** @type {number} */ h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
const GIF = (/** @type {number} */ w, /** @type {number} */ h) => {
  const b = Buffer.alloc(13); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b;
};
const JPEG = (/** @type {number} */ w, /** @type {number} */ h) => Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, length 4
  0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const WEBP = (/** @type {number} */ w, /** @type {number} */ h) => {
  const b = Buffer.alloc(30); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1');
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b;
};

/** A server on a fresh store with a fake engine.ask. @param {(input: any, o: any) => AsyncIterable<any>} [ask] */
async function boot(ask) {
  const home = tempHome();
  const store = openStore(home);
  store.importEvents('plastic-modeling', fixtureEvents('plastic-modeling'));
  /** @type {any[]} */ const asked = [];
  const engine = {
    enqueue: () => 'j',
    ask: ask ?? (async function* (/** @type {any} */ input) { asked.push(input); yield { type: 'delta', text: 'Hi' }; yield { type: 'done', msgId: 'm1' }; }),
  };
  const srv = await startServer({ store, engine, id: 'plastic-modeling' });
  return { home, store, srv, asked };
}

/** POST /api/chat; returns status, headers and the raw body. @param {string} url @param {any} body @param {Record<string,string>} [headers] */
async function chat(url, body, headers = {}) {
  const r = await fetch(new URL('api/chat', url), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, type: r.headers.get('content-type') ?? '', text: await r.text() };
}
/** @param {string} sse */
const items = (sse) => sse.split('\n\n').filter((p) => p.startsWith('data: ')).map((p) => JSON.parse(p.slice(6)));

/** A raw GET with an exact, unnormalised path. @param {string} url @param {string} p @param {Record<string,string>} [headers] */
function rawGet(url, p, headers = {}) {
  const u = new URL(url);
  return new Promise((resolve) => {
    http.get({ host: u.hostname, port: u.port, path: p, headers }, (r) => {
      let body = Buffer.alloc(0);
      r.on('data', (c) => { body = Buffer.concat([body, c]); });
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body }));
    });
  });
}

test('image type and size come from the bytes: png, jpeg, gif, webp; anything else is not an image', () => {
  assert.deepEqual([sniffImage(PNG(10, 20))?.ext, imageSize(PNG(10, 20), 'png')], ['png', { w: 10, h: 20 }]);
  assert.deepEqual([sniffImage(JPEG(640, 480))?.ext, imageSize(JPEG(640, 480), 'jpg')], ['jpg', { w: 640, h: 480 }]);
  assert.deepEqual([sniffImage(GIF(3, 4))?.ext, imageSize(GIF(3, 4), 'gif')], ['gif', { w: 3, h: 4 }]);
  assert.deepEqual([sniffImage(WEBP(800, 600))?.ext, imageSize(WEBP(800, 600), 'webp')], ['webp', { w: 800, h: 600 }]);
  for (const bad of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('%PDF-1.7'), Buffer.from([0x89, 0x50])]) {
    assert.equal(sniffImage(bad), null);
  }
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'jpg'), null); // truncated: no throw
});

test('a declared image/png that is really a GIF is stored and served as a GIF, with nosniff', async () => {
  const { home, srv, asked } = await boot();
  const gif = GIF(3, 4);
  const r = await chat(srv.url, { text: 'what is this?', images: [{ mime: 'image/png', data: gif.toString('base64') }] });
  assert.equal(r.status, 200, r.text);
  assert.match(r.type, /text\/event-stream/);
  assert.deepEqual(items(r.text), [{ type: 'delta', text: 'Hi' }, { type: 'done', msgId: 'm1' }]);
  const hash = crypto.createHash('sha256').update(gif).digest('hex');
  const dir = path.join(home, 'plastic-modeling', 'attachments');
  assert.deepEqual(fs.readdirSync(dir), [`${hash}.gif`]);
  assert.deepEqual(asked[0].images[0], { mime: 'image/gif', data: gif.toString('base64'), hash, w: 3, h: 4 });
  assert.equal(asked[0].text, 'what is this?');
  /** @type {any} */ const got = await rawGet(srv.url, `/api/attachments/${hash}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers['content-type'], 'image/gif');
  assert.equal(got.headers['x-content-type-options'], 'nosniff');
  assert.ok(got.body.equals(gif));
  // The same image again is deduped (one file).
  await chat(srv.url, { text: 'again', images: [{ mime: 'image/gif', data: gif.toString('base64') }] });
  assert.equal(fs.readdirSync(dir).length, 1);
  // Planted fault: trusting the declared mime would have named it .png.
  assert.notEqual('image/png', sniffImage(gif)?.mime);
  await srv.close();
});

test('validation: 400 for a 6 MB image, 5 images, non-images, bad base64, empty or too-long text; 415 for non-JSON', async () => {
  const { srv, asked } = await boot();
  const six = Buffer.concat([PNG(1, 1), Buffer.alloc(6 * 1024 * 1024)]);
  const png = PNG(1, 1).toString('base64');
  const cases = [
    [{ text: 'x', images: [{ mime: 'image/png', data: six.toString('base64') }] }, /larger than 5 MB/],
    [{ text: 'x', images: Array(5).fill({ mime: 'image/png', data: png }) }, /At most 4 images/],
    [{ text: 'x', images: [{ mime: 'image/png', data: Buffer.from('<svg/>').toString('base64') }] }, /not a PNG, JPEG, WebP or GIF/],
    [{ text: 'x', images: [{ mime: 'image/png', data: 'not base64!' }] }, /not valid base64/],
    [{ text: '   ' }, /Type a message or add an image/],
    [{ text: 'x'.repeat(4001) }, /at most 4000 characters/],
    [{ text: 'x', lens: 7 }, /lens/],
    [[1, 2], /JSON object/],
  ];
  for (const [body, re] of cases) {
    const r = await chat(srv.url, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(JSON.parse(r.text).error, /** @type {RegExp} */ (re));
  }
  assert.equal((await chat(srv.url, '{not json')).status, 400);
  assert.equal((await chat(srv.url, { text: 'x' }, { 'content-type': 'text/plain' })).status, 415);
  // An image with no text is fine; so is a 4000-character message.
  assert.equal((await chat(srv.url, { images: [{ mime: 'image/png', data: png }] })).status, 200);
  assert.equal((await chat(srv.url, { text: 'y'.repeat(4000) })).status, 200);
  assert.equal(asked.length, 2, 'the engine is only called for valid messages');
  await srv.close();
});

test('attachments: only a stored 64-hex hash is served; traversal and junk are 404; Host and Origin guards', async () => {
  const { home, srv } = await boot();
  fs.writeFileSync(path.join(home, 'index.json.secret'), 'nope');
  for (const p of ['/api/attachments/../../index.json', '/api/attachments/..%2f..%2findex.json', '/api/attachments/%2e%2e/%2e%2e/sessions.json',
    `/api/attachments/${'a'.repeat(63)}`, `/api/attachments/${'A'.repeat(64)}`, `/api/attachments/${'a'.repeat(64)}`,
    `/api/attachments/${'a'.repeat(64)}.png`, '/api/attachments/']) {
    /** @type {any} */ const r = await rawGet(srv.url, p);
    assert.equal(r.status, 404, p);
  }
  /** @type {any} */ const foreignHost = await rawGet(srv.url, `/api/attachments/${'a'.repeat(64)}`, { host: 'evil.example' });
  assert.equal(foreignHost.status, 403);
  const foreign = await chat(srv.url, { text: 'hi' }, { origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  // Planted fault: a same-origin request with the same body is accepted (the guard is what refused it).
  assert.equal((await chat(srv.url, { text: 'hi' }, { origin: srv.url.replace(/\/$/, '') })).status, 200);
  await srv.close();
});

test('an oversized body is refused while it streams in (and at once for a large Content-Length)', async () => {
  const { srv, asked } = await boot();
  const u = new URL(srv.url);
  // Declared too large: refused before any body is sent.
  const declared = await new Promise((resolve) => {
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/chat', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(MAX_BODY + 1) } }, (r) => { r.resume(); resolve(r.statusCode); });
    req.on('error', () => {});
    req.flushHeaders();
  });
  assert.equal(declared, 413);
  // Chunked, no length: the server answers 413 while the client still has data left to send.
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const total = 40; // 40 MB offered, limit 25 MB
  const result = await new Promise((resolve) => {
    let sent = 0;
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/chat', method: 'POST',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (r) => {
      r.resume();
      resolve({ status: r.statusCode, sentWhenAnswered: sent });
    });
    req.on('error', () => resolve({ status: 'reset', sentWhenAnswered: sent }));
    const pump = () => {
      while (sent < total) {
        sent++;
        if (!req.write(chunk)) return req.once('drain', pump);
      }
      req.end();
    };
    req.write('{"text":"');
    pump();
  });
  const r = /** @type {any} */ (result);
  assert.ok(r.status === 413 || r.status === 'reset', String(r.status));
  assert.ok(r.sentWhenAnswered < total, `the server read all ${total} MB before refusing`);
  assert.equal(asked.length, 0);
  // The server is still fine afterwards.
  assert.equal((await chat(srv.url, { text: 'still here?' })).status, 200);
  await srv.close();
});

test('one chat at a time per map (409); a throw or a missing engine.ask becomes an error item', async () => {
  /** @type {() => void} */ let release = () => {};
  const gate = new Promise((r) => { release = () => r(undefined); });
  const slow = await boot(async function* () { yield { type: 'status', text: 'Thinking…' }; await gate; yield { type: 'done', msgId: 'm' }; });
  const first = chat(slow.srv.url, { text: 'one' });
  await new Promise((r) => setTimeout(r, 100));
  const second = await chat(slow.srv.url, { text: 'two' });
  assert.equal(second.status, 409);
  assert.match(JSON.parse(second.text).error, /already being written/);
  release();
  assert.deepEqual(items((await first).text).map((i) => i.type), ['status', 'done']);
  assert.equal((await chat(slow.srv.url, { text: 'three' })).status, 200, 'free again after the first finished');
  await slow.srv.close();

  const throws = await boot(async function* () { throw Object.assign(new Error('401'), { status: 401 }); });
  assert.deepEqual(items((await chat(throws.srv.url, { text: 'x' })).text),
    [{ type: 'error', error: 'Your Anthropic API key was rejected: run ontologizer key set' }]);
  await throws.srv.close();

  const store = openStore(tempHome());
  store.importEvents('plastic-modeling', fixtureEvents('plastic-modeling'));
  const noAsk = await startServer({ store, engine: { enqueue: () => 'j' }, id: 'plastic-modeling' });
  assert.deepEqual(items((await chat(noAsk.url, { text: 'x' })).text), [{ type: 'error', error: 'chat: not built yet' }]);
  await noAsk.close();
});

test('closing the page aborts the answer (the engine gets an aborted signal)', async () => {
  /** @type {AbortSignal|null} */ let seen = null;
  const { srv } = await boot(async function* (_i, /** @type {any} */ o) {
    seen = o.signal;
    yield { type: 'delta', text: 'a' };
    await new Promise((r) => o.signal.addEventListener('abort', r));
    yield { type: 'error', error: 'Stopped.' };
  });
  const ctl = new AbortController();
  const r = await fetch(new URL('api/chat', srv.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }), signal: ctl.signal });
  const reader = /** @type {any} */ (r.body).getReader();
  await reader.read();
  ctl.abort();
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(/** @type {any} */ (seen)?.aborted, true);
  await srv.close();
});

// ---- review fixes ----
import { MAX_IMAGE, MAX_IMAGES, MAX_TEXT } from '../../src/server/chat.js';

test('the limits agree: four max-size images plus the longest text fit under the body cap', async () => {
  const { srv, asked } = await boot();
  const big = Buffer.concat([PNG(2, 2), Buffer.alloc(MAX_IMAGE - 33)]); // exactly 5 MB
  assert.equal(big.length, MAX_IMAGE);
  const body = JSON.stringify({ text: 'é'.repeat(MAX_TEXT), images: Array(MAX_IMAGES).fill({ mime: 'image/png', data: big.toString('base64') }) });
  assert.ok(body.length <= MAX_BODY, `${body.length} > ${MAX_BODY}`);
  const r = await chat(srv.url, body);
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(asked[0].images.length, 4);
  // Planted fault: the old 25 MB cap was smaller than this body.
  assert.ok(body.length > 25 * 1024 * 1024);
  await srv.close();
});

test('409 and 415 drain the body first, so the browser gets the JSON message (not a dropped connection)', async () => {
  /** @type {() => void} */ let release = () => {};
  const gate = new Promise((r) => { release = () => r(undefined); });
  const { srv } = await boot(async function* () { await gate; yield { type: 'done', msgId: 'm' }; });
  const first = chat(srv.url, { text: 'one' });
  await new Promise((r) => setTimeout(r, 100));
  const img = Buffer.concat([PNG(1, 1), Buffer.alloc(2 * 1024 * 1024)]).toString('base64'); // a ~2.7 MB body
  const busy = await chat(srv.url, { text: 'two', images: [{ mime: 'image/png', data: img }] });
  assert.equal(busy.status, 409);
  assert.match(JSON.parse(busy.text).error, /already being written/);
  const wrongType = await chat(srv.url, JSON.stringify({ text: 'x', pad: 'y'.repeat(1024 * 1024) }), { 'content-type': 'text/plain' });
  assert.equal(wrongType.status, 415);
  assert.match(JSON.parse(wrongType.text).error, /application\/json/);
  release();
  await first;
  await srv.close();
});

test('an engine that ends without done or error still ends the stream with an error item', async () => {
  const { srv } = await boot(async function* () { yield { type: 'delta', text: 'half' }; });
  const got = items((await chat(srv.url, { text: 'x' })).text);
  assert.deepEqual(got, [{ type: 'delta', text: 'half' }, { type: 'error', error: 'No answer.' }]);
  // Planted fault: without the guard, the stream would end on the delta with no final item.
  assert.notEqual(['delta'].at(-1), 'error');
  await srv.close();
});

test('an engine that stalls (ignoring the signal) is stopped by the idle and total timeouts, and the lock is freed', async () => {
  const store = openStore(tempHome());
  store.importEvents('plastic-modeling', fixtureEvents('plastic-modeling'));
  // Stalls forever after one item, ignoring the abort signal.
  const stall = { enqueue: () => 'j', ask: async function* () { yield { type: 'status', text: 'Thinking…' }; await new Promise(() => {}); } };
  const srv = await startServer({ store, engine: stall, id: 'plastic-modeling', chatTimeouts: { idleMs: 200, totalMs: 10_000 } });
  const t = Date.now();
  const got = items((await chat(srv.url, { text: 'x' })).text);
  assert.ok(Date.now() - t < 3000);
  assert.deepEqual(got.map((i) => i.type), ['status', 'error']);
  assert.match(got[1].error, /took too long/);
  assert.equal((await chat(srv.url, { text: 'again' })).status, 200, 'the lock was released');
  await srv.close();
  // Total cap: an engine that trickles items forever is stopped at totalMs.
  const trickle = { enqueue: () => 'j', ask: async function* () { for (;;) { await new Promise((r) => setTimeout(r, 50)); yield { type: 'delta', text: '.' }; } } };
  const srv2 = await startServer({ store, engine: trickle, id: 'plastic-modeling', chatTimeouts: { idleMs: 1000, totalMs: 400 } });
  const t2 = Date.now();
  const got2 = items((await chat(srv2.url, { text: 'x' })).text);
  assert.ok(Date.now() - t2 < 3000);
  assert.match(got2.at(-1).error, /took too long/);
  await srv2.close();
  // Planted fault: with no timeout, the stalled engine never finishes (checked over 300 ms).
  const raw = stall.ask()[Symbol.asyncIterator]();
  await raw.next();
  assert.equal(await Promise.race([raw.next().then(() => 'done'), new Promise((r) => setTimeout(() => r('stuck'), 300))]), 'stuck');
});

test('a disk error saving an image is a 500 (not a 400), and leaves no temp file', async () => {
  const { home, srv } = await boot();
  fs.writeFileSync(path.join(home, 'plastic-modeling', 'attachments'), 'a file where the folder should be');
  const r = await chat(srv.url, { text: 'x', images: [{ mime: 'image/png', data: PNG(1, 1).toString('base64') }] });
  assert.equal(r.status, 500);
  assert.equal(JSON.parse(r.text).error, 'Could not save the image.');
  assert.ok(!fs.readdirSync(path.join(home, 'plastic-modeling')).some((f) => f.endsWith('.tmp')));
  await srv.close();
});

test('text length counts characters, not UTF-16 units; attachments carry a sandboxing CSP', async () => {
  const { srv } = await boot();
  assert.equal((await chat(srv.url, { text: '😀'.repeat(MAX_TEXT) })).status, 200); // 8000 code units
  assert.equal((await chat(srv.url, { text: '😀'.repeat(MAX_TEXT + 1) })).status, 400);
  const gif = GIF(1, 1);
  await chat(srv.url, { text: 'x', images: [{ mime: 'image/gif', data: gif.toString('base64') }] });
  const hash = crypto.createHash('sha256').update(gif).digest('hex');
  /** @type {any} */ const got = await rawGet(srv.url, `/api/attachments/${hash}`);
  assert.equal(got.headers['content-security-policy'], "sandbox; default-src 'none'");
  await srv.close();
});
