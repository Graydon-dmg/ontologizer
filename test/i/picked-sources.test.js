// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// Picked sources: the build's wave 0 and wave 1 prompts say which sources the reader chose (only when the
// run has source tools), and a map that already has its ontology.created is not created or raised again.
// Every check is a function that returns problems; each has a planted fault proving it can fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine/index.js';
import { UNTRUSTED } from '../../src/core/engine/run.js';
import { makeEvent } from '../../src/core/events.js';
import { createFakeClient, createMemoryStore, lines } from '../c/fake.js';

const BRIEF = { context: 'glue', subject: 'Glue', scope: 'sticking things', purpose: 'learn', level: 'beginner' };

const sysOf = (/** @type {any} */ p) => (typeof p.system === 'string' ? p.system : p.system.map((/** @type {any} */ b) => b.text).join('\n'));
/** Which wave a request belongs to, from its system prompt. @param {any} p */
function waveOf(p) {
  const s = sysOf(p);
  if (s.includes('top-level categories')) return 0;
  if (s.includes('children of one category')) return 1;
  if (s.includes('hidden connections')) return 2;
  return -1;
}
/** A hand-made ToolSet. */
function toolset() {
  const info = { wiki__search: { source: 'wiki', visibility: 'public' }, docs__search: { source: 'docs', visibility: 'public' } };
  return { defs: Object.keys(info).map((name) => ({ name, description: name, input_schema: { type: 'object', properties: {} } })), info, call: async () => ({ isError: false, text: '', source: 'wiki', visibility: 'public', refs: [] }) };
}

/** @param {any} params */
function scripted(params) {
  const w = waveOf(params);
  if (w === 0) return { text: lines(['Types', 'Uses'].map((label) => ({ label, summary: `About ${label}.`, hook: 'h' }))) };
  if (w === 1) {
    const label = /The category to expand: (.+)/.exec(String(params.messages[0].content))?.[1] ?? 'X';
    return { text: lines([{ label: `${label} One`, parent: label }]) };
  }
  return { text: '' };
}

/** Run a build; returns the requests' system prompts by wave and the events. @param {any} opts @param {(store: any) => void} [seed] */
async function run(opts, seed) {
  const store = createMemoryStore();
  if (seed) seed(store);
  const fake = createFakeClient({ respond: scripted, chunkMs: 0 });
  const engine = createEngine({ store, id: 't', client: fake });
  await engine.build(BRIEF, opts);
  const reqs = fake.calls.map((c) => ({ wave: waveOf(c.params), system: sysOf(c.params) }));
  return { reqs, events: store.list('t').map((/** @type {any} */ e) => e) };
}

// ---- checks ----

/**
 * Problems in a request list. With `picked`, wave 0 and wave 1 requests carry the note (naming each picked
 * source, asking to search it for a category) and the UNTRUSTED line; without, no request carries the note.
 * @param {{ wave: number, system: string }[]} reqs @param {string[]} picked
 */
export function noteProblems(reqs, picked) {
  /** @type {string[]} */ const p = [];
  reqs.forEach((r, i) => {
    const has = r.system.includes('The reader chose these sources');
    if (!picked.length) { if (has) p.push(`request ${i} (wave ${r.wave}) has the note without picked sources`); return; }
    const grounded = r.wave === 0 || r.wave === 1;
    if (!grounded) { if (has) p.push(`request ${i} (wave ${r.wave}) has the note outside waves 0 and 1`); return; }
    if (!has) { p.push(`request ${i} (wave ${r.wave}) lacks the note`); return; }
    for (const n of picked) if (!r.system.includes(n)) p.push(`request ${i} does not name ${n}`);
    if (!/search these sources for it/.test(r.system)) p.push(`request ${i} does not ask to search them for each category`);
    if (!r.system.includes(UNTRUSTED)) p.push(`request ${i} lost the UNTRUSTED line`);
  });
  return p;
}

/** A log must hold one ontology.created, at most one raise, and the root node.added right after them. @param {any[]} events */
export function creationProblems(events) {
  /** @type {string[]} */ const p = [];
  const n = (/** @type {string} */ t) => events.filter((e) => e.t === t).length;
  if (n('ontology.created') !== 1) p.push(`${n('ontology.created')} ontology.created events, expected 1`);
  if (n('visibility.raised') > 1) p.push(`${n('visibility.raised')} raises, expected at most 1`);
  return p;
}

test('picked sources: the note is in waves 0 and 1 with tools and picks, and the UNTRUSTED line stays', async () => {
  const { reqs } = await run({ tools: toolset(), picked: ['wiki', 'docs'] });
  assert.ok(reqs.some((r) => r.wave === 0) && reqs.filter((r) => r.wave === 1).length === 2 && reqs.some((r) => r.wave === 2));
  assert.deepEqual(noteProblems(reqs, ['wiki', 'docs']), []);
  assert.match(reqs[0].system, /wiki, docs/);

  // planted fault: the note missing with picked sources is reported
  const missing = reqs.map((r) => (r.wave === 1 ? { ...r, system: r.system.replace(/The reader chose[\s\S]*?nothing\.|The reader chose[\s\S]*?have nothing\./, '') } : r));
  assert.ok(noteProblems(missing, ['wiki', 'docs']).length >= 1);
  // planted fault: the note present without picked sources is reported
  assert.ok(noteProblems(reqs, []).length >= 1);
});

test('picked sources: no note without picks, and none with picks but no tools', async () => {
  const noPick = await run({ tools: toolset() });
  assert.deepEqual(noteProblems(noPick.reqs, []), []);
  assert.ok(noPick.reqs.every((r) => !r.system.includes('The reader chose')));

  const noTools = await run({ picked: ['wiki', 'docs'] });
  assert.ok(noTools.reqs.length > 0);
  assert.deepEqual(noteProblems(noTools.reqs, []), []);
  assert.ok(noTools.reqs.every((r) => !r.system.includes('The reader chose')));
});

test('a map that already has ontology.created and a raise: build writes neither again', async () => {
  const seed = (/** @type {any} */ store) => {
    store.append('t', makeEvent('ontology.created', { name: 'Glue', root: 'glue', brief: BRIEF, categories: [] }, 0));
    store.append('t', makeEvent('visibility.raised', { to: 'private', reason: 'sources-picked', sources: ['wiki'] }, 0));
  };
  const { events } = await run({ tools: toolset(), picked: ['wiki'], privateSources: ['wiki'] }, seed);
  assert.deepEqual(creationProblems(events), []);
  assert.equal(events.filter((e) => e.t === 'visibility.raised').length, 1);
  assert.equal(events[2].t, 'node.added');
  assert.equal(events[2].node.id, 'glue');
  assert.equal(events[2].node.parent, null);

  // a fresh map still gets its own created and raise from the build
  const fresh = await run({ tools: toolset(), picked: ['wiki'], privateSources: ['wiki'] });
  assert.deepEqual(creationProblems(fresh.events), []);
  assert.deepEqual(fresh.events.slice(0, 3).map((e) => e.t), ['ontology.created', 'visibility.raised', 'node.added']);

  // planted fault: a log with two ontology.created events is reported
  const twice = [...events, events[0]];
  assert.equal(creationProblems(twice).length, 1);
});
