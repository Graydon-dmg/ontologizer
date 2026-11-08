// @ts-check
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceRadial } from 'd3-force';
// Interface (implemented below; extra test-only options are documented there):
// createGraphLayout({ seed = 1, width = 1000, height = 800 } = {})
// Returns:
//   add(node)                 place a new node at its parent's position plus a seeded jitter;
//                             reheat gently (alpha 0.3, never 1) so placed nodes barely move
//   addEdge(edge)             cross-link: weak link force
//   setFocus(id)              radial force re-centered on the focus by graph distance
//   setCollapsed(ids)         hidden subtrees leave the simulation; their positions are kept
//   positions()               Map<id, { x, y }>
//   on('tick', fn) / off('tick', fn)
//   settle(ticks = 300)       run synchronously (tests, replays)
//   stop()
// Forces: parent link (strong, short), cross-link (weak, long), many-body charge, collide by
// node radius, radial by depth from the focus (ring spacing 90), and an angular pull toward the
// node's category sector (sectors split 360 degrees in category order).
// Determinism: all randomness comes from a seeded PRNG (mulberry32(seed)); never Math.random.
// A node whose parent has not arrived yet starts at the center and is re-placed when its parent
// arrives. Nodes with category "" (roots) get no angular pull.

const RING = 90;
const TAU = Math.PI * 2;

/**
 * Seeded PRNG.
 * @param {number} a
 * @returns {() => number}
 */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @typedef {{ id: string, label?: string, parent: string|null, category: string, depth: number }} OntoNode
 * @typedef {{ id?: string, from: string, to: string, type?: string, why?: string }} OntoEdge
 * @typedef {{ id: string, data: OntoNode, x: number, y: number, vx: number, vy: number,
 *   placed: boolean, hidden: boolean, dist: number, desc: number }} SimNode
 */

/**
 * Create an incremental force layout for the concept map. Coordinates are centered on
 * (width/2, height/2). Options prefixed with `_` are TEST-ONLY fault injectors:
 *   _noAngular: drop the category-sector force; _reheat: alpha used on add() (default 0.3).
 * @param {{ seed?: number, width?: number, height?: number, _noAngular?: boolean, _reheat?: number }} [opts]
 */
export function createGraphLayout({ seed = 1, width = 1000, height = 800, _noAngular = false, _reheat = 0.3 } = {}) {
  const cx = width / 2;
  const cy = height / 2;
  const jitterRng = mulberry32(seed);
  const simRng = mulberry32(seed + 7919);

  /** @type {Map<string, SimNode>} */
  const nodes = new Map();
  /** @type {OntoEdge[]} */
  const edges = [];
  /** @type {string[]} */
  const categories = [];
  /** @type {Set<string>} */
  let collapsed = new Set();
  /** @type {string|null} */
  let focus = null;
  /** @type {Set<(...a: any[]) => void>} */
  const tickFns = new Set();

  /** @type {any} */
  const link = forceLink([]).id((/** @type {any} */ d) => d.id)
    .distance((/** @type {any} */ l) => (l.kind === 'cross' ? 160 : 40))
    .strength((/** @type {any} */ l) => (l.kind === 'cross' ? 0.03 : 0.9));
  const sim = forceSimulation([])
    .randomSource(simRng)
    .force('link', link)
    .force('charge', forceManyBody().strength(-60).distanceMax(250))
    .force('collide', forceCollide((/** @type {any} */ d) => radiusOf(d)).strength(0.8))
    .force('radial', forceRadial((/** @type {any} */ d) => RING * d.dist, cx, cy).strength(0.25))
    .alphaDecay(0.03)
    .velocityDecay(0.5)
    .stop();
  if (!_noAngular) sim.force('angular', angularForce());

  /** @param {SimNode} d */
  function radiusOf(d) {
    return Math.min(22, 5 + 3 * Math.log2(1 + d.desc)) + 2;
  }

  function sectorAngle(/** @type {string} */ cat) {
    const i = categories.indexOf(cat);
    if (i < 0 || !categories.length) return null;
    return ((i + 0.5) * TAU) / categories.length;
  }

  function angularForce() {
    /** @type {SimNode[]} */
    let list = [];
    const f = (/** @type {number} */ alpha) => {
      for (const d of list) {
        if (!d.data.category) continue;
        const a = sectorAngle(d.data.category);
        if (a === null) continue;
        const r = RING * d.dist;
        const tx = cx + r * Math.cos(a);
        const ty = cy + r * Math.sin(a);
        d.vx += (tx - d.x) * 0.12 * alpha;
        d.vy += (ty - d.y) * 0.12 * alpha;
      }
    };
    f.initialize = (/** @type {SimNode[]} */ n) => { list = n; };
    return f;
  }

  /** @returns {number} jitter in [-1,1) scaled */
  function jit() {
    const ang = jitterRng() * TAU;
    const r = 10 + jitterRng() * 10;
    return { dx: Math.cos(ang) * r, dy: Math.sin(ang) * r };
  }

  /** @param {SimNode} n */
  function placeNear(n, parent) {
    const j = jit();
    n.x = parent.x + j.dx;
    n.y = parent.y + j.dy;
    n.vx = 0;
    n.vy = 0;
    n.placed = true;
  }

  /** Place waiting children (recursively) once their parent is placed. @param {SimNode} p */
  function placeChildren(p) {
    for (const c of nodes.values()) {
      if (c.data.parent === p.id && !c.placed) {
        placeNear(c, p);
        placeChildren(c);
      }
    }
  }

  /** Recompute distances, descendants, visibility and push into the simulation. */
  function sync() {
    // hidden = strict descendant of a collapsed id
    for (const n of nodes.values()) {
      let hidden = false;
      let p = n.data.parent;
      let guard = 0;
      while (p !== null && p !== undefined && guard++ < 10000) {
        if (collapsed.has(p)) { hidden = true; break; }
        p = nodes.get(p)?.data.parent ?? null;
      }
      if (n.hidden && !hidden) { n.vx = 0; n.vy = 0; }
      n.hidden = hidden;
    }
    // descendants
    for (const n of nodes.values()) n.desc = 0;
    for (const n of nodes.values()) {
      let p = n.data.parent;
      let guard = 0;
      while (p !== null && p !== undefined && guard++ < 10000) {
        const pn = nodes.get(p);
        if (!pn) break;
        pn.desc++;
        p = pn.data.parent;
      }
    }
    // graph distance from focus over tree edges
    const adj = new Map();
    for (const n of nodes.values()) {
      const p = n.data.parent;
      if (p !== null && nodes.has(p)) {
        if (!adj.has(p)) adj.set(p, []);
        if (!adj.has(n.id)) adj.set(n.id, []);
        adj.get(p).push(n.id);
        adj.get(n.id).push(p);
      }
    }
    const dist = new Map();
    if (focus !== null && nodes.has(focus)) {
      dist.set(focus, 0);
      const q = [focus];
      for (let i = 0; i < q.length; i++) {
        const cur = q[i];
        for (const nb of adj.get(cur) ?? []) {
          if (!dist.has(nb)) { dist.set(nb, dist.get(cur) + 1); q.push(nb); }
        }
      }
    }
    for (const n of nodes.values()) {
      n.dist = dist.has(n.id) ? dist.get(n.id) : (Number.isFinite(n.data.depth) ? n.data.depth : 0);
    }
    const vis = [...nodes.values()].filter((n) => !n.hidden);
    /** @type {any[]} */
    const links = [];
    for (const n of vis) {
      const p = n.data.parent;
      if (p !== null && nodes.has(p) && !nodes.get(p)?.hidden) links.push({ source: p, target: n.id, kind: 'tree' });
    }
    for (const e of edges) {
      const a = nodes.get(e.from);
      const b = nodes.get(e.to);
      if (a && b && !a.hidden && !b.hidden) links.push({ source: e.from, target: e.to, kind: 'cross' });
    }
    sim.nodes(vis);
    link.links(links);
  }

  let running = false;
  function emit() { for (const fn of [...tickFns]) fn(); }

  function loop() {
    if (!running) return;
    if (sim.alpha() < sim.alphaMin()) { running = false; return; }
    sim.tick();
    emit();
    globalThis.requestAnimationFrame(loop);
  }

  /** @param {number} a */
  function reheat(a) {
    sim.alpha(Math.max(sim.alpha(), a));
    if (!running && typeof globalThis.requestAnimationFrame === 'function') {
      running = true;
      globalThis.requestAnimationFrame(loop);
    }
  }

  return {
    /** @param {OntoNode} node */
    add(node) {
      if (nodes.has(node.id)) return;
      const parent = node.parent !== null ? nodes.get(node.parent) : undefined;
      /** @type {SimNode} */
      const n = { id: node.id, data: node, x: cx, y: cy, vx: 0, vy: 0, placed: false, hidden: false, dist: 0, desc: 0 };
      nodes.set(node.id, n);
      if (node.parent === null) n.placed = true;
      else if (parent && parent.placed) placeNear(n, parent);
      if (node.parent === null && focus === null) focus = node.id;
      if (node.category && node.depth === 1 || (node.category && node.category === node.id)) {
        if (!categories.includes(node.category)) categories.push(node.category);
      }
      if (n.placed) placeChildren(n);
      sync();
      reheat(_reheat);
    },
    /** @param {OntoEdge} edge */
    addEdge(edge) {
      edges.push(edge);
      sync();
      reheat(_reheat);
    },
    /** @param {string} id */
    setFocus(id) {
      if (!nodes.has(id)) return;
      focus = id;
      sync();
      reheat(0.5);
    },
    /** @param {Iterable<string>} ids */
    setCollapsed(ids) {
      collapsed = new Set(ids);
      sync();
      reheat(0.3);
    },
    /** @returns {Map<string, {x: number, y: number}>} */
    positions() {
      const m = new Map();
      for (const n of nodes.values()) {
        m.set(n.id, {
          x: Number.isFinite(n.x) ? n.x : cx,
          y: Number.isFinite(n.y) ? n.y : cy,
        });
      }
      return m;
    },
    /** @param {'tick'} _ev @param {() => void} fn */
    on(_ev, fn) { tickFns.add(fn); },
    /** @param {'tick'} _ev @param {() => void} fn */
    off(_ev, fn) { tickFns.delete(fn); },
    /** @param {number} [ticks] */
    settle(ticks = 300) {
      for (let i = 0; i < ticks; i++) sim.tick();
      emit();
    },
    stop() {
      running = false;
      sim.stop();
    },
  };
}
