// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuse } from '../../src/core/engine/fuse.js';
import { fakeClient, fakeStore, makeCtx, fixtureEvents, foldAll } from './helpers.js';

const REFUSAL = 'fuse takes two maps; fuse the result again to add a third';

const PM_KIT = 'plastic-modeling/kits/snap-fit-kits';
const PM_COMM = 'plastic-modeling/community';
const PM_PAINT = 'plastic-modeling/paints-finishing';
const MG_CULT = 'manga/culture-adaptations';
const MG_TEZ = 'manga/origins-history/osamu-tezuka';
const MG_IND = 'manga/industry-creation';

/** @param {string[]} lines */
const jl = (lines) => lines.join('\n') + '\n';
/** @param {object} o */
const J = (o) => JSON.stringify(o);

const HYBRIDS = [
  J({ hybrid: 'Gunpla', summary: 'Bandai snap-fit Gundam kits.', hook: 'Gunpla outsells other kit lines.' }),
  J({ from: PM_KIT, to: 'Gunpla', why: 'Gunpla kits snap together without glue.' }),
  J({ from: MG_CULT, to: 'gunpla', why: 'The Gundam anime created the kit line.' }),
  J({ hybrid: 'Garage kits', summary: 'Hobbyist resin kits of anime characters.', hook: 'Born at Wonder Festival.' }),
  J({ from: PM_COMM, to: 'Garage kits', why: 'Garage kit makers sell at modeling events.' }),
  J({ from: MG_TEZ, to: 'Garage kits', why: 'Fans cast early manga characters.' }),
  J({ hybrid: 'Figure painting', summary: 'Painting anime figures.', hook: 'Eye painting is its own craft.' }),
  J({ from: PM_PAINT, to: 'Figure painting', why: 'Painting techniques carry over directly.' }),
  J({ from: MG_IND, to: 'Figure painting', why: 'Merchandise drives demand for painted figures.' }),
];
const DIRECT = [
  J({ from: PM_COMM, to: MG_CULT, why: 'Hobby communities meet at adaptation events.' }),
  J({ from: PM_KIT, to: MG_TEZ, why: 'Astro Boy kits were among the first character models.' }),
  J({ from: PM_PAINT, to: MG_IND, why: 'Cover art and kit box art share illustrators.' }),
  J({ from: PM_COMM, to: MG_IND, why: 'Publishers sponsor modeling contests.' }),
  J({ from: PM_KIT, to: MG_CULT, why: 'Kits adapt manga mecha.' }),
];
const GOOD_TEXT = (/** @type {string} */ name) => jl([...(name ? [J({ name })] : []), ...HYBRIDS, ...DIRECT]);

function setup(/** @type {(p: any, i: number) => any} */ respond, opts = {}) {
  const store = fakeStore({
    'plastic-modeling': fixtureEvents('plastic-modeling'),
    manga: fixtureEvents('manga'),
  });
  const client = fakeClient(respond, opts);
  const ctx = makeCtx({ store, client });
  return { store, client, ctx };
}

/**
 * Pure checker. Returns a list of problems with a fused draft's events.
 * @param {any[]} events @param {any} srcA @param {any} srcB  folded source ontologies
 */
function checkFused(events, srcA, srcB) {
  /** @type {string[]} */
  const problems = [];
  const added = events.filter((e) => e.t === 'node.added').map((e) => e.node);
  const catEvents = events.filter((e) => e.t === 'category.added').map((e) => e.category);
  const catIds = new Set(catEvents.map((c) => c.id));
  const have = new Set(added.map((n) => n.id));
  for (const src of [srcA, srcB]) {
    for (const id of Object.keys(src.nodes)) if (!have.has(id)) problems.push(`missing node ${id}`);
  }
  if (!catEvents.some((c) => c.family === 0)) problems.push('no family 0 categories');
  if (!catEvents.some((c) => c.family === 1)) problems.push('no family 1 categories');
  const bridges = events.filter((e) => e.t === 'edge.added' && e.edge.id.startsWith('bridge-'));
  if (bridges.length < 3) problems.push(`only ${bridges.length} bridges`);

  const seen = new Map();
  for (const n of added) {
    if (n.parent === null) {
      if (n.depth !== 0) problems.push(`root ${n.id} depth ${n.depth}`);
    } else if (!seen.has(n.parent)) {
      problems.push(`parent ${n.parent} of ${n.id} missing or emitted later`);
    } else if (n.depth !== seen.get(n.parent) + 1) {
      problems.push(`depth of ${n.id} is ${n.depth}, parent is ${seen.get(n.parent)}`);
    }
    if (n.category !== '' && !catIds.has(n.category)) problems.push(`category ${n.category} of ${n.id} unknown`);
    seen.set(n.id, n.depth);
  }
  return problems;
}

/** Asserts `fn` rejects a third map with the chaining message. Fails (throws) if it does not. */
async function assertRefusesThird(/** @type {(...a: any[]) => Promise<any>} */ fn) {
  const ctx = {};
  await assert.rejects(() => fn(ctx, 'plastic-modeling', 'manga', 'gunpla-extra'), { message: REFUSAL });
  await assert.rejects(() => fn(ctx, ['a', 'b', 'c'], 'x'), { message: REFUSAL });
}

test('fusing plastic-modeling with manga keeps every node, both families, and bridges', async () => {
  const { store, ctx } = setup(() => GOOD_TEXT('Gunpla Lab'));
  const id = await fuse(ctx, 'plastic-modeling', 'manga');
  const events = /** @type {any[]} */ (store.logs.get(id));
  const srcA = store.read('plastic-modeling');
  const srcB = store.read('manga');
  assert.deepEqual(checkFused(events, srcA, srcB), []);

  // planted fault: drop every manga node
  const mangaIds = new Set(Object.keys(srcB.nodes));
  const faulty = events.filter((e) => !(e.t === 'node.added' && mangaIds.has(e.node.id)));
  const problems = checkFused(faulty, srcA, srcB);
  assert.ok(problems.some((p) => p.startsWith('missing node manga')), problems.join('\n'));
});

test('parents come first, depths are parent + 1, categories are known', async () => {
  const { store, ctx } = setup(() => GOOD_TEXT('Gunpla Lab'));
  const id = await fuse(ctx, 'plastic-modeling', 'manga');
  const events = /** @type {any[]} */ (store.logs.get(id));
  const srcA = store.read('plastic-modeling');
  const srcB = store.read('manga');
  assert.deepEqual(checkFused(events, srcA, srcB), []);

  // planted fault: hybrids re-parented to the category id 'hybrids' (no such node)
  const faulty = events.map((e) => (e.t === 'node.added' && e.node.depth === 2 && e.node.category === 'hybrids'
    ? { ...e, node: { ...e.node, parent: 'hybrids' } } : e));
  const problems = checkFused(faulty, srcA, srcB);
  assert.ok(problems.some((p) => p.includes('parent hybrids')), problems.join('\n'));
});

test('a third map is refused with the chaining message', async () => {
  await assertRefusesThird(fuse);
  // planted fault: a stub that accepts three maps fails the helper
  await assert.rejects(() => assertRefusesThird(async () => 'draft'));
});

test('missing ids and a === b are refused', async () => {
  const { ctx } = setup(() => '');
  await assert.rejects(() => fuse(ctx, 'manga', /** @type {any} */ (undefined)), /two map ids/);
  await assert.rejects(() => fuse(ctx, 'manga', 'manga'), /different/);
});

test('with into omitted, the model\'s first line names the root', async () => {
  const { store, client, ctx } = setup(() => GOOD_TEXT('Gunpla Lab'));
  const id = await fuse(ctx, 'plastic-modeling', 'manga');
  const o = store.read(id);
  assert.equal(o.root, 'gunpla-lab');
  assert.equal(o.name, 'gunpla-lab');
  assert.equal(o.nodes['gunpla-lab'].label, 'Gunpla Lab');
  assert.equal(store.briefs.get(id).suggestedName, 'gunpla-lab');
  assert.match(client.calls[0].messages[0].content, /Name the fused map/);
  assert.equal(client.calls[0].model, 'fake-strong');
  assert.deepEqual(o.categories.filter((c) => c.family === 2).map((c) => c.id), ['hybrids']);
  assert.ok(o.nodes['gunpla-lab/hybrids/gunpla']);
  assert.ok(o.nodes['gunpla-lab/hybrids/garage-kits']);
});

test('a first line that is not a name falls back to <a>-x-<b> and is still processed', async () => {
  const { store, ctx } = setup(() => jl([...HYBRIDS, ...DIRECT]));
  const id = await fuse(ctx, 'plastic-modeling', 'manga');
  const o = store.read(id);
  assert.equal(o.root, 'plastic-modeling-x-manga');
  assert.ok(o.nodes['plastic-modeling-x-manga/hybrids/gunpla'], 'first hybrid kept');
  // empty stream still gives a structure
  const e = setup(() => '');
  const id2 = await fuse(e.ctx, 'plastic-modeling', 'manga');
  assert.equal(e.store.read(id2).root, 'plastic-modeling-x-manga');
});

test('with into, no name is asked for and ontology.created comes first, before the call', async () => {
  const { store, client, ctx } = setup(() => GOOD_TEXT(''));
  let callsAtFirstNode = -1;
  const orig = store.append.bind(store);
  store.append = (id, ev) => {
    if (callsAtFirstNode < 0 && /** @type {any} */ (ev).t === 'node.added') callsAtFirstNode = client.calls.length;
    orig(id, ev);
  };
  const id = await fuse(ctx, 'plastic-modeling', 'manga', { into: 'gunpla' });
  const events = /** @type {any[]} */ (store.logs.get(id));
  assert.equal(events[0].t, 'ontology.created');
  assert.equal(events[0].root, 'gunpla');
  assert.match(client.calls[0].messages[0].content, /Do not write a name line/);
  assert.equal(callsAtFirstNode, 0, 'structure was appended before the model call started');
  assert.equal(store.briefs.get(id).suggestedName, 'gunpla');
  assert.equal(events[0].brief.context, 'Fusion of Plastic modeling and Manga');
});

test('structure and seam are appended live, while the stream is still running', async () => {
  const { store, client, ctx } = setup(() => GOOD_TEXT('Gunpla Lab'), { chunk: 20, delayMs: 3 });
  const stats = { ended: false, firstNodeBeforeEnd: false, hybridBeforeEnd: false };
  const origGetClient = ctx.getClient;
  ctx.getClient = () => {
    const c = origGetClient();
    const origStream = c.messages.stream.bind(c.messages);
    c.messages.stream = (/** @type {any} */ p) => {
      const s = origStream(p);
      const it = s[Symbol.asyncIterator]();
      return {
        ...s,
        finalMessage: () => s.finalMessage(),
        [Symbol.asyncIterator]: () => ({
          async next() { const r = await it.next(); if (r.done) stats.ended = true; return r; },
        }),
      };
    };
    return c;
  };
  const orig = store.append.bind(store);
  store.append = (id, ev) => {
    const e = /** @type {any} */ (ev);
    if (e.t === 'node.added' && !stats.firstNodeBeforeEnd) stats.firstNodeBeforeEnd = !stats.ended;
    if (e.t === 'node.added' && e.node.origin === 'fuse' && e.node.depth === 2 && !stats.hybridBeforeEnd) stats.hybridBeforeEnd = !stats.ended;
    orig(id, ev);
  };
  await fuse(ctx, 'plastic-modeling', 'manga');
  assert.ok(stats.ended);
  assert.ok(stats.firstNodeBeforeEnd, 'first structure node appended before the stream ended');
  assert.ok(stats.hybridBeforeEnd, 'first hybrid appended before the stream ended');
  assert.equal(client.calls.length, 1);
});

test('copied edge ids do not collide', async () => {
  const { store, ctx } = setup(() => GOOD_TEXT('Gunpla Lab'));
  const id = await fuse(ctx, 'plastic-modeling', 'manga');
  const o = store.read(id);
  const a = store.read('plastic-modeling');
  const b = store.read('manga');
  const bridges = o.edges.filter((e) => e.id.startsWith('bridge-')).length;
  assert.ok(bridges >= 8);
  assert.equal(o.edges.length, b.edges.length + a.edges.length + bridges);
  assert.equal(b.edges.length, 8);
  assert.ok(o.edges.some((e) => e.id === 'manga:e1'));
  assert.ok(o.edges.some((e) => e.id === 'plastic-modeling:e1'));
  assert.ok(o.edges.filter((e) => e.id.startsWith('bridge-')).every((e) => e.why));
});

test('invalid bridges are dropped, valid ones deduped', async () => {
  const text = jl([
    J({ hybrid: 'Gunpla', summary: 's', hook: 'h' }),
    J({ from: PM_KIT, to: 'Gunpla', why: 'ok' }),
    J({ from: PM_KIT, to: 'Gunpla', why: 'duplicate' }),
    J({ from: 'plastic-modeling/nope', to: MG_CULT, why: 'unknown id' }),
    J({ from: PM_KIT, to: PM_COMM, why: 'same map' }),
    J({ from: MG_CULT, to: MG_TEZ, why: 'same map' }),
    J({ from: PM_KIT, to: MG_CULT, why: '' }),
    J({ from: PM_KIT, to: PM_KIT, why: 'self' }),
    J({ from: PM_KIT, to: 'Nonexistent', why: 'unknown label' }),
    J({ from: PM_KIT, to: MG_CULT, why: 'good' }),
    J({ weird: true }),
  ]);
  const { store, ctx } = setup(() => text);
  const id = await fuse(ctx, 'plastic-modeling', 'manga', { into: 'gunpla' });
  const bridges = store.read(id).edges.filter((e) => e.id.startsWith('bridge-'));
  assert.deepEqual(bridges.map((e) => [e.from, e.to, e.why]), [
    [PM_KIT, 'gunpla/hybrids/gunpla', 'ok'],
    [PM_KIT, MG_CULT, 'good'],
  ]);
  assert.deepEqual(bridges.map((e) => e.id), ['bridge-1', 'bridge-2']);
});

test('hybrids and bridges are capped at 8 and 20; duplicate hybrid labels get -2', async () => {
  const lines = [];
  for (let i = 0; i < 12; i++) lines.push(J({ hybrid: `Hybrid ${i}`, summary: 's', hook: 'h' }));
  lines.push(J({ hybrid: 'Hybrid 0', summary: 's', hook: 'h' })); // beyond cap, ignored
  for (let i = 0; i < 12; i++) {
    lines.push(J({ from: PM_KIT, to: `Hybrid ${i % 8}`, why: `w${i}` }));
    lines.push(J({ from: MG_CULT, to: `Hybrid ${i % 8}`, why: `w${i}` }));
  }
  const pm = Object.keys(foldAll(fixtureEvents('plastic-modeling')).nodes).slice(1, 9);
  const mg = Object.keys(foldAll(fixtureEvents('manga')).nodes).slice(1, 9);
  for (const p of pm) for (const m of mg) lines.push(J({ from: p, to: m, why: `${p} meets ${m}` }));
  const { store, ctx } = setup(() => jl(lines));
  const id = await fuse(ctx, 'plastic-modeling', 'manga', { into: 'x' });
  const o = store.read(id);
  assert.equal(Object.values(o.nodes).filter((n) => n.parent === 'x/hybrids').length, 8);
  assert.equal(o.edges.filter((e) => e.id.startsWith('bridge-')).length, 20);

  const dup = setup(() => jl([J({ hybrid: 'Gunpla' }), J({ hybrid: 'gunpla' })]));
  const id2 = await fuse(dup.ctx, 'plastic-modeling', 'manga', { into: 'x' });
  const o2 = dup.store.read(id2);
  assert.ok(o2.nodes['x/hybrids/gunpla'] && o2.nodes['x/hybrids/gunpla-2']);
});

test('a refusal or max_tokens stop keeps what streamed; a 401 is rethrown unchanged', async () => {
  const cut = setup(() => ({ text: GOOD_TEXT('Gunpla Lab'), stop_reason: 'max_tokens' }));
  const id = await fuse(cut.ctx, 'plastic-modeling', 'manga');
  assert.ok(cut.store.read(id).nodes['gunpla-lab/hybrids/gunpla']);

  const { store, ctx } = setup(() => '');
  const err = Object.assign(new Error('bad key'), { status: 401 });
  ctx.getClient = () => ({ messages: { stream() { throw err; } } });
  await assert.rejects(() => fuse(ctx, 'plastic-modeling', 'manga', { into: 'x' }), (e) => e === err);
  // structure already emitted stays
  const [draft] = [...store.logs.keys()].filter((k) => k.startsWith('draft-'));
  assert.equal(/** @type {any[]} */ (store.logs.get(draft))[0].t, 'ontology.created');
});

test('a bridge between two things with the same name is dropped (planted: Gunpla node -> Gunpla hybrid)', async () => {
  const store = fakeStore({ manga: fixtureEvents('manga'), 'plastic-modeling': fixtureEvents('plastic-modeling') });
  const lines = [
    { hybrid: 'Gunpla', summary: 's', hook: 'h' },
    { from: 'plastic-modeling/kits/gunpla', to: 'Gunpla', why: 'same thing' },
    { from: 'manga', to: 'Gunpla', why: 'anime robots' },
  ].map((o) => JSON.stringify(o)).join('\n');
  const ctx = makeCtx({ store, client: fakeClient(() => lines) });
  const id = await fuse(ctx, 'plastic-modeling', 'manga', { into: 'gunpla' });
  const bridges = store.read(id).edges.filter((e) => e.id.startsWith('bridge-'));
  assert.deepEqual(bridges.map((e) => e.from), ['manga']);
});

test('onDraft is called once with the draft id, before any event is appended (planted: called late)', async () => {
  const seam = [{ hybrid: 'Gunpla', summary: 's', hook: 'h' }, { from: 'manga', to: 'Gunpla', why: 'anime robots' }]
    .map((o) => JSON.stringify(o)).join('\n');
  /** @param {(store: any, cb: (id: string) => void) => (id: string) => void} wrap */
  async function run(wrap) {
    const store = fakeStore({ manga: fixtureEvents('manga'), 'plastic-modeling': fixtureEvents('plastic-modeling') });
    /** @type {{ id: string, eventsSoFar: number }[]} */
    const seen = [];
    const cb = (/** @type {string} */ id) => seen.push({ id, eventsSoFar: store.logs.get(id)?.length ?? -1 });
    const ctx = makeCtx({ store, client: fakeClient(() => seam) });
    const id = await fuse(ctx, 'manga', 'plastic-modeling', { into: 'gunpla', onDraft: wrap(store, cb) });
    return { id, seen };
  }
  /** the check: exactly one call, with the returned id, before any event */
  const problems = (/** @type {{ id: string, seen: any[] }} */ r) =>
    r.seen.length !== 1 ? ['not called exactly once'] : r.seen[0].id !== r.id ? ['wrong id'] : r.seen[0].eventsSoFar !== 0 ? ['called after events'] : [];
  assert.deepEqual(problems(await run((_s, cb) => cb)), []);
  // planted fault: a fuse that calls onDraft only after the structure is written
  const late = await run((store, cb) => (id) => queueMicrotask(() => setTimeout(() => cb(id), 30)));
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(problems(late).length > 0);
});

test('a throwing or rejecting onDraft never breaks the fuse; the return value is still the draft id', async () => {
  for (const onDraft of [() => { throw new Error('boom'); }, async () => { throw new Error('async boom'); }]) {
    const store = fakeStore({ manga: fixtureEvents('manga'), 'plastic-modeling': fixtureEvents('plastic-modeling') });
    const ctx = makeCtx({ store, client: fakeClient(() => '{"hybrid":"Gunpla","summary":"s","hook":"h"}') });
    const id = await fuse(ctx, 'manga', 'plastic-modeling', { into: 'gunpla', onDraft });
    assert.match(id, /^draft-test-/);
    assert.ok(Object.keys(store.read(id).nodes).length > 100);
  }
});
