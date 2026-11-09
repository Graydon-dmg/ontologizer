// @ts-check
import { lensMenuOptions, pickLens, chooseLens, createLensRequests } from '../lens.js';
import { createDropdown } from './dropdown.js';
import { keepFitted } from './fit.js';

/** The "Rosetta" lens switcher: None, every lens, then "New lens…". @param {HTMLElement} el @param {any} shell */
export function mountLens(el, shell) {
  el.classList.add('lens-switcher');
  const label = document.createElement('span');
  label.className = 'lens-label dd-label';
  label.textContent = 'Rosetta';
  const dd = createDropdown({
    ariaLabel: 'Rosetta lens', options: [], value: 'none',
    onSelect: (v) => pickLens(v, { choose: (x) => { dd.setValue(x); choose(x); }, openNew: () => openPop() }),
  });

  // The "New lens…" popover.
  const pop = document.createElement('form');
  pop.className = 'lens-pop';
  pop.hidden = true;
  const prompt = document.createElement('label');
  prompt.textContent = 'Explain this map as if I were…';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'a home chef';
  input.maxLength = 120;
  prompt.append(input);
  const msg = document.createElement('div');
  msg.className = 'lens-msg';
  const row = document.createElement('div');
  row.className = 'lens-row';
  const create = document.createElement('button');
  create.type = 'submit';
  create.textContent = 'Create lens';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  row.append(create, cancel);
  pop.append(prompt, msg, row);
  el.append(label, dd.el, pop);

  const choose = (/** @type {string|null} */ id) => chooseLens(shell.activeView(), (a) => shell.act(a), id);
  const requests = createLensRequests({
    act: (a) => shell.act(a),
    snapshot: () => shell.snapshot(),
    select: (id) => { choose(id); build(); },
    notice: (text) => shell.emit('notice', { text }),
  });
  shell.lensRequests = requests;

  const closePop = () => { pop.hidden = true; msg.textContent = ''; };
  // Fixed beside the lens menu, always inside the window (re-placed on resize).
  const place = keepFitted(pop, el);
  const openPop = () => { pop.hidden = false; msg.textContent = ''; input.value = ''; place(); input.focus(); };

  function build() {
    const o = shell.snapshot();
    dd.setOptions(lensMenuOptions(o), o.view?.lens ?? 'none');
  }

  pop.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value.trim()) { msg.textContent = 'Type who the map should speak to, e.g. "a home chef".'; input.focus(); return; }
    create.disabled = true;
    const r = await requests.create(input.value);
    create.disabled = false;
    if (r.ok) closePop();
    else msg.textContent = `Could not create the lens: ${r.error}`;
  });
  cancel.addEventListener('click', closePop);
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
  build();
  shell.on('event', (/** @type {any} */ d) => {
    const t = d?.event?.t;
    if (t === 'lens.added' || t === 'view.changed') build();
    requests.onEvent(d?.event);
  });
}
