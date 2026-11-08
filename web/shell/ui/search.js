// @ts-check
import { searchNodes } from '../search.js';

/** @param {HTMLElement} el @param {any} shell */
export function mountSearch(el, shell) {
  el.classList.add('search');
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Search';
  input.setAttribute('aria-label', 'Search nodes');
  const list = document.createElement('ul');
  list.className = 'search-results';
  list.hidden = true;
  el.append(input, list);

  /** @returns {string[]} */
  const matches = () => searchNodes(shell.snapshot(), input.value);
  const go = (/** @type {string} */ id) => {
    shell.activeView()?.setFocus(id);
    shell.act({ type: 'focus', nodeId: id });
    list.hidden = true;
  };
  const refresh = () => {
    const ids = matches();
    shell.activeView()?.highlight(ids);
    const nodes = shell.snapshot().nodes;
    list.replaceChildren(...ids.slice(0, 8).map((id) => {
      const li = document.createElement('li');
      li.textContent = nodes[id].label;
      li.addEventListener('mousedown', (e) => { e.preventDefault(); go(id); });
      return li;
    }));
    list.hidden = ids.length === 0;
  };
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const [best] = matches();
      if (best) go(best);
    } else if (e.key === 'Escape') {
      input.value = '';
      list.replaceChildren();
      list.hidden = true;
      shell.activeView()?.highlight([]);
    }
  });
  shell.on('view', () => { if (input.value.trim()) shell.activeView()?.highlight(matches()); });
}
