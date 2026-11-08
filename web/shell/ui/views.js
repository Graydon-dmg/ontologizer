// @ts-check
import { toggleButtons, pressToggle } from '../viewtoggle.js';

/** A segmented "2D | 3D" toggle. Hidden when only one view is registered.
 * @param {HTMLElement} el @param {any} shell */
export function mountViewSwitcher(el, shell) {
  const group = document.createElement('div');
  group.className = 'view-toggle';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'View');

  const render = () => {
    const buttons = toggleButtons(shell.views || [], shell.activeViewId());
    el.hidden = buttons.length === 0;
    // Native <button>: Tab focuses it, Enter and Space press it.
    group.replaceChildren(...buttons.map((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      btn.title = b.title;
      btn.dataset.view = b.id;
      btn.setAttribute('aria-pressed', String(b.pressed));
      btn.addEventListener('click', () => pressToggle(shell, b.id));
      return btn;
    }));
  };
  el.replaceChildren(group);
  shell.on('view', () => {
    const had = /** @type {HTMLElement|null} */ (document.activeElement)?.dataset?.view;
    render();
    // Keep keyboard focus on the toggle after a switch.
    if (had) /** @type {HTMLElement|null} */ (group.querySelector(`[data-view="${CSS.escape(shell.activeViewId() || had)}"]`))?.focus();
  });
  render();
}
