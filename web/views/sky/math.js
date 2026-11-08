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
