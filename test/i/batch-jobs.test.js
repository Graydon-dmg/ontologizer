// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// explain and sources on several nodes (nodeIds): one job per node under the same dedupe, limits
// and private-map rules as one node; every node checked before any job starts; wait_for_map waits
// for all of them. The live router with the real engine and a fake model client (metered, so every
// model call counts against the daily limit). Every check has a planted fault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startService } from '../../src/server/service.js';
import { createUsage } from '../../src/server/usage.js';
import { createEngine } from '../../src/core/engine/index.js';
import { openStore } from '../../src/core/store.js';
import { main } from '../../src/cli/main.js';
import { createFakeClient, lines, searchBlock } from '../c/fake.js';
import { tempHome, fixtureEvents, req } from './helpers-service.js';

const MODELS = { fast: 'fast-model', strong: 'strong-model' };
const P = 'plastic-modeling';
const A = `${P}/tools/adhesives`;
const B = `${P}/tools/adhesives/plastic-cement`;
const C = `${P}/tools`;
const D = `${P}/kits`;
const ARTICLE = { summary: 'An article.', keyFacts: ['A fact.'], whyItMatters: 'It matters.', seeAlso: [] };
const FOUND = [{ title: 'Guide', url: 'https://guide.example/a' }, { title: 'Notes', url: 'https://notes.example/b' }];

/**
 * A served map on a temp home. @param {{ limitCalls?: number, priorCalls?: number, events?: any[], delayMs?: number }} [o]
 */
async function serve(o = {}) {
  const home = tempHome();
  const seed = openStore(home);
  seed.importEvents(P, o.events ?? fixtureEvents(P));
  seed.flush?.();
  const fake = createFakeClient({
    chunkMs: 0,
    // Staggered: call i takes (i + 1) × delayMs, so the jobs of a batch finish one after another.
    respond: (params, i) => ({
      delayMs: (o.delayMs ?? 0) * (i + 1),
      content: params.tools?.some((/** @type {any} */ t) => t.name === 'web_search') ? [searchBlock(FOUND)] : [],
      text: /article/i.test(JSON.stringify(params.system ?? '')) ? lines([ARTICLE]) : lines(FOUND),
    }),
  });
  const usage = createUsage({ home, limitCalls: o.limitCalls ?? null });
  if (o.priorCalls) usage.record('default', { calls: o.priorCalls });
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, allowHosts: [], maxBuilds: 2, version: 'test', tokensFile: null, usage,
    makeEngine: async (/** @type {any} */ x) => createEngine({ store: x.store, id: x.id, client: x.meter(fake), models: MODELS }),
  });
  const origin = `http://127.0.0.1:${srv.port}`;
  /** @param {Record<string, any>} body */
  const act = async (body) => {
    const r = await req(origin, `/v1/t/default/maps/${P}/actions`, { method: 'POST', body, headers: { accept: 'application/json' } });
    return { status: r.status, body: /** @type {any} */ (JSON.parse(r.body || '{}')) };
  };
  const wait = async () => /** @type {any} */ (JSON.parse((await req(origin, `/v1/t/default/maps/${P}/wait?timeout=20000`, { headers: { accept: 'application/json' } })).body));
  return { home, srv, origin, fake, usage, act, wait };
}
/** The map as stored now. @param {string} home */
const mapOf = (home) => openStore(home).read(P);
/** Job states for one kind, by node. @param {any} map @param {string} kind */
const jobsOf = (map, kind) => Object.values(map.jobs ?? {}).filter((/** @type {any} */ j) => j.kind === kind);

/**
 * Problems in a batch reply against what was asked.
 * @param {any} reply @param {string[]} asked @param {{ refusedFrom?: number }} [o] refusedFrom: the first index the limit refuses
 */
export function batchProblems(reply, asked, o = {}) {
  const p = [];
  if (!reply?.ok || !Array.isArray(reply.jobs)) return ['not a batch reply'];
  const got = reply.jobs.map((/** @type {any} */ j) => j.nodeId);
  if (JSON.stringify(got) !== JSON.stringify(asked)) p.push(`answered for [${got}] not [${asked}]: a node was dropped`);
  reply.jobs.forEach((/** @type {any} */ j, /** @type {number} */ i) => {
    const has = ['jobId', 'skipped', 'refused'].filter((k) => j[k] !== undefined);
    if (has.length !== 1) p.push(`${j.nodeId}: has ${has.join('+') || 'nothing'}`);
    if (o.refusedFrom !== undefined && (i >= o.refusedFrom) !== (j.refused !== undefined)) p.push(`${j.nodeId}: refused is ${j.refused !== undefined} at ${i}`);
    if (j.refused !== undefined && !/^Daily limit reached/.test(j.refused)) p.push(`${j.nodeId}: refused without the limit's message`);
  });
  return p;
}

test('a batch of 3 starts 3 jobs; wait_for_map waits for all of them; get_node then shows each article', async () => {
  const s = await serve({ delayMs: 150 });
  try {
    const r = await s.act({ type: 'explain', nodeIds: [A, C, D] });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.deepEqual(batchProblems(r.body, [A, C, D]), []);
    const ids = r.body.jobs.map((/** @type {any} */ j) => j.jobId);
    assert.equal(new Set(ids).size, 3, 'three different jobs');
    // Asked again while they run: the same jobs, nothing new.
    const again = await s.act({ type: 'explain', nodeIds: [A, C, D] });
    assert.deepEqual(again.body.jobs.map((/** @type {any} */ j) => j.jobId), ids);
    const w = await s.wait();
    assert.equal(w.state, 'idle', JSON.stringify(w));
    const map = mapOf(s.home);
    /** Jobs of the batch not finished when wait said idle. @param {any} m */
    const unfinished = (m) => ids.filter((i) => m.jobs?.[i]?.state !== 'done');
    assert.deepEqual(unfinished(map), []);
    for (const n of [A, C, D]) assert.ok(map.nodes[n].article, `${n} explained`);
    assert.equal(s.fake.calls.length, 3, 'one model call per node');
    // Planted fault: a wait that returned with one job still queued is reported.
    assert.deepEqual(unfinished({ ...map, jobs: { ...map.jobs, [ids[2]]: { ...map.jobs[ids[2]], state: 'queued' } } }), [ids[2]]);
  } finally { await s.srv.close(); }
});

test('the list is checked before anything starts: a duplicate, 9 nodes, both forms, or a missing node start nothing', async () => {
  const s = await serve();
  try {
    /** Jobs started so far, of any kind. */
    const started = () => Object.keys(mapOf(s.home).jobs ?? {}).length;
    const before = started();
    const cases = /** @type {[any, RegExp][]} */ ([
      [{ type: 'explain', nodeIds: [A, C, A] }, /twice/],
      [{ type: 'sources', nodeIds: Array.from({ length: 9 }, (_, i) => `${P}/n${i}`) }, /1 to 8/],
      [{ type: 'explain', nodeIds: [] }, /1 to 8/],
      [{ type: 'explain', nodeId: A, nodeIds: [C] }, /not both/],
      [{ type: 'explain' }, /nodeId \(one node\) or nodeIds/],
      [{ type: 'sources', nodeIds: [A, `${P}/no-such-node`, C] }, /no node "plastic-modeling\/no-such-node".*nothing was started/],
    ]);
    for (const [body, msg] of cases) {
      const r = await s.act(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(String(r.body.error), msg);
    }
    /** @param {number} n */
    const partial = (n) => (n !== before ? [`${n - before} jobs started by a refused batch`] : []);
    assert.deepEqual(partial(started()), []);
    // Planted fault: a batch that started its good nodes before finding the missing one is reported.
    await s.act({ type: 'sources', nodeIds: [A] });
    assert.deepEqual(partial(started()), ['1 jobs started by a refused batch']);
    await s.wait();
  } finally { await s.srv.close(); }
});

test('explain skips an already explained node; the rest run', async () => {
  const events = fixtureEvents(P);
  events.push({ t: 'node.updated', at: 1, id: C, patch: { article: { ...ARTICLE, sources: [] } } });
  const s = await serve({ events });
  try {
    const r = await s.act({ type: 'explain', nodeIds: [A, C] });
    assert.deepEqual(batchProblems(r.body, [A, C]), []);
    assert.deepEqual(r.body.jobs[1], { nodeId: C, skipped: 'already explained' });
    assert.ok(r.body.jobs[0].jobId);
    await s.wait();
    assert.equal(jobsOf(mapOf(s.home), 'explain').length, 1);
    // sources has no such skip: a node with an article can still get sources.
    const src = await s.act({ type: 'sources', nodeIds: [C] });
    assert.ok(src.body.jobs[0].jobId);
    await s.wait();
  } finally { await s.srv.close(); }
});

test('the daily limit crossed partway: the nodes past it are refused, each with the limit\'s message', async () => {
  const s = await serve({ limitCalls: 4, priorCalls: 2 });
  try {
    const asked = [A, B, C, D];
    const r = await s.act({ type: 'sources', nodeIds: asked });
    assert.equal(r.status, 202);
    assert.deepEqual(batchProblems(r.body, asked, { refusedFrom: 2 }), []);
    assert.match(r.body.jobs[2].refused, /Daily limit reached: 2 model calls today for tenant default, and 2 more just started by this request \(limit 4\)/);
    await s.wait();
    assert.equal(s.usage.today('default').calls, 4, 'every model call counted');
    // At the limit, the whole request is refused as for one node.
    const over = await s.act({ type: 'sources', nodeIds: [A] });
    assert.equal(over.status, 429);
    // Planted fault: a reply that silently dropped the refused nodes is reported.
    assert.ok(batchProblems({ ok: true, jobs: r.body.jobs.slice(0, 2) }, asked, { refusedFrom: 2 }).some((x) => x.includes('dropped')));
    assert.ok(batchProblems({ ok: true, jobs: r.body.jobs.map((/** @type {any} */ j) => (j.refused ? { nodeId: j.nodeId, refused: 'no' } : j)) }, asked, { refusedFrom: 2 }).some((x) => x.includes('limit\'s message')));
  } finally { await s.srv.close(); }
});

test('a private map keeps its rules in a batch: no web search for any node', async () => {
  const events = fixtureEvents(P);
  events.splice(1, 0, { t: 'visibility.raised', at: 0, to: 'private', reason: 'source', sources: [] });
  const s = await serve({ events });
  try {
    const r = await s.act({ type: 'explain', nodeIds: [A, C] });
    assert.deepEqual(batchProblems(r.body, [A, C]), []);
    await s.wait();
    /** Model calls that offered web search. @param {any[]} calls */
    const searched = (calls) => calls.filter((c) => (c.params.tools ?? []).some((/** @type {any} */ t) => t.name === 'web_search'));
    assert.equal(s.fake.calls.length, 2);
    assert.deepEqual(searched(s.fake.calls), []);
    // Planted fault: a call that offered web search on the private map is reported.
    assert.equal(searched([...s.fake.calls, { params: { tools: [{ type: 'web_search_20260209', name: 'web_search' }] } }]).length, 1);
  } finally { await s.srv.close(); }
});

test('over MCP: explain with nodeIds answers jobs; argument errors name the rule', async () => {
  const s = await serve();
  const c = new Client({ name: 'test', version: '1' });
  try {
    await c.connect(new StreamableHTTPClientTransport(new URL(`${s.origin}/v1/mcp`)));
    const r = /** @type {any} */ (await c.callTool({ name: 'explain', arguments: { id: P, nodeIds: [A, D] } }));
    assert.ok(!r.isError, JSON.stringify(r.content));
    assert.deepEqual(batchProblems(r.structuredContent, [A, D]), []);
    const text = (/** @type {any} */ x) => x.content.map((/** @type {any} */ y) => y.text).join('');
    const dup = /** @type {any} */ (await c.callTool({ name: 'sources', arguments: { id: P, nodeIds: [A, A] } }));
    assert.ok(dup.isError && /twice/.test(text(dup)), text(dup));
    const nine = /** @type {any} */ (await c.callTool({ name: 'sources', arguments: { id: P, nodeIds: Array.from({ length: 9 }, (_, i) => `x${i}`) } }));
    assert.ok(nine.isError && /at most 8/.test(text(nine)), text(nine));
    const both = /** @type {any} */ (await c.callTool({ name: 'explain', arguments: { id: P, nodeId: A, nodeIds: [D] } }));
    assert.ok(both.isError && /not both/.test(text(both)), text(both));
    const w = /** @type {any} */ (await c.callTool({ name: 'wait_for_map', arguments: { id: P, timeout: 20000 } }));
    assert.equal(w.structuredContent.state, 'idle');
  } finally {
    await c.close().catch(() => {});
    await s.srv.close();
  }
});

test('CLI: explain takes several nodes (resolved first; a missing one starts nothing), --sources runs the sources job', async () => {
  const home = tempHome();
  const store = openStore(home);
  store.importEvents(P, fixtureEvents(P));
  store.flush?.();
  const cap = () => ({ out: '', write(/** @type {string} */ x) { this.out += x; return true; } });
  /** @param {string[]} args */
  const run = async (args) => {
    const stdout = cap(); const stderr = cap();
    const code = await main(args, { home, stdout, stderr, interactive: false, keyring: { get: () => null, set() {}, delete: () => false },
      openBrowser: async () => {}, onSignal: () => () => {}, env: { ...process.env, ONTOLOGIZER_HOME: home, ONTOLOGIZER_STUB_SPEED: '1000', ANTHROPIC_API_KEY: 'sk-ant-test-0000' } });
    return { code, stdout: stdout.out, stderr: stderr.out };
  };
  const jobsFor = (/** @type {string} */ kind) => Object.values(openStore(home).read(P).jobs ?? {}).filter((/** @type {any} */ j) => j.kind === kind && j.state === 'done').map((/** @type {any} */ j) => j.nodeId).sort();
  const miss = await run(['explain', P, 'adhesives', 'no-such-thing']);
  assert.equal(miss.code, 1);
  assert.match(miss.stderr, /No node "no-such-thing"/);
  assert.deepEqual(jobsFor('explain'), [], 'nothing started');
  const two = await run(['explain', P, 'adhesives', 'kits']);
  assert.equal(two.code, 0, two.stderr);
  assert.deepEqual(jobsFor('explain'), [A, D].sort());
  assert.match(two.stdout, /== .*\(plastic-modeling\/tools\/adhesives\) ==/);
  const src = await run(['explain', P, 'adhesives', '--sources']);
  assert.equal(src.code, 0, src.stderr);
  assert.deepEqual(jobsFor('sources'), [A]);
  const nine = await run(['explain', P, ...Array.from({ length: 9 }, () => 'adhesives')]);
  assert.equal(nine.code, 1);
  assert.match(nine.stderr, /At most 8 nodes/);
});
