// @ts-check
// <onto-graph>: the 2D graph view. Draws, hit-tests and emits; the shell owns all chrome and
// feeds the layout. See web/shared/view.js for the view standard.
import { select } from 'd3-selection';
import { zoom, zoomIdentity } from 'd3-zoom';
import { drag } from 'd3-drag';
import { easeBackOut } from 'd3-ease';
import { hsl } from 'd3-color';
import { registerView } from '../../shared/view.js';
import { THEME, MOTION, LABEL_RULE, categoryColor, depthLightness, nodeRadius, edgeStyle, originOutline } from '../../shared/tokens.js';
import { descendants, ringsFrom, labelVisible } from './math.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FALLBACK_CENTER = { x: 500, y: 400 };
const SCALE_EXTENT = /** @type {[number, number]} */ ([0.2, 4]);

/** @typedef {{ g: any, circle: any, ring: any, label: any, r: number, spawn: { t0: number, from: {x:number,y:number} }|null }} NodeView */

/**
 * Fill color: category color lightened by depth; root / unknown category -> neutral.
 * @param {import('../../src/core/schema.js').Ontology} ont
 * @param {any} node
 * @returns {string}
 */
function fillFor(ont, node) {
  const cat = ont.categories.find((c) => c.id === node.category);
  if (!cat) return THEME.dark.muted;
  // d3-color does not parse the space-separated hsl() syntax tokens emit
  const c = hsl(categoryColor(cat.index, cat.family).replace(/\s+/g, ','));
  c.l += depthLightness(node.depth) / 100;
  return c.formatHsl();
}

/**
 * Quadratic link path; control point offset perpendicular to the chord by curve * distance.
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @param {number} curve
 * @returns {string}
 */
function linkPath(a, b, curve) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const cx = (a.x + b.x) / 2 - dy * curve;
  const cy = (a.y + b.y) / 2 + dx * curve;
  return `M${a.x},${a.y}Q${cx},${cy} ${b.x},${b.y}`;
}

/**
 * @param {any} sel d3 selection
 * @param {number[]|null} dash
 */
function setDash(sel, dash) {
  sel.attr('stroke-dasharray', dash ? dash.join(' ') : null);
}

const Base = globalThis.HTMLElement ?? class {};

class OntoGraph extends Base {
  /** @type {import('../../shared/view.js').ViewContext|null} */ ctx = null;
  /** @type {Map<string, NodeView>} */ nodes = new Map();
  /** @type {Map<string, any>} parent links keyed by child id */ links = new Map();
  /** @type {Map<string, any>} */ edges = new Map();
  /** @type {Map<string, number>} */ rings = new Map();
  /** @type {string|null} */ hovered = null;
  /** @type {{ id: string, x: number, y: number }|null} */ dragging = null;
  k = 1;
  centered = false;
  frame = 0;
  /** @type {any} */ svg = null;
  /** @type {any} */ layers = null;
  /** @type {any} */ zoomBehavior = null;
  /** @type {ResizeObserver|null} */ resizeObs = null;
  /** @type {(() => void)|null} */ tickFn = null;

  /**
   * @param {HTMLElement} el
   * @param {import('../../shared/view.js').ViewContext} ctx
   */
  mount(el, ctx) {
    this.ctx = ctx;
    this.buildSvg(el);
    this.tickFn = () => this.schedule();
    ctx.layout.on('tick', this.tickFn);
    const ont = ctx.snapshot();
    for (const id of Object.keys(ont.nodes)) this.ensureNode(id, false);
    for (const e of ont.edges) this.ensureEdge(e);
    this.refreshRings();
    this.refreshLabels();
    this.centerWorld();
    this.schedule();
  }

  /** @param {HTMLElement} el */
  buildSvg(el) {
    const svg = select(el).append('svg').attr('width', '100%').attr('height', '100%').style('position', 'absolute').style('inset', '0').style('display', 'block').style('touch-action', 'none');
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const root = svg.append('g');
    this.layers = {
      root,
      links: root.append('g').attr('class', 'links').attr('fill', 'none'),
      nodes: root.append('g').attr('class', 'nodes'),
      halos: root.append('g').attr('class', 'halos'),
      labels: root.append('g').attr('class', 'labels').style('pointer-events', 'none'),
    };
    this.svg = svg;
    this.zoomBehavior = zoom().scaleExtent(SCALE_EXTENT).on('zoom', (/** @type {any} */ ev) => this.onZoom(ev.transform));
    svg.call(this.zoomBehavior).on('dblclick.zoom', null);
    svg.on('click', (/** @type {MouseEvent} */ ev) => {
      if (ev.target === svg.node()) this.ctx?.emit('select', { nodeId: null });
    });
    this.resizeObs = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.schedule());
    this.resizeObs?.observe(el);
  }

  /** Center the layout's world (the root's position) on the SVG, once, when the root first has a position. */
  centerWorld() {
    if (this.centered) return;
    const ont = this.ctx.snapshot();
    const c = this.ctx.layout.positions().get(ont.root);
    if (!c) return;
    this.centered = true;
    const box = this.svg.node().getBoundingClientRect();
    this.svg.call(this.zoomBehavior.transform, zoomIdentity.translate(box.width / 2 - c.x, box.height / 2 - c.y));
  }

  /** @param {{k:number,x:number,y:number}} t */
  onZoom(t) {
    this.k = t.k;
    this.layers.root.attr('transform', `translate(${t.x},${t.y}) scale(${t.k})`);
    this.refreshLabels();
  }

  /** @param {import('../../../src/core/events.js').OntoEvent} event */
  apply(event) {
    switch (event.t) {
      case 'node.added': this.onNodeAdded(event.node.id); break;
      case 'node.updated': this.restyle(event.id); break;
      case 'edge.added': this.ensureEdge(event.edge); break;
      default: break;
    }
    this.schedule();
  }

  /** @param {string} id */
  onNodeAdded(id) {
    this.ensureNode(id, true);
    this.centerWorld();
    this.refreshRadii(id);
    this.refreshRings();
    this.refreshLabels();
  }

  /**
   * Create the node's elements (once) and its parent link, plus links of children that arrived early.
   * @param {string} id
   * @param {boolean} animate spring out of the parent's current position
   */
  ensureNode(id, animate) {
    const ont = this.ctx.snapshot();
    const node = ont.nodes[id];
    if (!node || this.nodes.has(id)) return;
    const g = this.layers.nodes.append('g').attr('data-id', id).style('cursor', 'pointer');
    const ring = g.append('circle').attr('fill', 'none');
    const circle = g.append('circle');
    const label = this.layers.labels.append('text').attr('font-size', 11).attr('font-family', 'system-ui, sans-serif')
      .attr('fill', THEME.dark.fg).attr('stroke', THEME.dark.bg).attr('stroke-width', 3).attr('stroke-linejoin', 'round')
      .attr('paint-order', 'stroke').attr('dy', '0.35em').text(node.label);
    const nv = { g, circle, ring, label, r: 0, spawn: null };
    this.nodes.set(id, nv);
    this.bindNode(id, g);
    this.restyle(id);
    nv.r = nodeRadius(descendants(id, ont));
    if (animate) nv.spawn = { t0: performance.now(), from: this.spawnOrigin(node.parent, id) };
    this.ensureLink(id);
    for (const c of Object.values(ont.nodes)) if (c.parent === id) this.ensureLink(c.id);
  }

  /**
   * @param {string|null|undefined} parentId
   * @param {string} id
   * @returns {{x:number,y:number}}
   */
  spawnOrigin(parentId, id) {
    const pos = this.ctx.layout.positions();
    return (parentId && this.currentPos(parentId, pos)) || pos.get(id) || FALLBACK_CENTER;
  }

  /**
   * @param {string} id
   * @param {Map<string,{x:number,y:number}>} pos
   * @returns {{x:number,y:number}|null}
   */
  currentPos(id, pos) {
    if (this.dragging?.id === id) return this.dragging;
    const target = pos.get(id);
    const nv = this.nodes.get(id);
    if (!target || !nv) return target ?? null;
    if (!nv.spawn) return target;
    const t = Math.min(1, (performance.now() - nv.spawn.t0) / MOTION.spawnMs);
    const e = easeBackOut(t);
    return { x: nv.spawn.from.x + (target.x - nv.spawn.from.x) * e, y: nv.spawn.from.y + (target.y - nv.spawn.from.y) * e };
  }

  /** @param {string} id */
  ensureLink(id) {
    const node = this.ctx.snapshot().nodes[id];
    if (!node || !node.parent || this.links.has(id) || !this.nodes.has(node.parent) || !this.nodes.has(id)) return;
    const path = this.layers.links.append('path').attr('stroke', THEME.dark.muted).attr('stroke-opacity', 0.55).attr('stroke-width', 1.2);
    this.links.set(id, path);
  }

  /** @param {any} edge */
  ensureEdge(edge) {
    if (this.edges.has(edge.id)) return;
    const s = edgeStyle(edge.type);
    const path = this.layers.links.append('path').attr('stroke', s.color).attr('stroke-width', s.width);
    setDash(path, s.dash);
    this.edges.set(edge.id, { path, curve: s.curve, from: edge.from, to: edge.to });
  }

  /** Restyle a node from its current data (fill, outline). @param {string} id */
  restyle(id) {
    const nv = this.nodes.get(id);
    const ont = this.ctx.snapshot();
    const node = ont.nodes[id];
    if (!nv || !node) return;
    const o = originOutline(node.origin, (node.sources?.length ?? 0) > 0);
    nv.circle.attr('fill', fillFor(ont, node)).attr('stroke', o.stroke).attr('stroke-width', o.width ?? 1.5);
    setDash(nv.circle, o.dash);
    nv.ring.attr('stroke', o.stroke).attr('stroke-width', 1).style('display', o.double ? null : 'none');
    nv.label.text(node.label);
  }

  /** Recompute radii of the node and its ancestors. @param {string} id */
  refreshRadii(id) {
    const ont = this.ctx.snapshot();
    const seen = new Set();
    for (let cur = ont.nodes[id]; cur && !seen.has(cur.id); cur = ont.nodes[cur.parent]) {
      seen.add(cur.id);
      const nv = this.nodes.get(cur.id);
      if (nv) nv.r = nodeRadius(descendants(cur.id, ont));
    }
  }

  refreshRings() {
    const ont = this.ctx.snapshot();
    this.rings = ringsFrom(ont.view.focus, ont);
  }

  /** Re-evaluate label visibility (zoom, hover, focus changes). */
  refreshLabels() {
    const ont = this.ctx.snapshot();
    for (const [id, nv] of this.nodes) {
      const node = ont.nodes[id];
      const on = labelVisible(node, { k: this.k, focus: ont.view.focus, hovered: this.hovered, rings: this.rings, rule: LABEL_RULE });
      nv.label.style('display', on ? null : 'none');
    }
  }

  /**
   * @param {string} id
   * @param {any} g
   */
  bindNode(id, g) {
    g.on('click', (/** @type {MouseEvent} */ ev) => {
      ev.stopPropagation();
      this.ctx?.emit('select', { nodeId: id, x: ev.clientX, y: ev.clientY });
    });
    g.on('dblclick', (/** @type {MouseEvent} */ ev) => {
      ev.stopPropagation();
      this.ctx?.emit('focus', { nodeId: id });
    });
    g.on('mouseenter', () => this.setHover(id));
    g.on('mouseleave', () => this.setHover(null));
    g.call(drag().on('start', (/** @type {any} */ ev) => this.dragStart(id, ev))
      .on('drag', (/** @type {any} */ ev) => this.dragMove(id, ev))
      .on('end', () => this.dragEnd(id)));
  }

  /** @param {string|null} id */
  setHover(id) {
    this.hovered = id;
    this.refreshLabels();
    this.ctx?.emit('hover', { nodeId: id });
  }

  /**
   * @param {string} id
   * @param {any} ev
   */
  dragStart(id, ev) {
    this.dragging = { id, x: ev.x, y: ev.y };
    this.pin(id, ev.x, ev.y);
  }

  /**
   * @param {string} id
   * @param {any} ev
   */
  dragMove(id, ev) {
    this.dragging = { id, x: ev.x, y: ev.y };
    this.pin(id, ev.x, ev.y);
    this.schedule();
  }

  /**
   * Pin the layout node under the cursor when the layout supports it (drawing is overridden regardless).
   * @param {string} id
   * @param {number} x
   * @param {number} y
   */
  pin(id, x, y) {
    const layout = /** @type {any} */ (this.ctx.layout);
    if (typeof layout.pin === 'function') layout.pin(id, x, y);
  }

  /** @param {string} id */
  dragEnd(id) {
    this.dragging = null;
    /** @type {any} */ (this.ctx.layout).unpin?.(id);
    this.schedule();
  }

  schedule() {
    if (this.frame || !this.ctx) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** Write every transform and path once; keep ticking while a spawn is animating. */
  render() {
    if (!this.ctx) return;
    const pos = this.ctx.layout.positions();
    const now = performance.now();
    let animating = false;
    /** @type {Map<string,{x:number,y:number}>} */
    const cur = new Map();
    for (const [id, nv] of this.nodes) {
      const p = this.currentPos(id, pos);
      if (!p) continue;
      cur.set(id, p);
      if (nv.spawn && now - nv.spawn.t0 >= MOTION.spawnMs) nv.spawn = null;
      else if (nv.spawn) animating = true;
      nv.g.attr('transform', `translate(${p.x},${p.y})`);
      nv.circle.attr('r', nv.r);
      nv.ring.attr('r', nv.r + 3);
      nv.label.attr('x', p.x + nv.r + 4).attr('y', p.y);
    }
    this.renderLinks(cur);
    if (animating) this.schedule();
  }

  /** @param {Map<string,{x:number,y:number}>} cur */
  renderLinks(cur) {
    const nodes = this.ctx.snapshot().nodes;
    for (const [id, path] of this.links) {
      const a = cur.get(nodes[id]?.parent), b = cur.get(id);
      if (a && b) path.attr('d', linkPath(a, b, 0));
    }
    for (const e of this.edges.values()) {
      const a = cur.get(e.from), b = cur.get(e.to);
      if (a && b) e.path.attr('d', linkPath(a, b, e.curve));
    }
  }

  /** @param {string} _nodeId */
  setFocus(_nodeId) {}
  /** @param {string|null} _lensId */
  setLens(_lensId) {}
  /** @param {{ categories: string[]|null, maxDepth: number|null }} _filter */
  setFilter(_filter) {}
  /** @param {string[]} _nodeIds */
  highlight(_nodeIds) {}
  /** @param {HTMLElement} _el */
  mountMinimap(_el) {}

  unmount() {
    if (this.tickFn) this.ctx?.layout.off('tick', this.tickFn);
    this.tickFn = null;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.svg?.remove();
    this.svg = null;
    this.nodes.clear();
    this.links.clear();
    this.edges.clear();
    this.ctx = null;
  }
}

if (globalThis.customElements) {
  customElements.define('onto-graph', OntoGraph);
  registerView('graph-2d', '2D graph', 'onto-graph');
}
