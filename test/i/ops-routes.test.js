// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// src/ops.js describes the router; it does not generate it. These checks keep the two in step, both
// ways: every op is served by the router, and every /v1 route the router serves has an op. Every MCP
// tool is an op, and every op with an MCP name is a tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { OPS, requestFor, pathParams } from '../../src/ops.js';
import { toolList } from '../../src/server/mcp.js';
import { boot, seed } from './helpers-service.js';

const ROOT = new URL('../../', import.meta.url);
const MAP = 'demo';
const NODE = 'plastic-modeling';

/**
 * One request; resolves at the response's headers (an event stream never ends), with the body when
 * it is not a stream. @param {string} origin @param {string} method @param {string} p @param {any} [body]
 * @returns {Promise<{ status: number, body: string }>}
 */
function probe(origin, method, p, body) {
  const u = new URL(origin);
  const data = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: u.hostname, port: u.port, path: p, method,
      headers: { accept: 'application/json, text/event-stream', ...(data !== null ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      const status = /** @type {number} */ (res.statusCode);
      if (String(res.headers['content-type'] ?? '').startsWith('text/event-stream')) { r.destroy(); resolve({ status, body: '' }); return; }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status, body: d }));
      res.on('error', () => resolve({ status, body: d }));
    });
    r.on('error', reject);
    r.setTimeout(5000, () => r.destroy(new Error(`timeout: ${method} ${p}`)));
    if (data !== null) r.write(data);
    r.end();
  });
}

/** The router's answer to a route it does not have: 404 "not found" (JSON or plain), or 405. @param {{ status: number, body: string }} r */
const missed = (r) => r.status === 405 || (r.status === 404 && /^(\{"ok":false,"error":"not found"\}|not found)$/.test(r.body.trim()));

/** Sample input for an op: valid path params on the seeded map; a body the handler rejects (400), so nothing runs. @param {import('../../src/ops.js').Op} op */
function sample(op) {
  /** @type {Record<string, any>} */
  const input = { tenant: 'default', id: MAP, nodeId: NODE, path: op.http.method === 'GET' ? 'snapshot' : 'action' };
  if (op.name === 'search_map') input.q = 'paint';
  if (op.name === 'export_map') input.format = 'json';
  if (op.name === 'wait_for_map') input.timeout = 0;
  return input;
}

/**
 * Forward: every op's method and path reaches its handler (never the router's miss).
 * @param {import('../../src/ops.js').Op[]} ops @param {string} origin
 */
async function unservedOps(ops, origin) {
  /** @type {string[]} */
  const problems = [];
  for (const op of ops) {
    const r = requestFor(op, sample(op));
    // POST bodies are left out (or empty) on purpose: the handler answers 400, so no build or job starts.
    const res = await probe(origin, r.method, r.path, r.method === 'POST' ? {} : undefined);
    if (missed(res)) problems.push(`${op.name}: ${r.method} ${r.path} is not served (${res.status} ${res.body.slice(0, 60)})`);
  }
  return problems;
}

/** Every path word the router and the map handler test for: string literals in their source. */
function routerWords() {
  const words = new Set();
  for (const file of ['src/server/service.js', 'src/server/map.js']) {
    const src = fs.readFileSync(new URL(file, ROOT), 'utf8');
    for (const m of src.matchAll(/'([a-z0-9/._-]{2,60})'/g)) {
      words.add(m[1]);
      if (m[1].startsWith('/api/')) words.add(m[1].slice(1)); // the page's routes, under a map's base
    }
    // Route names that are object keys (the /v1 aliases of the page's routes: `snapshot: '/api/snapshot'`).
    for (const m of src.matchAll(/\b([a-z]+): '\/api\//g)) words.add(m[1]);
  }
  return [...words];
}

/** @param {string} template @returns {RegExp} */
const routeRe = (template) => new RegExp(`^${template.replace(/[.]/g, '\\.').replace(/\{path\}/g, '.+').replace(/\{\w+\}/g, '[^/]+')}$`);

/**
 * Reverse: every /v1 path and method the router answers (anything but its miss) has an op.
 * @param {import('../../src/ops.js').Op[]} ops @param {string} origin @param {string[]} words
 */
async function routesWithoutOps(ops, origin, words) {
  /** @type {Set<string>} */
  const candidates = new Set();
  for (const w of words) {
    if (w.startsWith('/v1/')) { candidates.add(w.replace(/\/$/, '')); continue; }
    if (w.startsWith('/')) continue;
    for (const prefix of ['/v1/', '/v1/t/default/', '/v1/t/default/maps/', `/v1/t/default/maps/${MAP}/`, `/v1/t/default/maps/${MAP}/nodes/`]) candidates.add(`${prefix}${w}`);
  }
  /** @type {string[]} */
  const problems = [];
  for (const p of [...candidates].sort()) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await probe(origin, method, p, method === 'POST' ? {} : undefined);
      if (missed(res)) continue;
      if (!ops.some((op) => op.http.method === method && routeRe(op.http.path).test(p))) {
        problems.push(`${method} ${p} is served (${res.status}) but has no op`);
      }
    }
  }
  return problems;
}

/** Every op with an MCP name is a tool, and every tool is an op. @param {import('../../src/ops.js').Op[]} ops @param {{ name: string }[]} tools */
function toolProblems(ops, tools) {
  const want = ops.filter((o) => o.mcp).map((o) => /** @type {any} */ (o.mcp).name).sort();
  const have = tools.map((t) => t.name).sort();
  return [...want.filter((n) => !have.includes(n)).map((n) => `op tool ${n} is not offered`),
    ...have.filter((n) => !want.includes(n)).map((n) => `tool ${n} has no op`)];
}

test('every op is served by the router, and every /v1 route the router serves has an op', async () => {
  const { home, srv, origin } = await boot();
  try {
    await seed(home, 'default', MAP);
    assert.deepEqual(await unservedOps(OPS, origin), []);
    const words = routerWords();
    for (const w of ['outline', 'usage', '/v1/openapi.json', 'snapshot', 'events', 'actions', 'chat', 'api/snapshot', 'nodes', 'wait', 'save', 'view']) {
      assert.ok(words.includes(w), `the word list holds ${w}`);
    }
    assert.deepEqual(await routesWithoutOps(OPS, origin, words), []);

    // Planted fault: a route added to the router only (here: its op missing from the list) is reported.
    const withoutUsage = OPS.filter((o) => o.name !== 'get_usage');
    assert.deepEqual(await routesWithoutOps(withoutUsage, origin, ['usage']), ['GET /v1/t/default/usage is served (200) but has no op']);
    const withoutNodes = OPS.filter((o) => o.name !== 'get_node');
    assert.ok((await routesWithoutOps(withoutNodes, origin, [NODE])).some((p) => p.startsWith(`GET /v1/t/default/maps/${MAP}/nodes/${NODE}`)));
    // Planted fault: an op the router does not serve is reported.
    const ghost = { ...OPS.find((o) => o.name === 'get_outline'), name: 'get_summary', http: { method: 'GET', path: '/v1/t/{tenant}/maps/{id}/summary' } };
    assert.deepEqual((await unservedOps([/** @type {any} */ (ghost)], origin)).length, 1);
  } finally { await srv.close(); }
});

test('every op with an MCP name is a tool and every tool is an op; the contract\'s sixteen tools', () => {
  assert.deepEqual(toolProblems(OPS, toolList()), []);
  assert.deepEqual(toolList().map((t) => t.name).sort(), ['ask_map', 'build_map', 'check_context', 'explain', 'export_map', 'fuse', 'get_context',
    'get_node', 'get_outline', 'list_maps', 'research', 'rosetta', 'save_map', 'search_map', 'sources', 'wait_for_map']);
  // Planted faults: a tool with no op; an op whose tool is not offered.
  assert.deepEqual(toolProblems(OPS, [...toolList(), { name: 'delete_map' }]), ['tool delete_map has no op']);
  assert.deepEqual(toolProblems(OPS, toolList().filter((t) => t.name !== 'fuse')), ['op tool fuse is not offered']);
});

test('the op list itself: unique names, known scopes, params in every input, cost only where the model is called', () => {
  /** @param {import('../../src/ops.js').Op[]} ops */
  const listProblems = (ops) => {
    /** @type {string[]} */
    const p = [];
    const names = new Set();
    for (const op of ops) {
      if (names.has(op.name)) p.push(`${op.name}: listed twice`);
      names.add(op.name);
      if (![null, 'read', 'ask', 'build', 'admin'].includes(op.scope)) p.push(`${op.name}: scope ${op.scope}`);
      for (const param of pathParams(op.http.path)) {
        if (!op.input?.properties?.[param]) p.push(`${op.name}: {${param}} is not in its input`);
      }
      if (op.callsModel && op.scope === 'read') p.push(`${op.name}: calls the model with read scope`);
      if (op.mcp && !op.mcp.description) p.push(`${op.name}: no tool description`);
    }
    return p;
  };
  assert.deepEqual(listProblems(OPS), []);
  // Planted faults: a model call that needs only read; a path param missing from the input.
  assert.ok(listProblems([{ ...OPS[0], name: 'x', scope: 'read', callsModel: true }]).some((s) => /read scope/.test(s)));
  const outline = /** @type {any} */ (OPS.find((o) => o.name === 'get_outline'));
  assert.ok(listProblems([{ ...outline, input: { type: 'object', properties: { tenant: {} } } }]).some((s) => /\{id\} is not in its input/.test(s)));
});
