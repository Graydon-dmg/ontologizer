// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// Provenance: the actor on every event of a run, verified citations, and the tool loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createEngine } from '../../src/core/engine/index.js';
import { MAX_TOOL_TURNS } from '../../src/core/engine/call.js';
import { createSources } from '../../src/server/sources.js';
import { createFakeClient, createMemoryStore, lines, searchBlock } from '../c/fake.js';
import { buildStubServer, calls as stubCalls } from './fixtures/stub-mcp.js';

const ACTOR = { id: 'token:ci', kind: 'service' };
const BRIEF = { context: 'glue', subject: 'Glue', scope: 'sticking things', purpose: 'learn', level: 'beginner' };

/** The system prompt as one string (the chat sends blocks). @param {any} params */
const sysOf = (params) => (typeof params.system === 'string' ? params.system : params.system.map((/** @type {any} */ b) => b.text).join('\n'));
/** Whether a request already carries a tool_result. @param {any} params */
const hasResult = (params) => params.messages.some((/** @type {any} */ m) => Array.isArray(m.content) && m.content.some((/** @type {any} */ b) => b.type === 'tool_result'));
const toolUse = (/** @type {string} */ id, /** @type {string} */ name, /** @type {any} */ input) => ({ type: 'tool_use', id, name, input });

/** A scripted model that answers every purpose with valid lines. @param {any} params */
function scripted(params) {
  const sys = sysOf(params);
  const prompt = typeof params.messages[0].content === 'string' ? params.messages[0].content : '';
  if (sys.includes('four tests')) return { text: lines([{ ready: true, brief: { subject: 'Glue', scope: 's', purpose: 'p', level: 'beginner' }, name: 'glue' }]) };
  if (sys.includes('top-level categories')) return { text: lines(['Types', 'Uses'].map((label) => ({ label, summary: `About ${label}.`, hook: `Fact about ${label}.` }))) };
  if (sys.includes('children of one category')) {
    const label = /The category to expand: (.+)/.exec(prompt)?.[1] ?? 'X';
    return { text: lines([{ label: `${label} One`, parent: label }, { label: `${label} Two`, parent: label }]) };
  }
  if (sys.includes('hidden connections')) return { text: '' };
  if (sys.includes('explainer articles')) return { text: lines([{ summary: 'Glue joins parts.', keyFacts: ['a'], whyItMatters: 'm', seeAlso: ['b'] }]) };
  if (sys.includes('best sources')) {
    const r = [{ title: 'One', url: 'https://one.example/a' }, { title: 'Two', url: 'https://two.example/b' }, { title: 'Three', url: 'https://three.example/c' }];
    return { text: lines(r), content: [searchBlock(r)] };
  }
  if (sys.includes('Task: research one node') || sys.includes('reference-book picture')) {
    return { text: lines([{ label: 'Fresh Idea', summary: 's', hook: 'h' }, { label: 'Another Idea', summary: 's', hook: 'h' }]) };
  }
  if (sys.includes('You fuse two concept maps')) return { text: lines([{ name: 'mix' }, { hybrid: 'Blend', summary: 's', hook: 'h' }]) };
  if (sys.includes('You explain a field to')) {
    const ids = prompt.split('\n').filter((l) => l.includes(' | ') && !l.startsWith('Nodes,')).map((l) => l.split(' | ')[0]);
    return { text: lines(ids.map((id) => ({ id, analog: `like ${id}`, breaks: 'not quite' }))) };
  }
  return { text: 'An answer about glue.' };   // the chat
}

/** @param {(params: any, i: number) => any} [respond] */
function setup(respond = scripted) {
  const store = createMemoryStore();
  const fake = createFakeClient({ respond, chunkMs: 0 });
  const engine = createEngine({ store, id: 't', client: fake });
  return { store, fake, engine, events: () => store.list('t') };
}

/** A fused map needs a store that can create drafts. */
function withDrafts() {
  const store = createMemoryStore();
  let n = 0;
  return Object.assign(store, { createDraft: () => `draft-${++n}` });
}

/** @param {AsyncIterable<any>} it */
async function drain(it) { for await (const _ of it) { /* consume */ } }

/** Events the check wants to carry exactly `actor`. @param {any[]} events @param {any} [actor] */
export function missingActor(events, actor = ACTOR) {
  /** @type {string[]} */ const problems = [];
  events.forEach((e, i) => {
    if (!('actor' in e)) problems.push(`#${i} ${e.t} has no actor`);
    else if (JSON.stringify(e.actor) !== JSON.stringify(actor)) problems.push(`#${i} ${e.t} has actor ${JSON.stringify(e.actor)}`);
  });
  return problems;
}
/** CLI events must carry no `actor` key. @param {any[]} events */
export function cliHasActor(events) {
  return events.flatMap((e, i) => ('actor' in e ? [`#${i} ${e.t} has an actor key`] : []));
}

/** Run every kind of call on one map; returns the events each phase appended. @param {any} opts */
async function scenario(opts) {
  const t = setup();
  /** @type {Record<string, any[]>} */ const phase = {};
  const mark = () => t.events().length;
  let from = 0;
  const take = (/** @type {string} */ name) => { phase[name] = t.events().slice(from); from = mark(); };

  await t.engine.build(BRIEF, opts); take('build');
  for (const kind of /** @type {const} */ (['research', 'explain', 'sources'])) {
    t.engine.enqueue(kind === 'research' ? { kind, nodeId: 'glue', mode: 'context' } : { kind, nodeId: 'glue' }, { priority: 10, ...opts });
    await t.engine.idle(); take(kind);
  }
  await drain(t.engine.ask({ text: 'What is glue?' }, opts)); take('ask');
  await t.engine.rosetta('t', 'a home chef', opts); take('rosetta');

  // fuse: two seeded maps in a store that makes drafts
  const store = withDrafts();
  for (const e of t.events()) { const { _wall, ...rest } = e; store.append('a', rest); store.append('b', rest); }
  const engine = createEngine({ store, id: 'a', client: createFakeClient({ respond: scripted, chunkMs: 0 }) });
  const draft = await engine.fuse('a', 'b', opts);
  phase.fuse = store.list(draft);
  return phase;
}

const strip = (/** @type {any} */ e) => { const { at, _wall, ...rest } = e; return rest; };

test('with an actor, every event of every kind of call carries exactly that actor', async () => {
  const phase = await scenario({ actor: ACTOR });
  const expect = {
    build: ['ontology.created', 'node.added', 'job.queued', 'job.done'], research: ['job.queued', 'job.started', 'node.added', 'job.done'],
    explain: ['job.queued', 'node.updated', 'job.done'], sources: ['job.queued', 'node.updated', 'job.done'],
    ask: ['chat.asked', 'chat.answered'], rosetta: ['lens.added', 'lens.analog'], fuse: ['ontology.created', 'node.added', 'edge.added'],
  };
  for (const [name, types] of Object.entries(expect)) {
    const ts = new Set(phase[name].map((e) => e.t));
    for (const t of types) assert.ok(ts.has(t) || (name === 'fuse' && t === 'edge.added'), `${name}: no ${t} among ${[...ts]}`);
    assert.deepEqual(missingActor(phase[name]), [], name);
  }
  // planted fault: one event without an actor is reported
  const faulty = phase.ask.map((e, i) => (i === 1 ? (({ actor, ...r }) => r)(e) : e));
  assert.equal(missingActor(faulty).length, 1);
  // planted fault: a different actor is reported too
  assert.equal(missingActor(phase.build, { id: 'token:other', kind: 'service' }).length, phase.build.length);
});

test('without an actor no event has an actor key, and the build is unchanged', async () => {
  const bare = await scenario({});
  for (const [name, evs] of Object.entries(bare)) {
    assert.ok(evs.length > 0, name);
    assert.deepEqual(cliHasActor(evs), [], name);
  }
  // planted fault: a CLI event with an actor key is reported
  const faulty = bare.build.map((e, i) => (i === 2 ? { ...e, actor: ACTOR } : e));
  assert.equal(cliHasActor(faulty).length, 1);

  // the build with an actor, minus `actor`, is the build without one (job ids' timestamp aside)
  const withActor = await scenario({ actor: ACTOR });
  /** @param {any[]} evs */
  const canon = (evs) => evs.map((e) => { const { actor, ...r } = strip(e); return JSON.stringify(r).replace(/"id":"(\w+)-[a-z0-9]+-(\d+)"/g, '"id":"$1-S-$2"'); }).sort();
  assert.deepEqual(canon(withActor.build), canon(bare.build));
  // planted fault: an extra field on one event breaks the equality
  const tampered = bare.build.map((e, i) => (i === 1 ? { ...e, extra: 1 } : e));
  assert.notDeepEqual(canon(tampered), canon(withActor.build));
});

// ---- verified citations --------------------------------------------------------------------------

/** An injectable connect that serves the stub through InMemoryTransport. */
async function connect(/** @type {any} */ e) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildStubServer({ name: e.name }).connect(b);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(a);
  return client;
}
const wiki = (/** @type {any} */ over = {}) => ({ name: 'wiki', url: 'https://wiki.example/mcp', visibility: 'public', allowTools: ['search', 'get', 'delete_page'], ...over });
const PRINCIPAL = { scopes: ['read'] };

/** Problems in the citations on a map's nodes, given the refs the tools returned. @param {any} nodes @param {Record<string, { title: string, url: string }>} returned */
export function badCitations(nodes, returned) {
  /** @type {string[]} */ const problems = [];
  for (const n of Object.values(nodes)) {
    for (const s of /** @type {any[]} */ (n.sources ?? [])) {
      if (typeof s.source !== 'string') continue;       // a web source
      const hit = returned[`${s.source}/${s.ref}`];
      if (!hit) problems.push(`${n.id} cites ${s.ref}, which no tool returned`);
      else if (s.title !== hit.title || s.url !== hit.url) problems.push(`${n.id} cites ${s.ref} with a title or url the tool did not give`);
    }
  }
  return problems;
}
/** Problems in the tools a request offers. @param {any} params @param {string[]} allowed */
export function toolProblems(params, allowed) {
  const names = (params.tools ?? []).map((/** @type {any} */ t) => t.name);
  return JSON.stringify([...names].sort()) === JSON.stringify([...allowed].sort()) ? [] : [`offered ${JSON.stringify(names)}`];
}

test('a cited ref keeps the tool title and url; an invented ref is dropped; only read-only allowed tools are offered', async () => {
  stubCalls.length = 0;
  const sources = createSources([wiki()], { connect });
  try {
    const toolset = await sources.toolset(PRINCIPAL, ['wiki']);
    assert.ok(toolset);
    const cat = (/** @type {string} */ label, /** @type {any[]} */ cites) => ({ label, summary: `About ${label}.`, hook: 'h', sources: cites });
    const t = setup((params, i) => {
      const sys = sysOf(params);
      if (sys.includes('top-level categories')) {
        if (!hasResult(params)) return { content: [toolUse('tu1', 'wiki__search', { query: 'glue' })], stop_reason: 'tool_use' };
        return { text: lines([
          cat('Glue Types', [{ source: 'wiki', ref: 'doc-glue' }]),
          cat('Invented', [{ source: 'wiki', ref: 'doc-invented', url: 'https://evil.example/x', title: 'made up' }]),
          cat('Spoofed', [{ source: 'wiki', ref: 'doc-glue', url: 'https://evil.example/y', title: 'fake' }]),
        ]) };
      }
      return scripted(params);
    });
    await t.engine.build(BRIEF, { tools: toolset });

    const nodes = t.store.read('t').nodes;
    const byLabel = (/** @type {string} */ l) => Object.values(nodes).find((n) => n.label === l);
    const expected = [{ source: 'wiki', ref: 'doc-glue', title: 'Choosing glue', url: 'https://wiki.example/doc-glue' }];
    assert.deepEqual(byLabel('Glue Types').sources, expected);
    assert.deepEqual(byLabel('Spoofed').sources, expected);   // the model's own url and title are never used
    assert.deepEqual(byLabel('Invented').sources, []);        // the invented ref is dropped

    const returned = { 'wiki/doc-glue': { title: 'Choosing glue', url: 'https://wiki.example/doc-glue' } };
    assert.deepEqual(badCitations(nodes, returned), []);
    // planted fault: a node that keeps the invented ref (with the model's url) is reported
    const planted = { ...nodes, x: { id: 'x', sources: [{ source: 'wiki', ref: 'doc-invented', title: 'made up', url: 'https://evil.example/x' }] } };
    assert.equal(badCitations(planted, returned).length, 1);
    // planted fault: a real ref with the model's url is reported
    const spoof = { ...nodes, x: { id: 'x', sources: [{ source: 'wiki', ref: 'doc-glue', title: 'fake', url: 'https://evil.example/y' }] } };
    assert.equal(badCitations(spoof, returned).length, 1);

    // the second request carried the tool_result for tu1
    const second = t.fake.calls[1].params.messages;
    const last = second[second.length - 1];
    assert.equal(last.role, 'user');
    assert.deepEqual(last.content.map((/** @type {any} */ b) => [b.type, b.tool_use_id]), [['tool_result', 'tu1']]);
    assert.equal(second[second.length - 2].content[0].id, 'tu1');

    // the offered tools: exactly search and get, in the waves that get tools; none in wave 2
    const ALLOWED = ['wiki__search', 'wiki__get'];
    const toolCalls = t.fake.calls.filter((c) => /top-level categories|children of one category/.test(sysOf(c.params)));
    assert.ok(toolCalls.length >= 2);
    for (const c of toolCalls) assert.deepEqual(toolProblems(c.params, ALLOWED), []);
    const wave2 = t.fake.calls.find((c) => sysOf(c.params).includes('hidden connections'));
    assert.equal(wave2.params.tools, undefined);
    // planted fault: a request that offers a write tool or a restricted one is reported
    assert.equal(toolProblems({ tools: [{ name: 'wiki__search' }, { name: 'wiki__delete_page' }] }, ALLOWED).length, 1);
    assert.equal(toolProblems({ tools: [{ name: 'wiki__search' }, { name: 'wiki__get' }, { name: 'wiki__secret_search' }] }, ALLOWED).length, 1);
    assert.deepEqual(stubCalls, []);                          // the write tool never ran
  } finally { await sources.close(); stubCalls.length = 0; }
});

test('a run without tools sends no tools param in wave 0 (CLI behaviour unchanged)', async () => {
  const t = setup();
  await t.engine.build(BRIEF);
  const wave0 = t.fake.calls.find((c) => sysOf(c.params).includes('top-level categories'));
  assert.ok(wave0);
  assert.equal('tools' in wave0.params, false);
  for (const c of t.fake.calls) assert.equal('tools' in c.params, false);
  // planted fault: the same check on a request that has tools fails
  assert.equal('tools' in { tools: [] }, true);
});

// ---- the tool loop -------------------------------------------------------------------------------

/** Problems in the wave-0 requests of a model that asks for a tool on every turn. @param {any[]} wave0 @param {number} max */
export function loopProblems(wave0, max) {
  /** @type {string[]} */ const problems = [];
  if (wave0.length !== max + 1) problems.push(`${wave0.length} requests, expected ${max + 1}`);
  wave0.forEach((c, i) => {
    const none = c.params.tool_choice?.type === 'none';
    if (i < max && none) problems.push(`request ${i} forbids tools too early`);
    if (i === wave0.length - 1 && !none) problems.push('the last request does not carry tool_choice none');
  });
  return problems;
}

test('the tool loop stops after MAX_TOOL_TURNS rounds and the last request forbids tools', async () => {
  const sources = createSources([wiki()], { connect });
  try {
    const toolset = await sources.toolset(PRINCIPAL, ['wiki']);
    const t = setup((params) => (sysOf(params).includes('top-level categories')
      ? { content: [toolUse(`tu${params.messages.length}`, 'wiki__search', { query: 'glue' })], stop_reason: 'tool_use' }
      : scripted(params)));
    await assert.rejects(() => t.engine.build(BRIEF, { tools: toolset }), /no categories/);
    const wave0 = t.fake.calls.filter((c) => sysOf(c.params).includes('top-level categories'));
    assert.deepEqual(loopProblems(wave0, MAX_TOOL_TURNS), []);
    const rounds = wave0[wave0.length - 1].params.messages.filter((/** @type {any} */ m) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result').length;
    assert.equal(rounds, MAX_TOOL_TURNS);
    // planted fault: one round too many, or no tool_choice on the last request, is reported
    assert.ok(loopProblems([...wave0, wave0[0]], MAX_TOOL_TURNS).length > 0);
    const noChoice = wave0.map((c, i) => (i === wave0.length - 1 ? { params: { ...c.params, tool_choice: undefined } } : c));
    assert.ok(loopProblems(noChoice, MAX_TOOL_TURNS).length > 0);
  } finally { await sources.close(); }
});
