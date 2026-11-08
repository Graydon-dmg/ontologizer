// @ts-check
// <onto-graph>: the 2D graph view. Draws, hit-tests and emits; the shell owns all chrome and
// feeds the layout. See web/shared/view.js for the view standard.
import { select } from 'd3-selection';
import { zoom, zoomIdentity, zoomTransform } from 'd3-zoom';
import { drag } from 'd3-drag';
import 'd3-transition';
import { easeBackOut } from 'd3-ease';
import { hsl } from 'd3-color';
import { registerView } from '../../shared/view.js';
import { MOTION, LABEL_RULE, categoryColor, depthLightness, nodeRadius, edgeStyle, originOutline } from '../../shared/tokens.js';
import { descendants, ringsFrom, labelVisible, neighborhood, hiddenIds, placeLabels, fitTransform, syncViewState } from './math.js';
import { createMinimap } from './minimap.js';
import { themeVars, onThemeChange } from './theme.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FALLBACK_CENTER = { x: 500, y: 400 };
const SCALE_EXTENT = /** @type {[number, number]} */ ([0.2, 4]);

const DIM_TRANSITION = 'opacity 150ms';
const RING_STEP = 90;
/** Auto-fit (follow the build until the user zooms or pans): largest zoom, refit interval, margin. */
const FIT_MAX_K = 2.2;
const FIT_EVERY_MS = 500;
const FIT_MARGIN = 0.88;
/** Pointer travel (px) still treated as a click rather than a drag or pan: real clicks jitter. */
const CLICK_DISTANCE = 4;
/** Label box estimate in screen px (11.5px system-ui): width per character, height. */
const LABEL_CHAR_W = 6.2;
const LABEL_H = 14;

/** @typedef {{ g: any, circle: any, ring: any, label: any, core: any, glyph: any, r: number, fill: string, hasArticle?: boolean,
 *   spawn: { t0: number, from: {x:number,y:number} }|null }} NodeView */
/** @typedef {{ el: any, circle: any, anim: any, fade: any, r: number, state: string }} Halo */

/**
 * Fill color: category color lightened by depth; root / unknown category -> neutral.
 * @param {import('../../src/core/schema.js').Ontology} ont
 * @param {any} node
 * @returns {string}
 */
function fillFor(ont, node) {
  const cat = ont.categories.find((c) => c.id === node.category);
  if (!cat) return 'var(--o-muted)';
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
  /** @type {Set<string>} */ collapsed = new Set();
  /** @type {{ categories: string[]|null, maxDepth: number|null }} */ filter = { categories: null, maxDepth: null };
  /** @type {Set<string>} */ hidden = new Set();
  /** @type {Set<string>|null} neighborhood union set by highlight() */ hl = null;
  /** @type {string|null} */ lensId = null;
  /** @type {Map<string, any>} ghost lens labels by node id */ ghosts = new Map();
  /** @type {Map<string, any>} "+N" badges by node id */ badges = new Map();
  /** @type {Map<string, { nodeId: string, state: string }>} */ jobs = new Map();
  /** @type {Map<string, Halo>} */ halos = new Map();
  maxRing = 0;
  /** @type {any[]} */ ringEls = [];
  /** @type {Map<string, boolean>} */ labelWanted = new Map();
  userMoved = false;
  lastFit = 0;
  /** @type {any} */ fitTimer = 0;
  /** last snapshot view values seen (see syncFromSnapshot) */ seen = { filter: '', collapsed: '' };
  box = { width: 0, height: 0 };
  /** @type {(() => void)|null} */ themeOff = null;
  /** @type {{ update(): void, unmount(): void }|null} */ minimap = null;
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
    this.syncFromSnapshot(false);
    for (const j of Object.values(ont.jobs || {})) if (j.nodeId && (j.state === 'queued' || j.state === 'running')) this.jobs.set(j.id, { nodeId: j.nodeId, state: j.state });
    this.updateVisibility();
    this.setLens(ont.view?.lens ?? null);
    this.refreshRings();
    this.refreshLabels();
    this.centerWorld();
    this.schedule();
  }

  /** @param {HTMLElement} el */
  buildSvg(el) {
    const svg = select(el).append('svg').attr('width', '100%').attr('height', '100%').style('position', 'absolute').style('inset', '0').style('display', 'block').style('touch-action', 'none');
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    svg.append('style').text('path, circle { vector-effect: non-scaling-stroke; }');
    const root = svg.append('g');
    this.layers = {
      root,
      rings: root.append('g').attr('class', 'rings').attr('fill', 'none').style('pointer-events', 'none'),
      links: root.append('g').attr('class', 'links').attr('fill', 'none'),
      nodes: root.append('g').attr('class', 'nodes'),
      halos: root.append('g').attr('class', 'halos'),
      labels: root.append('g').attr('class', 'labels').style('pointer-events', 'none'),
    };
    this.svg = svg;
    this.zoomBehavior = zoom().scaleExtent(SCALE_EXTENT).clickDistance(CLICK_DISTANCE).on('zoom', (/** @type {any} */ ev) => {
      if (ev.sourceEvent) this.userMoved = true;
      this.onZoom(ev.transform);
    });
    svg.call(this.zoomBehavior).on('dblclick.zoom', null);
    svg.on('click', (/** @type {MouseEvent} */ ev) => {
      if (ev.target === svg.node()) this.ctx?.emit('select', { nodeId: null });
    });
    this.box = { width: el.clientWidth, height: el.clientHeight };
    this.resizeObs = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.onResize(el));
    this.resizeObs?.observe(el);
    themeVars(svg);
    this.themeOff = onThemeChange(() => this.onTheme());
  }

  /**
   * Size comes from the mount element. A first real size (after a 0x0 mount) or any resize refits
   * while following the build; after the user has moved, the view keeps its center instead.
   * @param {HTMLElement} el
   */
  onResize(el) {
    const prev = this.box;
    this.box = { width: el.clientWidth, height: el.clientHeight };
    if (!this.ctx || (prev.width === this.box.width && prev.height === this.box.height)) return;
    if (this.userMoved && prev.width && prev.height) {
      const t = zoomTransform(this.svg.node());
      this.svg.call(this.zoomBehavior.transform, zoomIdentity
        .translate(t.x + (this.box.width - prev.width) / 2, t.y + (this.box.height - prev.height) / 2).scale(t.k));
    } else {
      this.lastFit = 0;
      if (!prev.width || !prev.height) this.centered = false;
      this.centerWorld();
    }
    this.minimap?.update();
    this.schedule();
  }

  /** Theme switched (System / Light / Dark): repaint colors that come from THEME. */
  onTheme() {
    if (!this.ctx) return;
    themeVars(this.svg);
    for (const id of this.nodes.keys()) this.restyle(id);
    this.minimap?.update();
  }

  /** Center the layout's world (the root's position) on the SVG, once, when the root first has a position. */
  centerWorld() {
    if (this.centered) return;
    const ont = this.ctx.snapshot();
    const c = this.ctx.layout.positions().get(ont.root);
    const box = this.box;
    if (!c || !box.width || !box.height) return;
    this.centered = true;
    this.svg.call(this.zoomBehavior.transform, zoomIdentity.translate(box.width / 2 - c.x, box.height / 2 - c.y));
  }

  /** @param {{k:number,x:number,y:number}} t */
  onZoom(t) {
    if (!this.ctx) return; // a transition can outlive unmount
    this.k = t.k;
    this.layers.root.attr('transform', `translate(${t.x},${t.y}) scale(${t.k})`);
    this.refreshLabels();
    this.minimap?.update();
    this.schedule();
  }

  /**
   * Follow the build: while the user has not zoomed or panned, ease the view to fit every visible
   * node (zoom capped at FIT_MAX_K so deeper labels stay hidden until the user zooms in).
   * @param {Map<string,{x:number,y:number}>} cur
   */
  autoFit(cur) {
    const now = performance.now();
    if (this.userMoved || !cur.size) return;
    if (now - this.lastFit < FIT_EVERY_MS) {
      // re-check once the interval passes, so the final layout is always fitted
      this.fitTimer ||= setTimeout(() => { this.fitTimer = 0; this.schedule(); }, FIT_EVERY_MS);
      return;
    }
    this.lastFit = now;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [id, p] of cur) {
      if (this.hidden.has(id)) continue;
      const r = (this.nodes.get(id)?.r ?? 0) + 8;
      minX = Math.min(minX, p.x - r); maxX = Math.max(maxX, p.x + r + 60); // room for the label
      minY = Math.min(minY, p.y - r); maxY = Math.max(maxY, p.y + r);
    }
    const f = fitTransform({ minX, minY, maxX, maxY }, this.box, { minK: SCALE_EXTENT[0], maxK: FIT_MAX_K, margin: FIT_MARGIN });
    if (!f) return; // 0x0 mount: the ResizeObserver refits once the element has a size
    const t = zoomTransform(this.svg.node());
    if (Math.abs(t.k - f.k) / f.k < 0.03 && Math.abs(t.x - f.x) < 15 && Math.abs(t.y - f.y) < 15) return;
    this.svg.transition('fit').duration(FIT_EVERY_MS * 0.9).call(this.zoomBehavior.transform, zoomIdentity.translate(f.x, f.y).scale(f.k));
  }

  /**
   * Adopt the snapshot's filter / collapsed set only when the stored value changed since the last
   * one seen, so a filter set through setFilter() is never wiped by an unrelated event.
   * @param {boolean} [refresh]
   */
  syncFromSnapshot(refresh = true) {
    const s = syncViewState({ filter: this.filter, collapsed: [...this.collapsed] }, this.seen, this.ctx.snapshot().view);
    this.seen = s.seen;
    if (!s.changed) return;
    this.filter = s.local.filter;
    this.collapsed = new Set(s.local.collapsed);
    if (refresh) this.updateVisibility();
  }

  /** @param {import('../../../src/core/events.js').OntoEvent} event */
  apply(event) {
    if (event.t === 'view.changed') this.syncFromSnapshot();
    switch (event.t) {
      case 'node.added': this.onNodeAdded(event.node.id); break;
      case 'node.updated': this.restyle(event.id); break;
      case 'edge.added': this.ensureEdge(event.edge); break;
      case 'view.changed': this.onViewChanged(event.patch || {}); break;
      case 'job.queued': case 'job.started': case 'job.done': case 'job.failed': this.onJob(event); break;
      case 'lens.added': if (event.lens?.id === this.lensId) this.syncGhosts(); break;
      case 'lens.analog': if (event.lensId === this.lensId) this.syncGhost(event.nodeId); break;
      default: break;
    }
    this.schedule();
  }

  /** @param {string} id */
  onNodeAdded(id) {
    this.ensureNode(id, true);
    this.centerWorld();
    this.refreshRadii(id);
    if (this.collapsed.size || this.filter.categories || this.filter.maxDepth != null) this.updateVisibility();
    this.refreshRings();
    this.refreshLabels();
    if (this.lensId) this.syncGhost(id);
    if (this.hl || this.hovered) this.applyDim();
  }

  /** @param {any} patch */
  onViewChanged(patch) {
    if ('lens' in patch) this.setLens(patch.lens ?? null);
    if (patch.focus) this.setFocus(patch.focus);
  }

  /** @param {any} event */
  onJob(event) {
    const job = event.job;
    if (!job) return;
    if (event.t === 'job.queued' || event.t === 'job.started') {
      if (job.nodeId) this.jobs.set(job.id, { nodeId: job.nodeId, state: event.t === 'job.queued' ? 'queued' : 'running' });
    } else {
      this.jobs.delete(job.id);
      this.removeHalo(job.id);
    }
  }

  /** @param {string} id @returns {boolean} */
  isVisible(id) {
    return this.nodes.has(id) && !this.hidden.has(id);
  }

  /** @param {string[]} ids */
  setCollapsed(ids) {
    this.collapsed = new Set(ids);
    this.updateVisibility();
  }

  /** Recompute hidden set and the "+N" badges; only on events. */
  updateVisibility() {
    const ont = this.ctx.snapshot();
    this.hidden = hiddenIds(ont, this.collapsed, this.filter);
    for (const [id, b] of this.badges) if (!this.collapsed.has(id)) { b.g.remove(); this.badges.delete(id); }
    for (const id of this.collapsed) {
      if (!ont.nodes[id]) continue;
      const n = descendants(id, ont);
      let b = this.badges.get(id);
      if (n === 0) { if (b) { b.g.remove(); this.badges.delete(id); } continue; }
      if (!b) {
        const g = this.layers.labels.append('g');
        const rect = g.append('rect').attr('rx', 6).attr('height', 13).attr('y', -6.5).style('fill', 'var(--o-panel)').style('stroke', 'var(--o-muted)').attr('stroke-width', 0.5);
        const text = g.append('text').attr('font-size', 10).attr('font-family', 'system-ui, sans-serif').style('fill', 'var(--o-fg)').attr('text-anchor', 'middle').attr('dy', '0.35em');
        b = { g, rect, text };
        this.badges.set(id, b);
      }
      const label = `+${n}`;
      b.text.text(label);
      const w = label.length * 6 + 8;
      b.rect.attr('width', w).attr('x', -w / 2);
    }
    this.refreshRings();
    this.refreshLabels();
    this.schedule();
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
    const core = g.append('circle').style('fill', 'var(--o-fg)').attr('opacity', 0.9).style('pointer-events', 'none').style('display', 'none');
    const glyph = g.append('g').style('pointer-events', 'none').style('display', 'none');
    glyph.append('rect').attr('x', -3).attr('y', -4).attr('width', 6).attr('height', 8).attr('fill', 'none');
    glyph.append('path').attr('d', 'M-3,-4 H1 L3,-2 V4 H-3 Z M1,-4 V-2 H3').attr('fill', 'none').style('stroke', 'var(--o-bg)').attr('stroke-width', 0.8).attr('stroke-linejoin', 'round');
    g.style('transition', DIM_TRANSITION);
    const label = this.layers.labels.append('text').attr('x', 5).attr('font-size', 11.5).attr('font-family', 'system-ui, sans-serif')
      .style('fill', 'var(--o-fg)').style('stroke', 'var(--o-bg)').attr('stroke-width', 3).attr('stroke-linejoin', 'round')
      .attr('paint-order', 'stroke').attr('dy', '0.35em').text(node.label);
    label.style('transition', DIM_TRANSITION);
    const nv = { g, circle, ring, label, core, glyph, r: 0, fill: '', spawn: null };
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
    const path = this.layers.links.append('path').style('stroke', 'var(--o-muted)').attr('stroke-opacity', 0.55).attr('stroke-width', 1.2).style('transition', DIM_TRANSITION);
    this.links.set(id, path);
  }

  /** @param {any} edge */
  ensureEdge(edge) {
    if (this.edges.has(edge.id)) return;
    const s = edgeStyle(edge.type);
    const path = this.layers.links.append('path').attr('stroke', s.color).attr('stroke-width', s.width).style('transition', DIM_TRANSITION);
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
    nv.fill = fillFor(ont, node);
    nv.circle.style('fill', nv.fill).attr('fill-opacity', node.status === 'pending' ? 0.45 : 1).attr('stroke', o.stroke).attr('stroke-width', o.width ?? 1.5);
    nv.hasArticle = !!node.article;
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
    let max = 0;
    for (const [id, d] of this.rings) if (d > max && !this.hidden.has(id)) max = d;
    this.maxRing = max;
    const els = this.ringEls;
    while (els.length < max) els.push(this.layers.rings.append('circle').style('stroke', 'var(--o-muted)').attr('stroke-opacity', 0.12).attr('r', RING_STEP * (els.length + 1)));
    while (els.length > max) els.pop().remove();
  }

  /** Re-evaluate label visibility (zoom, hover, focus changes). */
  refreshLabels() {
    if (!this.ctx) return;
    const ont = this.ctx.snapshot();
    /** @type {Map<string, boolean>} candidate id -> forced (always drawn) */
    const wanted = new Map();
    for (const [id] of this.nodes) {
      const node = ont.nodes[id];
      if (this.hidden.has(id) || !labelVisible(node, { k: this.k, focus: ont.view.focus, hovered: this.hovered, rings: this.rings, rule: LABEL_RULE })) continue;
      const ring = this.rings.get(id) ?? Infinity;
      wanted.set(id, id === ont.view.focus || id === this.hovered || ring < 2);
    }
    this.labelWanted = wanted;
    this.schedule();
  }

  /**
   * Draw the wanted labels that fit: depth-2+ labels whose screen box collides with one already
   * drawn are skipped (they come back on hover, focus, or once zoom gives them room).
   * @param {Map<string,{x:number,y:number}>} cur
   */
  placeLabelsNow(cur) {
    const t = zoomTransform(this.svg.node());
    const ont = this.ctx.snapshot();
    const items = [];
    for (const [id, forced] of this.labelWanted) {
      const nv = this.nodes.get(id), p = cur.get(id);
      if (!nv || !p) continue;
      const w = 5 + LABEL_CHAR_W * (ont.nodes[id]?.label.length ?? 0);
      const sx = (p.x + nv.r) * t.k + t.x, sy = p.y * t.k + t.y;
      items.push({ id, forced, depth: ont.nodes[id]?.depth ?? 0, r: nv.r, box: { x: sx, y: sy - LABEL_H / 2, w, h: LABEL_H } });
    }
    const shown = placeLabels(items);
    for (const [id, nv] of this.nodes) nv.label.style('display', shown.has(id) ? null : 'none');
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
    g.call(drag().clickDistance(CLICK_DISTANCE).on('start', (/** @type {any} */ ev) => this.dragStart(id, ev))
      .on('drag', (/** @type {any} */ ev) => this.dragMove(id, ev))
      .on('end', () => this.dragEnd(id)));
  }

  /** @param {string|null} id */
  setHover(id) {
    this.hovered = id;
    this.refreshLabels();
    this.applyDim();
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
    const inv = 1 / this.k; // labels and badges keep a constant on-screen size
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
      nv.label.attr('transform', `translate(${p.x + nv.r},${p.y}) scale(${inv})`);
      const hid = this.hidden.has(id);
      nv.g.style('display', hid ? 'none' : null);
      const showCore = nv.hasArticle && !hid;
      nv.core.attr('r', nv.r * 0.45).style('display', showCore ? null : 'none');
      nv.glyph.style('display', showCore && nv.r >= 8 ? null : 'none');
      const gh = this.ghosts.get(id);
      if (gh) gh.attr('transform', `translate(${p.x},${p.y + nv.r}) scale(${inv})`).style('display', hid ? 'none' : null);
      const b = this.badges.get(id);
      if (b) b.g.attr('transform', `translate(${p.x + nv.r * 0.75},${p.y - nv.r * 0.75}) scale(${inv})`).style('display', hid ? 'none' : null);
    }
    this.placeLabelsNow(cur);
    this.renderHalos(cur);
    this.autoFit(cur);
    const fp = cur.get(this.ctx.snapshot().view.focus);
    if (fp) for (const el of this.ringEls) el.attr('cx', fp.x).attr('cy', fp.y);
    this.renderLinks(cur);
    this.minimap?.update();
    if (animating) this.schedule();
  }

  /** @param {Map<string,{x:number,y:number}>} cur */
  renderLinks(cur) {
    const nodes = this.ctx.snapshot().nodes;
    for (const [id, path] of this.links) {
      const a = cur.get(nodes[id]?.parent), b = cur.get(id);
      if (a && b) path.attr('d', linkPath(a, b, 0));
      path.style('display', this.hidden.has(id) || this.hidden.has(nodes[id]?.parent) ? 'none' : null);
    }
    for (const e of this.edges.values()) {
      const a = cur.get(e.from), b = cur.get(e.to);
      if (a && b) e.path.attr('d', linkPath(a, b, e.curve));
      e.path.style('display', this.hidden.has(e.from) || this.hidden.has(e.to) ? 'none' : null);
    }
  }

  /** @param {Map<string,{x:number,y:number}>} cur */
  renderHalos(cur) {
    for (const [jid, job] of this.jobs) {
      const nv = this.nodes.get(job.nodeId);
      if (!nv) continue;
      let h = this.halos.get(jid);
      if (!h) {
        const el = this.layers.halos.append('g').style('pointer-events', 'none');
        const circle = el.append('circle').attr('fill', 'none').style('stroke', 'var(--o-fg)').attr('stroke-width', 1.5);
        const anim = circle.append('animate').attr('attributeName', 'r').attr('dur', '1.2s').attr('repeatCount', 'indefinite');
        const fade = circle.append('animate').attr('attributeName', 'opacity').attr('dur', '1.2s').attr('repeatCount', 'indefinite');
        h = { el, circle, anim, fade, r: -1, state: '' };
        this.halos.set(jid, h);
      }
      if (h.r !== nv.r || h.state !== job.state) {
        h.r = nv.r;
        h.state = job.state;
        const r = nv.r + 6;
        h.circle.attr('r', r);
        h.anim.attr('values', `${r - 2};${r + 4};${r - 2}`);
        h.fade.attr('values', job.state === 'queued' ? '0.15;0.4;0.15' : '0.35;1;0.35');
      }
      const p = cur.get(job.nodeId);
      if (p) h.el.attr('transform', `translate(${p.x},${p.y})`);
      h.el.style('display', this.hidden.has(job.nodeId) ? 'none' : null);
    }
  }

  /** @param {string} jobId */
  removeHalo(jobId) {
    const h = this.halos.get(jobId);
    if (h) h.el.remove();
    this.halos.delete(jobId);
  }

  /** Apply highlight / hover dimming to nodes, labels, ghosts and links. */
  applyDim() {
    if (!this.ctx) return;
    const ont = this.ctx.snapshot();
    const s = this.hovered ? neighborhood(this.hovered, ont) : this.hl;
    const dim = MOTION.hoverDim;
    const op = (/** @type {boolean} */ on) => (s ? (on ? 1 : dim) : null);
    for (const [id, nv] of this.nodes) {
      const v = op(!!s?.has(id));
      nv.g.style('opacity', v);
      nv.label.style('opacity', v);
      this.badges.get(id)?.g.style('opacity', v);
      this.ghosts.get(id)?.style('opacity', s && !s.has(id) ? dim * 0.85 : null);
    }
    for (const [id, path] of this.links) path.style('opacity', op(!!s && s.has(id) && s.has(ont.nodes[id]?.parent)));
    for (const e of this.edges.values()) e.path.style('opacity', op(!!s && s.has(e.from) && s.has(e.to)));
  }

  /** @param {string} id */
  syncGhost(id) {
    const old = this.ghosts.get(id);
    const a = this.lensId ? this.ctx.snapshot().lenses?.[this.lensId]?.analogs?.[id] : null;
    if (!a || !this.nodes.has(id)) {
      if (old) { old.remove(); this.ghosts.delete(id); }
      return;
    }
    const t = old || this.layers.labels.append('text').attr('y', 13).attr('font-size', 10).attr('font-style', 'italic').attr('font-family', 'system-ui, sans-serif')
      .style('fill', 'var(--o-muted)').attr('opacity', 0.85).attr('text-anchor', 'middle').style('stroke', 'var(--o-bg)').attr('stroke-width', 3)
      .attr('stroke-linejoin', 'round').attr('paint-order', 'stroke').style('transition', DIM_TRANSITION);
    t.text(a.breaks ? `${a.label} \u26A0` : a.label);
    t.select('title').remove();
    if (a.breaks) t.style('pointer-events', 'auto').append('title').text(a.breaks);
    else t.style('pointer-events', 'none');
    if (!old) this.ghosts.set(id, t);
    this.schedule();
  }

  syncGhosts() {
    const ont = this.ctx.snapshot();
    const analogs = (this.lensId && ont.lenses?.[this.lensId]?.analogs) || {};
    for (const id of [...this.ghosts.keys()]) if (!analogs[id]) this.syncGhost(id);
    for (const id of Object.keys(analogs)) this.syncGhost(id);
  }

  /** @param {string} nodeId */
  setFocus(nodeId) {
    if (!this.ctx || !this.nodes.has(nodeId)) return;
    this.refreshRings();
    this.refreshLabels();
    // Focusing the root means "the whole map": go back to following the build.
    // Any other focus centers that node and stops the auto-fit.
    if (nodeId === this.ctx.snapshot().root) {
      this.userMoved = false;
      this.lastFit = 0;
    } else {
      this.userMoved = true;
      const p = this.currentPos(nodeId, this.ctx.layout.positions());
      if (p) this.svg.interrupt('fit').transition().duration(MOTION.focusMs).call(this.zoomBehavior.translateTo, p.x, p.y);
    }
    this.schedule();
  }

  /** @param {string|null} lensId */
  setLens(lensId) {
    this.lensId = lensId || null;
    for (const t of this.ghosts.values()) t.remove();
    this.ghosts.clear();
    if (this.lensId) this.syncGhosts();
  }

  /** @param {{ categories: string[]|null, maxDepth: number|null }} filter */
  setFilter(filter) {
    this.filter = { categories: filter?.categories ?? null, maxDepth: filter?.maxDepth ?? null };
    this.updateVisibility();
  }

  /** @param {string[]} nodeIds */
  highlight(nodeIds) {
    if (!this.ctx) return;
    if (!nodeIds || !nodeIds.length) this.hl = null;
    else {
      const ont = this.ctx.snapshot();
      this.hl = new Set();
      for (const id of nodeIds) for (const n of neighborhood(id, ont)) this.hl.add(n);
    }
    this.applyDim();
  }
  /**
   * Draw the minimap into the shell's top-right slot. Replaces any earlier minimap.
   * @param {HTMLElement} el
   */
  mountMinimap(el) {
    if (!this.ctx) return;
    this.minimap?.unmount();
    this.minimap = createMinimap(el, {
      positions: () => this.ctx.layout.positions(),
      nodes: () => [...this.nodes].map(([id, nv]) => ({ id, color: nv.fill, visible: !this.hidden.has(id) })),
      transform: () => zoomTransform(this.svg.node()),
      viewSize: () => this.box,
      panTo: (t) => (this.userMoved = true) && this.svg.call(this.zoomBehavior.transform, zoomIdentity.translate(t.x, t.y).scale(t.k)),
    });
  }

  unmount() {
    if (this.tickFn) this.ctx?.layout.off('tick', this.tickFn);
    this.tickFn = null;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    clearTimeout(this.fitTimer);
    this.themeOff?.();
    this.themeOff = null;
    this.svg?.interrupt().interrupt('fit').on('.zoom', null);
    this.minimap?.unmount();
    this.minimap = null;
    this.svg?.remove();
    this.svg = null;
    this.nodes.clear();
    this.links.clear();
    this.edges.clear();
    this.ghosts.clear();
    this.badges.clear();
    this.jobs.clear();
    this.halos.clear();
    this.ringEls = [];
    this.ctx = null;
  }
}

if (globalThis.customElements) {
  customElements.define('onto-graph', OntoGraph);
  registerView('graph-2d', '2D graph', 'onto-graph');
}
