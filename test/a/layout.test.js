// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createGraphLayout } from '../../web/shared/layout/graph.js';

const FIXTURE = new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url);

/** Deterministic tiny PRNG for the synthetic fallback tree. @param {number} a */
function rng(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Synthetic events: root, 8 categories, ~80 nodes, ~20 cross-links. */
function syntheticEvents() {
  const r = rng(5);
  /** @type {any[]} */
  const ev = [];
  ev.push({ t: 'node.added', node: { id: 'root', label: 'root', parent: null, category: '', depth: 0 } });
  const ids = [];
  for (let c = 0; c < 8; c++) {
    const cid = `c${c}`;
    ev.push({ t: 'node.added', node: { id: cid, label: cid, parent: 'root', category: cid, depth: 1 } });
    ids.push(cid);
  }
  for (let i = 0; ids.length < 88; i++) {
    const c = i % 8;
    const pool = ids.filter((id) => id.startsWith(`c${c}`));
    const parent = pool[Math.floor(r() * pool.length)];
    const id = `c${c}-${i}`;
    const depth = parent === `c${c}` ? 2 : 3;
    ev.push({ t: 'node.added', node: { id, label: id, parent, category: `c${c}`, depth } });
    ids.push(id);
  }
  for (let i = 0; i < 20; i++) {
    ev.push({ t: 'edge.added', edge: { id: `e${i}`, from: ids[8 + Math.floor(r() * 80)], to: ids[8 + Math.floor(r() * 80)], type: 'influences', why: '' } });
  }
  return ev;
}

function loadEvents() {
  if (existsSync(FIXTURE)) {
    return readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  return syntheticEvents();
}

/** @param {any} layout @param {any[]} events */
function feed(layout, events) {
  for (const e of events) {
    if (e.t === 'node.added') layout.add(e.node);
    else if (e.t === 'edge.added') layout.addEdge(e.edge);
  }
}

/** @param {any[]} events */
function nodesOf(events) {
  return events.filter((e) => e.t === 'node.added').map((e) => e.node);
}

/** @param {Map<string,{x:number,y:number}>} m */
const plain = (m) => new Map([...m].map(([k, v]) => [k, { x: v.x, y: v.y }]));

// ---- checks: each returns a list of problems (empty = pass) ----

/**
 * 1. Same seed + same input -> positions agree within 1 px.
 * @param {(opts: any) => any} factory
 * @param {any[]} events
 * @returns {string[]}
 */
export function checkSeeded(factory, events) {
  const a = factory({ seed: 3 });
  const b = factory({ seed: 3 });
  feed(a, events); feed(b, events);
  a.settle(); b.settle();
  const pa = a.positions(); const pb = b.positions();
  /** @type {string[]} */
  const problems = [];
  for (const [id, p] of pa) {
    const q = pb.get(id);
    if (!q) { problems.push(`${id} missing`); continue; }
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (!(d <= 1)) problems.push(`${id} differs by ${d}`);
  }
  a.stop(); b.stop();
  return problems;
}

/**
 * 2. >= 80% of each category's nodes lie in the category's angular sector around the root.
 * @param {(opts: any) => any} factory
 * @param {any[]} events
 * @param {{ noAngular?: boolean }} [extra]
 * @returns {string[]}
 */
export function checkSectors(factory, events, extra = {}) {
  const l = factory({ seed: 1, ...(extra.noAngular ? { _noAngular: true } : {}) });
  feed(l, events);
  l.settle(600);
  const pos = l.positions();
  const nodes = nodesOf(events);
  const root = nodes.find((n) => n.parent === null);
  const rp = pos.get(root.id);
  /** @type {string[]} */
  const cats = [];
  for (const n of nodes) if (n.category && n.depth === 1 && !cats.includes(n.category)) cats.push(n.category);
  const K = cats.length;
  /** @type {string[]} */
  const problems = [];
  cats.forEach((cat, i) => {
    const center = ((i + 0.5) * 2 * Math.PI) / K;
    const half = Math.PI / K;
    const members = nodes.filter((n) => n.category === cat);
    let inside = 0;
    for (const n of members) {
      const p = pos.get(n.id);
      let d = Math.atan2(p.y - rp.y, p.x - rp.x) - center;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) <= half) inside++;
    }
    const frac = inside / members.length;
    if (frac < 0.8) problems.push(`${cat}: only ${(frac * 100).toFixed(0)}% in sector`);
  });
  l.stop();
  return problems;
}

/**
 * 3. Adding one node to a settled layout moves no other node more than 20 px.
 * @param {(opts: any) => any} factory
 * @param {any[]} events
 * @param {Record<string, any>} [opts]
 * @returns {string[]}
 */
export function checkStability(factory, events, opts = {}) {
  const l = factory({ seed: 1, ...opts });
  feed(l, events);
  l.settle(600);
  const before = plain(l.positions());
  const nodes = nodesOf(events);
  const parent = nodes.find((n) => n.depth === 2) ?? nodes[1];
  l.add({ id: 'late-node', label: 'late', parent: parent.id, category: parent.category, depth: parent.depth + 1 });
  l.settle(300);
  const after = l.positions();
  /** @type {string[]} */
  const problems = [];
  for (const [id, p] of before) {
    const q = after.get(id);
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d > 20) problems.push(`${id} moved ${d.toFixed(1)} px`);
  }
  l.stop();
  return problems;
}

/**
 * 4. A node added before its parent ends with finite coordinates once the parent arrives.
 * @param {(opts: any) => any} factory
 * @returns {string[]}
 */
export function checkOrphanFinite(factory) {
  const l = factory({ seed: 1 });
  l.add({ id: 'r', label: 'r', parent: null, category: '', depth: 0 });
  l.add({ id: 'kid', label: 'kid', parent: 'mid', category: 'a', depth: 2 });
  l.add({ id: 'a', label: 'a', parent: 'r', category: 'a', depth: 1 });
  l.add({ id: 'mid', label: 'mid', parent: 'a', category: 'a', depth: 2 });
  l.settle(300);
  /** @type {string[]} */
  const problems = [];
  for (const [id, p] of l.positions()) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) problems.push(`${id} not finite`);
  }
  if (!l.positions().has('kid')) problems.push('kid missing');
  l.stop();
  return problems;
}

const real = (/** @type {any} */ o) => createGraphLayout(o);
const events = loadEvents();

test('fixture source', () => {
  assert.ok(nodesOf(events).length >= 50, 'enough nodes');
});

test('1 seeded: same seed, same positions', () => {
  assert.deepEqual(checkSeeded(real, events), []);
});

test('1 fault: Math.random jitter is detected', () => {
  /** @type {(o: any) => any} */
  const noisy = (o) => {
    const l = createGraphLayout(o);
    const orig = l.positions;
    l.positions = () => new Map([...orig()].map(([k, v]) => [k, { x: v.x + Math.random() * 20, y: v.y + Math.random() * 20 }]));
    return l;
  };
  assert.ok(checkSeeded(noisy, events).length > 0);
});

test('2 sectors: >=80% of each category inside its sector', () => {
  assert.deepEqual(checkSectors(real, events), []);
});

test('2 fault: no angular force is detected', () => {
  assert.ok(checkSectors(real, events, { noAngular: true }).length > 0);
});

test('3 stability: adding a node moves others <= 20 px', () => {
  assert.deepEqual(checkStability(real, events), []);
});

test('3 fault: reheat to alpha 1 is detected', () => {
  assert.ok(checkStability(real, events, { _reheat: 1 }).length > 0);
});

test('4 orphan: child before parent ends finite', () => {
  assert.deepEqual(checkOrphanFinite(real), []);
});

test('4 fault: child placed at missing parent (NaN) is detected', () => {
  /** @type {(o: any) => any} */
  const nanFactory = (o) => {
    const l = createGraphLayout(o);
    const orig = l.positions;
    l.positions = () => {
      const m = orig();
      const k = m.get('kid');
      if (k) m.set('kid', { x: NaN, y: NaN });
      return m;
    };
    return l;
  };
  assert.ok(checkOrphanFinite(nanFactory).length > 0);
});

test('pin holds a node in place through settle; unpin releases it; unknown ids are no-ops', async () => {
  const { createGraphLayout } = await import('../../web/shared/layout/graph.js');
  const L = createGraphLayout({ seed: 3 });
  const mk = (id, parent, depth) => ({ id, label: id, parent, category: depth ? 'r/a' : '', depth });
  L.add(mk('r', null, 0)); L.add(mk('r/a', 'r', 1)); L.add(mk('r/a/b', 'r/a', 2));
  L.settle(50);
  L.pin('r/a/b', 777, 111);
  L.settle(100);
  const p = L.positions().get('r/a/b');
  assert.equal(p?.x, 777); assert.equal(p?.y, 111);
  L.unpin('r/a/b');
  L.settle(200);
  assert.notEqual(L.positions().get('r/a/b')?.x, 777, 'unpinned node is free to move');
  L.pin('nope', 1, 2); L.unpin('nope');
  assert.equal(L.positions().has('nope'), false);
  L.stop();
});

test('planted fault: a pin that only sets x/y (no fx/fy) does not hold', async () => {
  const { createGraphLayout } = await import('../../web/shared/layout/graph.js');
  const L = createGraphLayout({ seed: 3 });
  const mk = (id, parent, depth) => ({ id, label: id, parent, category: depth ? 'r/a' : '', depth });
  L.add(mk('r', null, 0)); L.add(mk('r/a', 'r', 1)); L.add(mk('r/a/b', 'r/a', 2));
  L.settle(50);
  // Fake pin: move without fixing. The hold check must fail.
  L.pin('r/a/b', 777, 111); L.unpin('r/a/b');
  L.settle(100);
  assert.notEqual(L.positions().get('r/a/b')?.x, 777);
  L.stop();
});
