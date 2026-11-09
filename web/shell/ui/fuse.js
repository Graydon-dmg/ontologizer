// @ts-check
import { fuseCandidates, slugName, submitFuse } from '../fuse.js';
import { api } from '../base.js';

/** "Fuse" in the top bar: pick another saved map, optionally name the result, open it in a new tab.
 * @param {HTMLElement} el @param {any} shell */
export function mountFuse(el, shell) {
  el.classList.add('fuse');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fuse-btn';
  btn.textContent = 'Fuse';
  btn.setAttribute('aria-haspopup', 'dialog');

  const pop = document.createElement('form');
  pop.className = 'fuse-pop';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Fuse this map with another');
  const head = document.createElement('div');
  head.className = 'fuse-head';
  head.textContent = 'Fuse this map with…';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search your maps';
  search.setAttribute('aria-label', 'Search your maps');
  const list = document.createElement('div');
  list.className = 'fuse-list';
  list.setAttribute('role', 'listbox');
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Name the new map (optional)';
  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = 'e.g. gunpla';
  name.maxLength = 60;
  nameLabel.append(name);
  const hint = document.createElement('div');
  hint.className = 'fuse-msg';
  const row = document.createElement('div');
  row.className = 'fuse-row';
  const go = document.createElement('button');
  go.type = 'submit';
  go.textContent = 'Fuse';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  row.append(go, cancel);
  pop.append(head, search, list, nameLabel, hint, row);
  el.append(btn, pop);

  /** @type {any[]} */
  let maps = [];
  /** @type {string|null} */
  let picked = null;
  /** @type {Map<string, string>} */
  const names = new Map();
  shell.mapName = (/** @type {string} */ id) => names.get(id) || id;

  const render = () => {
    const rows = fuseCandidates(maps, search.value, { currentName: shell.snapshot().name });
    list.replaceChildren();
    if (!maps.length) {
      const empty = document.createElement('p');
      empty.className = 'fuse-empty';
      empty.textContent = 'No other saved maps yet. Build one in a terminal with `ontologizer new`, then fuse it here.';
      list.append(empty);
    } else if (!rows.length) {
      const none = document.createElement('p');
      none.className = 'fuse-empty';
      none.textContent = 'No map matches that search.';
      list.append(none);
    }
    for (const m of rows) {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'fuse-item';
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', String(m.id === picked));
      const t = document.createElement('span');
      t.textContent = m.name || m.id;
      const meta = document.createElement('span');
      meta.className = 'fuse-meta';
      meta.textContent = `${m.nodes} nodes`;
      opt.append(t, meta);
      if (m.draft) { const d = document.createElement('span'); d.className = 'fuse-draft'; d.textContent = 'draft'; opt.append(d); }
      opt.addEventListener('click', () => { picked = m.id; render(); });
      list.append(opt);
    }
    go.disabled = !picked || !maps.length;
  };

  const load = async () => {
    list.replaceChildren(Object.assign(document.createElement('p'), { className: 'fuse-empty', textContent: 'Loading your maps…' }));
    try {
      const res = await fetch(api('/api/maps'));
      maps = res.ok ? await res.json() : [];
      if (!res.ok) hint.textContent = `Could not list your maps (HTTP ${res.status}).`;
    } catch {
      maps = [];
      hint.textContent = 'Could not list your maps. Is ontologizer still running?';
    }
    for (const m of maps) names.set(m.id, m.name || m.id);
    render();
  };

  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const open = () => {
    pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
    picked = null; search.value = ''; name.value = ''; hint.textContent = '';
    load(); search.focus();
  };
  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  cancel.addEventListener('click', close);
  search.addEventListener('input', render);
  name.addEventListener('input', () => {
    const s = slugName(name.value);
    hint.textContent = name.value.trim() && s !== name.value.trim() ? `Will be saved as "${s || '…'}".` : '';
  });
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus(); } });

  /** Resolve with the new map's url once job.done carries it (fallback when the 202 had none). */
  const waitForUrl = (/** @type {string} */ jobId) => new Promise((resolve) => {
    const done = (/** @type {string|null} */ v) => { off(); clearTimeout(t); resolve(v); };
    const check = () => {
      const j = shell.snapshot().jobs[jobId];
      if (j && j.url) done(j.url);
      else if (j && j.state === 'failed') done(null);
    };
    const off = shell.on('event', check);
    const t = setTimeout(() => done(null), 60000);
    check();
  });

  pop.addEventListener('submit', (e) => {
    e.preventDefault();
    const withName = picked ? names.get(picked) : undefined;
    // submitFuse opens the tab synchronously, inside this click, so popup blockers allow it.
    submitFuse({
      act: (a) => shell.act(a),
      openTab: () => window.open('about:blank', '_blank'),
      notice: (text) => shell.emit('notice', { text }),
      waitForUrl,
    }, { withId: picked, into: slugName(name.value), withName }).then((r) => {
      if (r.ok) close();
      else hint.textContent = `Could not fuse: ${r.error}`;
    });
  });
}
