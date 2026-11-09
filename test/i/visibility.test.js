// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// Visibility: one private source makes the map private for life; fuse inherits it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createEngine } from '../../src/core/engine/index.js';
import { fold, emptyOntology, makeEvent } from '../../src/core/events.js';
import { createSources } from '../../src/server/sources.js';
import { createFakeClient, createMemoryStore, lines } from '../c/fake.js';
import { buildStubServer } from './fixtures/stub-mcp.js';

const ACTOR = { id: 'token:ci', kind: 'service' };
const BRIEF = { context: 'glue', subject: 'Glue', scope: 'sticking things', purpose: 'learn', level: 'beginner' };
const raisedEvent = (/** @type {string[]} */ sources, reason = 'source') => makeEvent('visibility.raised', { to: 'private', reason, sources }, 0);

const sysOf = (/** @type {any} */ p) => (typeof p.system === 'string' ? p.system : p.system.map((/** @type {any} */ b) => b.text).join('\n'));
const hasResult = (/** @type {any} */ p) => p.messages.some((/** @type {any} */ m) => Array.isArray(m.content) && m.content.some((/** @type {any} */ b) => b.type === 'tool_result'));
const toolUse = (/** @type {string} */ id) => ({ type: 'tool_use', id, name: 'wiki__search', input: { query: 'glue' } });

// ---- fold ----------------------------------------------------------------------------------------

/** Problems where a fold step lowers visibility or shrinks privateSources. @param {any[]} events @param {(o: any, e: any) => any} [foldFn] */
export function lowered(events, foldFn = fold) {
  /** @type {string[]} */ const problems = [];
  let o = emptyOntology();
  events.forEach((e, i) => {
    const next = foldFn(o, e);
    if (o.visibility === 'private' && next.visibility !== 'private') problems.push(`#${i} ${e.t} lowered visibility`);
    if (o.privateSources.some((/** @type {string} */ s) => !next.privateSources.includes(s))) problems.push(`#${i} ${e.t} dropped a private source`);
    o = next;
  });
  return problems;
}

test('fold: raised makes the map private with sorted, deduplicated sources; nothing lowers it', () => {
  const empty = emptyOntology();
  assert.equal(empty.visibility, 'public');
  assert.deepEqual(empty.privateSources, []);

  const created = makeEvent('ontology.created', { name: 'g', root: 'g', brief: BRIEF, categories: [] }, 0);
  const events = [created, raisedEvent(['b', 'a', 'b']), raisedEvent(['a', 'c']),
    { t: 'visibility.raised', at: 1, to: 'public', sources: [] }, { t: 'visibility.raised', at: 1, to: 'public', reason: 'source', sources: ['a'] },
    created];
  let o = emptyOntology();
  for (const e of events.slice(0, 2)) o = fold(o, e);
  assert.equal(o.visibility, 'private');
  assert.deepEqual(o.privateSources, ['a', 'b']);
  o = events.slice(2).reduce(fold, o);
  assert.equal(o.visibility, 'private');
  assert.deepEqual(o.privateSources, ['a', 'b', 'c']);
  assert.deepEqual(lowered(events), []);

  // planted fault: a fold that lets a later event set public is reported
  /** @param {any} o @param {any} e */
  const badFold = (o, e) => (e.to === 'public' ? { ...fold(o, e), visibility: 'public' } : fold(o, e));
  assert.ok(lowered(events, badFold).length > 0);
  // planted fault: a fold that lets ontology.created reset the sources
  const resetting = (/** @type {any} */ o, /** @type {any} */ e) => (e.t === 'ontology.created' ? { ...fold(o, e), visibility: 'public', privateSources: [] } : fold(o, e));
  assert.ok(lowered(events, resetting).length > 0);
});

// ---- the build -----------------------------------------------------------------------------------

async function connect(/** @type {any} */ e) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildStubServer({ name: e.name }).connect(b);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(a);
  return client;
}
const wiki = (/** @type {'public'|'private'} */ visibility) => ({ name: 'wiki', url: 'https://wiki.example/mcp', visibility, allowTools: ['search', 'get'] });

/** A model that asks for the source tool on wave 0, wave 1, research and chat turns, then writes. @param {any} params */
function scripted(params) {
  const sys = sysOf(params);
  const prompt = typeof params.messages[0].content === 'string' ? params.messages[0].content : '';
  const wantsTool = !hasResult(params) && (params.tools ?? []).length > 0;
  if (wantsTool) return { content: [toolUse(`tu${Math.random().toString(36).slice(2)}`)], stop_reason: 'tool_use' };
  if (sys.includes('top-level categories')) return { text: lines(['Types', 'Uses'].map((label) => ({ label, summary: 's', hook: 'h' }))) };
  if (sys.includes('children of one category')) {
    const label = /The category to expand: (.+)/.exec(prompt)?.[1] ?? 'X';
    return { text: lines([{ label: `${label} One`, parent: label }]) };
  }
  if (sys.includes('Task: research one node') || sys.includes('reference-book picture')) return { text: lines([{ label: 'Fresh Idea', summary: 's', hook: 'h' }]) };
  if (sys.includes('You fuse two concept maps')) return { text: lines([{ name: 'mix' }, { hybrid: 'Blend', summary: 's', hook: 'h' }]) };
  if (sys.includes('hidden connections')) return { text: '' };
  return { text: 'An answer.' };
}

/** Problems in a build's events for one private source. @param {any[]} events @param {string[]} sources @param {any} [actor] */
export function raiseProblems(events, sources, actor) {
  /** @type {string[]} */ const problems = [];
  const idx = events.flatMap((e, i) => (e.t === 'visibility.raised' ? [i] : []));
  if (idx.length !== 1) return [`${idx.length} visibility.raised events, expected 1`];
  const e = events[idx[0]];
  if (e.to !== 'private' || e.reason !== 'source' || JSON.stringify(e.sources) !== JSON.stringify(sources)) problems.push(`wrong event ${JSON.stringify(e)}`);
  if (actor && JSON.stringify(e.actor) !== JSON.stringify(actor)) problems.push('raised event has no actor');
  const firstCat = events.findIndex((x) => x.t === 'node.added' && x.node.createdBy === 'wave0' && x.node.depth === 1);
  if (firstCat !== -1 && idx[0] > firstCat) problems.push('raised after the first category node');
  return problems;
}

/** @param {'public'|'private'} visibility */
async function buildWith(visibility) {
  const store = createMemoryStore();
  const fake = createFakeClient({ respond: scripted, chunkMs: 0 });
  const engine = createEngine({ store, id: 't', client: fake });
  const sources = createSources([wiki(visibility)], { connect });
  const toolset = await sources.toolset({ scopes: ['read'] }, ['wiki']);
  assert.ok(toolset);
  await engine.build(BRIEF, { actor: ACTOR, tools: toolset });
  return { store, engine, toolset, sources, events: () => store.list('t') };
}

test('a private source used in a build raises once, before the first category node; later jobs add no second', async () => {
  const t = await buildWith('private');
  try {
    assert.deepEqual(raiseProblems(t.events(), ['wiki'], ACTOR), []);
    assert.equal(t.store.read('t').visibility, 'private');
    assert.deepEqual(t.store.read('t').privateSources, ['wiki']);
    // planted fault: the raise moved after the first category node is reported
    const ev = t.events();
    const at = ev.findIndex((e) => e.t === 'visibility.raised');
    const late = [...ev.slice(0, at), ...ev.slice(at + 1)];
    late.splice(late.findIndex((e) => e.t === 'node.added' && e.node.createdBy === 'wave0' && e.node.depth === 1) + 1, 0, ev[at]);
    assert.ok(raiseProblems(late, ['wiki'], ACTOR).length > 0);
    // planted fault: a second event for the same name is reported
    assert.ok(raiseProblems([...ev, ev[at]], ['wiki'], ACTOR).length > 0);

    // a later job on the same map (a new run) uses the private source again: no second event
    const engine = createEngine({ store: t.store, id: 't', client: createFakeClient({ respond: scripted, chunkMs: 0 }) });
    engine.enqueue({ kind: 'research', nodeId: 'glue', mode: 'context' }, { priority: 10, actor: ACTOR, tools: t.toolset });
    await engine.idle();
    assert.ok(t.events().some((e) => e.t === 'node.added' && e.node.createdBy === 'research'));
    assert.equal(t.events().filter((e) => e.t === 'visibility.raised').length, 1);
  } finally { await t.sources.close(); }
});

test('a public source never raises', async () => {
  const t = await buildWith('public');
  try {
    assert.ok(t.events().some((e) => e.t === 'node.added' && e.node.createdBy === 'wave0' && e.node.depth === 1));
    assert.equal(t.events().filter((e) => e.t === 'visibility.raised').length, 0);
    assert.equal(t.store.read('t').visibility, 'public');
    // planted fault: the same events from a private source are reported by the check that wants zero
    const priv = await buildWith('private');
    try {
      const raises = (/** @type {any[]} */ evs) => evs.filter((e) => e.t === 'visibility.raised').length;
      assert.equal(raises(t.events()), 0);
      assert.equal(raises(priv.events()), 1);
    } finally { await priv.sources.close(); }
  } finally { await t.sources.close(); }
});

// ---- fuse ----------------------------------------------------------------------------------------

const fixture = (/** @type {string} */ name) => readFileSync(new URL(`../../fixtures/${name}.events.jsonl`, import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Problems in a fused draft's events. @param {any[]} events @param {string[]} privateSources the inputs' union, [] when both public */
export function fuseProblems(events, privateSources) {
  /** @type {string[]} */ const problems = [];
  const raised = events.filter((e) => e.t === 'visibility.raised');
  const folded = events.reduce(fold, emptyOntology());
  if (!privateSources.length) {
    if (raised.length) problems.push('a public fuse raised');
    if (folded.visibility !== 'public') problems.push('a public fuse is not public');
    return problems;
  }
  if (events[1]?.t !== 'visibility.raised' || events[1].reason !== 'fuse') problems.push('no fuse raise right after ontology.created');
  if (folded.visibility !== 'private') problems.push('the draft is not private');
  if (JSON.stringify(folded.privateSources) !== JSON.stringify(privateSources)) problems.push(`draft sources ${JSON.stringify(folded.privateSources)}`);
  return problems;
}

/** @param {{ pm?: string[], manga?: string[] }} priv private sources to raise on each input */
async function fused(priv, actor = undefined) {
  const store = createMemoryStore();
  let n = 0;
  Object.assign(store, { createDraft: () => `draft-${++n}` });
  for (const [id, name] of /** @type {const} */ ([['pm', 'plastic-modeling'], ['manga', 'manga']])) {
    for (const e of fixture(name)) store.append(id, e);
    if (priv[id]?.length) store.append(id, raisedEvent(priv[id]));
  }
  const engine = createEngine({ store, id: 'pm', client: createFakeClient({ respond: scripted, chunkMs: 0 }) });
  const draft = await engine.fuse('pm', 'manga', actor ? { actor } : undefined);
  return store.list(draft);
}

test('fuse inherits the stricter side: private input gives a private draft, public inputs do not', async () => {
  const ev = await fused({ manga: ['wiki'] }, ACTOR);
  assert.deepEqual(fuseProblems(ev, ['wiki']), []);
  assert.equal(ev[0].t, 'ontology.created');
  assert.deepEqual(ev[1].actor, ACTOR);
  assert.deepEqual([ev[1].to, ev[1].reason, ev[1].sources], ['private', 'fuse', ['wiki']]);
  // the union of both inputs, sorted
  assert.deepEqual(fuseProblems(await fused({ pm: ['zeta'], manga: ['wiki'] }), ['wiki', 'zeta']), []);
  // fuse(public, public) appends none
  assert.deepEqual(fuseProblems(await fused({}), []), []);
  // planted fault: a draft that drops the flag is reported
  const dropped = ev.filter((e) => e.t !== 'visibility.raised');
  assert.ok(fuseProblems(dropped, ['wiki']).length > 0);
  // planted fault: a public fuse that raises is reported
  assert.ok(fuseProblems(ev, []).length > 0);
});

// ---- ask -----------------------------------------------------------------------------------------

test('ask with a private source tool raises the map before chat.answered', async () => {
  const store = createMemoryStore();
  for (const e of fixture('plastic-modeling')) store.append('pm', e);
  const sources = createSources([wiki('private')], { connect });
  try {
    const toolset = await sources.toolset({ scopes: ['read'] }, ['wiki']);
    const engine = createEngine({ store, id: 'pm', client: createFakeClient({ respond: scripted, chunkMs: 0 }) });
    for await (const _ of engine.ask({ text: 'Which glue?' }, { actor: ACTOR, tools: toolset })) { /* consume */ }
    const ev = store.list('pm');
    /** @param {any[]} events */
    const order = (events) => {
      const r = events.findIndex((e) => e.t === 'visibility.raised');
      const a = events.findIndex((e) => e.t === 'chat.answered');
      return a === -1 ? ['no chat.answered'] : r === -1 ? ['never raised'] : r < a ? [] : ['raised after chat.answered'];
    };
    assert.deepEqual(order(ev), []);
    assert.deepEqual(store.read('pm').privateSources, ['wiki']);
    assert.deepEqual(ev.find((e) => e.t === 'visibility.raised').actor, ACTOR);
    // planted faults: a raise after the answer, and no raise at all
    const r = ev.findIndex((e) => e.t === 'visibility.raised');
    assert.deepEqual(order([...ev.slice(0, r), ...ev.slice(r + 1), ev[r]]), ['raised after chat.answered']);
    assert.deepEqual(order(ev.filter((e) => e.t !== 'visibility.raised')), ['never raised']);
  } finally { await sources.close(); }
});
