// @ts-check
// engine.ask(): the chat panel's brain, offline with a fake client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../../src/core/engine/index.js';
import { createTokenFilter, checkAnswer, buildIndex, runTool, outline, linksIn, historyMessages, STOPPED } from '../../src/core/engine/chat.js';
import { KEY_REJECTED } from '../../src/core/engine/call.js';
import { createFakeClient, createMemoryStore, searchBlock } from './fake.js';

const ADHESIVES = 'plastic-modeling/tools/adhesives';
const MODELS = { fast: 'fast-model', strong: 'strong-model' };

function seeded() {
  const store = createMemoryStore();
  const file = fileURLToPath(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url));
  for (const l of readFileSync(file, 'utf8').split('\n')) if (l.trim()) store.append('pm', JSON.parse(l));
  return store;
}

/** @param {AsyncIterable<any>} it */
async function collect(it) {
  const items = [];
  for await (const x of it) items.push(x);
  return items;
}
const text = (/** @type {any[]} */ items) => items.filter((i) => i.type === 'delta').map((i) => i.text).join('');
const toolUse = (/** @type {string} */ id, /** @type {string} */ name, /** @type {any} */ input) => ({ type: 'tool_use', id, name, input });

test('ask: map tools, a valid citation kept, an invented id dropped, a suggestion, then done', async () => {
  const store = seeded();
  const client = createFakeClient({
    respond: (_p, i) => i === 0
      ? { content: [toolUse('t1', 'search_map', { query: 'glue' })], stop_reason: 'tool_use' }
      : i === 1
        ? { content: [toolUse('t2', 'get_node', { id: ADHESIVES })], stop_reason: 'tool_use' }
        : { text: `Plastic cement welds parts [[${ADHESIVES}]] and CA glue sets fast [[plastic-modeling/tools/made-up-glue]].\n[[suggest:${ADHESIVES}|general|Glue chemistry]]\n[[suggest:not/a/node|general|Nope]]` },
  });
  const engine = createEngine({ store, id: 'pm', client, models: MODELS });
  const items = await collect(engine.ask({ text: 'Which glue should I use?' }));

  const answer = text(items);
  assert.ok(answer.includes(`[[${ADHESIVES}]]`));
  // Planted fault: the invented id must not survive, in the stream or in the saved answer.
  assert.ok(!answer.includes('made-up-glue'), answer);
  assert.deepEqual(items.filter((i) => i.type === 'citation').map((i) => i.nodeId), [ADHESIVES]);
  assert.deepEqual(items.filter((i) => i.type === 'suggestion'),
    [{ type: 'suggestion', kind: 'research', nodeId: ADHESIVES, mode: 'general', label: 'Glue chemistry' }]);
  assert.ok(!answer.includes('suggest:'));
  assert.ok(items.some((i) => i.type === 'status' && i.text === 'Searching your map…'));
  assert.equal(items.at(-1).type, 'done');

  // The tools ran: turn 2 carries the search results, turn 3 the node's children.
  const r1 = client.calls[1].params.messages.at(-1).content[0];
  assert.equal(r1.type, 'tool_result');
  assert.ok(JSON.parse(r1.content).results.some((/** @type {any} */ r) => r.id === ADHESIVES));
  const r2 = JSON.parse(client.calls[2].params.messages.at(-1).content[0].content);
  assert.equal(r2.id, ADHESIVES);
  assert.ok(Array.isArray(r2.children) && r2.children.length > 0);

  // Read-only: the only events are the chat pair, and the map is unchanged.
  const events = store.list('pm');
  const chatEvents = events.slice(-2);
  assert.deepEqual(chatEvents.map((e) => e.t), ['chat.asked', 'chat.answered']);
  assert.equal(events.filter((e) => e.t.startsWith('job.') || e.t.startsWith('node.') ).length,
    seeded().list('pm').filter((e) => e.t.startsWith('job.') || e.t.startsWith('node.')).length);
  const [asked, answered] = chatEvents;
  assert.equal(answered.replyTo, asked.msgId);
  assert.equal(items.at(-1).msgId, answered.msgId);
  assert.equal(answered.usedWeb, false);
  assert.ok(!answered.text.includes('made-up-glue'));
  assert.deepEqual(answered.citations, [{ nodeId: ADHESIVES, label: store.read('pm').nodes[ADHESIVES].label }]);
  assert.equal(answered.suggestions.length, 1);
  assert.deepEqual(store.read('pm').chat.map((m) => m.role), ['user', 'assistant']);
});

test('ask: system and outline are cached blocks; the request has tools, history and the strong model', async () => {
  const store = seeded();
  const client = createFakeClient({ respond: () => ({ text: 'An answer.' }) });
  const engine = createEngine({ store, id: 'pm', client, models: MODELS });
  await collect(engine.ask({ text: 'first question' }));
  await collect(engine.ask({ text: 'second question' }));
  const p = client.calls[1].params;
  assert.equal(p.model, 'strong-model');
  assert.equal(p.system.length, 2);
  assert.deepEqual(p.system[1].cache_control, { type: 'ephemeral' });
  assert.match(p.system[1].text, new RegExp(`\\(${ADHESIVES}\\)`));
  assert.deepEqual(p.tools.map((/** @type {any} */ t) => t.name), ['search_map', 'get_node', 'web_search']);
  assert.equal(p.tools[2].max_uses, 3);
  assert.deepEqual(p.messages.map((/** @type {any} */ m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(p.messages[0].content, 'first question');
  assert.equal(p.messages[1].content, 'An answer.');
});

test('ask: image bytes go to the model but never into events', async () => {
  const store = seeded();
  const client = createFakeClient({ respond: () => ({ text: `That is a tube of cement [[${ADHESIVES}]].` }) });
  const engine = createEngine({ store, id: 'pm', client, models: MODELS });
  const data = 'SECRETBASE64PIXELS' + 'A'.repeat(64);
  await collect(engine.ask({ text: 'what is this?', images: [{ mime: 'image/png', data, hash: 'h1', w: 10, h: 20 }] }));
  const sent = client.calls[0].params.messages.at(-1).content[0];
  // Planted fault: the marker is findable where it belongs (the request), so its absence below means something.
  assert.equal(sent.source.data, data);
  const logged = JSON.stringify(store.list('pm'));
  assert.ok(!logged.includes('SECRETBASE64PIXELS'), 'base64 reached the event log');
  const asked = store.list('pm').find((e) => e.t === 'chat.asked');
  assert.deepEqual(asked.images, [{ hash: 'h1', mime: 'image/png', w: 10, h: 20 }]);
});

test('ask: web search sets usedWeb, gives status and source items from the links in the answer', async () => {
  const store = seeded();
  const url = 'https://example.org/glue-stats';
  const client = createFakeClient({
    respond: () => ({
      content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'glue' } }, searchBlock([{ title: 'Glue stats', url }])],
      text: `## From your map\nCement welds [[${ADHESIVES}]].\n## From the web\n- 70% of modelers use cement ([Glue stats](${url})).`,
    }),
  });
  const engine = createEngine({ store, id: 'pm', client, models: MODELS });
  const items = await collect(engine.ask({ text: 'how popular is cement?' }));
  assert.ok(items.some((i) => i.type === 'status' && i.text === 'Searching the web…'));
  assert.deepEqual(items.filter((i) => i.type === 'source'), [{ type: 'source', title: 'Glue stats', url }]);
  const answered = store.list('pm').find((e) => e.t === 'chat.answered');
  assert.equal(answered.usedWeb, true);
  assert.deepEqual(checkAnswer(answered.text, { nodes: store.read('pm').nodes }), []);
});

test('checkAnswer: a web fact without a URL fails; a well-formed answer passes', () => {
  const good = `## From your map\nCement welds [[${ADHESIVES}]].\n\n## From the web\n- 70% use it ([Survey](https://example.org/s)).\n- Sales grew 5% (https://example.com/r).`;
  const nodes = seeded().read('pm').nodes;
  assert.deepEqual(checkAnswer(good, { nodes }), []);
  // Planted fault: the same answer with one link removed.
  const bad = good.replace(' (https://example.com/r)', '');
  assert.equal(checkAnswer(bad, { nodes }).length, 1);
  assert.match(checkAnswer(bad)[0], /web fact without a link/);
  assert.equal(checkAnswer('Uses [[no/such/node]].', { nodes }).length, 1);
  // Commentary with no numbers needs no link; a bare percentage anywhere does.
  assert.deepEqual(checkAnswer('## From the web\nTreat vendor numbers with care.\n- 70% ([S](https://e.org))'), []);
  assert.match(checkAnswer('Most people, about 80%, agree.')[0], /statistic without a source/);
});

test('ask: a 401 yields the key message and appends chat.failed; the iterator never throws', async () => {
  const store = seeded();
  const client = createFakeClient({ respond: () => ({ error: Object.assign(new Error('401'), { status: 401 }) }) });
  const items = await collect(createEngine({ store, id: 'pm', client, models: MODELS }).ask({ text: 'hi' }));
  assert.deepEqual(items.at(-1), { type: 'error', error: KEY_REJECTED });
  const failed = store.list('pm').at(-1);
  assert.equal(failed.t, 'chat.failed');
  assert.equal(failed.error, KEY_REJECTED);
  assert.equal(failed.replyTo, store.list('pm').at(-2).msgId);
  assert.equal(store.read('pm').chat.at(-1).role, 'error');
});

test('ask: a refusal and an empty question are errors, not throws', async () => {
  const store = seeded();
  const client = createFakeClient({ respond: () => ({ text: '', stop_reason: 'refusal' }) });
  const engine = createEngine({ store, id: 'pm', client, models: MODELS });
  assert.match((await collect(engine.ask({ text: 'x' }))).at(-1).error, /declined/);
  assert.deepEqual(await collect(engine.ask({ text: '  ' })), [{ type: 'error', error: 'Ask a question first.' }]);
  assert.equal(client.calls.length, 1);
});

test('ask: the tool loop stops at 6 calls, the last with tool_choice none', async () => {
  const store = seeded();
  const client = createFakeClient({ respond: (_p, i) => ({ content: [toolUse(`t${i}`, 'search_map', { query: 'paint' })], stop_reason: 'tool_use' }) });
  const items = await collect(createEngine({ store, id: 'pm', client, models: MODELS }).ask({ text: 'loop' }));
  assert.equal(client.calls.length, 6);
  assert.deepEqual(client.calls[5].params.tool_choice, { type: 'none' });
  assert.equal(client.calls[4].params.tool_choice, undefined);
  assert.equal(items.at(-1).type, 'done');
});

test('ask: aborting stops the answer with chat.failed "Stopped."', async () => {
  const store = seeded();
  const client = createFakeClient({ chunkMs: 20, respond: () => ({ text: 'a long answer '.repeat(40) }) });
  const ac = new AbortController();
  const it = createEngine({ store, id: 'pm', client, models: MODELS }).ask({ text: 'go' }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  const items = await collect(it);
  assert.deepEqual(items.at(-1), { type: 'error', error: STOPPED });
  assert.equal(store.list('pm').at(-1).t, 'chat.failed');
});

test('token filter: split tokens resolve across chunks; plain brackets pass through', () => {
  /** @type {string[]} */ const seen = [];
  const f = createTokenFilter((inner) => { seen.push(inner); return inner === 'ok' ? '[[ok]]' : ''; });
  const out = ['see [', '[o', 'k]] and [[ba', 'd]] and [a](b) x[', '[unclosed\nline'].map((c) => f.push(c)).join('') + f.flush();
  assert.equal(out, 'see [[ok]] and  and [a](b) x[[unclosed\nline');
  assert.deepEqual(seen, ['ok', 'bad']);
});

test('search_map ranks the matching node first; get_node returns neighbours and handles unknown ids', () => {
  const o = seeded().read('pm');
  const index = buildIndex(o);
  const hits = index.search('adhesives');
  assert.ok(hits.length <= 8 && hits.length > 0);
  assert.equal(hits[0].id, ADHESIVES);
  assert.ok(hits[0].snippet && hits[0].path.includes('>'));
  // Planted fault: a nonsense query finds nothing.
  assert.deepEqual(index.search('zzqx'), []);
  const r = runTool('get_node', { id: ADHESIVES }, o, index, null);
  assert.equal(r.error, undefined);
  assert.ok(Array.isArray(r.result.neighbours));
  const miss = runTool('get_node', { id: 'nope/adhesive' }, o, index, null);
  assert.equal(miss.error, true);
  assert.ok(miss.result.didYouMean.length >= 1);
});

test('outline shows the tree with ids and the lens analog when a lens is active', () => {
  const store = seeded();
  store.append('pm', { t: 'lens.added', at: 1, lens: { id: 'chef', persona: 'a home chef', analogs: {} } });
  store.append('pm', { t: 'lens.analog', at: 2, lensId: 'chef', nodeId: ADHESIVES, label: 'Egg wash' });
  const o = store.read('pm');
  const plain = outline(o);
  assert.match(plain, /^- .*\(plastic-modeling\)/);
  assert.match(plain, new RegExp(`\\n {4}- .*\\(${ADHESIVES}\\)`));
  assert.ok(!plain.includes('Egg wash'));
  assert.match(outline(o, 'chef'), /\(plastic-modeling\/tools\/adhesives\).*≈ Egg wash/);
});

test('history pairs answered questions only, and linksIn finds markdown and bare URLs', () => {
  const o = { chat: [
    { role: 'user', chatId: 'main', msgId: 'q1', text: 'one' },
    { role: 'assistant', chatId: 'main', msgId: 'a1', replyTo: 'q1', text: 'ONE' },
    { role: 'user', chatId: 'main', msgId: 'q2', text: 'two' },
    { role: 'error', chatId: 'main', msgId: 'err:q2', replyTo: 'q2', text: 'boom' },
    { role: 'user', chatId: 'other', msgId: 'q3', text: 'three' },
    { role: 'assistant', chatId: 'other', msgId: 'a3', replyTo: 'q3', text: 'THREE' },
  ] };
  assert.deepEqual(historyMessages(o, 'main', 'q9'), [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'ONE' }]);
  assert.deepEqual(linksIn('see [A](https://a.org/x) and https://b.org/y.').map((l) => l.url), ['https://a.org/x', 'https://b.org/y']);
});
