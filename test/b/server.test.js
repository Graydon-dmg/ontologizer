// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../src/server/index.js';
import { fakeStore, fakeEngine } from './helpers-server.js';

const fixture = fs.readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Raw GET with an unnormalized path and optional headers. */
function raw(base, p, { method = 'GET', headers = {}, body = null } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: p, method, headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/** Read SSE data events until `n` arrived (or timeout). Returns { events, ms }. */
function readSse(base, p, n, timeoutMs = 15000, onFirstBatch = null) {
  const u = new URL(base);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const events = [];
    let buf = '';
    const req = http.get({ host: u.hostname, port: u.port, path: p }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const msg = buf.slice(0, i); buf = buf.slice(i + 2);
          if (msg.startsWith('data: ')) events.push(JSON.parse(msg.slice(6)));
        }
        if (onFirstBatch && events.length >= onFirstBatch.at) { const f = onFirstBatch.fn; onFirstBatch = null; f(); }
        if (events.length >= n) { req.destroy(); resolve({ events, ms: Date.now() - t0 }); }
      });
    });
    req.on('error', (e) => { if (events.length < n) reject(e); });
    setTimeout(() => { req.destroy(); resolve({ events, ms: Date.now() - t0 }); }, timeoutMs);
  });
}

/** Planted-fault server: SSE that sends only NEW events. */
function faultyNewOnlyServer(store) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      store.subscribe('x', (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    });
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}/`, close: () => { s.closeAllConnections(); s.close(); } }));
  });
}

async function boot(opts = {}) {
  const store = opts.store ?? fakeStore(fixture.slice(0, 5));
  const engine = fakeEngine();
  const srv = await startServer({ store, engine, id: 'demo', ...opts });
  return { store, engine, srv };
}

test('1. /api/events?from=0 sends all stored events in order, then a new one', async () => {
  const { store, srv } = await boot();
  try {
    const extra = { t: 'insight', at: 99999, text: 'live' };
    const r = await readSse(srv.url, '/api/events?from=0', 6, 5000, { at: 5, fn: () => store.append('demo', extra) });
    assert.deepEqual(r.events, [...fixture.slice(0, 5), extra]);
    const r2 = await readSse(srv.url, '/api/events?from=3', 3, 5000, { at: 2, fn: () => store.append('demo', extra) });
    assert.deepEqual(r2.events, [fixture[3], fixture[4], extra]);
  } finally { await srv.close(); }
  // planted fault: new-only handler misses stored events
  const fs2 = fakeStore(fixture.slice(0, 5));
  const bad = await faultyNewOnlyServer(fs2);
  try {
    const rr = await readSse(bad.url, '/', 6, 400, { at: 0, fn: () => {} });
    assert.notDeepEqual(rr.events.slice(0, 5), fixture.slice(0, 5), 'fault must be detectable');
  } finally { bad.close(); }
});

test('2. replay at speed 10 keeps order and takes ~span/10; send-all-at-once is rejected by the timing check', async () => {
  const span = fixture[fixture.length - 1].at - fixture[0].at;
  const expected = span / 10;
  const within = (ms) => Math.abs(ms - expected) <= expected * 0.5;
  const { srv } = await boot({ store: fakeStore(fixture), replay: { speed: 10 } });
  try {
    const r = await readSse(srv.url, '/api/events?from=0', fixture.length, 20000);
    assert.deepEqual(r.events, fixture);
    assert.ok(within(r.ms), `took ${r.ms}ms, expected about ${expected}ms`);
  } finally { await srv.close(); }
  // planted fault: no pacing (no replay option) finishes far too fast
  const fast = await boot({ store: fakeStore(fixture) });
  try {
    const r = await readSse(fast.srv.url, '/api/events?from=0', fixture.length, 20000);
    assert.equal(within(r.ms), false, 'timing check must reject unpaced delivery');
  } finally { await fast.srv.close(); }
});

test('3. unknown /api/action type returns 400 (a 202-for-anything router fails the assertion)', async () => {
  const { srv } = await boot();
  try {
    const post = (b) => raw(srv.url, '/api/action', { method: 'POST', body: b, headers: { 'Content-Type': 'application/json' } });
    const r = await post(JSON.stringify({ type: 'bogus' }));
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).ok, false);
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post('[1]')).status, 400);
    assert.equal((await post(JSON.stringify({ type: 'focus' }))).status, 400);
    assert.equal((await post(JSON.stringify({ type: 'research', nodeId: 'a', mode: 'x' }))).status, 400);
    assert.equal((await post('x'.repeat(70 * 1024))).status, 413);
    // planted fault
    const lax = http.createServer((q, s) => { s.writeHead(202); s.end('{"ok":true}'); });
    await new Promise((r2) => lax.listen(0, '127.0.0.1', r2));
    const lr = await raw(`http://127.0.0.1:${lax.address().port}/`, '/api/action', { method: 'POST', body: '{"type":"bogus"}' });
    assert.notEqual(lr.status, 400, 'lax router is detected as not returning 400');
    lax.close();
  } finally { await srv.close(); }
});

test('4. actions map to view.changed patches; research enqueues with priority 10', async () => {
  const { store, engine, srv } = await boot();
  try {
    const post = (o) => raw(srv.url, '/api/action', { method: 'POST', body: JSON.stringify(o) });
    const last = () => store.log[store.log.length - 1];
    assert.equal((await post({ type: 'collapse', nodeId: 'a' })).status, 202);
    assert.equal(last().t, 'view.changed');
    assert.deepEqual(last().patch, { collapsed: ['a'] });
    await post({ type: 'collapse', nodeId: 'b' });
    assert.deepEqual(last().patch, { collapsed: ['a', 'b'] });
    await post({ type: 'expand', nodeId: 'a' });
    assert.deepEqual(last().patch, { collapsed: ['b'] });
    await post({ type: 'focus', nodeId: 'n1' });
    assert.deepEqual(last().patch, { focus: 'n1' });
    await post({ type: 'layout', value: 'tree' });
    assert.deepEqual(last().patch, { layout: 'tree' });
    await post({ type: 'lens', value: null });
    assert.deepEqual(last().patch, { lens: null });
    await post({ type: 'filter', value: { maxDepth: 2 } });
    assert.deepEqual(last().patch, { filter: { maxDepth: 2 } });
    assert.equal(typeof last().at, 'number');
    const r = await post({ type: 'research', nodeId: 'n1', mode: 'general' });
    assert.equal(r.status, 202);
    assert.deepEqual(JSON.parse(r.body), { ok: true, jobId: 'job-1' });
    assert.deepEqual(engine.calls[0], { job: { kind: 'research', nodeId: 'n1', mode: 'general' }, opts: { priority: 10 } });
    const e = await post({ type: 'explain', nodeId: 'n1' });
    assert.equal(JSON.parse(e.body).jobId, 'job-2');
    assert.equal(engine.calls[1].job.kind, 'explain');
  } finally { await srv.close(); }
});

test('5. static serving, import map, traversal, Host and Origin guards', async () => {
  const web = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-'));
  fs.mkdirSync(path.join(web, 'shared')); fs.mkdirSync(path.join(web, 'shell'));
  fs.writeFileSync(path.join(web, 'index.html'), '<html><head><!--importmap--></head></html>');
  fs.writeFileSync(path.join(web, 'shared', 'importmap.json'), '{"imports":{"a":"/x.js"}}');
  fs.writeFileSync(path.join(web, 'shell', 'a.js'), 'export {}');
  const { srv } = await boot({ webDir: web });
  try {
    const home = await raw(srv.url, '/');
    assert.equal(home.status, 200);
    assert.ok(!home.body.includes('<!--importmap-->'));
    assert.ok(home.body.includes('<script type="importmap">{"imports":{"a":"/x.js"}}</script>'));
    assert.equal((await raw(srv.url, '/shell/a.js')).status, 200);
    assert.equal((await raw(srv.url, '/shell/../../package.json')).status, 404);
    assert.equal((await raw(srv.url, '/shell/%2e%2e/%2e%2e/package.json')).status, 404);
    assert.equal((await raw(srv.url, '/shell/%zz')).status, 400);
    assert.equal((await raw(srv.url, '/nope')).status, 404);
    assert.equal((await raw(srv.url, '/fixtures/plastic-modeling.events.jsonl')).status, 200);
    assert.equal((await raw(srv.url, '/src/core/events.js')).status, 200);
    const v = await raw(srv.url, '/vendor/d3-force/dist/d3-force.mjs');
    assert.equal(v.status, 200);
    assert.match(v.headers['content-type'], /javascript/);
    assert.equal((await raw(srv.url, '/vendor/d3-force/../../package.json')).status, 404);
    assert.equal((await raw(srv.url, '/', { headers: { Host: 'evil.com' } })).status, 403);
    const body = JSON.stringify({ type: 'focus', nodeId: 'a' });
    assert.equal((await raw(srv.url, '/api/action', { method: 'POST', body, headers: { Origin: 'http://evil.com' } })).status, 403);
    const port = new URL(srv.url).port;
    assert.equal((await raw(srv.url, '/api/action', { method: 'POST', body, headers: { Origin: `http://localhost:${port}` } })).status, 202);
  } finally { await srv.close(); }
});

test('6. close() removes the sessions entry (and start recorded it)', async () => {
  const store = fakeStore();
  const srv = await startServer({ store, engine: fakeEngine(), id: 'demo' });
  assert.equal(store.sessionMap.demo.port, Number(new URL(srv.url).port));
  assert.equal(store.sessionMap.demo.pid, process.pid);
  const sse = readSse(srv.url, '/api/events?from=0', 1, 300);
  await sse;
  await srv.close();
  assert.equal('demo' in store.sessionMap, false);
  assert.equal(store.subscriberCount(), 0, 'SSE subscriptions cleaned up');
});
