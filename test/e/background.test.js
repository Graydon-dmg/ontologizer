// @ts-check
// A click on a link, an edge or an empty layer is a background click (clears the selection and
// any citation); only a click on a node keeps them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBackgroundClick } from '../../web/views/graph/math.js';

/** A tiny fake SVG tree: svg > g.root > { g.links > path, g.nodes > g > circle, g.rings > circle }. */
const el = (/** @type {string} */ name, /** @type {any} */ parent = null) => ({ name, parent });
const svg = el('svg'), root = el('g.root', svg);
const links = el('g.links', root), link = el('path.link', links), edge = el('path.edge', links);
const nodes = el('g.nodes', root), nodeG = el('g.node', nodes), circle = el('circle', nodeG);
const rings = el('g.rings', root), ring = el('circle.ring', rings);
const layer = (/** @type {any} */ l) => ({ contains: (/** @type {any} */ n) => { for (let x = n; x; x = x.parent) if (x === l) return true; return false; } });

function check(/** @type {typeof isBackgroundClick} */ isBg) {
  for (const t of [svg, root, links, link, edge, rings, ring]) assert.ok(isBg(t, layer(nodes)), `${t.name} is background`);
  for (const t of [nodeG, circle]) assert.ok(!isBg(t, layer(nodes)), `${t.name} is a node hit`);
}

test('links, edges and empty layers count as background; catches "only the bare svg" ', () => {
  check(isBackgroundClick);
  /** planted fault: the old rule, only a click whose target is the <svg> itself */
  assert.throws(() => check((t) => t === svg));
});
