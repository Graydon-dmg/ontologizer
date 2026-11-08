// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEngine } from '../../src/core/engine/index.js';
import { researchContextPrompt } from '../../src/core/engine/prompts.js';
import { createFakeClient, createMemoryStore, lines, searchBlock } from './fake.js';

const ADH = 'plastic-modeling/tools/adhesives';
const fixture = readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** @param {(params: any, i: number) => any} respond */
function setup(respond) {
  const store = createMemoryStore();
  for (const e of fixture) store.append('pm', e);
  const fake = createFakeClient({ respond, chunkMs: 0 });
  const engine = createEngine({ store, id: 'pm', client: fake });
  return { store, fake, engine };
}
/** @param {any} engine @param {any} job */
async function run(engine, job) { engine.enqueue(job, { priority: 10 }); await engine.idle(); }
/** @param {any} store @param {string} t */
const evs = (store, t) => store.list('pm').filter((/** @type {any} */ e) => e.t === t);

const ARTICLE = { summary: 'Glue for plastic.', keyFacts: ['a', 7, 'b'], whyItMatters: 'Matters.', seeAlso: ['CA Glue'] };
const R2 = [{ title: 'One', url: 'https://one.example' }, { title: 'Two', url: 'https://two.example' }];

test('research: context carries brief and path, general carries only the label', async () => {
  const { store, fake, engine } = setup((_p, i) => ({ text: lines([{ label: i === 0 ? 'Ctx Item' : 'Gen Item', summary: 's', hook: 'h' }]) }));
  const subject = fixture[0].brief.subject;
  await run(engine, { kind: 'research', nodeId: ADH, mode: 'context' });
  await run(engine, { kind: 'research', nodeId: ADH, mode: 'general' });
  const [ctx, gen] = fake.calls.map((c) => c.params.messages[0].content + '\n' + c.params.system);
  assert.ok(ctx.includes(subject) && ctx.includes('Tools > Adhesives'));
  assert.ok(gen.includes('Adhesives'));
  assert.ok(!gen.includes(subject) && !gen.includes('Tools'));
  // Planted fault: a prompt built the context way would fail the general assertion.
  const wrong = researchContextPrompt(fixture[0].brief, ['Plastic modeling', 'Tools', 'Adhesives'], []);
  assert.ok((wrong.prompt).includes(subject), 'the faulty prompt leaks the brief, so the general check would fail it');
  const added = evs(store, 'node.added').filter((/** @type {any} */ e) => e.node.createdBy === 'research');
  assert.deepEqual(added.map((/** @type {any} */ e) => [e.node.parent, e.node.origin, e.node.createdBy]),
    [[ADH, 'context', 'research'], [ADH, 'general', 'research']]);
  assert.equal(evs(store, 'job.done').length, 2);
});

test('research: general origin, new ids, duplicates and bad labels skipped', async () => {
  const { store, engine } = setup(() => ({ text: lines([
    { label: 'Epoxies', summary: 's', hook: 'h' }, { label: 'epoxies' }, { label: 'Plastic cement' },
    { label: '  ' }, { label: 'x'.repeat(81) }, { label: 'Glue Sticks', summary: 's', hook: 'h' }]) }));
  await run(engine, { kind: 'research', nodeId: ADH, mode: 'general' });
  const added = evs(store, 'node.added').filter((/** @type {any} */ e) => e.node.createdBy === 'research').map((/** @type {any} */ e) => e.node);
  assert.deepEqual(added.map((n) => n.label), ['Epoxies', 'Glue Sticks']);   // "Plastic cement" already exists under adhesives
  assert.ok(added.every((n) => n.origin === 'general' && n.parent === ADH && n.depth === 3 && n.status === 'done'));
  assert.equal(evs(store, 'job.done').length, 1);
});

test('research on the root adds categories', async () => {
  const { store, engine } = setup(() => ({ text: lines([{ label: 'Zebra Studies', summary: 's', hook: 'h' }]) }));
  const before = store.read('pm').categories.length;
  await run(engine, { kind: 'research', nodeId: 'plastic-modeling', mode: 'context' });
  const o = store.read('pm');
  assert.equal(o.categories.length, before + 1);
  assert.equal(o.categories[before].index, before);
  assert.equal(o.nodes['plastic-modeling/zebra-studies'].category, 'plastic-modeling/zebra-studies');
});

test('explain: sources come only from the search results', async () => {
  const text = lines([{ ...ARTICLE, summary: 'See https://unrelated.example for more.' }]);
  const { store, fake, engine } = setup(() => ({ text, content: [searchBlock(R2)] }));
  await run(engine, { kind: 'explain', nodeId: ADH });
  const patch = evs(store, 'node.updated')[0].patch;
  assert.deepEqual(patch.article.sources, R2);
  assert.deepEqual(patch.article.keyFacts, ['a', 'b']);
  assert.equal(typeof patch.article.whyItMatters, 'string');
  assert.deepEqual(patch.sources, R2);
  assert.ok(fake.calls[0].params.tools.some((/** @type {any} */ t) => t.type === 'web_search_20260209'));

  // Planted fault: no search block, so no sources; "at least one source" would catch web search being removed.
  const bad = setup(() => ({ text }));
  await run(bad.engine, { kind: 'explain', nodeId: ADH });
  assert.deepEqual(evs(bad.store, 'node.updated')[0].patch.article.sources, []);
});

test('a search error block does not crash explain', async () => {
  const errBlock = { type: 'web_search_tool_result', tool_use_id: 'x', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } };
  const { store, engine } = setup(() => ({ text: lines([ARTICLE]), content: [errBlock] }));
  await run(engine, { kind: 'explain', nodeId: ADH });
  assert.equal(evs(store, 'job.done').length, 1);
  assert.deepEqual(evs(store, 'node.updated')[0].patch.article.sources, []);
});

test('refusal fails the job and writes nothing else', async () => {
  const { store, engine } = setup(() => ({ stop_reason: 'refusal', text: '' }));
  const n = store.list('pm').length;
  await run(engine, { kind: 'explain', nodeId: ADH });
  const failed = evs(store, 'job.failed');
  assert.equal(failed.length, 1);
  assert.ok(typeof failed[0].job.error === 'string' && failed[0].job.error.length < 200);
  assert.equal(evs(store, 'node.updated').length, 0);
  assert.equal(store.list('pm').length, n + 3);   // queued, started, failed
});

test('pause_turn resumes, but only twice', async () => {
  const a = setup((_p, i) => (i === 0 ? { stop_reason: 'pause_turn' } : { text: lines([ARTICLE]) }));
  await run(a.engine, { kind: 'explain', nodeId: ADH });
  assert.equal(evs(a.store, 'job.done').length, 1);
  assert.equal(a.fake.calls.length, 2);
  const msgs = a.fake.calls[1].params.messages;
  assert.equal(msgs[msgs.length - 1].role, 'assistant');

  const b = setup(() => ({ stop_reason: 'pause_turn' }));
  await run(b.engine, { kind: 'explain', nodeId: ADH });
  assert.equal(b.fake.calls.length, 3);
  assert.equal(evs(b.store, 'job.failed').length, 1);
});

test('max_tokens on research keeps what streamed', async () => {
  const { store, engine } = setup(() => ({ stop_reason: 'max_tokens',
    text: lines([{ label: 'A1', summary: 's', hook: 'h' }, { label: 'B1', summary: 's', hook: 'h' }]) }));
  await run(engine, { kind: 'research', nodeId: ADH, mode: 'context' });
  assert.equal(evs(store, 'node.added').filter((/** @type {any} */ e) => e.node.createdBy === 'research').length, 2);
  assert.equal(evs(store, 'job.done').length, 1);
});

test('a 401 fails the job with the key message', async () => {
  const { store, engine } = setup(() => ({ error: { status: 401, name: 'AuthenticationError', message: 'invalid x-api-key' } }));
  await run(engine, { kind: 'explain', nodeId: ADH });
  assert.equal(evs(store, 'job.failed')[0].job.error, 'Your Anthropic API key was rejected: run ontologizer key set');
});

test('sources: a hallucinated url is dropped and the list is topped up from the search', async () => {
  const found = [...R2, { title: 'Three', url: 'https://three.example' }];
  const { store, engine } = setup(() => ({
    text: lines([{ title: 'My Title', url: 'https://two.example' }, { title: 'Fake', url: 'https://fake.example' }]),
    content: [searchBlock(found)] }));
  await run(engine, { kind: 'sources', nodeId: ADH });
  const got = evs(store, 'node.updated')[0].patch.sources;
  assert.deepEqual(got, [{ title: 'My Title', url: 'https://two.example' }, found[0], found[2]]);
  assert.ok(!got.some((/** @type {any} */ s) => s.url.includes('fake')));
});

test('missing node throws', async () => {
  const { store, engine } = setup(() => ({}));
  await run(engine, { kind: 'explain', nodeId: 'nope' });
  assert.match(evs(store, 'job.failed')[0].job.error, /no node "nope"/);
});
