// @ts-check
import { dropdownKey, placeList } from '../dropdown.js';

let seq = 0;

/**
 * An in-page dropdown: a button with the current value and a caret, and a listbox popover.
 * @param {{ ariaLabel: string, options: { value: string, label: string }[], value: string,
 *           onSelect: (value: string) => void }} o
 */
export function createDropdown(o) {
  const id = `onto-dd-${++seq}`;
  const wrap = document.createElement('span');
  wrap.className = 'dd';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dd-btn';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', o.ariaLabel);
  button.setAttribute('aria-controls', id);
  const val = document.createElement('span');
  val.className = 'dd-val';
  const caret = document.createElement('span');
  caret.className = 'dd-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = '▾';
  button.append(val, caret);
  wrap.append(button);
  const list = document.createElement('ul');
  list.className = 'dd-list';
  list.id = id;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', o.ariaLabel);
  list.tabIndex = -1;
  list.hidden = true;
  document.body.append(list);

  let options = o.options;
  let value = o.value;
  let state = { open: false, active: 0 };
  const selectedIndex = () => options.findIndex((x) => x.value === value);

  const paint = () => {
    const cur = options[selectedIndex()];
    val.textContent = cur ? cur.label : '';
    list.replaceChildren(...options.map((x, i) => {
      const li = document.createElement('li');
      li.id = `${id}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(x.value === value));
      li.className = 'dd-opt' + (state.open && i === state.active ? ' active' : '');
      li.textContent = x.label;
      li.addEventListener('mousemove', () => { if (state.active !== i) { state = { ...state, active: i }; mark(); } });
      li.addEventListener('click', () => { close(true); choose(i); });
      return li;
    }));
    if (state.open) list.setAttribute('aria-activedescendant', `${id}-${state.active}`);
    else list.removeAttribute('aria-activedescendant');
  };
  const mark = () => {
    list.querySelectorAll('.dd-opt').forEach((li, i) => li.classList.toggle('active', i === state.active));
    list.setAttribute('aria-activedescendant', `${id}-${state.active}`);
  };
  const place = () => {
    const r = button.getBoundingClientRect();
    const p = placeList(r, { width: Math.max(list.offsetWidth, r.width), height: list.offsetHeight }, { w: innerWidth, h: innerHeight });
    list.style.left = p.left + 'px';
    list.style.top = p.top + 'px';
    list.style.minWidth = Math.round(r.width) + 'px';
  };
  const open = () => {
    state = { open: true, active: Math.max(0, selectedIndex()) };
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    paint();
    place();
    list.focus();
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const close = (/** @type {boolean} */ focusButton) => {
    state = { ...state, open: false };
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (focusButton) button.focus();
  };
  const choose = (/** @type {number} */ i) => {
    const x = options[i];
    if (!x) return;
    o.onSelect(x.value);
  };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    const r = dropdownKey(state, e.key, options.length, selectedIndex());
    if (!r.handled) { if (state.open && e.key === 'Tab') close(false); return; }
    e.preventDefault();
    if (r.open && !state.open) return open();
    if (!r.open) { close(!!r.focusButton); if (r.pick !== undefined) choose(r.pick); return; }
    state = { open: true, active: r.active };
    mark();
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  button.addEventListener('click', () => (state.open ? close(true) : open()));
  button.addEventListener('keydown', onKey);
  list.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', (e) => {
    const t = /** @type {Node} */ (e.target);
    if (state.open && !wrap.contains(t) && !list.contains(t)) close(false);
  }, true);
  addEventListener('resize', () => { if (state.open) place(); });
  paint();

  return {
    el: wrap,
    button,
    list,
    get value() { return value; },
    /** @param {string} v */
    setValue(v) { value = v; paint(); },
    /** @param {{ value: string, label: string }[]} opts @param {string} [v] */
    setOptions(opts, v) { options = opts; if (v !== undefined) value = v; paint(); if (state.open) place(); },
  };
}
