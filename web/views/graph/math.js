// @ts-check
// Pure geometry / graph helpers for the 2D graph view. No DOM, no d3.

/** @typedef {import('../../../src/core/schema.js').Ontology} Ontology */
/** @typedef {{ minX: number, minY: number, maxX: number, maxY: number }} Bounds */
/** @typedef {{ width: number, height: number }} Size */

/** @param {Ontology} ontology @returns {Map<string, string[]>} */
function childLists(ontology) {
  /** @type {Map<string, string[]>} */
  const kids = new Map();
  for (const n of Object.values(ontology.nodes)) {
    if (n.parent == null) continue;
    const l = kids.get(n.parent);
    if (l) l.push(n.id);
    else kids.set(n.parent, [n.id]);
  }
  return kids;
}

/**
 * The node, its parent, its direct children, and every edge-joined node.
 * @param {string} nodeId @param {Ontology} ontology @returns {Set<string>}
 */
export function neighborhood(nodeId, ontology) {
  const out = new Set([nodeId]);
  const node = ontology.nodes[nodeId];
  if (!node) return out;
  if (node.parent != null) out.add(node.parent);
  for (const n of Object.values(ontology.nodes)) if (n.parent === nodeId) out.add(n.id);
  for (const e of ontology.edges || []) {
    if (e.from === nodeId) out.add(e.to);
    else if (e.to === nodeId) out.add(e.from);
  }
  return out;
}

/**
 * Count of nodes strictly below nodeId.
 * @param {string} nodeId @param {Ontology} ontology @returns {number}
 */
export function descendants(nodeId, ontology) {
  if (!ontology.nodes[nodeId]) return 0;
  const kids = childLists(ontology);
  let count = 0;
  const stack = [...(kids.get(nodeId) || [])];
  const seen = new Set([nodeId]);
  while (stack.length) {
    const id = /** @type {string} */ (stack.pop());
    if (seen.has(id)) continue;
    seen.add(id);
    count++;
    for (const c of kids.get(id) || []) stack.push(c);
  }
  return count;
}

/**
 * Tree distance from focusId over parent links (undirected).
 * @param {string} focusId @param {Ontology} ontology @returns {Map<string, number>}
 */
export function ringsFrom(focusId, ontology) {
  /** @type {Map<string, number>} */
  const rings = new Map();
  if (!ontology.nodes[focusId]) return rings;
  const kids = childLists(ontology);
  rings.set(focusId, 0);
  let frontier = [focusId];
  while (frontier.length) {
    /** @type {string[]} */
    const next = [];
    for (const id of frontier) {
      const d = /** @type {number} */ (rings.get(id));
      const adj = [...(kids.get(id) || [])];
      const p = ontology.nodes[id].parent;
      if (p != null && ontology.nodes[p]) adj.push(p);
      for (const a of adj) {
        if (!rings.has(a)) {
          rings.set(a, d + 1);
          next.push(a);
        }
      }
    }
    frontier = next;
  }
  return rings;
}

/**
 * @param {{ id: string }} node
 * @param {{ k: number, focus: string, hovered: string|null, rings: Map<string, number>,
 *           rule: { alwaysDepth: number, zoomForDeeper: number } }} ctx
 * @returns {boolean}
 */
export function labelVisible(node, ctx) {
  if (node.id === ctx.focus || node.id === ctx.hovered) return true;
  const r = ctx.rings.get(node.id);
  if (r !== undefined && r <= ctx.rule.alwaysDepth) return true;
  return ctx.k >= ctx.rule.zoomForDeeper;
}

/**
 * @param {Bounds} wb @param {Size} miniSize @returns {{ s: number, ox: number, oy: number }}
 */
export function miniScale(wb, miniSize) {
  const w = Math.max(wb.maxX - wb.minX, 1);
  const h = Math.max(wb.maxY - wb.minY, 1);
  const pw = w * 1.1;
  const ph = h * 1.1;
  const s = Math.min(miniSize.width / pw, miniSize.height / ph);
  const minX = wb.minX - w * 0.05;
  const minY = wb.minY - h * 0.05;
  // mini = (world - min) * s + o, where min is the unpadded minimum.
  const ox = (miniSize.width - pw * s) / 2 + (wb.minX - minX) * s;
  const oy = (miniSize.height - ph * s) / 2 + (wb.minY - minY) * s;
  return { s, ox, oy };
}

/**
 * @param {Map<string, {x: number, y: number}> | Iterable<{x: number, y: number}>} positions
 * @returns {Bounds}
 */
export function worldBounds(positions) {
  const it = positions instanceof Map ? positions.values() : positions;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of it) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX === Infinity) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

/**
 * @param {{x: number, y: number, k: number}} t @param {Size} viewSize
 * @param {Bounds} wb @param {Size} miniSize
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function viewportRect(t, viewSize, wb, miniSize) {
  const { s, ox, oy } = miniScale(wb, miniSize);
  const x0 = (0 - t.x) / t.k, x1 = (viewSize.width - t.x) / t.k;
  const y0 = (0 - t.y) / t.k, y1 = (viewSize.height - t.y) / t.k;
  return {
    x: (x0 - wb.minX) * s + ox,
    y: (y0 - wb.minY) * s + oy,
    width: (x1 - x0) * s,
    height: (y1 - y0) * s,
  };
}

/**
 * @param {{x: number, y: number}} point @param {Bounds} wb @param {Size} miniSize
 * @param {Size} viewSize @param {number} k
 * @returns {{ x: number, y: number, k: number }}
 */
export function panFromMinimap(point, wb, miniSize, viewSize, k) {
  const { s, ox, oy } = miniScale(wb, miniSize);
  const wx = (point.x - ox) / s + wb.minX;
  const wy = (point.y - oy) / s + wb.minY;
  return { x: viewSize.width / 2 - k * wx, y: viewSize.height / 2 - k * wy, k };
}

/**
 * Ids hidden by collapsed subtrees (strict descendants of a collapsed id) or by the filter
 * (category not listed, depth beyond maxDepth). The root and collapsed nodes themselves are
 * never hidden by this; the root is exempt from the filter.
 * @param {Ontology} ontology
 * @param {string[]|Set<string>|null|undefined} collapsed
 * @param {{ categories: string[]|null, maxDepth: number|null }|null|undefined} filter
 * @returns {Set<string>}
 */
export function hiddenIds(ontology, collapsed, filter) {
  /** @type {Set<string>} */
  const out = new Set();
  const col = new Set(collapsed || []);
  const cats = filter && Array.isArray(filter.categories) ? new Set(filter.categories) : null;
  const maxDepth = filter && Number.isFinite(filter.maxDepth) ? /** @type {number} */ (filter.maxDepth) : null;
  for (const n of Object.values(ontology.nodes)) {
    if (n.parent == null) continue;
    let hide = (cats && !cats.has(n.category)) || (maxDepth !== null && n.depth > maxDepth);
    if (!hide && col.size) {
      const seen = new Set([n.id]);
      for (let p = n.parent; p != null && !seen.has(p); p = ontology.nodes[p]?.parent) {
        if (col.has(p)) { hide = true; break; }
        seen.add(p);
      }
    }
    if (hide) out.add(n.id);
  }
  return out;
}

/**
 * Greedy label placement in screen space. Forced labels (focus, hovered, the first rings) always
 * show; the rest are tried parents before children, then larger nodes before smaller, and a label
 * is skipped when its box overlaps one already placed.
 * @param {Array<{ id: string, forced: boolean, depth: number, r: number,
 *                 box: { x: number, y: number, w: number, h: number } }>} items
 * @returns {Set<string>} ids whose label is drawn
 */
export function placeLabels(items) {
  const order = [...items].sort((a, b) =>
    (Number(b.forced) - Number(a.forced)) || (a.depth - b.depth) || (b.r - a.r) || (a.id < b.id ? -1 : 1));
  /** @type {Array<{ x: number, y: number, w: number, h: number }>} */
  const placed = [];
  const shown = new Set();
  for (const it of order) {
    const a = it.box;
    const hit = !it.forced && placed.some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
    if (hit) continue;
    placed.push(a);
    shown.add(it.id);
  }
  return shown;
}
