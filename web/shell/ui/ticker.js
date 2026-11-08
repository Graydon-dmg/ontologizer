// @ts-check
import { createTicker, tickerItem } from '../ticker.js';

/** @param {HTMLElement} el @param {any} shell */
export function mountTicker(el, shell) {
  el.classList.add('onto-ticker');
  /** @type {string|undefined} */
  let current;
  const ticker = createTicker({
    show(item) {
      current = item ? item.nodeId : undefined;
      if (item) el.textContent = item.text;
      el.classList.toggle('on', !!item);
    },
    setTimeout: (/** @type {any} */ f, /** @type {number} */ ms) => setTimeout(f, ms),
    clearTimeout: (/** @type {any} */ t) => clearTimeout(t),
  });
  el.addEventListener('click', () => {
    if (!current) return;
    shell.act({ type: 'focus', nodeId: current });
    const v = shell.activeView();
    if (v && v.setFocus) v.setFocus(current);
  });
  shell.on('notice', (/** @type {any} */ d) => { if (d && d.text) ticker.push({ text: d.text }); });
  shell.on('event', (/** @type {any} */ d) => {
    const item = d && tickerItem(d.event, d.ontology);
    if (item) ticker.push(item);
  });
}
