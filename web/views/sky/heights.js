// @ts-check
// Height modes for the 3D view: one number in [0, 1] per node, for one meaning at a time.
// Pure and deterministic (no three, no DOM), so it runs in Node tests.
//
//   learning       ideas you need first sit low, advanced ones high ('requires' links + tree depth)
//   coverage       how well researched an idea is (article, sources, children, researched descendants)
//   connectedness  how many cross-links touch the idea (sqrt-scaled, so one hub does not flatten the rest)

/** @typedef {'off'|'learning'|'coverage'|'connectedness'} HeightMode */
/** @typedef {{ nodes: Record<string, { parent: string|null, depth?: number, status?: string,
 *              article?: { sources?: unknown[] }|null, sources?: unknown[] }>,
 *              edges?: { from: string, to: string, type: string }[] }} HeightOntology */

export const HEIGHT_MODES = /** @type {const} */ (['off', 'learning', 'coverage', 'connectedness']);

/** A step along a prerequisite chain counts this much more than a step down the tree. */
export const DEPTH_WEIGHT = 0.5;

/** Sorted node ids: every function walks nodes in this order, so the result never depends on insertion order. */
const ids = (/** @type {HeightOntology} */ o) => Object.keys((o && o.nodes) || {}).sort();

/**
 * Raw learning levels (not normalised). A 'requires' link A -> B means "B needs A first", so B sits
 * at least one level above A: level(B) >= level(A) + 1 (longest-path layering). Tree depth is a
 * gentle base, DEPTH_WEIGHT per level, so a map with few 'requires' links still reads:
 *   level(n) = max(DEPTH_WEIGHT * depth(n), max over prerequisites p of level(p) + 1)
 * Cycles are broken deterministically: a depth-first walk in sorted id order drops each link that
 * closes a loop back onto the current path. Self-links and links to unknown nodes are ignored.
 * @param {HeightOntology} ontology
 * @returns {Map<string, number>}
 */
export function learningLevels(ontology) {
  const all = ids(ontology);
  const nodes = (ontology && ontology.nodes) || {};
  /** @type {Map<string, string[]>} prerequisite -> the nodes that need it */
  const out = new Map(all.map((id) => [id, []]));
  for (const e of (ontology && ontology.edges) || []) {
    if (!e || e.type !== 'requires' || e.from === e.to) continue;
    if (!out.has(e.from) || !out.has(e.to)) continue;
    /** @type {string[]} */ (out.get(e.from)).push(e.to);
  }
  for (const list of out.values()) list.sort();
  // Keep only the links of a depth-first forest; a link back onto the current path closes a cycle.
  /** @type {Map<string, string[]>} node -> its kept prerequisites */
  const prereqs = new Map(all.map((id) => [id, []]));
  const state = new Map(); // 1 = on the current path, 2 = done
  for (const start of all) {
    if (state.has(start)) continue;
    /** @type {{ id: string, i: number }[]} */
    const stack = [{ id: start, i: 0 }];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = /** @type {string[]} */ (out.get(top.id))[top.i++];
      if (next === undefined) { state.set(top.id, 2); stack.pop(); continue; }
      if (state.get(next) === 1) continue; // closes a cycle: dropped
      /** @type {string[]} */ (prereqs.get(next)).push(top.id);
      if (!state.has(next)) { state.set(next, 1); stack.push({ id: next, i: 0 }); }
    }
  }
  // Longest path over the acyclic links, memoised, without recursion (deep chains are fine).
  /** @type {Map<string, number>} */
  const level = new Map();
  for (const start of all) {
    if (level.has(start)) continue;
    const stack = [start];
    while (stack.length) {
      const id = stack[stack.length - 1];
      if (level.has(id)) { stack.pop(); continue; }
      const ps = /** @type {string[]} */ (prereqs.get(id));
      const pending = ps.filter((p) => !level.has(p));
      if (pending.length) { stack.push(...pending); continue; }
      const d = Number(nodes[id] && nodes[id].depth) || 0;
      let v = DEPTH_WEIGHT * Math.max(0, d);
      for (const p of ps) v = Math.max(v, /** @type {number} */ (level.get(p)) + 1);
      level.set(id, v);
      stack.pop();
    }
  }
  return level;
}

/** Saturating 0..1 curve: 0 -> 0, `half` -> 0.5, then toward 1. */
const sat = (/** @type {number} */ k, /** @type {number} */ half) => (k > 0 ? 1 - Math.pow(2, -k / half) : 0);

/**
 * How well researched each node is, in [0, 1]: thin and unexplored ideas are low.
 *   own(n)  = 0.5 explained article + 0.25 sources (2 sources -> half) + 0.25 children (3 children -> half)
 *   raw(n)  = 0.75 own(n) + 0.25 share of its descendants that have an article or a source
 *   height  = raw smoothed once with its tree neighbours (parent and children, weight `smooth`),
 *             so the map reads like terrain while every node keeps its own height.
 * A pending node (still being written) counts as unexplored. Already in [0, 1]; not stretched to
 * the map's best node, so a thin map stays low.
 * @param {HeightOntology} ontology
 * @param {{ smooth?: number }} [opts]
 * @returns {Map<string, number>}
 */
export function coverageScores(ontology, { smooth = 0.3 } = {}) {
  const all = ids(ontology);
  const nodes = (ontology && ontology.nodes) || {};
  /** @type {Map<string, string[]>} */
  const kids = new Map(all.map((id) => [id, []]));
  for (const id of all) {
    const p = nodes[id].parent;
    if (p != null && p !== id && kids.has(p)) /** @type {string[]} */ (kids.get(p)).push(id);
  }
  /** @type {Map<string, number>} */
  const own = new Map();
  /** @type {Map<string, boolean>} */
  const researched = new Map();
  for (const id of all) {
    const n = nodes[id];
    if (n.status === 'pending') { own.set(id, 0); researched.set(id, false); continue; }
    const art = n.article ? 1 : 0;
    const srcs = Math.max((n.sources || []).length, (n.article && n.article.sources ? n.article.sources : []).length);
    own.set(id, 0.5 * art + 0.25 * sat(srcs, 2) + 0.25 * sat(/** @type {string[]} */ (kids.get(id)).length, 3));
    researched.set(id, art > 0 || srcs > 0);
  }
  // Descendant counts, bottom-up from a sorted, cycle-safe walk.
  /** @type {Map<string, { total: number, done: number }>} */
  const sub = new Map();
  const seen = new Set();
  for (const start of all) {
    if (seen.has(start)) continue;
    /** @type {{ id: string, i: number }[]} */
    const stack = [{ id: start, i: 0 }];
    seen.add(start);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const c = /** @type {string[]} */ (kids.get(top.id))[top.i++];
      if (c !== undefined) { if (!seen.has(c)) { seen.add(c); stack.push({ id: c, i: 0 }); } continue; }
      let total = 0, done = 0;
      for (const k of /** @type {string[]} */ (kids.get(top.id))) {
        const s = sub.get(k);
        if (!s) continue; // a child reached only through a cycle
        total += 1 + s.total;
        done += (researched.get(k) ? 1 : 0) + s.done;
      }
      sub.set(top.id, { total, done });
      stack.pop();
    }
  }
  /** @type {Map<string, number>} */
  const raw = new Map();
  for (const id of all) {
    const s = sub.get(id) || { total: 0, done: 0 };
    raw.set(id, 0.75 * /** @type {number} */ (own.get(id)) + 0.25 * (s.total ? s.done / s.total : 0));
  }
  /** @type {Map<string, number>} */
  const outMap = new Map();
  const a = Math.max(0, Math.min(1, smooth));
  for (const id of all) {
    const near = [...(/** @type {string[]} */ (kids.get(id)))];
    const p = nodes[id].parent;
    if (p != null && raw.has(p) && p !== id) near.push(p);
    const r = /** @type {number} */ (raw.get(id));
    const v = near.length ? (1 - a) * r + a * (near.reduce((s, x) => s + /** @type {number} */ (raw.get(x)), 0) / near.length) : r;
    outMap.set(id, Math.max(0, Math.min(1, v)));
  }
  return outMap;
}

/** Cross-link weight by kind: a bridge joins distant areas, so it counts a little more. */
export const LINK_WEIGHT = /** @type {Record<string, number>} */ ({ bridge: 1.5 });

/**
 * Weighted cross-link degree per node (tree links are not counted). Self-links and links to unknown
 * nodes are ignored.
 * @param {HeightOntology} ontology
 * @returns {Map<string, number>}
 */
export function linkDegrees(ontology) {
  const deg = new Map(ids(ontology).map((id) => [id, 0]));
  for (const e of (ontology && ontology.edges) || []) {
    if (!e || e.from === e.to || !deg.has(e.from) || !deg.has(e.to)) continue;
    const w = LINK_WEIGHT[e.type] ?? 1;
    deg.set(e.from, /** @type {number} */ (deg.get(e.from)) + w);
    deg.set(e.to, /** @type {number} */ (deg.get(e.to)) + w);
  }
  return deg;
}

/**
 * Divide by the largest value (after `curve`), so the highest node is 1. All zero stays zero.
 * @param {Map<string, number>} m @param {(v: number) => number} [curve]
 * @returns {Map<string, number>}
 */
export function normalise(m, curve = (v) => v) {
  let max = 0;
  /** @type {Map<string, number>} */
  const c = new Map();
  for (const [k, v] of m) { const x = Math.max(0, curve(Number.isFinite(v) ? v : 0)); c.set(k, x); if (x > max) max = x; }
  for (const [k, v] of c) c.set(k, max > 0 ? v / max : 0);
  return c;
}

/**
 * Heights in [0, 1] for one mode; null for 'off' (or an unknown mode).
 * @param {string} mode
 * @param {HeightOntology} ontology
 * @returns {Map<string, number>|null}
 */
export function heightsFor(mode, ontology) {
  if (mode === 'learning') return normalise(learningLevels(ontology));
  if (mode === 'coverage') return coverageScores(ontology);
  if (mode === 'connectedness') return normalise(linkDegrees(ontology), Math.sqrt);
  return null;
}

/**
 * One step of the height animation: move `cur` toward `target`, framerate-independent
 * (time constant `tau` ms), snapping exactly onto the target when within `eps`.
 * @param {number} cur @param {number} target @param {number} dtMs @param {number} [tau] @param {number} [eps]
 */
export function easeToward(cur, target, dtMs, tau = 180, eps = 0.05) {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tau);
  const next = cur + (target - cur) * k;
  return Math.abs(target - next) < eps ? target : next;
}

/**
 * The apex lift for a cross-link between two lifted ends: its own height, raised when the ends
 * differ a lot so the arc still crests above both (a quadratic's crest at t = 0.5 is
 * mid + height, and mid is |dy| / 2 under the higher end).
 * @param {number} h @param {number} yA @param {number} yB @param {number} [clear]
 */
export function arcLift(h, yA, yB, clear = 20) {
  return Math.max(h, Math.abs(yA - yB) / 2 + clear);
}
