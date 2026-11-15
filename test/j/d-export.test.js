// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// D: include=hydration on the JSON export, get_node and the snapshot. Without it every output is
// byte-identical to the 1.8.0 goldens (test/j/golden/d-*), hydrated map or not. Hydrated maps are the
// fixtures plus literal node.hydrated events. Each check feeds its planted fault first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { foldAll } from '../../src/core/events.js';
import { exportMap } from '../../src/core/export/index.js';
import { stripHydration, withHydration, snapshotFor } from '../../src/core/export/hydration.js';
import { nodeForAgent } from '../../src/server/reads.js';
import { openStore } from '../../src/core/store.js';
import { main } from '../../src/cli/main.js';
import { boot, req, fixtureEvents } from '../i/helpers-service.js';

const FIXTURES = ['demo', 'manga', 'plastic-modeling'];
/** @param {string} f @param {string} surface */
const golden = (f, surface) => fs.readFileSync(new URL(`./golden/d-${f}-${surface}.json`, import.meta.url), 'utf8');
/** @param {string} f @returns {Record<string, { result: any, body: string }>} */
const nodeGolden = (f) => JSON.parse(golden(f, 'get_node')).nodes;

/** @param {string} i */
const H = (i) => ({ job: `Job ${i}`, examples: [`ex ${i} a`, `ex ${i} b`, `ex ${i} c`], not_for: `Not ${i}`, not_for_ids: [], model: 'stub', at: '2026-11-15T00:00:00.000Z' });
/** Five node ids of a fixture: the three golden get_node ids first, then others. @param {string} f */
function fiveIds(f) {
  const ids = Object.keys(nodeGolden(f));
  for (const id of Object.keys(foldAll(fixtureEvents(f)).nodes)) if (ids.length < 5 && !ids.includes(id)) ids.push(id);
  return ids;
}
/** The fixture's events plus node.hydrated on five nodes. @param {string} f */
function hydratedEvents(f) {
  const ev = fixtureEvents(f);
  const at = ev[ev.length - 1].at + 1;
  return [...ev, ...fiveIds(f).map((nodeId, i) => ({ t: 'node.hydrated', at: at + i, nodeId, hydration: H(String(i)) }))];
}

test('default outputs are byte-identical to 1.8.0, on plain and on hydrated maps', () => {
  // planted faults: a default that adds "hydration":null, or one that leaks hydration, changes the string
  const plain = foldAll(fixtureEvents('demo'));
  const nulls = { ...plain, nodes: Object.fromEntries(Object.entries(plain.nodes).map(([k, n]) => [k, { ...n, hydration: null }])) };
  assert.notEqual(JSON.stringify({ ...nulls, chat: [] }), golden('demo', 'export'));
  assert.notEqual(JSON.stringify(foldAll(hydratedEvents('demo'))), golden('demo', 'snapshot'));
  for (const f of FIXTURES) {
    for (const o of [foldAll(fixtureEvents(f)), foldAll(hydratedEvents(f))]) {
      assert.equal(exportMap(o, { format: 'json' }), golden(f, 'export'), `${f} export`);
      assert.equal(exportMap(o, { format: 'json', include: [] }), golden(f, 'export'), `${f} export include []`);
      assert.equal(JSON.stringify(snapshotFor(o, [])), golden(f, 'snapshot'), `${f} snapshot`);
      assert.equal(JSON.stringify(snapshotFor(o)), golden(f, 'snapshot'), `${f} snapshot, no include`);
      for (const [id, g] of Object.entries(nodeGolden(f))) {
        assert.equal(JSON.stringify(nodeForAgent(o, id).result), g.body, `${f} get_node ${id}`);
        assert.equal(JSON.stringify(nodeForAgent(o, id, { include: [] }).result), g.body, `${f} get_node ${id} include []`);
      }
    }
  }
});

test('callers without include (the page, MCP resources) still work: exportMap(o, { format: "json" })', () => {
  // planted fault: no default for include makes include.includes throw on undefined
  const noDefault = (/** @type {any} */ o, /** @type {any} */ { include }) => (include.includes('hydration') ? o : stripHydration(o));
  assert.throws(() => noDefault(foldAll(fixtureEvents('demo')), {}), TypeError);
  assert.equal(exportMap(foldAll(hydratedEvents('manga')), { format: 'json' }), golden('manga', 'export'));
  const plain = foldAll(fixtureEvents('manga'));
  assert.equal(withHydration(plain), plain);
  assert.equal(JSON.stringify(withHydration(foldAll(hydratedEvents('manga')))), golden('manga', 'snapshot'));
});

test('round trip with include: every hydrated node carries what was folded, no other node has the key', () => {
  for (const f of FIXTURES) {
    const ev = hydratedEvents(f);
    const o = foldAll(ev);
    const wanted = new Map(ev.filter((e) => e.t === 'node.hydrated').map((e) => [e.nodeId, e.hydration]));
    /** @param {any} out */
    const problems = (out) => {
      const p = [];
      for (const [id, n] of Object.entries(out.nodes)) {
        if (wanted.has(id)) { try { assert.deepEqual(/** @type {any} */ (n).hydration, wanted.get(id)); } catch { p.push(`${id} lost its hydration`); } }
        else if (Object.hasOwn(/** @type {any} */ (n), 'hydration')) p.push(`${id} has a hydration key`);
      }
      return p;
    };
    // planted fault: the strip on the wrong side of the condition drops every node's hydration
    assert.ok(problems(JSON.parse(JSON.stringify(stripHydration(o)))).length >= 5);
    assert.deepEqual(problems(JSON.parse(exportMap(o, { format: 'json', include: ['hydration'] }))), [], f);
    assert.deepEqual(problems(snapshotFor(o, ['hydration'])), [], f);
    assert.equal(snapshotFor(o, ['hydration']), o, 'with include the snapshot is the raw fold');
    // key order of every other field is kept
    const id = fiveIds(f)[0];
    const { hydration, ...rest } = /** @type {any} */ (o.nodes[id]); void hydration;
    assert.deepEqual(Object.keys(stripHydration(o).nodes[id]), Object.keys(rest));
    assert.deepEqual(Object.keys(stripHydration(o).nodes), Object.keys(o.nodes));
    assert.deepEqual(Object.keys(stripHydration(o)), Object.keys(o));
  }
});

test('the strip never mutates the live map, and copies nothing when no node is hydrated', () => {
  const o = foldAll(hydratedEvents('demo'));
  const ids = fiveIds('demo');
  // planted fault: a strip that deletes in place takes hydration off the live map
  const deleting = (/** @type {any} */ x) => { for (const n of Object.values(x.nodes)) delete /** @type {any} */ (n).hydration; return x; };
  const copy = structuredClone(o);
  deleting(copy);
  assert.ok(!copy.nodes[ids[0]].hydration);
  exportMap(o, { format: 'json' });
  JSON.stringify(snapshotFor(o, []));
  nodeForAgent(o, ids[0]);
  for (const id of ids) assert.ok(o.nodes[id].hydration, `${id} still hydrated in the fold`);
  const s = stripHydration(o);
  assert.notEqual(s, o);
  assert.notEqual(s.nodes, o.nodes);
  const plainId = Object.keys(o.nodes).find((k) => !ids.includes(k));
  assert.equal(s.nodes[/** @type {string} */ (plainId)], o.nodes[/** @type {string} */ (plainId)], 'unhydrated nodes are shared');
  assert.equal(s.edges, o.edges);
  const plain = foldAll(fixtureEvents('plastic-modeling'));
  assert.equal(stripHydration(plain), plain);
  // a __proto__ node id survives the strip as an own key
  const odd = foldAll([{ t: 'ontology.created', at: 0, name: 'x', root: 'r', brief: {}, categories: [] },
    { t: 'node.added', at: 1, node: { id: '__proto__', label: 'p' } }, { t: 'node.hydrated', at: 2, nodeId: '__proto__', hydration: H('p') }]);
  assert.ok(Object.hasOwn(stripHydration(odd).nodes, '__proto__'));
  assert.equal(Object.getPrototypeOf(stripHydration(odd).nodes), Object.prototype);
});

test('get_node with include: hydration comes last, escaped to one line; not added to unhydrated nodes', () => {
  const ev = fixtureEvents('manga');
  const [rootId, midId] = Object.keys(nodeGolden('manga'));
  const nasty = { job: 'line one\n# heading\n> quote', examples: ['a\nb', '[x](http://e.example)'], not_for: 'n\n## h',
    not_for_ids: ['id\nx'], model: 'stub', at: 't' };
  const o = foldAll([...ev, { t: 'node.hydrated', at: 1e9, nodeId: rootId, hydration: nasty }]);
  const r = nodeForAgent(o, rootId, { include: ['hydration'] }).result;
  assert.equal(Object.keys(r).at(-1), 'hydration');
  const g = nodeGolden('manga')[rootId].result;
  assert.deepEqual(Object.keys(r).slice(0, -1), Object.keys(g));
  // planted fault: the raw text has newlines and a live heading
  assert.ok(/\n/.test(nasty.job) && /^# /m.test(nasty.job));
  for (const v of [r.hydration.job, r.hydration.not_for, ...r.hydration.examples, ...r.hydration.not_for_ids]) {
    assert.ok(!/\n/.test(v), `one line: ${JSON.stringify(v)}`);
    assert.ok(!/^#/.test(v) && !/^>/.test(v), `no heading or quote: ${JSON.stringify(v)}`);
  }
  assert.ok(!/\]\(http/.test(r.hydration.examples[1]), 'no live markdown link');
  assert.equal(r.hydration.examples.length, 2);
  assert.equal(JSON.stringify(nodeForAgent(o, midId, { include: ['hydration'] }).result), nodeGolden('manga')[midId].body);
  assert.ok(nodeForAgent(o, 'no-such-node', { include: ['hydration'] }).error);
});

test('get_node resolves by the result id, not the raw argument', () => {
  const [, , leaf] = Object.keys(nodeGolden('plastic-modeling'));
  const o = foldAll([...fixtureEvents('plastic-modeling'), { t: 'node.hydrated', at: 1e9, nodeId: leaf, hydration: H('x') }]);
  const label = o.nodes[leaf].label;
  const byLabel = nodeForAgent(o, label, { include: ['hydration'] });
  if (!byLabel.error && byLabel.result.id === leaf) assert.equal(byLabel.result.hydration.job, 'Job x');
  assert.equal(nodeForAgent(o, leaf, { include: ['hydration'] }).result.hydration.job, 'Job x');
});

/** A service with one map: a fixture plus hydration on five nodes. */
async function bootHydrated(f = 'demo') {
  const b = await boot({ tokens: [{ name: 'r', scopes: ['read'] }] });
  openStore(b.home, { tenant: 'default' }).importEvents('m1', hydratedEvents(f));
  return b;
}
/** @param {string} t */
const bearer = (t) => ({ authorization: `Bearer ${t}` });

test('through the routes: export, nodes and snapshot carry hydration only with include', async () => {
  const f = 'demo';
  const { srv, secrets } = await bootHydrated(f);
  const get = (/** @type {string} */ p) => req(srv.url, `/v1/t/default/maps/m1${p}`, { headers: bearer(secrets.r) });
  const id = fiveIds(f)[0];
  const enc = encodeURIComponent;
  try {
    assert.equal((await get('/export?format=json')).body, golden(f, 'export'));
    assert.equal((await get('/snapshot')).body, golden(f, 'snapshot'));
    assert.equal((await get(`/nodes/${enc(id)}`)).body, nodeGolden(f)[id].body);
    for (const inc of ['hydration', enc('["hydration"]')]) {
      const ex = await get(`/export?format=json&include=${inc}`);
      assert.equal(ex.status, 200, ex.body);
      assert.deepEqual(ex.json().nodes[id].hydration, H('0'), `export include=${inc}`);
      const sn = await get(`/snapshot?include=${inc}`);
      assert.deepEqual(sn.json().nodes[id].hydration, H('0'), `snapshot include=${inc}`);
      const nd = await get(`/nodes/${enc(id)}?include=${inc}`);
      assert.equal(nd.json().hydration.job, 'Job 0', `node include=${inc}`);
    }
    assert.equal((await get('/export?format=json&include=hydrations')).status, 400);
    assert.equal((await get('/export?format=html&include=hydration')).status, 400);
    assert.equal((await get('/snapshot?include=hydrations')).status, 400);
    assert.equal((await get(`/nodes/${enc(id)}?include=nope`)).status, 400);
  } finally { await srv.close(); }
});

test('MCP: export_map and get_node with include ["hydration"] return it; without it, today\'s output', async () => {
  const f = 'manga';
  const { srv, origin, secrets } = await bootHydrated(f);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/v1/mcp`), { requestInit: { headers: bearer(secrets.r) } }));
  const text = (/** @type {any} */ r) => r.content.map((/** @type {any} */ c) => c.text).join('');
  const id = fiveIds(f)[0];
  try {
    const plain = /** @type {any} */ (await client.callTool({ name: 'export_map', arguments: { id: 'm1', format: 'json' } }));
    // MCP shapes (pretty-prints) the JSON it returns: same data as the golden, no hydration key
    assert.deepStrictEqual(JSON.parse(text(plain)), JSON.parse(golden(f, 'export')));
    assert.ok(!text(plain).includes('"hydration"'));
    const withH = /** @type {any} */ (await client.callTool({ name: 'export_map', arguments: { id: 'm1', format: 'json', include: ['hydration'] } }));
    assert.ok(!withH.isError, text(withH));
    assert.deepEqual(JSON.parse(text(withH)).nodes[id].hydration, H('0'));
    const n0 = /** @type {any} */ (await client.callTool({ name: 'get_node', arguments: { id: 'm1', nodeId: id } }));
    assert.ok(!text(n0).includes('"hydration"'));
    assert.deepEqual(JSON.parse(text(n0)), nodeGolden(f)[id].result);
    const n1 = /** @type {any} */ (await client.callTool({ name: 'get_node', arguments: { id: 'm1', nodeId: id, include: ['hydration'] } }));
    assert.equal(JSON.parse(text(n1)).hydration.job, 'Job 0');
  } finally { await client.close(); await srv.close(); }
});

test('CLI: export --format json --include hydration; include with another format exits 1', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-d-'));
  try {
    openStore(home).importEvents('m1', hydratedEvents('demo'));
    const cap = () => ({ out: '', write(/** @type {string} */ s) { this.out += s; return true; } });
    const run = async (/** @type {string[]} */ args) => {
      const stdout = cap(); const stderr = cap();
      const code = await main(args, { home, stdout, stderr, interactive: false, env: { ...process.env, ONTOLOGIZER_HOME: home }, openBrowser: async () => {}, onSignal: () => () => {} });
      return { code, stdout: stdout.out, stderr: stderr.out };
    };
    const plain = await run(['export', 'm1', '--format', 'json']);
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout, `${golden('demo', 'export')}\n`);
    const withH = await run(['export', 'm1', '--format', 'json', '--include', 'hydration']);
    assert.equal(withH.code, 0, withH.stderr);
    assert.equal(JSON.parse(withH.stdout).nodes[fiveIds('demo')[0]].hydration.job, 'Job 0');
    const html = await run(['export', 'm1', '--format', 'context', '--include', 'hydration']);
    assert.equal(html.code, 1);
    assert.match(html.stderr, /^ontologizer: include works only with format json/);
    const bad = await run(['export', 'm1', '--format', 'json', '--include', 'hydrations']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /unknown include "hydrations"/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
