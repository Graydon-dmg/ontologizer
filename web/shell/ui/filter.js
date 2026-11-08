// @ts-check
import { filterValue, sendFilter, DEPTH_OPTIONS } from '../filter.js';
import { createDropdown } from './dropdown.js';

/** @param {HTMLElement} el @param {any} shell */
export function mountFilter(el, shell) {
  el.classList.add('filter');
  const box = document.createElement('details');
  box.className = 'filter-box';
  const summary = document.createElement('summary');
  summary.textContent = 'Categories';
  const cats = document.createElement('div');
  cats.className = 'filter-cats';
  box.append(summary, cats);
  const depthLabel = document.createElement('span');
  depthLabel.className = 'dd-label';
  depthLabel.textContent = 'Depth';
  const depth = createDropdown({
    ariaLabel: 'Depth', options: DEPTH_OPTIONS, value: '',
    onSelect: (v) => { depth.setValue(v); busy = true; send(); busy = false; },
  });
  depth.el.classList.add('depth-dd');
  el.append(box, depthLabel, depth.el);

  /** @type {Set<string>|null} null = all */
  let selected = null;
  let busy = false;

  const send = () => {
    const all = shell.snapshot().categories.map((/** @type {any} */ c) => c.id);
    const boxes = /** @type {HTMLInputElement[]} */ ([...cats.querySelectorAll('input')]);
    const on = boxes.filter((b) => b.checked).map((b) => b.value);
    const value = filterValue(on, all, depth.value);
    selected = value.categories ? new Set(value.categories) : null;
    summary.textContent = selected ? `Categories (${selected.size})` : 'Categories';
    sendFilter(shell, value);
  };

  const build = () => {
    const f = shell.snapshot().view?.filter;
    selected = f?.categories ? new Set(f.categories) : null;
    cats.replaceChildren(...shell.snapshot().categories.map((/** @type {any} */ c) => {
      const l = document.createElement('label');
      const b = document.createElement('input');
      b.type = 'checkbox';
      b.value = c.id;
      b.checked = !selected || selected.has(c.id);
      b.addEventListener('change', () => { busy = true; send(); busy = false; });
      l.append(b, ' ', c.label);
      return l;
    }));
    depth.setValue(f?.maxDepth ? String(f.maxDepth) : '');
    summary.textContent = selected ? `Categories (${selected.size})` : 'Categories';
  };
  build();
  shell.on('event', (/** @type {any} */ d) => {
    const t = d?.event?.t;
    if (!busy && (t === 'view.changed' || t === 'category.added')) build();
  });
}
