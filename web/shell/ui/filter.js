// @ts-check

/** @param {HTMLElement} el @param {any} shell */
export function mountFilter(el, shell) {
  el.classList.add('filter');
  const cats = document.createElement('span');
  cats.className = 'filter-cats';
  const depthLabel = document.createElement('label');
  depthLabel.textContent = 'Depth ';
  const depth = document.createElement('select');
  for (const v of ['Any', 1, 2, 3, 4]) {
    const o = document.createElement('option');
    o.value = v === 'Any' ? '' : String(v);
    o.textContent = String(v);
    depth.append(o);
  }
  depthLabel.append(depth);
  el.append(cats, depthLabel);

  /** @type {Set<string>|null} null = all */
  let selected = null;
  let busy = false;

  const send = () => {
    const all = shell.snapshot().categories.map((/** @type {any} */ c) => c.id);
    const boxes = /** @type {HTMLInputElement[]} */ ([...cats.querySelectorAll('input')]);
    const on = boxes.filter((b) => b.checked).map((b) => b.value);
    const categories = on.length === all.length ? null : on;
    selected = categories ? new Set(categories) : null;
    const value = { categories, maxDepth: depth.value ? Number(depth.value) : null };
    shell.activeView()?.setFilter(value);
    shell.act({ type: 'filter', value });
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
    depth.value = f?.maxDepth ? String(f.maxDepth) : '';
  };
  depth.addEventListener('change', () => { busy = true; send(); busy = false; });
  build();
  shell.on('event', (/** @type {any} */ d) => {
    const t = d?.event?.t;
    if (!busy && (t === 'view.changed' || t === 'category.added')) build();
  });
}
