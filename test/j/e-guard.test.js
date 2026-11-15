// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// 3LR MED-3 / LOW-2: event-supplied keys that name a built-in (constructor, __proto__, toString, ...)
// never reach it, so fold and foldInto agree and nothing throws; a job record never shares the
// event's nodeIds. A seeded fuzz compares fold, foldInto, foldAll and the 1.8.0 oracle. Each check
// feeds its planted fault first.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fold, foldInto, foldAll, emptyOntology } from '../../src/core/events.js';
import { oracle } from './e-oracle-fold.js';
import { openStore } from '../../src/core/store.js';

const BUILTINS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];
const created = { t: 'ontology.created', at: 0, name: 'G', root: 'r', brief: {}, categories: [] };
const base = [created, { t: 'node.added', at: 1, node: { id: 'r', label: 'R', parent: null } },
  { t: 'lens.added', at: 2, lens: { id: 'l1', persona: 'chef', analogs: {} } }];

/** @param {any[]} ev */
const viaFold = (ev) => ev.reduce(fold, emptyOntology());
/** @param {any[]} ev @param {(o: any, e: any) => any} [f] */
const viaInto = (ev, f = foldInto) => { const o = emptyOntology(); for (const e of ev) f(o, e); return o; };

/** Planted fault: the pre-fix lens.analog (a plain lookup) inside foldInto. @param {any} o @param {any} e */
function unguarded(o, e) {
  if (e && e.t === 'lens.analog' && o.lenses[e.lensId] && !Object.hasOwn(o.lenses, e.lensId)) {
    o.lenses[e.lensId].analogs[e.nodeId] = { label: e.label };
    return o;
  }
  return foldInto(o, e);
}

test('lens.analog naming a built-in lens is ignored: fold and foldInto agree, nothing throws', () => {
  for (const name of BUILTINS) {
    const ev = [...base, { t: 'lens.analog', at: 3, lensId: name, nodeId: 'r', label: 'x' }];
    if (name !== '__proto__') assert.throws(() => viaInto(ev, unguarded), TypeError, `planted fault must throw for ${name}`);
    const a = viaFold(ev); const b = viaInto(ev); const c = foldAll(ev);
    assert.equal(JSON.stringify(b), JSON.stringify(a), name);
    assert.deepStrictEqual(c, a, name);
    assert.deepStrictEqual(Object.keys(a.lenses), ['l1'], name);
    assert.equal(JSON.stringify(a), JSON.stringify(foldAll(base)), `${name}: the event changes nothing`);
  }
  // a built-in name as an analog's node id on a real lens is just a key
  const o = foldAll([...base, { t: 'lens.analog', at: 3, lensId: 'l1', nodeId: '__proto__', label: 'p' }]);
  assert.ok(Object.hasOwn(o.lenses.l1.analogs, '__proto__'));
  assert.equal(Object.getPrototypeOf(o.lenses.l1.analogs), Object.prototype);
  // a lens whose analogs is not a plain object is never written into
  const odd = foldAll([created]);
  odd.lenses.weird = { id: 'weird', analogs: 'nope' };
  assert.doesNotThrow(() => foldInto(odd, { t: 'lens.analog', at: 1, lensId: 'weird', nodeId: 'r', label: 'x' }));
  assert.equal(odd.lenses.weird.analogs, 'nope');
});

test('node.updated naming a built-in node is ignored (1.8.0 folded a junk node)', () => {
  for (const name of BUILTINS) {
    const ev = [...base, { t: 'node.updated', at: 3, id: name, patch: { label: 'junk' } }];
    // planted fault: the 1.8.0 plain lookup makes a node out of the built-in
    if (name !== '__proto__') assert.ok(Object.hasOwn(oracle(ev).nodes, name), `oracle junk for ${name}`);
    for (const o of [viaFold(ev), viaInto(ev), foldAll(ev)]) assert.deepStrictEqual(Object.keys(o.nodes), ['r'], name);
  }
  // once the node exists under that name, it updates like any other (and matches 1.8.0)
  const ev = [...base, ...BUILTINS.map((id, i) => ({ t: 'node.added', at: 3 + i, node: { id, label: id } })),
    ...BUILTINS.map((id, i) => ({ t: 'node.updated', at: 10 + i, id, patch: { label: `${id}!` } }))];
  assert.equal(JSON.stringify(foldAll(ev)), JSON.stringify(oracle(ev)));
  for (const id of BUILTINS) assert.equal(foldAll(ev).nodes[id].label, `${id}!`);
});

test('jobs with a built-in id fold the same as 1.8.0', () => {
  const ev = [created, ...BUILTINS.flatMap((id, i) => [
    { t: 'job.queued', at: i * 2 + 1, job: { id, kind: 'research' } },
    { t: 'job.failed', at: i * 2 + 2, job: { id, kind: 'research', error: 'e' } }])];
  assert.equal(JSON.stringify(foldAll(ev)), JSON.stringify(oracle(ev)));
  assert.equal(JSON.stringify(viaFold(ev)), JSON.stringify(oracle(ev)));
});

test('a job record never shares the event\'s nodeIds array', () => {
  /** @param {(ev: any[]) => any} f */
  const leaks = (f) => {
    const e = { t: 'job.queued', at: 1, job: { id: 'j', kind: 'hydrate', nodeIds: ['a', 'b'] } };
    const o = f([created, e]);
    const before = JSON.stringify(o);
    e.job.nodeIds.push('MUTATED');
    return JSON.stringify(o) !== before;
  };
  assert.ok(leaks(oracle), 'planted fault: the 1.8.0 fold shares the array');
  assert.ok(!leaks(viaFold), 'fold');
  assert.ok(!leaks(viaInto), 'foldInto');
  assert.ok(!leaks(foldAll), 'foldAll');
  const o = foldAll([created, { t: 'job.queued', at: 1, job: { id: 'j', kind: 'hydrate', nodeIds: ['a'] } }, { t: 'job.done', at: 2, job: { id: 'j', kind: 'hydrate' } }]);
  assert.deepEqual(o.jobs.j.nodeIds, ['a']);
  assert.equal(o.jobs.j.state, 'done');
});

/** @type {string[]} */
const homes = [];
after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });

test('a store whose log holds such events appends them and loads again', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-eg-')); homes.push(home);
  const s1 = openStore(home);
  const id = s1.createDraft({ context: 'g' });
  for (const e of base) s1.append(id, e);
  for (const [i, name] of BUILTINS.entries()) {
    s1.append(id, { t: 'lens.analog', at: 10 + i, lensId: name, nodeId: 'r', label: 'x' });
    s1.append(id, { t: 'node.updated', at: 20 + i, id: name, patch: { label: 'junk' } });
  }
  s1.append(id, { t: 'insight', at: 40, text: 'still alive' });
  s1.flush(); s1.close();
  const s2 = openStore(home);
  const o = s2.read(id);
  assert.deepEqual(Object.keys(o.nodes), ['r']);
  assert.deepEqual(Object.keys(o.lenses), ['l1']);
  assert.equal(o.insights.at(-1)?.text, 'still alive');
  s2.close();
});

// ---------- fuzz ----------

/** Seeded PRNG (mulberry32). @param {number} seed */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * A random log. names: the key pool (ordinary names, optionally the built-ins). addedOnly: built-in
 * names are referenced only after something was added under them (where 1.8.0 was already right).
 * @param {number} seed @param {{ builtins: boolean, addedOnly: boolean }} o
 */
function randomLog(seed, { builtins, addedOnly }) {
  const r = rng(seed);
  const names = ['a', 'b', 'c', 'd', ...(builtins ? BUILTINS : [])];
  const pick = (/** @type {any[]} */ xs) => xs[Math.floor(r() * xs.length)];
  const nodes = new Set(); const lenses = new Set();
  /** @param {Set<string>} known */
  const ref = (known) => {
    const n = pick(names);
    return addedOnly && BUILTINS.includes(n) && !known.has(n) ? pick(['a', 'b', 'c', 'd']) : n;
  };
  /** @type {any[]} */
  const ev = [created];
  for (let at = 1; at < 80; at++) {
    const k = Math.floor(r() * 12);
    if (k === 0) { const id = pick(names); nodes.add(id); ev.push({ t: 'node.added', at, node: { id, label: `L${at}`, parent: 'r', sources: [{ title: 't', url: 'u' }] } }); }
    else if (k === 1) ev.push({ t: 'node.updated', at, id: ref(nodes), patch: { label: `U${at}` } });
    else if (k === 2) ev.push({ t: 'node.hydrated', at, nodeId: ref(nodes), hydration: { job: 'j', examples: ['x'], not_for: 'n', not_for_ids: [], model: 'm', at: 't' } });
    else if (k === 3) { const id = pick(names); lenses.add(id); ev.push({ t: 'lens.added', at, lens: { id, persona: 'p', analogs: {} } }); }
    else if (k === 4) ev.push({ t: 'lens.analog', at, lensId: ref(lenses), nodeId: pick(names), label: `A${at}`, ...(r() < 0.5 ? { breaks: 'b' } : {}) });
    else if (k === 5) ev.push({ t: pick(['job.queued', 'job.started', 'job.done', 'job.failed']), at, job: { id: pick(names), kind: 'k', ...(r() < 0.5 ? { nodeIds: [pick(names)] } : {}), ...(r() < 0.3 ? { error: 'e' } : {}) } });
    else if (k === 6) ev.push({ t: 'edge.added', at, edge: { id: pick(names), from: pick(names), to: pick(names) } });
    else if (k === 7) ev.push({ t: 'category.added', at, category: { id: pick(names), label: `C${at}` } });
    else if (k === 8) ev.push({ t: pick(['chat.asked', 'chat.answered', 'chat.failed']), at, chatId: 'main', msgId: pick(names), replyTo: pick(names), text: 't', error: 'e' });
    else if (k === 9) ev.push({ t: 'insight', at, text: `i${at}`, ...(r() < 0.5 ? { nodeId: pick(names) } : {}) });
    else if (k === 10) ev.push({ t: 'visibility.raised', at, to: 'private', reason: 'source', sources: [pick(names)] });
    else ev.push({ t: 'view.changed', at, patch: { focus: pick(names), filter: { maxDepth: 2 } } });
  }
  return ev;
}

test('fuzz: fold, foldInto and foldAll agree on random logs with built-in names, and never throw', () => {
  // planted fault: the unguarded foldInto throws on some built-in log
  let thrown = 0;
  for (let s = 1; s <= 300; s++) { try { viaInto(randomLog(s, { builtins: true, addedOnly: false }), unguarded); } catch { thrown++; } }
  assert.ok(thrown > 0, 'the planted fault never threw: the fuzz does not reach the built-in lens path');
  for (let s = 1; s <= 300; s++) {
    const ev = randomLog(s, { builtins: true, addedOnly: false });
    const a = viaFold(ev); const b = viaInto(ev); const c = foldAll(ev);
    const sa = JSON.stringify(a);
    assert.equal(JSON.stringify(b), sa, `seed ${s} foldInto`);
    assert.equal(JSON.stringify(c), sa, `seed ${s} foldAll`);
    assert.deepStrictEqual(b, a, `seed ${s} deep`);
  }
});

test('fuzz: equal to the 1.8.0 oracle wherever 1.8.0 was already right', () => {
  // ordinary names, and built-in names only after they were added (where the plain lookup found
  // the own key): the guard changes nothing there
  for (const opts of [{ builtins: false, addedOnly: false }, { builtins: true, addedOnly: true }]) {
    for (let s = 1; s <= 300; s++) {
      const ev = randomLog(s, opts);
      const want = JSON.stringify(oracle(ev));
      assert.equal(JSON.stringify(foldAll(ev)), want, `seed ${s} ${JSON.stringify(opts)}`);
      assert.equal(JSON.stringify(viaFold(ev)), want, `seed ${s} fold ${JSON.stringify(opts)}`);
    }
  }
  // planted fault: with unrestricted built-in names the oracle (the plain lookup) differs somewhere
  let differs = 0;
  for (let s = 1; s <= 300; s++) { const ev = randomLog(s, { builtins: true, addedOnly: false }); if (JSON.stringify(foldAll(ev)) !== JSON.stringify(oracle(ev))) differs++; }
  assert.ok(differs > 0, 'the fuzz never reaches a built-in lookup');
});
