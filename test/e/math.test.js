// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import * as real from '../../web/views/graph/math.js';

const events = readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const onto = foldAll(events);
const nodes = Object.values(onto.nodes);
const tools = nodes.find((n) => n.label === 'Tools' && n.depth === 1);

/** @param {() => void} fn */
const throws = (fn) => { try { fn(); } catch { return true; } return false; };
/** Assert check passes on real impl and fails on the planted fault. */
function checkCatches(check, impl, faulty) {
  check(impl);
  assert.ok(throws(() => check(faulty)), 'planted fault was not caught');
}

const parentsOf = (id) => { const o = []; let n = onto.nodes[id]; while (n && n.parent) { o.push(n.parent); n = onto.nodes[n.parent]; } return o; };

test('descendants of Tools / leaf; catches count-includes-self', () => {
  assert.ok(tools, 'Tools category exists');
  const expected = nodes.filter((n) => n.id !== tools.id && parentsOf(n.id).includes(tools.id)).length;
  assert.ok(expected > 0);
  assert.equal(expected, nodes.filter((n) => n.id.startsWith(tools.id + '/')).length);
  const leaf = nodes.find((n) => !nodes.some((m) => m.parent === n.id));
  const check = (m) => {
    assert.equal(m.descendants(tools.id, onto), expected);
    assert.equal(m.descendants(leaf.id, onto), 0);
    assert.equal(m.descendants('nope', onto), 0);
  };
  checkCatches(check, real, { ...real, descendants: (id, o) => real.descendants(id, o) + (o.nodes[id] ? 1 : 0) });
});

test('neighborhood = self + parent + children + cross-links; catches missing cross-links', () => {
  const linked = (id) => onto.edges.some((e) => e.from === id || e.to === id);
  const node = nodes.find((n) => n.parent && nodes.some((m) => m.parent === n.id) && linked(n.id));
  assert.ok(node, 'fixture has a node with parent, children, and an edge');
  const expected = new Set([node.id, node.parent]);
  for (const n of nodes) if (n.parent === node.id) expected.add(n.id);
  for (const e of onto.edges) { if (e.from === node.id) expected.add(e.to); if (e.to === node.id) expected.add(e.from); }
  assert.ok(expected.size > 3);
  const faulty = { ...real, neighborhood: (id, o) => real.neighborhood(id, { ...o, edges: [] }) };
  const check = (m) => assert.deepEqual([...m.neighborhood(node.id, onto)].sort(), [...expected].sort());
  checkCatches(check, real, faulty);
  assert.deepEqual([...real.neighborhood('nope', onto)], ['nope']);
});

const WB = { minX: -300, minY: -200, maxX: 500, maxY: 400 };
const MINI = { width: 200, height: 150 };
const VIEW = { width: 800, height: 600 };

test('viewportRect after zoom to k=2 at (100,50); catches ignored zoom', () => {
  const t = { x: 400 - 200, y: 300 - 100, k: 2 };
  const check = (m) => {
    const { s, ox, oy } = real.miniScale(WB, MINI);
    const r = m.viewportRect(t, VIEW, WB, MINI);
    assert.ok(Math.abs(r.width - 400 * s) < 1e-9);
    assert.ok(Math.abs(r.height - 300 * s) < 1e-9);
    assert.ok(Math.abs((r.x + r.width / 2) - ((100 - WB.minX) * s + ox)) < 1e-9);
    assert.ok(Math.abs((r.y + r.height / 2) - ((50 - WB.minY) * s + oy)) < 1e-9);
  };
  const faulty = { ...real, viewportRect: (t2, v, wb, mi) => real.viewportRect({ ...t2, k: 1 }, v, wb, mi) };
  checkCatches(check, real, faulty);
});

test('panFromMinimap round-trips through viewportRect; catches ignored minimap scale', () => {
  const pt = { x: 120, y: 40 };
  const check = (m) => {
    for (const k of [1, 2, 0.5]) {
      const t = m.panFromMinimap(pt, WB, MINI, VIEW, k);
      assert.equal(t.k, k);
      const r = real.viewportRect(t, VIEW, WB, MINI);
      assert.ok(Math.abs(r.x + r.width / 2 - pt.x) < 1e-6);
      assert.ok(Math.abs(r.y + r.height / 2 - pt.y) < 1e-6);
    }
  };
  const faulty = { ...real, panFromMinimap: (p, wb, mi, v, k) => ({ x: v.width / 2 - k * p.x, y: v.height / 2 - k * p.y, k }) };
  checkCatches(check, real, faulty);
});

test('labelVisible hides depth-3 at k=1, shows at k=2; catches show-everything', () => {
  const rings = real.ringsFrom(onto.root, onto);
  const rule = { alwaysDepth: 2, zoomForDeeper: 1.6 };
  const d3 = nodes.find((n) => n.depth === 3);
  const d1 = nodes.find((n) => n.depth === 1);
  const d2 = nodes.find((n) => n.depth === 2);
  assert.ok(d3 && d1 && d2);
  const ctx = (k, hovered = null) => ({ k, focus: onto.root, hovered, rings, rule });
  const check = (m) => {
    assert.equal(m.labelVisible(d3, ctx(1)), false);
    assert.equal(m.labelVisible(d3, ctx(2)), true);
    assert.equal(m.labelVisible(d1, ctx(1)), true);
    assert.equal(m.labelVisible(d2, ctx(1)), true);
    assert.equal(m.labelVisible(d3, ctx(1, d3.id)), true);
    assert.equal(m.labelVisible(onto.nodes[onto.root], ctx(1)), true);
  };
  checkCatches(check, real, { ...real, labelVisible: () => true });
});

test('ringsFrom, worldBounds, miniScale basics', () => {
  const rings = real.ringsFrom(onto.root, onto);
  assert.equal(rings.get(onto.root), 0);
  assert.equal(rings.size, nodes.length);
  for (const n of nodes) assert.equal(rings.get(n.id), n.depth);
  assert.deepEqual(real.worldBounds(new Map()), { minX: -1, minY: -1, maxX: 1, maxY: 1 });
  assert.deepEqual(real.worldBounds([{ x: 1, y: 5 }, { x: -2, y: 3 }]), { minX: -2, minY: 3, maxX: 1, maxY: 5 });
  const { s, ox, oy } = real.miniScale({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, MINI);
  assert.ok(Number.isFinite(s) && Number.isFinite(ox) && Number.isFinite(oy));
});
