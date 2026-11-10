// @ts-check
// W3: MCP tools over the router's one security path. Each check is a function that returns problems,
// and each test feeds it a planted fault first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, toolList, MCP_OPS, loopbackCaller, collectChat } from '../../src/server/mcp.js';
import { OPS, COST_NOTE, opByName } from '../../src/ops.js';
import { openStore } from '../../src/core/store.js';
import { boot, req, seed } from './helpers-service.js';

process.env.ONTOLOGIZER_STUB_SPEED = '200'; // the stub engine builds fast
const TOOLS = ['check_context', 'build_map', 'wait_for_map', 'list_maps', 'get_outline', 'search_map', 'get_node', 'research',
  'explain', 'sources', 'ask_map', 'fuse', 'rosetta', 'save_map', 'get_context', 'export_map'];

/** @param {string} origin @param {string} [token] */
async function connect(origin, token) {
  const client = new Client({ name: 'test', version: '1' });
  const t = new StreamableHTTPClientTransport(new URL(`${origin}/v1/mcp`), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {});
  await client.connect(t);
  return client;
}
/** @param {any} r */
const text = (r) => r.content.map((/** @type {any} */ c) => c.text).join('');

// ---------- 1. the tool list ----------
/** Problems in a tool list against the op list. @param {Array<{ name: string, description?: string, inputSchema?: any }>} tools @param {typeof OPS} ops */
export function toolProblems(tools, ops = OPS) {
  /** @type {string[]} */
  const p = [];
  const names = tools.map((t) => t.name);
  if (JSON.stringify([...names].sort()) !== JSON.stringify([...TOOLS].sort())) p.push(`tool names are ${names.join(',')}`);
  for (const t of tools) {
    const op = ops.find((o) => o.mcp?.name === t.name);
    if (!op) { p.push(`${t.name} has no op`); continue; }
    const ends = (t.description ?? '').endsWith(COST_NOTE);
    if (op.callsModel && !ends) p.push(`${t.name} calls the model but its description lacks the cost line`);
    if (!op.callsModel && (t.description ?? '').includes(COST_NOTE)) p.push(`${t.name} carries the cost line but does not call the model`);
    if (t.inputSchema?.properties?.tenant || (t.inputSchema?.required ?? []).includes('tenant')) p.push(`${t.name} asks for a tenant`);
  }
  return p;
}

test('tools/list is the 16 contract tools, each with an op, the cost line only on model calls', async () => {
  const { srv, origin } = await boot();
  const c = await connect(origin);
  try {
    const { tools } = await c.listTools();
    assert.deepEqual(toolProblems(tools), []);
    assert.equal(MCP_OPS.length, 16);
    assert.deepEqual(toolProblems(toolList()), []);
    // planted: an extra tool with no op
    assert.ok(toolProblems([...tools, { name: 'drop_everything', description: 'x' }]).some((x) => /drop_everything has no op/.test(x)));
    // planted: a model-calling tool without the line
    assert.ok(toolProblems(tools.map((t) => (t.name === 'build_map' ? { ...t, description: (t.description ?? '').replace(COST_NOTE, '') } : t)))
      .some((x) => /build_map calls the model but/.test(x)));
    // planted: the line on a tool that does not call the model
    assert.ok(toolProblems(tools.map((t) => (t.name === 'get_outline' ? { ...t, description: `${t.description} ${COST_NOTE}` } : t)))
      .some((x) => /get_outline carries/.test(x)));
  } finally { await c.close(); await srv.close(); }
});

// ---------- 2. one security path ----------
/**
 * What MCP and HTTP each said for the same read: problems when they differ.
 * @param {{ isError?: boolean, text: string }} mcp @param {{ status: number, error?: string, body?: string }} http
 */
export function samePathProblems(mcp, http) {
  /** @type {string[]} */
  const p = [];
  if (http.status === 200) {
    if (mcp.isError) p.push(`HTTP gave the map but MCP said: ${mcp.text}`);
    else if (mcp.text !== http.body) p.push('MCP and HTTP bodies differ');
  } else {
    if (!mcp.isError) p.push(`MCP answered but HTTP said ${http.status} ${http.error}`);
    // The server's own words come first (then what to call next), so not-found reads as over HTTP.
    else if (!mcp.text.startsWith(String(http.error))) p.push(`MCP said "${mcp.text}", HTTP said "${http.error}"`);
  }
  return p;
}

test('a reader\'s get_outline on a private map is the same not-found as HTTP; the admin gets the outline', async () => {
  const { srv, origin, home, secrets } = await boot({ tokens: [{ name: 'boss', scopes: ['read', 'build', 'admin'] }, { name: 'reader', scopes: ['read'] }] });
  const store = openStore(home, {});
  await seed(home, 'default', 'secret-map');
  store.append('secret-map', { t: 'visibility.raised', at: 1, to: 'private', reason: 'source', sources: ['wiki'] });
  const reader = await connect(origin, secrets.reader);
  const boss = await connect(origin, secrets.boss);
  try {
    const viaHttp = async (/** @type {string} */ tok) => {
      const r = await req(origin, '/v1/t/default/maps/secret-map/outline', { headers: { authorization: `Bearer ${tok}` } });
      return { status: r.status, body: r.body, error: r.status === 200 ? undefined : r.json().error };
    };
    const read = /** @type {any} */ (await reader.callTool({ name: 'get_outline', arguments: { id: 'secret-map' } }));
    const h = await viaHttp(secrets.reader);
    assert.equal(h.status, 404);
    assert.equal(h.error, 'not found');
    assert.equal(read.isError, true);
    assert.deepEqual(samePathProblems({ isError: read.isError, text: text(read) }, h), []);
    // Hidden and missing read exactly the same over MCP too, hint included.
    const gone = /** @type {any} */ (await reader.callTool({ name: 'get_outline', arguments: { id: 'no-such-map' } }));
    assert.equal(text(read), text(gone));
    const adm = /** @type {any} */ (await boss.callTool({ name: 'get_outline', arguments: { id: 'secret-map' } }));
    assert.ok(!adm.isError);
    assert.deepEqual(samePathProblems({ isError: adm.isError, text: text(adm) }, await viaHttp(secrets.boss)), []);
    assert.match(text(adm), /\(/);
    // planted: a tool that calls the store directly, ignoring credentials
    const faultyCall = async (/** @type {any} */ op, /** @type {any} */ input) => {
      if (op.name === 'get_session') return { status: 200, type: 'application/json', text: JSON.stringify({ tenant: 'default' }), headers: {} };
      const snap = openStore(home, {}).read(input.id);
      return { status: 200, type: 'text/markdown', text: JSON.stringify(snap.root), headers: {} };
    };
    const [a, b] = InMemoryTransport.createLinkedPair();
    const faulty = createMcpServer({ call: faultyCall });
    await faulty.connect(b);
    const fc = new Client({ name: 'f', version: '1' });
    await fc.connect(a);
    const leak = /** @type {any} */ (await fc.callTool({ name: 'get_outline', arguments: { id: 'secret-map' } }));
    const problems = samePathProblems({ isError: leak.isError, text: text(leak) }, h);
    assert.ok(problems.some((x) => /MCP answered but HTTP said 404/.test(x)), `the faulty tool must be reported: ${problems}`);
    await fc.close(); await faulty.close();
  } finally { await reader.close(); await boss.close(); store.close?.(); await srv.close(); }
});

// ---------- 3. auth ----------
/** Problems in what a caller does with the incoming headers: an answer that is not the caller's own. @param {{ isError?: boolean, text: string }} r @param {string} want */
export function callerAnswerProblems(r, want) {
  /** @type {string[]} */
  const p = [];
  if (!r.isError) p.push('expected an error result');
  if (!r.text.startsWith(want)) p.push(`expected "${want}" but got "${r.text}"`);
  return p;
}

test('MCP over HTTP: no token 401, a read token\'s build_map is refused like HTTP, a foreign Origin 403', async () => {
  const { srv, origin, secrets } = await boot({ tokens: [{ name: 'reader', scopes: ['read'] }] });
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const hdr = { accept: 'application/json, text/event-stream' };
  const c = await connect(origin, secrets.reader);
  try {
    const none = await req(origin, '/v1/mcp', { method: 'POST', body: rpc, headers: hdr });
    assert.equal(none.status, 401);
    assert.match(String(none.headers['www-authenticate']), /Bearer/);
    const foreign = await req(origin, '/v1/mcp', { method: 'POST', body: rpc, headers: { ...hdr, authorization: `Bearer ${secrets.reader}`, origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403);
    const direct = await req(origin, '/v1/t/default/maps', { method: 'POST', body: { brief: { context: 'x' } }, headers: { authorization: `Bearer ${secrets.reader}` } });
    assert.equal(direct.status, 403);
    assert.match(direct.json().error, /build scope/);
    const r = /** @type {any} */ (await c.callTool({ name: 'build_map', arguments: { brief: { context: 'x' } } }));
    assert.deepEqual(callerAnswerProblems({ isError: r.isError, text: text(r) }, direct.json().error), []);
    // planted: a caller that drops the incoming headers reaches the router without credentials
    const bare = loopbackCaller({ host: '127.0.0.1', port: srv.port, headers: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const s = createMcpServer({ call: bare });
    await s.connect(b);
    const bc = new Client({ name: 'b', version: '1' });
    await bc.connect(a);
    const dropped = /** @type {any} */ (await bc.callTool({ name: 'build_map', arguments: { brief: { context: 'x' } } }));
    const problems = callerAnswerProblems({ isError: dropped.isError, text: text(dropped) }, direct.json().error);
    assert.ok(problems.length > 0, 'a caller without the headers must be reported');
    assert.match(text(dropped), /Sign in|token/i);
    await bc.close(); await s.close();
  } finally { await c.close(); await srv.close(); }
});

// ---------- 4. the flow, open mode ----------
test('open mode: check, build, wait, read the map through the tools and resources', async () => {
  const { srv, origin } = await boot();
  const c = await connect(origin);
  try {
    const checked = /** @type {any} */ (await c.callTool({ name: 'check_context', arguments: { context: 'plastic recycling' } }));
    assert.ok(!checked.isError, text(checked));
    assert.equal(checked.structuredContent.ready, true);
    const built = /** @type {any} */ (await c.callTool({ name: 'build_map', arguments: { brief: checked.structuredContent.brief, name: 'plastic' } }));
    assert.ok(!built.isError, text(built));
    const { id, viewUrl } = built.structuredContent;
    assert.ok(viewUrl.startsWith(`${origin}/`), `viewUrl is absolute: ${viewUrl}`);
    let state = 'busy';
    for (let i = 0; i < 40 && state !== 'idle'; i++) {
      const w = /** @type {any} */ (await c.callTool({ name: 'wait_for_map', arguments: { id, timeout: 5000 } }));
      state = w.structuredContent.state;
    }
    assert.equal(state, 'idle');
    const outline = text(await c.callTool({ name: 'get_outline', arguments: { id } }));
    assert.match(outline, /^- /m);
    const s = /** @type {any} */ (await c.callTool({ name: 'search_map', arguments: { id, q: 'plastic' } }));
    assert.ok(s.structuredContent.results.length > 0);
    const nodeId = s.structuredContent.results[0].id;
    const n = /** @type {any} */ (await c.callTool({ name: 'get_node', arguments: { id, nodeId } }));
    assert.ok(!n.isError, text(n));
    assert.ok(text(await c.callTool({ name: 'get_context', arguments: { id } })).length > 20);
    const exp = /** @type {any} */ (await c.callTool({ name: 'export_map', arguments: { id, format: 'json' } }));
    assert.ok(!exp.isError, text(exp));
    const html = /** @type {any} */ (await c.callTool({ name: 'export_map', arguments: { id, format: 'embed' } }));
    assert.ok(!html.isError && text(html).length > 100);
    const { resources } = await c.listResources();
    const res = resources.find((r) => r.uri.endsWith(`/maps/${id}/snapshot`));
    assert.ok(res, 'the map is a resource');
    assert.equal(res.mimeType, 'application/json');
    const read = await c.readResource({ uri: res.uri });
    assert.ok(JSON.parse(/** @type {string} */ (read.contents[0].text)).root);
    const { resourceTemplates } = await c.listResourceTemplates();
    assert.equal(resourceTemplates[0].uriTemplate, 'ontologizer://{tenant}/maps/{id}/snapshot');
    // another tenant's maps are refused as an MCP error
    await assert.rejects(c.readResource({ uri: `ontologizer://other/maps/${id}/snapshot` }), /not found/);
    // ask_map on the stub: an answer or a clean error result, never a crash
    const ask = /** @type {any} */ (await c.callTool({ name: 'ask_map', arguments: { id, text: 'What is this?' } }));
    assert.ok(Array.isArray(ask.content) && ask.content.length === 1);
    // an unknown tool is a tool error that lists the tools, never an exception
    const unknown = /** @type {any} */ (await c.callTool({ name: 'drop_everything', arguments: {} }));
    assert.equal(unknown.isError, true);
    assert.match(text(unknown), /^Unknown tool "drop_everything"\. The tools: list_maps/);
    // a missing map is a tool error with the server's words
    const miss = /** @type {any} */ (await c.callTool({ name: 'get_outline', arguments: { id: 'nope' } }));
    assert.equal(miss.isError, true);
    assert.match(text(miss), /^not found\. No map with that id exists that you may read\. Call list_maps/);
  } finally { await c.close(); await srv.close(); }
});

test('a 1 MB cap and invalid JSON on /v1/mcp', async () => {
  const { srv, origin } = await boot();
  try {
    const hdr = { accept: 'application/json, text/event-stream' };
    assert.equal((await req(origin, '/v1/mcp', { method: 'POST', body: '{nope', headers: hdr })).status, 400);
    assert.equal((await req(origin, '/v1/mcp', { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(1024 * 1024 + 10) }), headers: hdr })).status, 413);
    assert.equal((await req(origin, '/v1/mcp', { method: 'GET', headers: hdr })).status, 405);
  } finally { await srv.close(); }
});

test('collectChat gathers text, cited nodes, sources and the error', () => {
  const sse = (/** @type {any[]} */ items) => items.map((i) => `data: ${JSON.stringify(i)}\n\n`).join('');
  const ok = collectChat(sse([{ type: 'delta', text: 'Hello ' }, { type: 'delta', text: 'world' }, { type: 'citation', nodeId: 'n1', label: 'Node one' },
    { type: 'source', title: 'T', url: 'https://x.example' }, { type: 'done', msgId: 'm' }]));
  assert.match(ok.text, /^Hello world/);
  assert.match(ok.text, /Cited nodes:\n- Node one \(n1\)/);
  assert.match(ok.text, /Sources:\n- T: https:\/\/x.example/);
  assert.equal(ok.isError, false);
  const bad = collectChat(sse([{ type: 'error', error: 'no key' }]));
  assert.equal(bad.isError, true);
  assert.match(bad.text, /no key/);
  assert.equal(collectChat(sse([{ type: 'delta', text: 'partial' }, { type: 'error', error: 'cut' }])).isError, false);
});
