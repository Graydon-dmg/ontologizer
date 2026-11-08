// @ts-check
// The floor matches the 2D view: the 3D view reads the shared layout's positions and maps them
// with toWorld; it never runs a layout of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import { createGraphLayout } from '../../web/shared/layout/graph.js';
import { toWorld, boundsOf } from '../../web/views/sky/math.js';

const events = fs.readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

/** Feed a layout the way the page does, then settle. */
function settledLayout() {
  const layout = createGraphLayout({ seed: 1, width: 1000, height: 800 });
  for (const e of events) {
    if (e.t === 'node.added') layout.add(e.node);
    else if (e.t === 'edge.added') layout.addEdge(e.edge);
  }
  layout.settle();
  layout.stop();
  return layout;
}

test('toWorld of every settled fixture position equals the 2D position under the documented mapping', () => {
  const layout = settledLayout();
  const pos = layout.positions();
  const nodeCount = Object.keys(foldAll(events).nodes).length;
  assert.equal(pos.size, nodeCount);
  const b = boundsOf(pos);
  const SIZE = 600;
  const s = SIZE / Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  for (const [id, p] of pos) {
    const [x, y, z] = toWorld(p, b, SIZE);
    assert.equal(y, 0, `${id} not on the floor`);
    // Back from world to layout: must land on the 2D view's own position.
    assert.ok(Math.abs(x / s + cx - p.x) < 1e-6 && Math.abs(z / s + cy - p.y) < 1e-6, `${id} off the 2D position`);
  }
  // The floor fits: everything within SIZE/2 of the origin on both axes.
  for (const p of pos.values()) {
    const [x, , z] = toWorld(p, b, SIZE);
    assert.ok(Math.abs(x) <= SIZE / 2 + 1e-9 && Math.abs(z) <= SIZE / 2 + 1e-9);
  }
});

// ---------- the view never runs its own layout ----------

const SKY = new URL('../../web/views/sky/', import.meta.url);

/** @param {string} src @returns {string[]} problems */
export function scanSource(src) {
  const p = [];
  if (/layout\/graph\.js/.test(src)) p.push('imports the shared layout module');
  if (/['"]d3-force['"]/.test(src)) p.push('imports d3-force');
  if (/createGraphLayout|forceSimulation/.test(src)) p.push('builds a layout');
  if (/\blayout\s*\.\s*(add|addEdge|settle|setFocus|setCollapsed)\s*\(/.test(src)) p.push('drives the shared layout');
  return p;
}

test('no file in web/views/sky runs or drives a layout; the view reads ctx.layout.positions()', () => {
  const files = fs.readdirSync(SKY).filter((f) => f.endsWith('.js'));
  let reads = false;
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, SKY), 'utf8');
    assert.deepEqual(scanSource(src), [], f);
    if (/layout\s*\.\s*positions\s*\(/.test(src)) reads = true;
  }
  const index = fs.readFileSync(new URL('index.js', SKY), 'utf8');
  if (!/^\/\/ Epic F registers/m.test(index)) assert.ok(reads, 'no sky file reads layout.positions()');
});

test('planted fault: a view that runs its own layout is caught', () => {
  const rogue = `import { createGraphLayout } from '../../shared/layout/graph.js';
    const own = createGraphLayout({ seed: 1 }); own.add(node); own.settle();`;
  assert.ok(scanSource(rogue).length > 0);
  assert.ok(scanSource(`import { forceSimulation } from 'd3-force';`).length > 0);
  assert.ok(scanSource(`ctx.layout.add(e.node)`).length > 0);
});

test('importing the view in Node does not throw', async () => {
  await import('../../web/views/sky/index.js');
});
