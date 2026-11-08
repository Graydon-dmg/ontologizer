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
 * show at their first spot; the rest are tried by priority (higher first: categories, hybrids, the focus's or
 * selection's neighbourhood), then parents before children, then larger nodes before smaller, and a label
 * is skipped when its box overlaps one already placed.
 * Each label may offer several candidate spots (`boxes`, in order of preference: right, left,
 * below, above); it takes the first one that overlaps nothing placed so far.
 * `must` labels are always drawn, placed right after the forced ones.
 * @param {Array<{ id: string, forced: boolean, must?: boolean, priority?: number, depth: number, r: number,
 *                 box?: { x: number, y: number, w: number, h: number },
 *                 boxes?: Array<{ x: number, y: number, w: number, h: number }> }>} items
 * @returns {Map<string, number>} drawn label id -> index of the spot it took
 */
export function placeLabels(items) {
  const order = [...items].sort((a, b) =>
    (Number(b.forced) - Number(a.forced)) || (Number(b.must ?? false) - Number(a.must ?? false)) || ((b.priority ?? 0) - (a.priority ?? 0)) || (a.depth - b.depth) || (b.r - a.r) || (a.id < b.id ? -1 : 1));
  /** @type {Array<{ x: number, y: number, w: number, h: number }>} */
  const placed = [];
  /** @type {Map<string, number>} */
  const shown = new Map();
  const free = (/** @type {{ x: number, y: number, w: number, h: number }} */ a) =>
    !placed.some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
  for (const it of order) {
    const boxes = it.boxes ?? (it.box ? [it.box] : []);
    // forced labels keep their first spot; the rest take the first spot that is free
    // `must` labels (hybrids) take a free spot when there is one, and their first spot otherwise
    const i = it.forced ? 0 : Math.max(boxes.findIndex(free), it.must ? 0 : -1);
    if (i < 0 || !boxes[i]) continue;
    placed.push(boxes[i]);
    shown.set(it.id, i);
  }
  return shown;
}

/**
 * The zoom transform that fits world bounds into a box, or null when it cannot be computed yet
 * (a 0x0 mount at connect time, or no nodes). k is clamped to [minK, maxK].
 * The box may carry an offset (x, y): the free area inside the shell's insets.
 * @param {Bounds} b
 * @param {Size & { x?: number, y?: number }} box
 * @param {{ minK: number, maxK: number, margin: number }} opt
 * @returns {{ x: number, y: number, k: number }|null}
 */
export function fitTransform(b, box, opt) {
  if (!(box.width > 0 && box.height > 0)) return null;
  if (![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite)) return null;
  const w = Math.max(b.maxX - b.minX, 1), h = Math.max(b.maxY - b.minY, 1);
  const k = Math.max(opt.minK, Math.min(opt.maxK, opt.margin * Math.min(box.width / w, box.height / h)));
  return { x: (box.x ?? 0) + box.width / 2 - k * (b.minX + b.maxX) / 2, y: (box.y ?? 0) + box.height / 2 - k * (b.minY + b.maxY) / 2, k };
}

/** @param {unknown} v */
const key = (v) => JSON.stringify(v ?? null);

/**
 * Keep the view's local filter and collapsed set; adopt the snapshot's value for a field only when
 * the snapshot's value actually changed since the last one seen. A filter set locally (setFilter)
 * therefore survives every later event that does not change the stored filter.
 * @param {{ filter: { categories: string[]|null, maxDepth: number|null }, collapsed: string[] }} local
 * @param {{ filter: string, collapsed: string }} seen  keys of the last snapshot values seen
 * @param {{ filter?: any, collapsed?: string[] }|undefined} view  the snapshot's view state
 * @returns {{ local: typeof local, seen: typeof seen, changed: boolean }}
 */
export function syncViewState(local, seen, view) {
  const f = { categories: view?.filter?.categories ?? null, maxDepth: view?.filter?.maxDepth ?? null };
  const c = view?.collapsed ?? [];
  const fk = key(f), ck = key(c);
  const out = { local: { ...local }, seen: { ...seen }, changed: false };
  if (fk !== seen.filter) { out.local.filter = f; out.seen.filter = fk; out.changed = true; }
  if (ck !== seen.collapsed) { out.local.collapsed = [...c]; out.seen.collapsed = ck; out.changed = true; }
  return out;
}

/**
 * Did a zoom gesture really move the view? A click with a few px of jitter still fires d3-zoom
 * 'zoom' events; only a pan beyond clickDistance, or any scale change, counts as the user moving.
 * @param {{ x: number, y: number, k: number }} start transform when the gesture began
 * @param {{ x: number, y: number, k: number }} t current transform
 * @param {number} clickDistance px
 */
export function isUserMove(start, t, clickDistance) {
  return Math.abs(t.k - start.k) > 1e-9 || Math.hypot(t.x - start.x, t.y - start.y) > clickDistance;
}

/**
 * The transform to use after the view is resized, whether or not the build is still running:
 * - the user has not moved since load / the last fit: refit the whole map to the new size;
 * - the user has moved: keep the same map point at the center of the view, same zoom.
 * Returns null when the new box has no size yet.
 * @param {{ x: number, y: number, k: number }} t current transform
 * @param {Size & { x?: number, y?: number }} prev previous free area of the view (inside the insets)
 * @param {Size & { x?: number, y?: number }} box new free area
 * @param {boolean} userMoved
 * @param {Bounds} bounds world bounds of the visible map
 * @param {{ minK: number, maxK: number, margin: number }} fitOpt
 * @returns {{ x: number, y: number, k: number }|null}
 */
export function resizeTransform(t, prev, box, userMoved, bounds, fitOpt) {
  if (!(box.width > 0 && box.height > 0)) return null;
  if (!userMoved || !(prev.width > 0 && prev.height > 0)) return fitTransform(bounds, box, fitOpt);
  const cx = (r) => (r.x ?? 0) + r.width / 2, cy = (r) => (r.y ?? 0) + r.height / 2;
  return { x: t.x + cx(box) - cx(prev), y: t.y + cy(box) - cy(prev), k: t.k };
}

/**
 * The free area of the view: its size minus the shell's chrome insets (--onto-inset-*, px).
 * Insets that would leave less than 40% of either side are ignored for that axis.
 * @param {Size} size
 * @param {{ top: number, right: number, bottom: number, left: number }} ins
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function innerRect(size, ins) {
  let { top, right, bottom, left } = ins;
  if (size.width - left - right < size.width * 0.4) left = right = 0;
  if (size.height - top - bottom < size.height * 0.4) top = bottom = 0;
  return { x: left, y: top, width: Math.max(0, size.width - left - right), height: Math.max(0, size.height - top - bottom) };
}

/**
 * Read --onto-inset-top/right/bottom/left (px) from a style lookup; missing or bad values are 0.
 * @param {(name: string) => string} get e.g. (n) => getComputedStyle(el).getPropertyValue(n)
 */
export function readInsets(get) {
  const v = (/** @type {string} */ side) => { const n = parseFloat(get(`--onto-inset-${side}`)); return Number.isFinite(n) && n > 0 ? n : 0; };
  return { top: v('top'), right: v('right'), bottom: v('bottom'), left: v('left') };
}
