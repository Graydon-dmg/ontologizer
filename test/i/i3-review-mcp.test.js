// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// I3 review fixes: the in-process MCP server signs in, jobs end with the session and say so, the
// read-only hint never sits on a model call, the snapshot resource is the filtered read, --url
// refuses a token in clear, and the build timeout aborts only its own build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startInProcess, urlProblem, tokenFileWarning } from '../../src/cli/commands/mcp.js';
import { createMcpServer, loopbackCaller, toolList, MCP_OPS } from '../../src/server/mcp.js';
import { agentMap } from '../../src/server/reads.js';
import { startService, STOPPED } from '../../src/server/service.js';
import { makeDeps } from '../../src/cli/deps.js';
import { complete } from '../../src/cli/complete.js';
import { openStore } from '../../src/core/store.js';
import { OPS } from '../../src/ops.js';
import { boot, req, seed, stubEngine, tempHome } from './helpers-service.js';

const CLI = fileURLToPath(new URL('../../src/cli/index.js', import.meta.url));
const ENV = { ...process.env, ONTOLOGIZER_ENGINE: 'stub', ONTOLOGIZER_KEYRING: 'none', ONTOLOGIZER_NO_UPDATE_CHECK: '1' };
delete ENV.ANTHROPIC_API_KEY; delete ENV.ONTOLOGIZER_CONFIG;

function sink() { return { out: '', write(/** @type {string} */ s) { this.out += s; return true; } }; }
/** An MCP client on a protocol server over `call`. @param {any} call */
async function clientOn(call) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ call, version: 'test' });
  await server.connect(a);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(b);
  return { c, close: async () => { await c.close(); await server.close(); } };
}
/** Every file under a folder, as text. @param {string} dir @returns {string} */
const allText = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile()).map((d) => fs.readFileSync(path.join(d.parentPath ?? /** @type {any} */ (d).path, d.name), 'utf8')).join('\n');

// ---------- 1. the in-process server requires its own token ----------
test('in-process mcp: a request without its in-memory token gets 401; the MCP tools still work; the token is never written or printed', async () => {
  const home = tempHome();
  const stderr = sink();
  const deps = makeDeps({ env: { ...ENV, ONTOLOGIZER_HOME: home }, stderr, home });
  const { srv, call } = await startInProcess({ home, deps, version: 'test' });
  try {
    assert.equal(srv.tokensLoaded, true, 'the server requires a token');
    await seed(home, 'default', 'plastic-modeling');
    // any other program on this machine that finds the port
    for (const p of ['/v1/t/default/maps', '/v1/t/default/maps/plastic-modeling/snapshot', '/v1/t/default/status']) {
      assert.equal((await req(srv.url, p)).status, 401, p);
    }
    assert.equal((await req(srv.url, '/v1/t/default/maps', { method: 'POST', body: { brief: { context: 'x', subject: 'x' } } })).status, 401);
    const session = await req(srv.url, '/v1/session');
    assert.ok(session.status === 401 || session.json().open === false, `not open: ${session.status} ${session.body}`);
    // the agent's own tools carry the token
    const { c, close } = await clientOn(call);
    try {
      const list = /** @type {any} */ (await c.callTool({ name: 'list_maps', arguments: {} }));
      assert.ok(!list.isError, JSON.stringify(list.content));
      assert.ok(list.structuredContent.maps.some((/** @type {any} */ m) => m.id === 'plastic-modeling'));
      const outline = /** @type {any} */ (await c.callTool({ name: 'get_outline', arguments: { id: 'plastic-modeling' } }));
      assert.ok(!outline.isError && /Plastic modeling/.test(outline.content[0].text));
    } finally { await close(); }
  } finally { await srv.close(); }
  assert.ok(!fs.existsSync(path.join(home, 'tokens.json')), 'no tokens file');
  assert.ok(!/ont_[A-Za-z0-9_-]{20,}/.test(allText(home)), 'no token in the home');
  assert.ok(!/ont_[A-Za-z0-9_-]{20,}/.test(stderr.out), 'no token on stderr');
});

test('in-process mcp: --build-timeout reaches the server (a slow stub build times out); a bad value exits 1', async () => {
  const home = tempHome();
  const deps = makeDeps({ env: { ...ENV, ONTOLOGIZER_HOME: home }, stderr: sink(), home });
  const prevSpeed = process.env.ONTOLOGIZER_STUB_SPEED;
  process.env.ONTOLOGIZER_STUB_SPEED = '10'; // the stub's build takes 2.5 s: past the 200 ms timeout
  const { srv, call } = await startInProcess({ home, deps, version: 'test', buildTimeoutMs: 200 });
  const { c, close } = await clientOn(call);
  try {
    const built = /** @type {any} */ (await c.callTool({ name: 'build_map', arguments: { brief: { context: 'slow', subject: 'slow' } } }));
    assert.ok(!built.isError, JSON.stringify(built.content));
    const w = /** @type {any} */ (await c.callTool({ name: 'wait_for_map', arguments: { id: built.structuredContent.id, timeout: 5000 } }));
    assert.match(String(w.structuredContent.error), /^Timed out after/);
  } finally {
    await close(); await srv.close();
    if (prevSpeed === undefined) delete process.env.ONTOLOGIZER_STUB_SPEED; else process.env.ONTOLOGIZER_STUB_SPEED = prevSpeed;
  }
  for (const v of ['0', '1441', '1.5']) {
    const r = spawnSync(process.execPath, [CLI, 'mcp', '--home', tempHome(), '--build-timeout', v], { env: ENV, input: '', encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 1, `${v}: ${r.stderr}`);
    assert.match(r.stderr, /--build-timeout must be a whole number of minutes from 1 to 1440/);
    assert.equal(r.stdout, '');
  }
  assert.deepEqual(complete(['mcp', '--b']), ['--build-timeout']);
  assert.deepEqual(complete(['mcp', '--allow']), ['--allow-http']);
});

// ---------- 2. jobs end with the session, and say so ----------
test('closing the server marks its running and queued builds and jobs failed ("Stopped: the server ended"); a later wait reports it', async () => {
  const home = tempHome();
  await seed(home, 'default', 'plastic-modeling');
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, tokensFile: null, version: 'test', maxBuilds: 1,
    makeEngine: async (/** @type {any} */ x) => {
      const e = stubEngine(x);
      return { ...e,
        build: () => new Promise(() => {}), // never returns
        enqueue(/** @type {any} */ job) {
          const info = { id: 'job-hang', kind: job.kind, nodeId: job.nodeId };
          x.store.append(x.id, { t: 'job.queued', at: x.store.now(x.id), job: info });
          x.store.append(x.id, { t: 'job.started', at: x.store.now(x.id), job: info });
          return info.id; // never done
        } };
    },
  });
  const post = (/** @type {string} */ n) => req(srv.url, '/v1/t/default/maps', { method: 'POST', body: { brief: { context: n, subject: n }, name: n } });
  let running; let queued;
  try {
    running = (await post('one')).json().id;
    queued = (await post('two')).json().id; // one slot: this one waits
    const nodeId = Object.keys(openStore(home).read('plastic-modeling').nodes)[1];
    const r = await req(srv.url, '/v1/t/default/maps/plastic-modeling/actions', { method: 'POST', body: { type: 'explain', nodeId } });
    assert.ok(r.status === 200 || r.status === 202, `${r.status} ${r.body}`);
    const w0 = (await req(srv.url, `/v1/t/default/maps/${running}/wait?timeout=0`)).json();
    assert.equal(w0.state, 'busy');
  } finally { await srv.close(); }

  const again = await startService({ home, host: '127.0.0.1', port: 0, tokensFile: null, version: 'test', makeEngine: async (/** @type {any} */ x) => stubEngine(x) });
  try {
    for (const id of [running, queued]) {
      const w = (await req(again.url, `/v1/t/default/maps/${id}/wait?timeout=0`)).json();
      assert.deepEqual({ state: w.state, error: w.error }, { state: 'idle', error: STOPPED }, id);
    }
    const jobs = (await req(again.url, '/v1/t/default/maps/plastic-modeling/snapshot')).json().jobs;
    assert.equal(jobs['job-hang']?.state, 'failed');
    assert.equal(jobs['job-hang']?.error, STOPPED);
  } finally { await again.close(); }
});

// ---------- 3. readOnlyHint never on a model call ----------
test('every tool that calls the model has readOnlyHint false (planted fault: check_context marked read-only)', () => {
  /** @param {typeof OPS} ops */
  const problems = (ops) => ops.filter((o) => o.mcp && o.callsModel && o.mcp.annotations?.readOnlyHint !== false).map((o) => o.name);
  assert.deepEqual(problems(OPS), []);
  assert.equal(toolList().find((t) => t.name === 'check_context')?.annotations?.readOnlyHint, false);
  const planted = OPS.map((o) => (o.name === 'check_context' ? { ...o, mcp: { .../** @type {any} */ (o.mcp), annotations: { ...o.mcp?.annotations, readOnlyHint: true } } } : o));
  assert.deepEqual(problems(planted), ['check_context']);
  assert.ok(MCP_OPS.some((o) => o.callsModel), 'the check is not empty');
});

// ---------- 4. the snapshot resource is the filtered read ----------
test('the map resource is the read tools\' filtered map: no chat, no jobs, escaped; never the raw snapshot', async () => {
  const { srv, secrets, home, origin } = await boot({ tokens: [{ name: 'agent', scopes: ['read'] }] });
  try {
    await seed(home, 'default', 'plastic-modeling');
    const store = openStore(home);
    store.append('plastic-modeling', { t: 'job.queued', at: store.now('plastic-modeling'), job: { id: 'job-x', kind: 'explain', nodeId: 'x' } });
    store.append('plastic-modeling', { t: 'chat.asked', at: store.now('plastic-modeling'), chatId: 'main', msgId: 'm1', text: 'secret question', images: [] });
    await store.flush?.('plastic-modeling');
    const call = loopbackCaller({ host: '127.0.0.1', port: srv.port, headers: { host: `127.0.0.1:${srv.port}`, authorization: `Bearer ${secrets.agent}` } });
    const { c, close } = await clientOn(call);
    try {
      const { resources } = await c.listResources();
      const res = /** @type {any} */ (resources.find((x) => x.uri.endsWith('/maps/plastic-modeling/snapshot')));
      const got = JSON.parse(/** @type {string} */ ((await c.readResource({ uri: res.uri })).contents[0].text));
      const raw = (await req(origin, '/v1/t/default/maps/plastic-modeling/snapshot', { headers: { authorization: `Bearer ${secrets.agent}` } })).json();
      assert.ok(Object.keys(raw.jobs).length > 0 && raw.chat.length > 0, 'the raw snapshot has jobs and chat (the test plants them)');
      assert.deepEqual(got.jobs, {});
      assert.deepEqual(got.chat, []);
      assert.ok(got.root && Object.keys(got.nodes).length > 0);
      assert.deepEqual(got, JSON.parse(JSON.stringify(agentMap(raw))), 'the same allow-list and escaping as the read tools');
      await assert.rejects(c.readResource({ uri: 'ontologizer://other/maps/plastic-modeling/snapshot' }), /not found/);
    } finally { await close(); }
  } finally { await srv.close(); }
});

// ---------- 5. --url and the token file ----------
test('--url refuses http:// to another host without --allow-http; a readable token file warns', () => {
  assert.equal(urlProblem(new URL('http://127.0.0.1:8787'), false), null);
  assert.equal(urlProblem(new URL('http://localhost:8787'), false), null);
  assert.equal(urlProblem(new URL('http://[::1]:8787'), false), null);
  assert.equal(urlProblem(new URL('https://maps.example.com'), false), null);
  assert.match(String(urlProblem(new URL('http://maps.example.com'), false)), /Refusing http:\/\/maps\.example\.com.*--allow-http/);
  assert.equal(urlProblem(new URL('http://maps.example.com'), true), null);
  assert.match(String(urlProblem(new URL('ftp://x'), true)), /must start with http/);

  const dir = tempHome();
  const file = path.join(dir, 'agent.token');
  fs.writeFileSync(file, 'ont_x\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  assert.equal(tokenFileWarning(file, 'darwin'), null);
  fs.chmodSync(file, 0o644);
  assert.match(String(tokenFileWarning(file, 'darwin')), /can be read by other users \(mode 644\): run chmod 600/);
  assert.equal(tokenFileWarning(file, 'win32'), null);

  const r = spawnSync(process.execPath, [CLI, 'mcp', '--url', 'http://maps.example.com', '--token-file', file], { env: ENV, input: '', encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /can be read by other users/);
  assert.match(r.stderr, /Refusing http:\/\/maps\.example\.com/);
  assert.equal(r.stdout, '');
  assert.ok(!r.stderr.includes('ont_x'), 'the token is never printed');
});

// ---------- 6. the build timeout aborts only its own build ----------
test('a build timeout aborts that build\'s model calls, not a call made outside it (a chat) on the same engine (planted fault: one signal per engine)', async () => {
  const home = tempHome();
  /** @type {Array<{ tag: string, signal: AbortSignal|undefined }>} */
  const calls = [];
  /** @type {any} */
  let client = null;
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, tokensFile: null, version: 'test', buildTimeoutMs: 150,
    makeEngine: async (/** @type {any} */ x) => {
      client = x.meter({ messages: { stream: (/** @type {any} */ p, /** @type {any} */ opts) => {
        calls.push({ tag: p.tag, signal: opts?.signal });
        return { [Symbol.asyncIterator]: async function* () {}, on() {}, finalMessage: async () => ({ usage: {} }) };
      } } });
      const e = stubEngine(x);
      return { ...e, async build() { client.messages.stream({ tag: 'build' }); await new Promise(() => {}); } };
    },
  });
  try {
    const id = (await req(srv.url, '/v1/t/default/maps', { method: 'POST', body: { brief: { context: 'a', subject: 'a' }, name: 'a' } })).json().id;
    for (let i = 0; i < 50 && !calls.length; i++) await new Promise((r) => setTimeout(r, 10));
    client.messages.stream({ tag: 'chat' }); // a call from outside the build (as a chat answer's is)
    const w = (await req(srv.url, `/v1/t/default/maps/${id}/wait?timeout=3000`)).json();
    assert.match(String(w.error), /^Timed out after/);
    const build = calls.find((c) => c.tag === 'build');
    const chat = calls.find((c) => c.tag === 'chat');
    assert.ok(build?.signal?.aborted, 'the build\'s call was aborted');
    assert.ok(!chat?.signal?.aborted, 'the chat\'s call was not aborted');
  } finally { await srv.close(); }
});
