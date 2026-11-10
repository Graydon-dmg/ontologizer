// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// How an agent reads a map that has one explained node among many (the usual state of a new map):
// get_context carries the article and every node id, says when it trimmed and when the map is mostly
// one line; get_node lists each source once and the links that leave a category's branch; get_outline
// marks explained nodes; the descriptions of get_context, ask_map and list_maps say what they do.
// The map is made by the real engine (explain on a category node) with a fake model client.
// Every check returns a list of problems and has a planted fault it must report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createEngine } from '../../src/core/engine/index.js';
import { contextPack } from '../../src/core/export/context.js';
import { exportMap } from '../../src/core/export/index.js';
import { openStore } from '../../src/core/store.js';
import { outlineText, nodeForAgent } from '../../src/server/reads.js';
import { opByName } from '../../src/ops.js';
import { toolList } from '../../src/server/mcp.js';
import { createFakeClient, createMemoryStore, lines, searchBlock } from '../c/fake.js';
import { boot, tempHome } from './helpers-service.js';

const CAT = 'plastic-modeling/tools'; // a category node: its cross-links all sit on the nodes under it
const PLAIN = 'plastic-modeling/tools/adhesives';
const LEAF = 'plastic-modeling/tools/adhesives/plastic-cement';
const ARTICLE = { summary: 'The hand tools a modeler uses, from nippers to sanding sticks.', keyFacts: ['Sprue nippers cut parts from the runner cleanly.', 'Hobby knives clean up the nub left behind.'], whyItMatters: 'Clean parts make every later step easier.', seeAlso: [] };
const R2 = [{ title: 'Tools guide', url: 'https://one.example/tools' }, { title: 'Starter kit', url: 'https://two.example/kit' }];
const fixture = readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** The fixture map with CAT explained by the real engine's explain job (fake model client, fake web search). */
async function explainedMap() {
  const store = createMemoryStore();
  for (const e of fixture) store.append('pm', e);
  const fake = createFakeClient({ respond: () => ({ text: lines([ARTICLE]), content: [searchBlock(R2)] }), chunkMs: 0 });
  const engine = createEngine({ store, id: 'pm', client: fake });
  engine.enqueue({ kind: 'explain', nodeId: CAT }, { priority: 10 });
  await engine.idle();
  return { map: store.read('pm'), events: store.list('pm'), fake };
}
const built = explainedMap();

const lastLine = (/** @type {string} */ t) => t.trimEnd().split('\n').pop() ?? '';
/** The lines of one section of a pack. @param {string} text @param {string} name */
const sectionOf = (text, name) => {
  const ls = text.split('\n');
  const i = ls.indexOf(`## ${name}`);
  if (i < 0) return [];
  const j = ls.findIndex((l, k) => k > i && l.startsWith('## '));
  return ls.slice(i + 1, j < 0 ? undefined : j).filter((l) => l.trim());
};

// ---------- 1. articles in the pack, ranked ahead of the outline's summaries ----------

/** @param {string} text @param {any} map @returns {string[]} */
export function articleProblems(text, map) {
  const p = [];
  const note = lastLine(text).startsWith('_Trimmed') ? lastLine(text) : '';
  const arts = sectionOf(text, 'Articles');
  const outline = sectionOf(text, 'Outline');
  const anySummary = outline.some((l) => /\): /.test(l));
  for (const n of Object.values(map.nodes)) {
    const a = /** @type {any} */ (n).article;
    if (!a) continue;
    const id = /** @type {any} */ (n).id;
    const head = arts.find((l) => l.startsWith(`- ${/** @type {any} */ (n).label} (${id}): `));
    if (!head) {
      if (!/\barticles\b/.test(note)) p.push(`article of ${id} missing and the trim line does not say so`);
      if (anySummary) p.push(`article of ${id} dropped while outline summaries remain`);
      continue;
    }
    if (!head.includes(a.summary.slice(0, 40))) p.push(`article of ${id} lacks its summary`);
    const facts = [...a.keyFacts, `Why it matters: ${a.whyItMatters}`];
    if (!facts.every((f) => arts.includes(`  - ${f}`))) {
      if (!/key facts/.test(note)) p.push(`key facts of ${id} missing and the trim line does not say so`);
      if (anySummary) p.push(`key facts of ${id} dropped while outline summaries remain`);
    }
  }
  return p;
}

test('get_context carries the explained node\'s article in full at a roomy budget, and keeps it while summaries go', async () => {
  const { map } = await built;
  const full = contextPack(map, { budget: 20000 });
  assert.deepEqual(articleProblems(full, map), []);
  assert.ok(full.includes(`- Tools (${CAT}): ${ARTICLE.summary}`));
  assert.ok(full.includes(`  - ${ARTICLE.keyFacts[0]}`));
  // A budget that cuts outline summaries still keeps the article whole.
  const tight = contextPack(map, { budget: 2200 });
  assert.match(lastLine(tight), /summaries/);
  assert.ok(sectionOf(tight, 'Outline').some((l) => /\): /.test(l)), 'some summaries remain');
  assert.deepEqual(articleProblems(tight, map), []);
  assert.ok(tight.includes(`  - ${ARTICLE.keyFacts[1]}`));
  // Smaller still, facts and then the article go, and the last line says so.
  for (const b of [1600, 1100]) assert.deepEqual(articleProblems(contextPack(map, { budget: b }), map), [], `budget ${b}`);
});

test('planted fault: a pack without the article (the old pack) is reported, as is one that drops it before summaries', async () => {
  const { map } = await built;
  const full = contextPack(map, { budget: 20000 });
  const noArticles = full.split('\n').filter((l, i, ls) => !(ls.slice(0, i).includes('## Articles') && !ls.slice(0, i).includes('## Bridges') && l.trim() && !l.startsWith('## '))).join('\n');
  assert.ok(articleProblems(noArticles, map).some((x) => x.includes('missing')));
  assert.ok(articleProblems(noArticles + '\n_Trimmed to fit 1 tokens: 1 of 1 articles._\n', map).some((x) => x.includes('while outline summaries remain')));
});

// ---------- 2. node ids in the pack's outline ----------

/** Every outline line's id, resolved ("…/x" under a parent) and checked against the map. @param {string} text @param {any} map */
export function idProblems(text, map) {
  const p = [];
  /** @type {string[]} */ const stack = [];
  let seen = 0;
  for (const l of sectionOf(text, 'Outline')) {
    const m = l.match(/^((?: {2})*)- (.+?) \(((?:…\/)?[\w.:/-]+)\)(?::| \[|$)/);
    // A label may itself end in "(…)" ("Local clubs (IPMS)"): an id is a path, or the root's id.
    if (!m || (!m[3].includes('/') && m[3] !== map.root)) { p.push(`no id: ${l}`); continue; }
    const depth = m[1].length / 2;
    const id = m[3].startsWith('…/') ? `${stack[depth - 1]}/${m[3].slice(2)}` : m[3];
    stack[depth] = id;
    stack.length = depth + 1;
    const n = map.nodes[id];
    if (!n) p.push(`id ${id} (${m[2]}) is not in the map`);
    else if (n.label !== m[2]) p.push(`id ${id} is "${n.label}", the line says "${m[2]}"`);
    else seen++;
  }
  const note = lastLine(text);
  if (seen < Object.keys(map.nodes).length && !/node ids|outline depth|categories/.test(note)) p.push(`${Object.keys(map.nodes).length - seen} nodes have no id and the trim line does not say so`);
  return p;
}

test('get_context gives every node\'s id after its label, compactly; ids go before labels when the budget is small', async () => {
  const { map } = await built;
  const full = contextPack(map, { budget: 20000 });
  assert.deepEqual(idProblems(full, map), []);
  assert.ok(full.includes(`  - Tools (…/tools): `), 'a child shows only its own part of the path');
  assert.ok(full.includes('- Ids: '), 'the Brief says how to read them');
  for (const b of [3000, 1500, 1100, 900]) {
    const t = contextPack(map, { budget: b });
    assert.deepEqual(idProblems(t, map).filter((x) => !x.startsWith('no id')), [], `budget ${b}`);
  }
  // The other exports do not change: the page and embed carry the map as data, not the pack.
  const embed = exportMap(map, { format: 'embed', bundle: '/* bundle */' });
  assert.ok(!embed.includes('- Ids: ') && !embed.includes('## Articles'));
  assert.equal(exportMap(map, { format: 'context', budget: 20000 }), full);
});

test('planted fault: a wrong id, a missing id and a pack without ids are reported', async () => {
  const { map } = await built;
  const full = contextPack(map, { budget: 20000 });
  assert.ok(idProblems(full.replace('(…/tools)', '(…/paints)'), map).some((x) => x.includes('the line says "Tools"') || x.includes('not in the map')));
  assert.ok(idProblems(full.replace(' (…/tools)', ''), map).some((x) => x.startsWith('no id')));
  const noIds = full.replace(/ \((?:…\/)?[\w.:/-]+\)(?=:| \[|$)/gm, '');
  assert.ok(idProblems(noIds, map).length >= Object.keys(map.nodes).length);
});

// ---------- 3. the trim line: the description and the pack agree ----------

/** @param {string} description @param {string} whole a pack with nothing trimmed @param {string} cut a trimmed pack */
export function trimClaimProblems(description, whole, cut) {
  const p = [];
  if (lastLine(whole).startsWith('_Trimmed')) p.push('a pack with nothing trimmed has a trim line');
  if (!lastLine(cut).startsWith('_Trimmed')) p.push('a trimmed pack has no trim line');
  if (/its last line says what was trimmed/.test(description)) p.push('the description promises a trim line on every pack');
  if (!/When anything was trimmed[^.]*last line says what/.test(description)) p.push('the description does not say when the trim line appears');
  if (!/without that line the whole map is there/.test(description)) p.push('the description does not say what no trim line means');
  return p;
}

test('get_context: the last line says what was trimmed when anything was, and the description says exactly that', async () => {
  const { map } = await built;
  const d = /** @type {any} */ (opByName('get_context')).mcp.description;
  assert.deepEqual(trimClaimProblems(d, contextPack(map, { budget: 20000 }), contextPack(map, { budget: 1500 })), []);
  // Planted fault: the old description, which promised the line on every pack.
  const old = 'Returns markdown text; its last line says what was trimmed. Free: no model call.';
  assert.ok(trimClaimProblems(old, contextPack(map, { budget: 20000 }), contextPack(map, { budget: 1500 })).length >= 2);
});

// ---------- 4. get_node on an explained category ----------

/** @param {any} r get_node's result @param {any} map */
export function nodeProblems(r, map) {
  const p = [];
  const urls = r.sources.map((/** @type {any} */ s) => s.url);
  if (new Set(urls).size !== urls.length) p.push(`sources repeat: ${urls.join(', ')}`);
  const direct = map.edges.filter((/** @type {any} */ e) => e.from === r.id || e.to === r.id).length;
  if (r.neighbours.length !== direct) p.push(`${r.neighbours.length} neighbours, ${direct} direct edges`);
  const inBranch = (/** @type {string} */ id) => id.startsWith(`${r.id}/`);
  const leaving = map.edges.filter((/** @type {any} */ e) => inBranch(e.from) !== inBranch(e.to) && e.from !== r.id && e.to !== r.id);
  if (r.children.length && !Array.isArray(r.branchLinks)) p.push('no branchLinks on a node with children');
  else if (r.children.length && r.branchLinks.length !== Math.min(leaving.length, 20)) p.push(`${r.branchLinks?.length} branchLinks, ${leaving.length} links leave the branch`);
  return p;
}

test('get_node on an explained category: each source once, its branch\'s cross-links, its own neighbours', async () => {
  const { map } = await built;
  const r = nodeForAgent(map, CAT).result;
  assert.equal(typeof r.article, 'object');
  assert.deepEqual(nodeProblems(r, map), []);
  assert.deepEqual(r.sources.map((/** @type {any} */ s) => s.url), R2.map((s) => s.url));
  assert.equal(r.neighbours.length, 0, 'no edge touches the category itself');
  assert.ok(r.branchLinks.length >= 1);
  const l = r.branchLinks[0];
  assert.ok(l.from.label && l.to.label && l.type && 'why' in l);
  // A leaf has no branch; a node with children lists the links that leave it.
  assert.equal(nodeForAgent(map, LEAF).result.branchLinks, undefined);
  assert.deepEqual(nodeProblems(nodeForAgent(map, PLAIN).result, map), []);
});

test('planted fault: the old get_node (sources twice, no branch links) is reported', async () => {
  const { map } = await built;
  const r = nodeForAgent(map, CAT).result;
  const n = map.nodes[CAT];
  const old = { ...r, sources: [...n.sources, ...n.article.sources] };
  delete old.branchLinks;
  const got = nodeProblems(old, map);
  assert.ok(got.some((x) => x.startsWith('sources repeat')));
  assert.ok(got.some((x) => x.startsWith('no branchLinks')));
});

// ---------- 5. the outline marks explained nodes ----------

/** @param {string} text get_outline's text @param {any} map */
export function markerProblems(text, map) {
  const p = [];
  for (const l of text.split('\n')) {
    const m = l.match(/^\s*- .+? \(([\w.:/-]+)\)/);
    if (!m || !map.nodes[m[1]]) continue;
    const marked = l.endsWith(' [explained]');
    if (Boolean(map.nodes[m[1]].article) !== marked) p.push(`${m[1]}: ${marked ? 'marked but not explained' : 'explained but not marked'}`);
  }
  return p;
}

test('get_outline marks the explained node, and only it', async () => {
  const { map } = await built;
  const text = outlineText(map, 'pm');
  assert.deepEqual(markerProblems(text, map), []);
  assert.equal(text.split('\n').filter((l) => l.endsWith(' [explained]')).length, 1);
  // Planted faults: the old outline (no marker), and a marker on a plain node.
  assert.deepEqual(markerProblems(text.replace(' [explained]', ''), map), [`${CAT}: explained but not marked`]);
  const wrong = text.split('\n').map((l) => (l.includes(`(${PLAIN})`) ? `${l} [explained]` : l)).join('\n');
  assert.deepEqual(markerProblems(wrong, map), [`${PLAIN}: marked but not explained`]);
});

// ---------- 6. say plainly when the map is mostly one line, and name the next step ----------

/** @param {string} pack @param {any} nodeResult get_node on a node with no article @param {any} map */
export function nudgeProblems(pack, nodeResult, map) {
  const p = [];
  const all = Object.values(map.nodes);
  const plain = all.filter((n) => !(/** @type {any} */ (n).article)).length;
  const want = `- Depth: ${plain} of ${all.length} nodes are one-line summaries; call explain on the nodes your task depends on`;
  const has = sectionOf(pack, 'Brief').some((l) => l.startsWith(want));
  if (plain * 2 > all.length && !has) p.push('the pack does not say the map is mostly one line');
  if (plain * 2 <= all.length && sectionOf(pack, 'Brief').some((l) => l.startsWith('- Depth:'))) p.push('the pack nudges on a map that is mostly explained');
  if (nodeResult) {
    const a = String(nodeResult.article);
    if (!a.startsWith('Not explained yet') || !a.includes(`${plain} of ${all.length} nodes`) || !/call explain on it/.test(a) || !/costs credits/.test(a)) p.push(`get_node does not name the next step: ${a}`);
  }
  return p;
}

test('a mostly unexplained map says so in get_context and get_node, and names explain; nothing is explained for you', async () => {
  const { map, fake } = await built;
  const calls = fake.calls.length;
  const pack = contextPack(map, { budget: 4000 });
  const node = nodeForAgent(map, PLAIN).result;
  assert.deepEqual(nudgeProblems(pack, node, map), []);
  assert.ok(pack.includes('- Depth: 75 of 76 nodes are one-line summaries; call explain on the nodes your task depends on (it calls the model, so it costs credits).'));
  assert.equal(fake.calls.length, calls, 'reading never calls the model');
  // A map that is mostly explained carries no nudge.
  const rich = { ...map, nodes: Object.fromEntries(Object.entries(map.nodes).map(([id, n]) => [id, { ...n, article: n.article ?? { summary: 's', keyFacts: [], whyItMatters: '', seeAlso: [], sources: [] } }])) };
  assert.deepEqual(nudgeProblems(contextPack(rich, { budget: 200000 }), null, rich), []);
  // Planted faults: the old pack (no Depth line) and the old get_node text.
  const noNudge = pack.split('\n').filter((l) => !l.startsWith('- Depth:')).join('\n');
  assert.ok(nudgeProblems(noNudge, node, map).includes('the pack does not say the map is mostly one line'));
  const oldNode = { ...node, article: 'Not explained yet: the reader can click Explain on this node.' };
  assert.ok(nudgeProblems(pack, oldNode, map).some((x) => x.startsWith('get_node does not name the next step')));
});

// ---------- 7 and 8. ask_map and list_maps say what they do ----------

/** @param {any} tool ask_map as tools/list shows it */
export function askProblems(tool) {
  const p = [];
  if (!/added to the map's chat/.test(tool.description)) p.push('does not say it adds to the map\'s chat');
  if (!/everyone who can open the map sees/.test(tool.description)) p.push('does not say others see it');
  if (!/not a read/.test(tool.description)) p.push('does not say it is not a read');
  if (tool.annotations?.readOnlyHint !== false) p.push('claims to be read-only');
  if (tool.annotations?.idempotentHint !== false) p.push('claims to be idempotent');
  return p;
}

/** @param {any} tool list_maps as tools/list shows it */
export function listProblems(tool) {
  const p = [];
  if (!/updatedAt is when the map last changed, in milliseconds since 1970/.test(tool.description)) p.push('description does not explain updatedAt');
  if (!/draft id .*server's clock, usually UTC/.test(tool.description)) p.push('description does not say draft ids follow the server clock (UTC)');
  const row = tool.outputSchema?.properties?.maps?.items?.properties?.updatedAt;
  if (!row || row.type !== 'number' || !/milliseconds/.test(row.description ?? '')) p.push('output schema does not describe updatedAt');
  return p;
}

test('ask_map says it writes to the shared chat and is not read-only; list_maps documents updatedAt and draft ids', () => {
  const tools = toolList();
  const ask = tools.find((t) => t.name === 'ask_map');
  const list = tools.find((t) => t.name === 'list_maps');
  assert.deepEqual(askProblems(ask), []);
  assert.deepEqual(listProblems(list), []);
  // Planted faults: the 1.5.0 wording.
  assert.ok(askProblems({ ...ask, description: 'The question and answer are saved in the map\'s chat.' }).length >= 2);
  assert.ok(askProblems({ ...ask, annotations: { ...ask?.annotations, readOnlyHint: true } }).includes('claims to be read-only'));
  const oldList = { ...list, description: 'Returns { maps: [{ id, name, root, nodes, draft, visibility? }] }.', outputSchema: { properties: { maps: { items: { properties: { updatedAt: { type: 'number' } } } } } } };
  assert.equal(listProblems(oldList).length, 3);
});

// ---------- end to end, over MCP on a running server ----------

test('over MCP: get_context, get_outline, get_node and list_maps on a served map with one explained node', async () => {
  const { map, events } = await built;
  const home = tempHome();
  const store = openStore(home);
  store.importEvents('tools-map', events);
  store.flush?.();
  const { srv, origin } = await boot({ home });
  const c = new Client({ name: 'test', version: '1' });
  try {
    await c.connect(new StreamableHTTPClientTransport(new URL(`${origin}/v1/mcp`)));
    const text = (/** @type {any} */ r) => r.content.map((/** @type {any} */ x) => x.text).join('');
    const id = 'tools-map';
    const ctx = text(await c.callTool({ name: 'get_context', arguments: { id, budget: 20000 } }));
    assert.deepEqual([...articleProblems(ctx, map), ...idProblems(ctx, map)], []);
    assert.ok(!lastLine(ctx).startsWith('_Trimmed'));
    const outline = text(await c.callTool({ name: 'get_outline', arguments: { id } }));
    assert.deepEqual(markerProblems(outline, map), []);
    const cat = /** @type {any} */ (await c.callTool({ name: 'get_node', arguments: { id, nodeId: CAT } })).structuredContent ?? JSON.parse(text(await c.callTool({ name: 'get_node', arguments: { id, nodeId: CAT } })));
    assert.deepEqual(nodeProblems(cat, map), []);
    const leaf = JSON.parse(text(await c.callTool({ name: 'get_node', arguments: { id, nodeId: PLAIN } })));
    assert.deepEqual(nudgeProblems(ctx, leaf, map), []);
    const maps = /** @type {any} */ (await c.callTool({ name: 'list_maps', arguments: {} })).structuredContent.maps;
    assert.equal(typeof maps.find((/** @type {any} */ m) => m.id === id)?.updatedAt, 'number');
  } finally {
    await c.close().catch(() => {});
    await srv.close();
  }
});
