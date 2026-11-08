// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rosetta, lensSlug } from '../../src/core/engine/rosetta.js';
import { fakeClient, fakeStore, makeCtx, fixtureEvents, foldAll } from './helpers.js';

const seed = () => fixtureEvents('plastic-modeling');

/** Node ids out of the user prompt ("<id> | <path> | <summary>"). */
function idsIn(/** @type {any} */ params) {
  const content = params.messages[0].content;
  return content.split('\n').filter((/** @type {string} */ l) => l.includes(' | ') && !l.startsWith('Nodes,')).map((/** @type {string} */ l) => l.split(' | ')[0]);
}
function answer(/** @type {string} */ id, withBreaks = true) {
  return JSON.stringify(withBreaks
    ? { id, analog: `analog of ${id.split('/').pop()}`, breaks: 'it misleads here' }
    : { id, analog: `analog of ${id.split('/').pop()}` });
}
const goodModel = (/** @type {any} */ p) => idsIn(p).map((/** @type {string} */ id) => answer(id)).join('\n') + '\n';
const noBreaksModel = (/** @type {any} */ p) => idsIn(p).map((/** @type {string} */ id) => answer(id, false)).join('\n') + '\n';

function setup(/** @type {(p: any, i: number) => any} */ respond) {
  const store = fakeStore({ pm: seed() });
  const client = fakeClient(respond);
  return { store, client, ctx: makeCtx({ store, client }) };
}

// ---- pure checkers ----------------------------------------------------------------
/** Folded log must carry the analogs on the lens. @returns {string[]} problems */
function checkFolded(/** @type {any[]} */ events, /** @type {string} */ lensId) {
  const o = foldAll(events);
  const lens = o.lenses[lensId];
  if (!lens) return [`lens ${lensId} missing after fold`];
  const n = Object.keys(lens.analogs).length;
  return n ? [] : ['analogs missing: lens has no analogs after fold'];
}
/** Coverage and breaks. @returns {string[]} problems */
function checkCoverage(/** @type {any} */ o, /** @type {string} */ lensId) {
  const problems = [];
  const lens = o.lenses[lensId];
  if (!lens) return ['lens missing'];
  const total = Object.keys(o.nodes).length;
  const got = Object.values(lens.analogs);
  if (got.length < total * 0.9) problems.push(`only ${got.length}/${total} nodes have an analog`);
  if (!got.some((/** @type {any} */ a) => a.breaks)) problems.push('no analog has a breaks');
  return problems;
}

test('lens id from persona or name, deduped', async () => {
  assert.equal(lensSlug('a home chef'), 'chef');
  assert.equal(lensSlug('someone who is a Home Chef'), 'chef');
  assert.equal(lensSlug('the Jazz-Drummer'), 'drummer');
  assert.equal(lensSlug('a   '), 'lens');
  const { ctx, store } = setup(goodModel);
  assert.equal(await rosetta(ctx, 'pm', 'a home chef'), 'chef');
  assert.equal(await rosetta(ctx, 'pm', 'a home chef'), 'chef-2');
  assert.equal(await rosetta(ctx, 'pm', 'a home chef', { name: 'kitchen' }), 'kitchen');
  assert.deepEqual(Object.keys(store.read('pm').lenses), ['chef', 'chef-2', 'kitchen']);
});

test('check 1: folded events carry the analogs (planted fault: unwrapped lens.added)', async () => {
  const { ctx, store } = setup(goodModel);
  const lensId = await rosetta(ctx, 'pm', 'a home chef');
  const log = /** @type {any[]} */ (store.logs.get('pm'));
  assert.deepEqual(checkFolded(log, lensId), []);
  const faulty = log.map((e) => e.t === 'lens.added' ? { t: 'lens.added', at: e.at, ...e.lens } : e);
  assert.notDeepEqual(checkFolded(faulty, lensId), []);
  assert.match(checkFolded(faulty, lensId).join(' '), /missing/);
});

test('check 2: >=90% coverage and some breaks (planted fault: model with no breaks)', async () => {
  const good = setup(goodModel);
  const id = await rosetta(good.ctx, 'pm', 'a home chef');
  assert.deepEqual(checkCoverage(good.store.read('pm'), id), []);

  const bad = setup(noBreaksModel);
  const badId = await rosetta(bad.ctx, 'pm', 'a home chef');
  const problems = checkCoverage(bad.store.read('pm'), badId);
  assert.ok(problems.some((p) => /breaks/.test(p)), problems.join('; '));
});

test('batches are about 25 nodes, cover every node exactly once, run in parallel but at most 3 at once', async () => {
  const { ctx, client, store } = setup(goodModel);
  await rosetta(ctx, 'pm', 'a home chef');
  const all = Object.keys(store.read('pm').nodes);
  const seen = client.calls.flatMap(idsIn);
  assert.ok(client.calls.length > 1);
  for (const c of client.calls) {
    assert.ok(idsIn(c).length <= 26, `batch of ${idsIn(c).length}`);
    assert.equal(c.model, 'fake-strong');
  }
  assert.equal(seen.length, all.length);
  assert.deepEqual([...seen].sort(), [...all].sort());
  assert.ok(client.stats.maxInFlight <= 3, `maxInFlight ${client.stats.maxInFlight}`);
  assert.ok(client.stats.maxInFlight > 1, `maxInFlight ${client.stats.maxInFlight}`);
});

test('analogs are appended live, before the stream finishes', async () => {
  const { ctx, client, store } = setup(goodModel);
  let finalCalls = 0;
  const origStream = client.messages.stream;
  client.messages.stream = (/** @type {any} */ p) => {
    const s = origStream(p);
    const orig = s.finalMessage;
    s.finalMessage = () => { finalCalls++; return orig(); };
    return s;
  };
  let finalsAtFirstAnalog = -1;
  const origAppend = store.append.bind(store);
  store.append = (/** @type {string} */ id, /** @type {any} */ e) => {
    if (e.t === 'lens.analog' && finalsAtFirstAnalog < 0) finalsAtFirstAnalog = finalCalls;
    origAppend(id, e);
  };
  await rosetta(ctx, 'pm', 'a home chef');
  assert.equal(finalsAtFirstAnalog, 0);
});

test('invalid answers are dropped: foreign id, duplicate id, empty analog', async () => {
  const { ctx, store } = setup((p) => {
    const ids = idsIn(p);
    return [
      JSON.stringify({ id: 'not/in/this/batch', analog: 'ghost', breaks: 'x' }),
      JSON.stringify({ id: ids[0], analog: '  ' }),
      JSON.stringify({ id: ids[0], analog: 'first real', breaks: '' }),
      JSON.stringify({ id: ids[0], analog: 'second try' }),
    ].join('\n') + '\n';
  });
  const id = await rosetta(ctx, 'pm', 'a home chef');
  const lens = store.read('pm').lenses[id];
  assert.ok(!('not/in/this/batch' in lens.analogs));
  const vals = Object.values(lens.analogs);
  assert.ok(vals.length > 0);
  assert.ok(vals.every((/** @type {any} */ a) => a.label === 'first real' && !('breaks' in a)));
});

test('a batch that refuses does not stop the others', async () => {
  const { ctx, store } = setup((p, i) => {
    const ids = idsIn(p);
    if (i === 0) return { text: answer(ids[0]) + '\n{"id":', stop_reason: 'refusal' };
    return goodModel(p);
  });
  const id = await rosetta(ctx, 'pm', 'a home chef');
  const o = store.read('pm');
  assert.ok(Object.keys(o.lenses[id].analogs).length >= Object.keys(o.nodes).length - 24);
});

test('a 401 is rethrown unchanged', async () => {
  const { ctx, client } = setup(goodModel);
  const err = Object.assign(new Error('invalid x-api-key'), { status: 401 });
  client.messages.stream = () => { throw err; };
  await assert.rejects(rosetta(ctx, 'pm', 'a home chef'), (e) => e === err);
});

test('other failures: skipped unless every batch fails', async () => {
  const some = setup((p, i) => { if (i === 1) throw new Error('boom'); return goodModel(p); });
  const id = await rosetta(some.ctx, 'pm', 'a home chef');
  assert.ok(Object.keys(some.store.read('pm').lenses[id].analogs).length > 0);
  const all = setup(() => { throw new Error('boom'); });
  await assert.rejects(rosetta(all.ctx, 'pm', 'a home chef'), /boom/);
});

test('empty persona or empty ontology throws', async () => {
  const { ctx } = setup(goodModel);
  await assert.rejects(rosetta(ctx, 'pm', '   '), /persona/);
  const store = fakeStore({ e: [seed()[0]] });
  await assert.rejects(rosetta(makeCtx({ store, client: fakeClient(goodModel) }), 'e', 'a chef'), /no nodes/);
});

test('a lens name from the browser is slugged; an overlong persona is refused (planted: raw name kept)', async () => {
  const store = fakeStore({ pm: fixtureEvents('plastic-modeling') });
  const ctx = makeCtx({ store, client: fakeClient(() => '') });
  const id = await rosetta(ctx, 'pm', 'a home chef', { name: '  My Kitchen!!/../x ' }).catch((e) => e);
  assert.equal(id instanceof Error ? 'error' : id, 'my-kitchen-x');
  await assert.rejects(rosetta(ctx, 'pm', 'x'.repeat(201)), /too long/);
});
