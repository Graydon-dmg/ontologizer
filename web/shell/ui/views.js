// @ts-check
/** @param {HTMLElement} el @param {any} shell */
export function mountViewSwitcher(el, shell) {
  const views = shell.views || [];
  if (views.length === 0) { el.hidden = true; return; }
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', 'View');
  for (const v of views) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.label;
    sel.append(o);
  }
  sel.disabled = views.length < 2;
  sel.addEventListener('change', () => shell.switchView(sel.value));
  el.replaceChildren(sel);
  const sync = () => { const id = shell.activeViewId(); if (id) sel.value = id; };
  shell.on('view', sync);
  sync();
}
