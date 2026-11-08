// @ts-check
// Pure math for the 3D view. Must not import three, so it runs in Node tests.

/** @typedef {{ minX: number, minY: number, maxX: number, maxY: number }} Bounds */
/** @typedef {[number, number, number]} Vec3 */

/**
 * Bounding box of layout positions. An empty map gives a zero box at the origin.
 * @param {Map<string, { x: number, y: number }>} positions
 * @returns {Bounds}
 */
export function boundsOf(positions) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of positions.values()) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/**
 * Layout (x, y) -> world [x, 0, z]. The documented mapping: center the bounds on the origin,
 * then scale uniformly so the larger side of the bounds spans `size` world units.
 * Layout y becomes world z, so the floor is the 2D view seen from above.
 * Zero-size bounds keep scale 1.
 * @param {{ x: number, y: number }} pos
 * @param {Bounds} bounds
 * @param {number} size
 * @returns {Vec3}
 */
export function toWorld(pos, bounds, size) {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const span = Math.max(w, h);
  const s = span > 0 ? size / span : 1;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return [(pos.x - cx) * s, 0, (pos.y - cy) * s];
}

/**
 * Ancestor chain from a node up to its root, starting with the node itself.
 * Stops at a parent that has not arrived yet, and guards against cycles.
 * @param {string} id
 * @param {{ nodes: Record<string, { parent: string|null }> }} ontology
 * @returns {string[]}
 */
function chain(id, ontology) {
  const out = [];
  const seen = new Set();
  let cur = /** @type {string|null} */ (id);
  while (cur != null && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    const n = ontology.nodes[cur];
    cur = n ? n.parent : null;
  }
  return out;
}

/**
 * Tree hops from a up to their lowest common ancestor and down to b.
 * Siblings: 2. Node and grandparent: 2. Different categories: through the root.
 * No common ancestor (two roots of a fused map): both chains plus one bridging hop.
 * @param {string} a
 * @param {string} b
 * @param {{ nodes: Record<string, { parent: string|null }> }} ontology
 * @returns {number}
 */
export function treeDistance(a, b, ontology) {
  if (a === b) return 0;
  const ca = chain(a, ontology);
  const cb = chain(b, ontology);
  /** @type {Map<string, number>} */
  const upA = new Map(ca.map((id, i) => [id, i]));
  for (let j = 0; j < cb.length; j++) {
    const i = upA.get(cb[j]);
    if (i !== undefined) return i + j;
  }
  return (ca.length - 1) + (cb.length - 1) + 1;
}

/**
 * Points along a quadratic Bezier arc from `from` to `to` whose apex rises `height`
 * above the straight line between them (world y is up). Returns n + 1 points
 * (t = 0, 1/n, ..., 1), so with an even n the apex at t = 0.5 is sampled exactly.
 * For a quadratic Bezier the midpoint is (P0 + 2C + P2) / 4, so the control point
 * sits 2 * height above the chord's midpoint.
 * @param {Vec3} from
 * @param {Vec3} to
 * @param {number} height
 * @param {number} [n]
 * @returns {Vec3[]}
 */
export function arcPoints(from, to, height, n = 24) {
  const steps = Math.max(1, Math.floor(n));
  /** @type {Vec3} */
  const c = [
    (from[0] + to[0]) / 2,
    (from[1] + to[1]) / 2 + 2 * height,
    (from[2] + to[2]) / 2,
  ];
  /** @type {Vec3[]} */
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u, b = 2 * u * t, d = t * t;
    pts.push([
      a * from[0] + b * c[0] + d * to[0],
      a * from[1] + b * c[1] + d * to[1],
      a * from[2] + b * c[2] + d * to[2],
    ]);
  }
  return pts;
}

/**
 * Cut text to at most `max` characters, ending with an ellipsis when cut. Cuts at a word
 * boundary when one falls in the last third, so "a slow-reduced pan sauce with" never ends mid-word.
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function truncate(text, max = 30) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp >= Math.floor((max - 1) * 2 / 3) ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

/**
 * Greedy label placement. Candidates are screen boxes centred on (x, y); lower tier wins, then
 * nearer to the camera. Tier 0 always shows. A label skips if its box overlaps one already placed.
 * Hysteresis: a label shown last time (`was`) tests with a box shrunk by `keep` px per side and
 * wins ties within its tier, so labels do not flicker as the scene turns.
 * @param {{ id: string, x: number, y: number, w: number, h: number, tier: number, dist: number, was?: boolean,
 *           alt?: { x: number, y: number, w: number, h: number } }[]} cands
 * @param {{ pad?: number, keep?: number, altPlaced?: Set<string>|null }} [opts]  altPlaced collects ids placed by their alt box
 * @returns {Set<string>}
 */
export function placeLabels(cands, { pad = 2, keep = 1, altPlaced = null } = {}) {
  const order = [...cands].sort((a, b) =>
    a.tier - b.tier || Number(!!b.was) - Number(!!a.was) || a.dist - b.dist);
  /** @type {{ l: number, t: number, r: number, b: number }[]} */
  const placed = [];
  const out = new Set();
  /** @param {{ x: number, y: number, w: number, h: number }} c @param {number} g */
  const fits = (c, g) => {
    const box = { l: c.x - c.w / 2 - g, r: c.x + c.w / 2 + g, t: c.y - c.h / 2 - g, b: c.y + c.h / 2 + g };
    return !placed.some((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t);
  };
  for (const c of order) {
    const g = c.was ? -keep : pad;
    // A candidate may carry a smaller fallback box (`alt`), tried when its full box has no room.
    let use = c.tier === 0 || fits(c, g) ? c : c.alt && fits(c.alt, g) ? c.alt : null;
    if (!use) continue;
    if (use !== c && altPlaced) altPlaced.add(c.id);
    placed.push({ l: use.x - use.w / 2, r: use.x + use.w / 2, t: use.y - use.h / 2, b: use.y + use.h / 2 });
    out.add(c.id);
  }
  return out;
}

/**
 * Chat citations: exactly the cited nodes that exist, and the ids of cross-links whose BOTH
 * ends are cited. Neighbours are not included (unlike a search highlight).
 * @param {string[]|null} ids
 * @param {{ nodes: Record<string, unknown>, edges?: { id: string, from: string, to: string }[] }} ontology
 * @returns {{ nodes: Set<string>, edges: Set<string> }|null}  null when nothing is cited
 */
export function citedSets(ids, ontology) {
  if (!ids || !ids.length) return null;
  const nodes = new Set(ids.filter((id) => Object.prototype.hasOwnProperty.call(ontology.nodes, id)));
  if (!nodes.size) return null;
  const edges = new Set();
  for (const e of ontology.edges || []) if (nodes.has(e.from) && nodes.has(e.to)) edges.add(e.id);
  return { nodes, edges };
}

/**
 * Mean of world points; null for none.
 * @param {Vec3[]} pts
 * @returns {Vec3|null}
 */
export function centroid(pts) {
  if (!pts.length) return null;
  const c = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return /** @type {Vec3} */ (c.map((v) => v / pts.length));
}

/**
 * True when every projected point (normalised device coordinates, as from three's
 * Vector3.project) falls outside the visible screen or behind the camera. Empty -> false.
 * @param {{ x: number, y: number, z: number }[]} ndc
 * @returns {boolean}
 */
export function allOffscreen(ndc) {
  if (!ndc.length) return false;
  return ndc.every((p) => p.z > 1 || p.x < -1 || p.x > 1 || p.y < -1 || p.y > 1);
}
