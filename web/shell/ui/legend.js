// @ts-check
import { legendGroups, isFused, fusedSwatches, lineRows } from '../legend.js';

const NS = 'http://www.w3.org/2000/svg';

/** @param {string} tag @param {Record<string,string|number>} attrs */
function svg(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/**
 * A 22x12 swatch of one line kind, drawn from its edge style (null = the grey tree line).
 * Curved kinds bow upward in proportion to their style's curve.
 * @param {import('../../shared/tokens.js').EdgeStyle|null} st
 */
export function lineSwatch(st) {
  const s = svg('svg', { width: 22, height: 12, viewBox: '0 0 22 12', 'aria-hidden': 'true', class: 'legend-swatch' });
  const curve = st ? st.curve : 0;
  const y = curve > 0 ? 9.5 : 6;
  const lift = Math.min(7, curve * 22);
  const d = curve > 0 ? `M1 ${y} Q11 ${y - 2 * lift} 21 ${y}` : `M1 ${y} L21 ${y}`;
  /** @type {Record<string,string|number>} */
  const attrs = { d, fill: 'none', 'stroke-linecap': 'butt' };
  if (st) {
    attrs.stroke = st.color;
    attrs['stroke-width'] = st.width;
    if (st.dash) attrs['stroke-dasharray'] = st.dash.join(' ');
  } else {
    attrs.stroke = 'var(--muted)';
    attrs['stroke-opacity'] = 0.75;
    attrs['stroke-width'] = 1.2;
  }
  s.append(svg('path', attrs));
  return s;
}

/** @param {HTMLElement} el @param {any} shell */
export function mountLegend(el, shell) {
  el.classList.add('legend');
  let open = true;
  let sig = '';
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'legend-head';
  const body = document.createElement('div');
  body.className = 'legend-body';
  el.append(head, body);
  head.addEventListener('click', () => { open = !open; sync(); });

  function sync() {
    head.textContent = (open ? '▾ ' : '▸ ') + 'Legend';
    head.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
  }

  function render() {
    const o = shell.snapshot();
    const groups = legendGroups(o, shell.tokens);
    const fused = isFused(o);
    const lines = lineRows(o, shell.tokens);
    const next = JSON.stringify([groups, fused, lines.map((l) => l.type)]);
    if (next === sig) return;
    sig = next;
    body.replaceChildren();
    el.hidden = groups.length === 0;
    for (const g of groups) {
      if (g.title) {
        const t = document.createElement('div');
        t.className = 'legend-title';
        t.textContent = g.title;
        body.append(t);
      }
      for (const it of g.items) {
        const row = document.createElement('div');
        row.className = 'legend-row';
        const dot = document.createElement('span');
        dot.className = 'legend-dot';
        dot.style.background = it.color;
        const lab = document.createElement('span');
        lab.textContent = it.label;
        row.append(dot, lab);
        body.append(row);
      }
    }
    if (fused) {
      // The bridge line is keyed under "Lines" with the other kinds; Fusion keys the hybrid node.
      const h = fusedSwatches(shell.tokens).hybrid;
      const t = document.createElement('div');
      t.className = 'legend-title';
      t.textContent = 'Fusion';
      body.append(t);
      const r2 = document.createElement('div');
      r2.className = 'legend-row';
      const s2 = svg('svg', { width: 22, height: 22, viewBox: '0 0 22 22' });
      const ring = (/** @type {number} */ r) => svg('circle', {
        cx: 11, cy: 11, r, fill: 'none', stroke: h.stroke, 'stroke-width': h.width || 1.5,
        'stroke-dasharray': (h.dash || []).join(' '),
      });
      s2.append(ring(9));
      if (h.double) s2.append(ring(6));
      const l2 = document.createElement('span');
      l2.textContent = 'Hybrid';
      r2.append(s2, l2);
      body.append(r2);
    }
    // Lines: sized to the legend's width, never widening it (long meanings wrap).
    const sec = document.createElement('div');
    sec.className = 'legend-lines';
    const lt = document.createElement('div');
    lt.className = 'legend-title';
    lt.textContent = 'Lines';
    sec.append(lt);
    for (const l of lines) {
      const row = document.createElement('div');
      row.className = 'legend-row legend-line';
      row.dataset.kind = l.type;
      const txt = document.createElement('span');
      const b = document.createElement('span');
      b.className = 'legend-kind';
      b.textContent = l.label;
      const m = document.createElement('span');
      m.className = 'legend-meaning';
      m.textContent = ': ' + l.meaning;
      txt.append(b, m);
      row.append(lineSwatch(l.style), txt);
      sec.append(row);
    }
    body.append(sec);
    sync();
  }

  sync();
  shell.on('event', render);
  render();
}
