// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// The model port: clientFor gets each call's principal and purpose, and its headers reach the request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { createEngine } from '../../src/core/engine/index.js';
import { createFakeClient, createMemoryStore, lines } from '../c/fake.js';

const fixture = (/** @type {string} */ name) => readFileSync(new URL(`../../fixtures/${name}.events.jsonl`, import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const P1 = { actor: { id: 'token:one', kind: 'service' }, tenant: 't', scopes: ['admin'], sources: [] };
const P2 = { actor: { id: 'token:two', kind: 'service' }, tenant: 't', scopes: ['admin'], sources: [] };

const sysOf = (/** @type {any} */ p) => (typeof p.system === 'string' ? p.system : p.system.map((/** @type {any} */ b) => b.text).join('\n'));
const READY = { ready: true, brief: { subject: 'Glue', scope: 's', purpose: 'p', level: 'beginner' }, name: 'glue' };

/** A model that answers every purpose with valid lines. @param {any} params */
function scripted(params) {
  const sys = sysOf(params);
  const prompt = typeof params.messages[0].content === 'string' ? params.messages[0].content : '';
  if (sys.includes('four tests')) return { text: lines([READY]) };
  if (sys.includes('top-level categories')) return { text: lines([{ label: 'Types', summary: 's', hook: 'h' }]) };
  if (sys.includes('children of one category')) return { text: lines([{ label: 'Kind One', summary: 's', hook: 'h' }]) };
  if (sys.includes('hidden connections')) return { text: '' };
  if (sys.includes('explainer articles')) return { text: lines([{ summary: 'x', keyFacts: [], whyItMatters: 'm', seeAlso: [] }]) };
  if (sys.includes('best sources')) return { text: '' };
  if (sys.includes('Task: research one node') || sys.includes('reference-book picture')) return { text: lines([{ label: 'Fresh Idea', summary: 's', hook: 'h' }]) };
  if (sys.includes('You fuse two concept maps')) return { text: lines([{ name: 'mix' }, { hybrid: 'Blend', summary: 's', hook: 'h' }]) };
  if (sys.includes('You explain a field to')) {
    const ids = prompt.split('\n').filter((l) => l.includes(' | ') && !l.startsWith('Nodes,')).map((l) => l.split(' | ')[0]);
    return { text: lines(ids.map((id) => ({ id, analog: `like ${id}`, breaks: 'no' }))) };
  }
  return { text: 'An answer.' };
}

/** A port that records each call and answers from one fake client per caller (or one shared client). */
function makePort(shared = false) {
  /** @type {{ principal: any, purpose: string, client: any }[]} */ const log = [];
  /** @type {Map<string, any>} */ const clients = new Map();
  const one = createFakeClient({ respond: scripted, chunkMs: 0 });
  const port = ({ principal, purpose }) => {
    const key = principal?.actor?.id ?? 'none';
    if (!clients.has(key)) clients.set(key, shared ? one : createFakeClient({ respond: scripted, chunkMs: 0 }));
    const client = clients.get(key);
    log.push({ principal, purpose, client });
    return client;
  };
  return { port, log, clients };
}

/** Problems with how a port's clients map to callers: one client per principal, each call seen once. @param {Map<string, any>} clients */
export function isolation(clients) {
  /** @type {string[]} */ const problems = [];
  const list = [...clients.values()];
  if (new Set(list).size !== list.length) problems.push('two principals got the same client');
  return problems;
}

test('clientFor gets the run principal and the call purpose, once per model call', async () => {
  const { port, log } = makePort();
  const store = createMemoryStore();
  let n = 0;
  Object.assign(store, { createDraft: () => `draft-${++n}` });
  for (const e of fixture('plastic-modeling')) { store.append('pm', e); }
  for (const e of fixture('manga')) { store.append('manga', e); }
  const engine = createEngine({ store, id: 'pm', clientFor: port });

  /** Run one action; returns the log entries it made. @param {() => Promise<any>} act */
  const logged = async (act) => { const from = log.length; await act(); return log.slice(from); };
  /** @param {{ principal: any, purpose: string }[]} entries @param {string[]} purposes @param {any} principal */
  const problems = (entries, purposes, principal) => {
    /** @type {string[]} */ const out = [];
    if (!entries.length) out.push('no calls');
    for (const e of entries) {
      if (!purposes.includes(e.purpose)) out.push(`purpose ${e.purpose} not in ${purposes}`);
      if (e.principal !== principal) out.push(`${e.purpose}: wrong principal`);
    }
    for (const p of purposes) if (!entries.some((e) => e.purpose === p)) out.push(`purpose ${p} never asked for`);
    return out;
  };

  const checkEntries = await logged(() => engine.check('glue', [], { principal: P1 }));
  assert.deepEqual(problems(checkEntries, ['check'], P1), []);
  assert.equal(checkEntries.length, 1);

  const buildEngine = createEngine({ store: createMemoryStore(), id: 'b', clientFor: port });
  const b = await logged(() => buildEngine.build({ context: 'c', subject: 'Glue', scope: 's', purpose: 'p', level: 'beginner' }, { principal: P2 }));
  assert.deepEqual(problems(b, ['build'], P2), []);
  assert.ok(b.length >= 3);   // wave 0, wave 1, wave 2

  const NODE = 'plastic-modeling/tools/adhesives';
  for (const [kind, job] of /** @type {const} */ ([['research', { kind: 'research', nodeId: NODE, mode: 'context' }], ['explain', { kind: 'explain', nodeId: NODE }], ['sources', { kind: 'sources', nodeId: NODE }]])) {
    const e = await logged(async () => { engine.enqueue(job, { principal: P1 }); await engine.idle(); });
    assert.deepEqual(problems(e, [kind], P1), [], kind);
    assert.equal(e.length, 1, kind);
  }
  const asked = await logged(async () => { for await (const _ of engine.ask({ text: 'Which glue?' }, { principal: P2 })) { /* consume */ } });
  assert.deepEqual(problems(asked, ['ask'], P2), []);
  const fz = await logged(() => engine.fuse('pm', 'manga', { principal: P1 }));
  assert.deepEqual(problems(fz, ['fuse'], P1), []);
  const ro = await logged(() => engine.rosetta('manga', 'a home chef', { principal: P2 }));
  assert.deepEqual(problems(ro, ['rosetta'], P2), []);

  // planted fault: the wrong principal or the wrong purpose is reported
  assert.ok(problems(checkEntries, ['check'], P2).length > 0);
  assert.ok(problems(checkEntries, ['build'], P1).length > 0);
});

test('two principals get two different clients; a port that ignores the principal is caught', async () => {
  const good = makePort();
  const engine = createEngine({ store: createMemoryStore(), id: 'x', clientFor: good.port });
  await engine.check('glue', [], { principal: P1 });
  await engine.check('glue', [], { principal: P2 });
  const [a, b] = [...good.clients.values()];
  assert.equal(good.clients.size, 2);
  assert.deepEqual([a.calls.length, b.calls.length], [1, 1]);
  assert.deepEqual(isolation(good.clients), []);

  // planted fault: a port that returns one shared client for everyone
  const bad = makePort(true);
  const e2 = createEngine({ store: createMemoryStore(), id: 'x', clientFor: bad.port });
  await e2.check('glue', [], { principal: P1 });
  await e2.check('glue', [], { principal: P2 });
  assert.ok(isolation(bad.clients).length > 0);
});

// ---- headers reach the request -------------------------------------------------------------------

const sse = (/** @type {string} */ ev, /** @type {any} */ data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;

/** A loopback server that records request headers and answers /v1/messages with a streamed message. */
async function loopback() {
  /** @type {{ url: string, headers: Record<string, any> }[]} */ const requests = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ url: req.url ?? '', headers: req.headers });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }));
      res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify(READY) } }));
      res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
      res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }));
      res.write(sse('message_stop', { type: 'message_stop' }));
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { requests, url: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(() => r(undefined))); } };
}

/** Problems: each request must carry the x-caller of the principal that made it, in order. @param {{ url: string, headers: any }[]} requests @param {string[]} expected */
export function headerProblems(requests, expected) {
  /** @type {string[]} */ const problems = [];
  if (requests.length !== expected.length) problems.push(`${requests.length} requests, expected ${expected.length}`);
  expected.forEach((id, i) => {
    const got = requests[i]?.headers['x-caller'];
    if (got !== id) problems.push(`request ${i}: x-caller ${got}, expected ${id}`);
  });
  return problems;
}

test('headers the port sets reach each caller\'s request', async () => {
  const srv = await loopback();
  try {
    const port = ({ principal }) => new Anthropic({ apiKey: 'test-key', baseURL: srv.url, maxRetries: 0, defaultHeaders: { 'x-caller': principal.actor.id } });
    const engine = createEngine({ store: createMemoryStore(), id: 'h', clientFor: port });
    const r1 = await engine.check('glue', [], { principal: P1 });
    const r2 = await engine.check('glue', [], { principal: P2 });
    assert.equal(r1.ready, true);
    assert.equal(r2.ready, true);
    assert.deepEqual(srv.requests.map((r) => r.url.split('?')[0]), ['/v1/messages', '/v1/messages']);
    assert.deepEqual(headerProblems(srv.requests, ['token:one', 'token:two']), []);

    // planted fault: a port that sets no header is caught
    srv.requests.length = 0;
    const plain = ({ principal: _p }) => new Anthropic({ apiKey: 'test-key', baseURL: srv.url, maxRetries: 0 });
    const e2 = createEngine({ store: createMemoryStore(), id: 'h', clientFor: plain });
    assert.equal((await e2.check('glue', [], { principal: P1 })).ready, true);
    assert.ok(headerProblems(srv.requests, ['token:one']).length > 0);
  } finally { await srv.close(); }
});
