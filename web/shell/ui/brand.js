// @ts-check
// Service mode only: the brand mark at the top bar's left becomes a button (same 22 px, no extra
// width) with a small menu: "All maps" (the maps home) and "New map" (the home's New map dialog).
// The one-map page never calls this, so its brand mark stays decorative.
import { keepFitted } from './fit.js';
import { menuStep } from '../brand-menu.js';

const STYLE_ID = 'brand-menu-style';
const CSS = `
.brand-btn { all: unset; display: inline-flex; flex: none; width: 22px; height: 22px; cursor: pointer; border-radius: 4px; }
.brand-btn:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.brand-pop { position: fixed; z-index: 55; min-width: 150px; padding: 4px; box-sizing: border-box; display: flex; flex-direction: column;
  background: var(--panel); color: var(--fg); border: 1px solid color-mix(in srgb, var(--muted) 40%, transparent); border-radius: 8px;
  font: 13px system-ui, sans-serif; }
.brand-pop[hidden] { display: none; }
.brand-pop a { color: inherit; text-decoration: none; padding: 6px 10px; border-radius: 4px; }
.brand-pop a:hover, .brand-pop a:focus-visible { background: var(--bg); outline: none; }
`;

/** @param {HTMLElement} mark the top bar's `.brand-mark` */
export function mountBrandMenu(mark) {
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.append(st);
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'brand-menu';
  btn.className = 'brand-mark brand-btn';
  btn.setAttribute('aria-label', 'Maps: all maps, new map');
  btn.title = 'All maps · New map';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.append(...mark.childNodes);
  mark.replaceWith(btn);

  const pop = document.createElement('div');
  pop.className = 'brand-pop';
  pop.id = 'brand-menu-list';
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', 'Maps');
  pop.hidden = true;
  btn.setAttribute('aria-controls', pop.id);
  const items = [['All maps', '/'], ['New map', '/?new=1']].map(([text, href]) => {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    a.setAttribute('role', 'menuitem');
    a.tabIndex = -1;
    return a;
  });
  pop.append(...items);
  document.body.append(pop);

  const place = keepFitted(pop, btn, { align: 'left' });
  const focusItem = (/** @type {number} */ i) => items[i]?.focus();
  const open = (/** @type {number} */ at = 0) => {
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    place();
    focusItem(at);
  };
  const close = (/** @type {boolean} */ toButton) => {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (toButton) btn.focus();
  };
  // Enter and Space are the button's own click; ArrowDown/ArrowUp also open it.
  btn.addEventListener('click', () => (pop.hidden ? open(0) : close(true)));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); open(0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); open(items.length - 1); }
  });
  pop.addEventListener('keydown', (e) => {
    const step = menuStep(items.indexOf(/** @type {any} */ (document.activeElement)), e.key, items.length);
    if (step.handled) e.preventDefault();
    if (step.close) close(step.toButton);
    else if (step.focus !== undefined) focusItem(step.focus);
  });
  document.addEventListener('pointerdown', (e) => {
    const t = /** @type {Node} */ (e.target);
    if (!pop.hidden && !pop.contains(t) && !btn.contains(t)) close(false);
  }, true);
  return { button: btn, menu: pop };
}
