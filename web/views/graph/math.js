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
 * Forced and `must` labels are always drawn: at their first free spot, else at `fallback` (default 0).
 * @param {Array<{ id: string, forced: boolean, must?: boolean, fallback?: number, priority?: number, depth: number, r: number,
 *                 box?: { x: number, y: number, w: number, h: number },
 *                 boxes?: Array<{ x: number, y: number, w: number, h: number }> }>} items
 * @returns {Map<string, number>} drawn label id -> index of the spot it took
 */
export function placeLabels(items) {
  const order = [...items].sort((a, b) =>
    (Number(b.forced) - Number(a.forced)) || ((b.priority ?? 0) - (a.priority ?? 0)) || (a.depth - b.depth) || (b.r - a.r) || (a.id < b.id ? -1 : 1));
  /** @type {Array<{ x: number, y: number, w: number, h: number }>} */
  const placed = [];
  /** @type {Map<string, number>} */
  const shown = new Map();
  const free = (/** @type {{ x: number, y: number, w: number, h: number }} */ a) =>
    !placed.some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
  for (const it of order) {
    const boxes = it.boxes ?? (it.box ? [it.box] : []);
    // forced labels keep their first spot; the rest take the first spot that is free
    // every label takes its first free spot; forced and `must` labels (hybrids) that find none
    // take their fallback spot anyway
    let i = boxes.findIndex(free);
    if (i < 0 && (it.forced || it.must)) i = it.fallback ?? 0;
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
 * Both panels on an axis are honoured while they leave at least 25% of it (e.g. 900 px with the
 * legend and the explain panel open: the map fits in the column between them). Below that the
 * smaller inset is dropped, and if that still leaves less than 40%, both are.
 * @param {Size} size
 * @param {{ top: number, right: number, bottom: number, left: number }} ins
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function innerRect(size, ins) {
  /** @param {number} len @param {number} a @param {number} b */
  const axis = (len, a, b) => {
    if (len - a - b >= len * 0.25) return [a, b];
    const [a2, b2] = a >= b ? [a, 0] : [0, b];
    return len - a2 - b2 >= len * 0.4 ? [a2, b2] : [0, 0];
  };
  const [left, right] = axis(size.width, ins.left, ins.right);
  const [top, bottom] = axis(size.height, ins.top, ins.bottom);
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

/** Label geometry in screen px (11.5px labels, 10px italic analog line under them). */
export const LABEL_GEOM = { charW: 6.2, analogCharW: 5.4, h: 14, analogH: 13 };

/**
 * An analog as shown on the map: at most `max` characters, with an ellipsis.
 * @param {string} s @param {number} [max]
 */
export function truncateAnalog(s, max = 30) {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '\u2026' : s;
}

/** @typedef {{ id: string, forced: boolean, full?: boolean, must?: boolean, priority?: number, depth: number, r: number,
 *   cx: number, cy: number, R: number, w: number, aw: number, prev?: number }} LabelEntry
 *   cx, cy, R: the node's centre and radius on screen; w: label width; aw: analog width (0 = no analog);
 *   full: hovered or focused (its analog shows even when crowded); prev: last frame's spot. */

/**
 * The four spots (right, left, below, above) for a label, optionally with its analog as a second
 * line directly under it (same anchor and side). Screen px.
 * @param {LabelEntry} e @param {boolean} withAnalog
 */
export function spotBoxes(e, withAnalog) {
  const H = LABEL_GEOM.h, A = withAnalog ? LABEL_GEOM.analogH : 0, W = withAnalog ? Math.max(e.w, e.aw) : e.w;
  return [
    { x: e.cx + e.R + 5, y: e.cy - H / 2, w: W, h: H + A },
    { x: e.cx - e.R - 5 - W, y: e.cy - H / 2, w: W, h: H + A },
    { x: e.cx - W / 2, y: e.cy + e.R + 2, w: W, h: H + A },
    { x: e.cx - W / 2, y: e.cy - e.R - 2 - H - A, w: W, h: H + A },
  ];
}

/**
 * Place every label, each with its lens analog when the combined box fits. Candidates per label:
 * label+analog at each spot (last frame's spot first, so nothing hops), then label alone at each
 * spot. A label that is culled shows no analog. Forced labels are always drawn (at their last spot
 * when every spot is taken); a hovered or focused one (`full`) keeps its analog even then.
 * @param {LabelEntry[]} entries
 * @param {typeof spotBoxes} [boxesOf]
 * @returns {Map<string, { spot: number, analog: boolean }>} drawn labels only
 */
export function planLabels(entries, boxesOf = spotBoxes) {
  const items = entries.map((e) => {
    const prev = e.prev ?? 0;
    const spots = [prev, ...[0, 1, 2, 3].filter((i) => i !== prev)];
    /** @type {{ spot: number, analog: boolean, box: { x: number, y: number, w: number, h: number } }[]} */
    const cands = [];
    if (e.aw > 0) { const b = boxesOf(e, true); for (const sp of spots) cands.push({ spot: sp, analog: true, box: b[sp] }); }
    const b = boxesOf(e, false);
    for (const sp of spots) cands.push({ spot: sp, analog: false, box: b[sp] });
    const fallback = e.aw > 0 && !e.full ? spots.length : 0;
    return { id: e.id, forced: e.forced, must: e.must, priority: e.priority, depth: e.depth, r: e.r, boxes: cands.map((c) => c.box), cands, fallback };
  });
  const placed = placeLabels(items);
  /** @type {Map<string, { spot: number, analog: boolean }>} */
  const out = new Map();
  for (const it of items) {
    const i = placed.get(it.id);
    if (i !== undefined) out.set(it.id, { spot: it.cands[i].spot, analog: it.cands[i].analog });
  }
  return out;
}
