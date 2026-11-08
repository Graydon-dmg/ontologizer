// @ts-check
import { lensOptions, chooseLens } from '../lens.js';

/** @param {HTMLElement} el @param {any} shell */
export function mountLens(el, shell) {
  el.classList.add('lens-switcher');
  const label = document.createElement('label');
  label.textContent = 'See as ';
  const select = document.createElement('select');
  label.append(select);
  el.append(label);

  const build = () => {
    const o = shell.snapshot();
    const opts = lensOptions(o);
    select.replaceChildren(...opts.map((x) => {
      const op = document.createElement('option');
      op.value = x.value ?? 'none';
      op.textContent = x.label;
      return op;
    }));
    select.value = o.view?.lens ?? 'none';
    el.hidden = opts.length <= 1;
  };
  select.addEventListener('change', () => chooseLens(shell.activeView(), (a) => shell.act(a), select.value));
  build();
  shell.on('event', (/** @type {any} */ d) => {
    const t = d?.event?.t;
    if (t === 'lens.added' || t === 'view.changed') build();
  });
}
