// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine/index.js';
import { rootLabel } from '../../src/core/engine/build.js';
import { slug } from '../../src/core/engine/ids.js';
import { KEY_REJECTED } from '../../src/core/engine/call.js';
import { createFakeClient, createMemoryStore, lines } from './fake.js';

const BRIEF = { context: 'plastic models', subject: 'plastic modeling', scope: 'kits and tools', purpose: 'start', level: 'beginner' };
const CATS = ['Tools', 'Kits', 'Paints'];

/** @param {string[]} labels */
const cats = (labels) => lines(labels.map((label) => ({ label, summary: `About ${label} and what it covers in the hobby.`, hook: `A surprising fact about ${label}.` })));

/**
 * Build an engine over a fake client. wave1(label) -> answer for that category.
 * @param {{ wave0?: any, wave1?: (label: string) => any, wave2?: any, check?: any, chunkMs?: number }} o
 */
function setup(o = {}) {
  const store = createMemoryStore();
  const fake = createFakeClient({
    chunkMs: o.chunkMs ?? 1,
    respond: (params) => {
      const system = params.system;
      if (system.includes('four tests')) return o.check ?? { text: '' };
      if (system.includes('top-level categories')) return o.wave0 ?? { text: cats(CATS) };
      if (system.includes('children of one category')) {
        const label = /The category to expand: (.+)/.exec(params.messages[0].content)?.[1] ?? '';
        return o.wave1 ? o.wave1(label) : { text: lines([{ label: `${label} One`, parent: label }, { label: `${label} Two`, parent: label }]) };
      }
      if (system.includes('hidden connections')) return o.wave2 ?? { text: '' };
      return { text: '' };
    },
  });
  const engine = createEngine({ store, id: 't', client: fake });
  return { store, fake, engine, events: () => store.list('t'), nodes: () => store.read('t').nodes };
}

/** Throws unless the first category node arrived before the wave-0 call finished. */
function assertStreamed(/** @type {any[]} */ events, /** @type {number|null} */ finishedAt) {
  const first = events.filter((e) => e.t === 'node.added')[1];   // [0] is the root
  assert.ok(first, 'no category node.added');
  assert.ok(finishedAt !== null);
  assert.ok(first._wall < finishedAt, `first node at ${first._wall} is not before the call finished at ${finishedAt}`);
}

test('the first node.added arrives before the wave-0 call finishes', async () => {
  const labels = ['Tools', 'Kits', 'Paints', 'Techniques', 'History', 'Community'];
  const t = setup({ wave0: { text: cats(labels) }, chunkMs: 5 });
  await t.engine.build(BRIEF);
  const finishedAt = t.fake.calls[0].finishedAt;
  assertStreamed(t.events(), finishedAt);
  // Planted fault: an engine that waits for the whole call writes its first node at or after finishedAt.
  const buffered = t.events().map((e) => (e.t === 'node.added' ? { ...e, _wall: /** @type {number} */ (finishedAt) + 1 } : e));
  assert.throws(() => assertStreamed(buffered, finishedAt));
});

test('an unknown parent attaches to its category and is not dropped', async () => {
  const wave1 = (/** @type {string} */ label) => ({
    text: lines(label === 'Tools'
      ? [{ label: 'Glue', parent: 'Nonexistent Thing' }, { label: 'Knife', parent: 'Tools' }, { label: 'Tape' }]
      : [{ label: 'Valid Child', parent: label }]),
  });
  const t = setup({ wave1 });
  await t.engine.build(BRIEF);
  const n = t.nodes();
  assert.equal(n['plastic-modeling/tools/glue'].parent, 'plastic-modeling/tools');
  assert.equal(n['plastic-modeling/tools/tape'].parent, 'plastic-modeling/tools');
  assert.equal(n['plastic-modeling/tools/knife'].parent, 'plastic-modeling/tools');
  // Planted fault counterpart: a line whose parent is valid still lands, under that parent.
  const t2 = setup({
    wave1: (label) => ({ text: lines(label === 'Tools' ? [{ label: 'Glue', parent: 'Tools' }, { label: 'Epoxy', parent: 'Glue' }] : []) }),
  });
  await t2.engine.build(BRIEF, { depth: 3 });
  assert.equal(t2.nodes()['plastic-modeling/tools/glue/epoxy'].parent, 'plastic-modeling/tools/glue');
});

test('a refused category fails its job; the others and wave 2 carry on', async () => {
  const t = setup({
    wave1: (label) => (label === 'Kits'
      ? { text: '', stop_reason: 'refusal' }
      : { text: lines([{ label: `${label} A`, parent: label }, { label: `${label} B`, parent: label }]) }),
    wave2: { text: lines([{ from: 'Tools > Tools A', to: 'Paints > Paints B', type: 'bridge', why: 'both matter' }]) },
  });
  await t.engine.build(BRIEF);
  const failed = t.events().filter((e) => e.t === 'job.failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].job.nodeId, 'plastic-modeling/kits');
  assert.match(failed[0].job.error, /declined/);
  assert.ok(t.nodes()['plastic-modeling/tools/tools-a']);
  assert.ok(t.nodes()['plastic-modeling/paints/paints-b']);
  assert.equal(t.events().filter((e) => e.t === 'job.done').length, 2);
  assert.equal(t.events().filter((e) => e.t === 'edge.added').length, 1);
});

test('a 401 in wave 1 fails that job with the key message and rejects build with the same error', async () => {
  const err = { status: 401, name: 'AuthenticationError', message: 'invalid x-api-key' };
  const t = setup({
    wave1: (label) => (label === 'Paints' ? { error: err } : { text: lines([{ label: `${label} A`, parent: label }]) }),
    wave2: { text: lines([{ from: 'Tools > Tools A', to: 'Kits > Kits A', type: 'bridge', why: 'x' }]) },
  });
  await assert.rejects(t.engine.build(BRIEF), (e) => e === err);
  const failed = t.events().filter((e) => e.t === 'job.failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].job.error, KEY_REJECTED);
  assert.ok(t.nodes()['plastic-modeling/tools/tools-a'], 'other categories still finished');
  assert.equal(t.events().filter((e) => e.t === 'edge.added').length, 0, 'wave 2 is skipped');
});

test('check() rethrows a 401 unchanged', async () => {
  const err = { status: 401, name: 'AuthenticationError', message: 'invalid x-api-key' };
  const t = setup({ check: { error: err } });
  await assert.rejects(t.engine.check('anything'), (e) => e === err);
});

test('duplicate labels get a -2 id', async () => {
  const t = setup({
    wave1: (label) => ({ text: lines(label === 'Tools' ? [{ label: 'Cement', parent: 'Tools' }, { label: 'cement!', parent: 'Tools' }, { label: 'CEMENT', parent: 'Tools' }] : []) }),
  });
  await t.engine.build(BRIEF);
  const n = t.nodes();
  assert.ok(n['plastic-modeling/tools/cement']);
  assert.ok(n['plastic-modeling/tools/cement-2']);
  assert.equal(n['plastic-modeling/tools/cement-2'].label, 'cement!');
  assert.ok(!n['plastic-modeling/tools/cement-3'], 'the exact duplicate label was skipped');
});

test('depth: grandchildren sit under their child at depth 3, under the category at depth 2', async () => {
  const wave1 = (/** @type {string} */ label) => ({
    text: lines(label === 'Tools'
      ? [{ label: 'Glue', parent: 'Tools' }, { label: 'Epoxy', parent: 'Glue' }, { label: 'Resin', parent: 'Epoxy' }]
      : []),
  });
  const deep = setup({ wave1 });
  await deep.engine.build(BRIEF, { depth: 3 });
  assert.equal(deep.nodes()['plastic-modeling/tools/glue/epoxy'].depth, 3);
  assert.equal(deep.nodes()['plastic-modeling/tools/glue/epoxy'].parent, 'plastic-modeling/tools/glue');
  // one level too deep: attaches to the category
  assert.equal(deep.nodes()['plastic-modeling/tools/resin'].parent, 'plastic-modeling/tools');
  assert.equal(deep.nodes()['plastic-modeling/tools/resin'].depth, 2);

  const shallow = setup({ wave1 });
  await shallow.engine.build(BRIEF);   // depth 2
  assert.equal(shallow.nodes()['plastic-modeling/tools/epoxy'].parent, 'plastic-modeling/tools');
  assert.equal(shallow.nodes()['plastic-modeling/tools/epoxy'].depth, 2);
});

test('event order and node shape', async () => {
  const t = setup({ wave2: { text: lines([{ from: 'Tools > Tools One', to: 'Kits > Kits Two', type: 'weird', why: 5 }, { insight: 'A pattern.', about: 'Paints' }]) } });
  await t.engine.build(BRIEF);
  const ev = t.events();
  assert.equal(ev[0].t, 'ontology.created');
  assert.equal(ev[0].root, 'plastic-modeling');
  assert.equal(ev[1].t, 'node.added');
  assert.equal(ev[1].node.id, 'plastic-modeling');
  assert.equal(ev[1].node.label, 'Plastic Modeling');
  assert.equal(ev[1].node.summary, 'kits and tools');
  for (const c of CATS) {
    const id = `plastic-modeling/${c.toLowerCase()}`;
    const a = ev.findIndex((e) => e.t === 'category.added' && e.category.id === id);
    const b = ev.findIndex((e) => e.t === 'node.added' && e.node.id === id);
    assert.ok(a > 0 && b > a, `${id}: category.added before node.added`);
  }
  const keys = ['article', 'category', 'createdBy', 'depth', 'hook', 'id', 'label', 'origin', 'parent', 'sources', 'status', 'summary'];
  for (const e of ev.filter((x) => x.t === 'node.added')) assert.deepEqual(Object.keys(e.node).sort(), keys);
  const edge = ev.find((e) => e.t === 'edge.added').edge;
  assert.deepEqual(edge, { id: 'e1', from: 'plastic-modeling/tools/tools-one', to: 'plastic-modeling/kits/kits-two', type: 'influences', why: '' });
  const insight = ev.find((e) => e.t === 'insight');
  assert.equal(insight.nodeId, 'plastic-modeling/paints');
});

test('wave 2 skips parent-child, self and repeated pairs; wave 0 with no categories throws', async () => {
  const t = setup({
    wave2: { text: lines([
      { from: 'Tools', to: 'Tools > Tools One', type: 'part-of' },
      { from: 'Tools > Tools One', to: 'Tools > Tools One', type: 'part-of' },
      { from: 'Tools > Tools One', to: 'Nope', type: 'part-of' },
      { from: 'Tools > Tools One', to: 'Kits > Kits One', type: 'requires' },
      { from: 'Kits > Kits One', to: 'Tools > Tools One', type: 'requires' },
    ]) },
  });
  await t.engine.build(BRIEF);
  assert.equal(t.events().filter((e) => e.t === 'edge.added').length, 1);
  const empty = setup({ wave0: { text: 'Sorry, no.\n' } });
  await assert.rejects(empty.engine.build(BRIEF), /no categories/);
});

test('check: ready maps to a brief and a kebab-case name', async () => {
  const t = setup({ check: { text: lines([{ ready: true, brief: { context: 'ignored', subject: 'Scale Plastic Modeling', scope: 's', purpose: 'p', level: 'Expert' }, name: 'Plastic Modeling!' }]) } });
  const r = await t.engine.check('I like kits', [{ id: 'level', text: 'Level?', answer: 'expert' }, 'hobby']);
  assert.deepEqual(r, { ready: true, brief: { context: 'I like kits', subject: 'Scale Plastic Modeling', scope: 's', purpose: 'p', level: 'expert' }, name: 'plastic-modeling' });
  const prompt = t.fake.calls[0].params.messages[0].content;
  assert.match(prompt, /Level\?/);
  assert.match(prompt, /hobby/);

  const odd = setup({ check: { text: lines([{ ready: true, brief: { subject: 'Birds', level: 'wizard', scope: 4 } }]) } });
  const r2 = /** @type {any} */ (await odd.engine.check('birds'));
  assert.equal(r2.brief.level, 'beginner');
  assert.equal(r2.brief.scope, '');
  assert.equal(r2.name, 'birds');

  const noSubject = setup({ check: { text: lines([{ ready: true, brief: { subject: '' } }]) } });
  const r3 = /** @type {any} */ (await noSubject.engine.check('x'));
  assert.equal(r3.ready, false);
  assert.equal(r3.questions[0].id, 'subject');
});

test('check: questions are capped and cleaned; a fenced, prose-wrapped answer still parses', async () => {
  const q = (/** @type {number} */ i) => ({ id: `q${i}`, text: `Question ${i}?`, options: ['a', 'b', 'c', 'd', 'e', 'f', 7] });
  const text = 'Sure, here you go:\n```json\n' + lines([{ ready: false, questions: [q(1), q(2), { id: 'bad' }, q(3), q(4)] }]) + '```\n';
  const t = setup({ check: { text } });
  const r = /** @type {any} */ (await t.engine.check('modeling'));
  assert.equal(r.ready, false);
  assert.deepEqual(r.questions.map((/** @type {any} */ x) => x.id), ['q1', 'q2', 'q3']);
  for (const x of r.questions) {
    assert.deepEqual(x.options, ['a', 'b', 'c', 'd', 'e']);
    assert.equal(typeof x.text, 'string');
  }
  const none = setup({ check: { text: lines([{ ready: false, questions: [{ nope: 1 }] }]) } });
  assert.deepEqual(await none.engine.check('x'), { ready: false, questions: [{ id: 'subject', text: 'What exactly do you want to explore?', options: [] }] });
  const nothing = setup({ check: { text: 'no json here\n' } });
  await assert.rejects(nothing.engine.check('x'), /returned no answer/);
});

test('the root label is short Title Case; the root id is still slug(subject)', async () => {
  const long = 'Scale plastic modeling (building and finishing scale model kits)';
  const t = setup();
  await t.engine.build({ ...BRIEF, subject: long });
  const o = t.store.read('t');
  assert.equal(o.root, slug(long));
  assert.equal(o.nodes[o.root].label, 'Scale Plastic Modeling');
  // Planted fault: the old label (the subject with its first letter raised) is too long.
  const old = long.charAt(0).toUpperCase() + long.slice(1);
  assert.ok(old.split(/\s+/).length > 4);
  for (const [subject, want] of /** @type {[string, string][]} */ ([
    ['Japanese manga: history, genres and artists', 'Japanese Manga'],
    ['the history of the roman empire and its fall', 'The History'],
    ['3D printing - a guide for makers', '3D Printing'],
    ['DNA', 'DNA'],
    ['coffee', 'Coffee'],
  ])) {
    const label = rootLabel(subject);
    assert.equal(label, want, subject);
    assert.ok(label.split(' ').length <= 4);
  }
});
