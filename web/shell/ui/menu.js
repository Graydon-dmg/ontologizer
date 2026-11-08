// @ts-check
import { menuItems } from '../menu.js';

/** @param {HTMLElement} el @param {any} shell */
export function mountMenu(el, shell) {
  el.classList.add('onto-menu');
  el.hidden = true;
  const close = () => { el.hidden = true; el.textContent = ''; };
  shell.on('select', (/** @type {any} */ d) => {
    if (!d || !d.nodeId) return close();
    const snap = shell.snapshot();
    const node = snap.nodes[d.nodeId];
    if (!node) return close();
    el.textContent = '';
    for (const item of menuItems(node, snap)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = item.label;
      b.addEventListener('click', () => {
        close();
        if (item.action) {
          shell.act(item.action);
          if (item.action.type === 'explain') shell.openExplain(node.id);
        } else if (item.open === 'explain') shell.openExplain(node.id);
      });
      el.appendChild(b);
    }
    el.hidden = false;
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(0, Math.min(d.x || 0, window.innerWidth - r.width - 4)) + 'px';
    el.style.top = Math.max(0, Math.min(d.y || 0, window.innerHeight - r.height - 4)) + 'px';
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.addEventListener('mousedown', (e) => { if (!el.hidden && !el.contains(/** @type {Node} */ (e.target))) close(); }, true);
}
