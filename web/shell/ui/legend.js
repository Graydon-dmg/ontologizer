// @ts-check
import { legendGroups, isFused, fusedSwatches } from '../legend.js';

const NS = 'http://www.w3.org/2000/svg';

/** @param {string} tag @param {Record<string,string|number>} attrs */
function svg(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
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
    const next = JSON.stringify([groups, fused]);
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
      const sw = fusedSwatches(shell.tokens);
      const t = document.createElement('div');
      t.className = 'legend-title';
      t.textContent = 'Fusion';
      body.append(t);

      const r1 = document.createElement('div');
      r1.className = 'legend-row';
      const s1 = svg('svg', { width: 22, height: 10, viewBox: '0 0 22 10' });
      s1.append(svg('line', {
        x1: 0, y1: 5, x2: 22, y2: 5, stroke: sw.bridge.color,
        'stroke-width': sw.bridge.width, 'stroke-dasharray': (sw.bridge.dash || []).join(' '),
      }));
      const l1 = document.createElement('span');
      l1.textContent = 'Bridge';
      r1.append(s1, l1);

      const r2 = document.createElement('div');
      r2.className = 'legend-row';
      const s2 = svg('svg', { width: 22, height: 22, viewBox: '0 0 22 22' });
      const h = sw.hybrid;
      const ring = (/** @type {number} */ r) => svg('circle', {
        cx: 11, cy: 11, r, fill: 'none', stroke: h.stroke, 'stroke-width': h.width || 1.5,
        'stroke-dasharray': (h.dash || []).join(' '),
      });
      s2.append(ring(9));
      if (h.double) s2.append(ring(6));
      const l2 = document.createElement('span');
      l2.textContent = 'Hybrid';
      r2.append(s2, l2);
      body.append(r1, r2);
    }
    sync();
  }

  sync();
  shell.on('event', render);
  render();
}
