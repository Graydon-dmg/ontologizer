// @ts-check
import { searchNodes, createReveal } from '../search.js';

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
  // A match inside a collapsed branch would be highlighted where nothing is drawn: open the
  // collapsed branches that hold a match, once typing pauses or on Enter. Clearing the search
  // leaves them open. Sent straight to the source, not shell.act: a page that cannot change the
  // map (a read-only token) just stops trying, without a notice per keystroke.
  const reveal = createReveal({
    snapshot: () => shell.snapshot(),
    act: (a) => (shell.source && typeof shell.source.act === 'function' ? shell.source.act(a) : shell.act(a)),
  });
  const refresh = () => {
    const ids = matches();
    reveal.schedule(ids);
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
      const ids = matches();
      reveal.now(ids);
      if (ids[0]) go(ids[0]);
    } else if (e.key === 'Escape') {
      reveal.reset();
      input.value = '';
      list.replaceChildren();
      list.hidden = true;
      shell.activeView()?.highlight([]);
    }
  });
  shell.on('view', () => { if (input.value.trim()) shell.activeView()?.highlight(matches()); });
  // Once an opened branch is drawn, highlight its matches again so they light up there too.
  shell.on('event', (/** @type {any} */ d) => {
    if (d?.event?.t === 'view.changed' && d.event.patch?.collapsed && input.value.trim()) shell.activeView()?.highlight(matches());
  });
}
