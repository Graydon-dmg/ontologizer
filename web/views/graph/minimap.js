// @ts-check
// The minimap: a small SVG of the whole graph (dots only) with the main view's viewport rectangle.
// Click or drag pans the main view. No DOM access at module top level.
import { select } from 'd3-selection';
import { themeVars } from './theme.js';
import { worldBounds, miniScale, viewportRect, panFromMinimap } from './math.js';

const DEFAULT_W = 200;
const DEFAULT_H = 150;
const DOT_R = 2;
const DOT_INTERVAL_MS = 100;

/**
 * A rate gate: the returned function says whether the caller may fire now.
 * Returns true at most once per `ms` of the injected clock.
 * @param {number} ms
 * @param {() => number} [now]
 * @returns {() => boolean}
 */
export function makeThrottle(ms, now = () => Date.now()) {
  let last = -Infinity;
  return () => {
    const t = now();
    if (t - last < ms) return false;
    last = t;
    return true;
  };
}

/**
 * @param {number} v @param {number} lo @param {number} hi
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @param {HTMLElement} el
 * @param {{
 *   positions: () => Map<string,{x:number,y:number}>,
 *   nodes: () => Array<{ id: string, color: string, visible: boolean }>,
 *   transform: () => { x: number, y: number, k: number },
 *   viewSize: () => { width: number, height: number },
 *   panTo: (t: { x: number, y: number, k: number }) => void,
 * }} host
 * @returns {{ update(): void, unmount(): void }}
 */
export function createMinimap(el, host) {
  const size = () => ({ width: el.clientWidth || DEFAULT_W, height: el.clientHeight || DEFAULT_H });
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';

  const svg = select(el).append('svg')
    .attr('width', '100%').attr('height', '100%')
    .style('position', 'absolute').style('inset', '0').style('display', 'block')
    .style('touch-action', 'none').style('cursor', 'crosshair')
    .style('border-radius', '6px').style('box-sizing', 'border-box');
  const bg = svg.append('rect').attr('rx', 6).style('fill', 'var(--o-panel)').attr('fill-opacity', 0.85)
    .style('stroke', 'var(--o-muted)').attr('stroke-width', 1);
  const dots = svg.append('g').style('pointer-events', 'none');
  const rect = svg.append('rect').style('fill', 'var(--o-fg)').attr('fill-opacity', 0.06)
    .style('stroke', 'var(--o-fg)').attr('stroke-width', 1).style('pointer-events', 'none');

  /** World bounds from the last dot redraw; shared by the rect and by pan so they agree. */
  let bounds = worldBounds(new Map());
  let drawn = false;
  const gate = makeThrottle(DOT_INTERVAL_MS);
  /** @type {ReturnType<typeof setTimeout>|null} */
  let trailing = null;

  function drawDots() {
    const { width, height } = size();
    bg.attr('x', 0.5).attr('y', 0.5).attr('width', Math.max(0, width - 1)).attr('height', Math.max(0, height - 1));
    const pos = host.positions();
    const vis = host.nodes().filter((n) => n.visible && pos.has(n.id));
    bounds = worldBounds(vis.map((n) => /** @type {{x:number,y:number}} */ (pos.get(n.id))));
    const { s, ox, oy } = miniScale(bounds, { width, height });
    const sel = dots.selectAll('circle').data(vis, (/** @type {any} */ d) => d.id);
    sel.exit().remove();
    const all = sel.enter().append('circle').attr('r', DOT_R).merge(/** @type {any} */ (sel));
    all.style('fill', (/** @type {any} */ d) => d.color)
      .attr('cx', (/** @type {any} */ d) => ((/** @type {any} */ (pos.get(d.id))).x - bounds.minX) * s + ox)
      .attr('cy', (/** @type {any} */ d) => ((/** @type {any} */ (pos.get(d.id))).y - bounds.minY) * s + oy);
    drawn = true;
  }

  function drawRect() {
    const { width, height } = size();
    const r = viewportRect(host.transform(), host.viewSize(), bounds, { width, height });
    const x0 = clamp(r.x, 0, width), y0 = clamp(r.y, 0, height);
    const x1 = clamp(r.x + r.width, 0, width), y1 = clamp(r.y + r.height, 0, height);
    rect.attr('x', x0).attr('y', y0).attr('width', Math.max(0, x1 - x0)).attr('height', Math.max(0, y1 - y0));
  }

  function update() {
    themeVars(svg);
    if (!drawn || gate()) {
      if (trailing) { clearTimeout(trailing); trailing = null; }
      drawDots();
    } else if (!trailing) {
      // A throttled redraw is deferred, so the last layout tick is never left undrawn.
      trailing = setTimeout(() => { trailing = null; if (gate()) { drawDots(); drawRect(); } }, DOT_INTERVAL_MS);
    }
    drawRect();
  }

  /** @param {PointerEvent} ev */
  function panAt(ev) {
    const box = /** @type {SVGSVGElement} */ (svg.node()).getBoundingClientRect();
    const point = { x: ev.clientX - box.left, y: ev.clientY - box.top };
    host.panTo(panFromMinimap(point, bounds, size(), host.viewSize(), host.transform().k));
  }

  let dragging = false;
  /** @param {PointerEvent} ev */
  const onDown = (ev) => {
    dragging = true;
    try { /** @type {Element} */ (svg.node()).setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
    ev.preventDefault();
    ev.stopPropagation();
    panAt(ev);
  };
  /** @param {PointerEvent} ev */
  const onMove = (ev) => { if (dragging) panAt(ev); };
  /** @param {PointerEvent} ev */
  const onUp = (ev) => {
    if (!dragging) return;
    dragging = false;
    try { /** @type {Element} */ (svg.node()).releasePointerCapture(ev.pointerId); } catch { /* already released */ }
  };
  /** @param {Event} ev */
  const stop = (ev) => ev.stopPropagation();
  const node = /** @type {SVGSVGElement} */ (svg.node());
  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', onUp);
  node.addEventListener('pointercancel', onUp);
  node.addEventListener('wheel', stop);
  node.addEventListener('click', stop);

  update();

  return {
    update,
    unmount() {
      if (trailing) clearTimeout(trailing);
      trailing = null;
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
      node.removeEventListener('wheel', stop);
      node.removeEventListener('click', stop);
      svg.remove();
    },
  };
}
