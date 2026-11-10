// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// A web search that fails or runs out (web_search_tool_result_error) is recorded, not swallowed:
// ask says which failure in plain words and names the next step (sources on the node the question
// is about), ask_map carries webSearch { used, failed }, and the sources job says why it found
// nothing. The real engine with a fake model client; every check has a planted fault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createEngine } from '../../src/core/engine/index.js';
import { openStore } from '../../src/core/store.js';
import { collectChat } from '../../src/server/mcp.js';
import { createFakeClient, createMemoryStore, lines, searchBlock } from '../c/fake.js';
import { boot, tempHome } from './helpers-service.js';

const ADH = 'plastic-modeling/tools/adhesives';
const MODELS = { fast: 'fast-model', strong: 'strong-model' };
const fixture = readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

const searchUse = (/** @type {string} */ id) => ({ type: 'server_tool_use', id, name: 'web_search', input: { query: 'glue' } });
/** @param {string} code */
const searchError = (code) => ({ type: 'web_search_tool_result', tool_use_id: 'srvtoolu_x', content: { type: 'web_search_tool_result_error', error_code: code } });
const RESULTS = [{ title: 'Glue guide', url: 'https://glue.example/guide' }];

/** An engine over the fixture whose model answers once with these blocks and this text. @param {any[]} content @param {string} text */
function setup(content, text) {
  const store = createMemoryStore();
  for (const e of fixture) store.append('pm', e);
  const client = createFakeClient({ respond: () => ({ content, text }), chunkMs: 0 });
  return { store, client, engine: createEngine({ store, id: 'pm', client, models: MODELS }) };
}
/** @param {AsyncIterable<any>} it */
async function collect(it) {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
}

const PLAIN = /** @type {Record<string, RegExp>} */ ({
  max_uses_exceeded: /web search ran out: one call may search 3 times/,
  too_many_requests: /web search was rate-limited \(too many requests\)/,
});

/**
 * Problems in an ask's items: the websearch item must come just before done and say what happened.
 * @param {any[]} items @param {string|null} code the failure expected, or null @param {string} [nodeId] the node the next step names
 */
export function webItemProblems(items, code, nodeId) {
  const p = [];
  const i = items.findIndex((x) => x.type === 'websearch');
  if (i < 0) return ['no websearch item'];
  const w = items[i];
  if (items[i + 1]?.type !== 'done') p.push('the websearch item is not just before done');
  if (w.used !== true) p.push('used is not true after a search');
  if (code === null) {
    if (w.failed !== undefined || w.note !== undefined) p.push(`a failure is reported where none happened: ${w.failed}`);
    return p;
  }
  if (w.failed !== code) p.push(`failed is ${w.failed}, expected ${code}`);
  if (!PLAIN[code]?.test(String(w.note))) p.push(`the note does not say what happened in plain words: ${w.note}`);
  if (nodeId && !String(w.note).includes(`run sources on ${nodeId} (or explain)`)) p.push(`the note does not name the next step for ${nodeId}: ${w.note}`);
  return p;
}

test('ask: a search that ran out (max_uses_exceeded) is reported, with sources on the cited node as the next step', async () => {
  const { engine, store } = setup([searchUse('s1'), searchBlock(RESULTS), searchUse('s2'), searchError('max_uses_exceeded')],
    `Plastic cement welds styrene [[${ADH}]].`);
  const items = await collect(engine.ask({ text: 'Which glue should I use?' }));
  assert.deepEqual(webItemProblems(items, 'max_uses_exceeded', ADH), []);
  // The saved answer is unchanged: the page and the map's chat keep their shape.
  const answered = store.list('pm').at(-1);
  assert.equal(answered.t, 'chat.answered');
  assert.equal(answered.usedWeb, true);
  assert.ok(!('webSearch' in store.read('pm').chat.at(-1)));
  // Planted faults: the old ask (no websearch item), and an item that names the wrong failure.
  assert.deepEqual(webItemProblems(items.filter((x) => x.type !== 'websearch'), 'max_uses_exceeded', ADH), ['no websearch item']);
  const wrong = items.map((x) => (x.type === 'websearch' ? { ...x, failed: 'unavailable' } : x));
  assert.ok(webItemProblems(wrong, 'max_uses_exceeded', ADH).some((x) => x.startsWith('failed is unavailable')));
});

test('ask: a rate-limited search (too_many_requests) with no citation names the best match for the question', async () => {
  const { engine } = setup([searchUse('s1'), searchError('too_many_requests')], 'I could not reach the web.');
  const items = await collect(engine.ask({ text: 'adhesives' }));
  const w = items.find((x) => x.type === 'websearch');
  assert.match(String(w?.note), /run sources on plastic-modeling\/\S+ \(or explain\)/);
  const nodeId = String(w?.note).match(/run sources on (\S+) /)?.[1];
  assert.deepEqual(webItemProblems(items, 'too_many_requests', nodeId), []);
  // Planted fault: a note that says the search "failed" without saying how.
  const vague = items.map((x) => (x.type === 'websearch' ? { ...x, note: 'Web search failed.' } : x));
  assert.ok(webItemProblems(vague, 'too_many_requests', nodeId).some((x) => x.includes('plain words')));
});

test('ask: a search that worked reports used and no failure', async () => {
  const { engine } = setup([searchUse('s1'), searchBlock(RESULTS)], `Cement it [[${ADH}]].`);
  const items = await collect(engine.ask({ text: 'Which glue?' }));
  assert.deepEqual(webItemProblems(items, null), []);
  // Planted fault: a failure claimed where none happened.
  const claimed = items.map((x) => (x.type === 'websearch' ? { ...x, failed: 'max_uses_exceeded', note: 'x' } : x));
  assert.ok(webItemProblems(claimed, null).length > 0);
});

/** @param {any[]} items */
const sse = (items) => items.map((x) => `data: ${JSON.stringify(x)}\n\n`).join('');

test('ask_map\'s result carries webSearch and the plain note; without the item there is none', () => {
  const note = 'The web search ran out: one call may search 3 times, so this answer may lack web sources. To find and keep web sources for "Adhesives", run sources on plastic-modeling/tools/adhesives (or explain); both call the model.';
  const body = sse([{ type: 'delta', text: 'An answer.' }, { type: 'websearch', used: true, failed: 'max_uses_exceeded', note }, { type: 'done', msgId: 'm' }]);
  const c = collectChat(body);
  assert.deepEqual(c.webSearch, { used: true, failed: 'max_uses_exceeded' });
  assert.ok(c.text.endsWith(`Web search: ${note}`));
  assert.deepEqual(collectChat(sse([{ type: 'delta', text: 'A.' }, { type: 'websearch', used: false }])).webSearch, { used: false });
  // Planted fault: a stream without the item (the old engine) gives no webSearch and no note.
  const old = collectChat(sse([{ type: 'delta', text: 'An answer.' }, { type: 'done', msgId: 'm' }]));
  assert.equal(old.webSearch, null);
  assert.ok(!old.text.includes('Web search:'));
});

test('the sources job says why it found nothing when web search was rate-limited', async () => {
  const { engine, store } = setup([searchUse('s1'), searchError('too_many_requests')], lines([]));
  engine.enqueue({ kind: 'sources', nodeId: ADH }, { priority: 10 });
  await engine.idle();
  const failed = store.list('pm').find((e) => e.t === 'job.failed');
  /** @param {string} msg */
  const says = (msg) => /no sources found/.test(msg) && PLAIN.too_many_requests.test(msg);
  assert.ok(failed && says(String(failed.job.error)), JSON.stringify(failed?.job));
  // Planted fault: the old message gave no reason.
  assert.ok(!says('sources: no sources found'));
});

test('over MCP: ask_map on a served map whose search ran out returns webSearch.failed and the next step', async () => {
  const home = tempHome();
  const seed = openStore(home);
  seed.importEvents('pm', fixture);
  seed.flush?.();
  const client = createFakeClient({ respond: () => ({ content: [searchUse('s1'), searchError('max_uses_exceeded')], text: `Use cement [[${ADH}]].` }), chunkMs: 0 });
  const { srv, origin } = await boot({ home, makeEngine: async (/** @type {any} */ x) => createEngine({ store: x.store, id: x.id, client, models: MODELS }) });
  const c = new Client({ name: 'test', version: '1' });
  try {
    await c.connect(new StreamableHTTPClientTransport(new URL(`${origin}/v1/mcp`)));
    const r = /** @type {any} */ (await c.callTool({ name: 'ask_map', arguments: { id: 'pm', text: 'Which glue?', chatId: 'agent' } }));
    assert.ok(!r.isError, JSON.stringify(r.content));
    assert.deepEqual(r.structuredContent.webSearch, { used: true, failed: 'max_uses_exceeded' });
    const text = r.content.map((/** @type {any} */ x) => x.text).join('');
    assert.match(text, /Web search: The web search ran out: one call may search 3 times/);
    assert.ok(text.includes(`run sources on ${ADH} (or explain)`));
  } finally {
    await c.close().catch(() => {});
    await srv.close();
  }
});
