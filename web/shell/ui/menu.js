// @ts-check
import { menuItems, runMenuItem, createMenuGuard, MENU_OFFSET_PX } from '../menu.js';

/** @param {HTMLElement} el @param {any} shell */
export function mountMenu(el, shell) {
  el.classList.add('onto-menu');
  el.hidden = true;
  const guard = createMenuGuard();
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
      b.addEventListener('click', (e) => {
        // Ignore the tail of the gesture that opened the menu (see createMenuGuard).
        if (!guard.allow(performance.now(), e.detail === 0)) return;
        close();
        runMenuItem(item, node.id, shell);
      });
      el.appendChild(b);
    }
    el.hidden = false;
    guard.opened(performance.now());
    const r = el.getBoundingClientRect();
    // Open beside the pointer, never under it; flip left/up when there is no room.
    const x = d.x || 0, y = d.y || 0, o = MENU_OFFSET_PX;
    const left = x + o + r.width <= window.innerWidth - 4 ? x + o : x - o - r.width;
    const top = y + o + r.height <= window.innerHeight - 4 ? y + o : y - o - r.height;
    el.style.left = Math.max(4, left) + 'px';
    el.style.top = Math.max(4, top) + 'px';
  });
  // Presses inside the menu belong to the menu: no view or window handler may react to them.
  el.addEventListener('pointerdown', () => guard.pointerDownInside(performance.now()));
  for (const t of ['mousedown', 'pointerdown', 'touchstart']) el.addEventListener(t, (e) => e.stopPropagation());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.addEventListener('mousedown', (e) => { if (!el.hidden && !el.contains(/** @type {Node} */ (e.target))) close(); }, true);
}
