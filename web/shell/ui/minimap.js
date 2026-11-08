// @ts-check

/** Decorates the minimap slot with a collapse toggle; main.js mounts the minimap itself.
 * @param {HTMLElement} el @param {any} shell */
export function mountMinimap(el, shell) {
  el.classList.add('minimap-frame');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'minimap-toggle';
  btn.textContent = '−';
  btn.title = 'Collapse minimap';
  btn.addEventListener('click', () => {
    const c = el.classList.toggle('collapsed');
    btn.textContent = c ? '+' : '−';
    btn.title = c ? 'Expand minimap' : 'Collapse minimap';
  });
  el.prepend(btn);
}
