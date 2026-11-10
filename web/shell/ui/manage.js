// @ts-check
// Manage maps (I5), the DOM side. One small panel for rename, delete and restore, placed beside the
// button that opened it by fitPanel (it stays inside the window at any size), used by the maps home
// and the service-mode map page. On the map page: the "All maps" link before the map name, and the map
// name as a button with a menu (Rename…, Delete…). The one-map page calls none of this.
import { fitTo } from './fit.js';
import { menuStep } from '../brand-menu.js';
import { renameTexts, deleteTexts, nameProblem, slugName, renameMap, deleteMap, getSession, allowed, isDraftId, failText } from '../manage.js';

const STYLE_ID = 'manage-style';
const CSS = `
.manage-pop { position: fixed; z-index: 60; width: 340px; padding: 12px; box-sizing: border-box; display: flex; flex-direction: column; gap: 8px;
  background: var(--panel); color: var(--fg); border: 1px solid color-mix(in srgb, var(--muted) 40%, transparent); border-radius: 8px;
  font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
.manage-pop[hidden] { display: none; }
.manage-pop h3 { margin: 0; font-size: 14px; }
.manage-pop p { margin: 0; overflow-wrap: anywhere; }
.manage-pop .hint { color: var(--muted); font-size: 12px; }
.manage-pop label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.manage-pop input { background: var(--bg); color: var(--fg); border: 1px solid var(--muted); border-radius: 4px; padding: 6px 8px; font: inherit; width: 100%; box-sizing: border-box; }
.manage-pop .msg { color: var(--fg); font-size: 12px; font-weight: 600; }
.manage-pop .msg:empty { display: none; }
.manage-pop .row { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
.manage-pop button { font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 6px; cursor: pointer; border: 1px solid var(--muted); background: var(--panel); color: var(--fg); }
.manage-pop button.go { background: var(--fg); color: var(--bg); border-color: var(--fg); font-weight: 600; }
.manage-pop button:disabled { opacity: .5; cursor: default; }
.manage-pop :focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.map-menu { position: fixed; z-index: 55; min-width: 150px; padding: 4px; box-sizing: border-box; display: flex; flex-direction: column;
  background: var(--panel); color: var(--fg); border: 1px solid color-mix(in srgb, var(--muted) 40%, transparent); border-radius: 8px;
  font: 13px system-ui, sans-serif; }
.map-menu[hidden] { display: none; }
.map-menu button { all: unset; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
.map-menu button:hover, .map-menu button:focus-visible { background: var(--bg); outline: none; }
.map-menu button[aria-disabled="true"] { opacity: .5; cursor: default; }
`;

function addStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = CSS;
  document.head.append(st);
}

/** The open panel's close, so a second one replaces the first. @type {(() => void)|null} */
let closeOpen = null;

/**
 * Open the panel beside `anchor`.
 * @param {HTMLElement} anchor
 * @param {{ title: string, text?: string, hint?: string, input?: { label: string, value: string }, confirm: string,
 *   align?: 'left'|'right', onConfirm: (value: string) => Promise<string|null> }} o
 *   onConfirm answers null when done (the panel closes), or a message to show (it stays open).
 * @returns {{ panel: HTMLElement, close: () => void }}
 */
export function openPanel(anchor, o) {
  addStyle();
  closeOpen?.();
  const panel = document.createElement('div');
  panel.className = 'manage-pop';
  panel.id = 'manage-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'manage-title');
  const h = document.createElement('h3');
  h.id = 'manage-title';
  h.textContent = o.title;
  panel.append(h);
  if (o.text) { const p = document.createElement('p'); p.textContent = o.text; panel.append(p); }
  /** @type {HTMLInputElement|null} */
  let input = null;
  if (o.input) {
    const l = document.createElement('label');
    l.textContent = o.input.label;
    input = document.createElement('input');
    input.id = 'manage-input';
    input.type = 'text';
    input.value = o.input.value;
    input.autocomplete = 'off';
    input.spellcheck = false;
    l.append(input);
    panel.append(l);
  }
  if (o.hint) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = o.hint; panel.append(p); }
  const msg = document.createElement('p');
  msg.className = 'msg';
  msg.setAttribute('role', 'alert');
  const row = document.createElement('div');
  row.className = 'row';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.id = 'manage-cancel';
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'go';
  go.id = 'manage-confirm';
  go.textContent = o.confirm;
  row.append(cancel, go);
  panel.append(msg, row);
  document.body.append(panel);

  const place = () => fitTo(panel, anchor, { align: o.align ?? 'left' });
  const onResize = () => place();
  const onDown = (/** @type {Event} */ e) => { const t = /** @type {Node} */ (e.target); if (!panel.contains(t) && !anchor.contains(t)) close(false); };
  const onKey = (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') { e.preventDefault(); close(true); } };
  function close(/** @type {boolean} */ toAnchor = false) {
    if (!panel.isConnected) return;
    removeEventListener('resize', onResize);
    document.removeEventListener('pointerdown', onDown, true);
    panel.remove();
    if (closeOpen === closer) closeOpen = null;
    if (toAnchor && anchor.isConnected) anchor.focus();
  }
  const closer = () => close(false);
  closeOpen = closer;
  addEventListener('resize', onResize);
  document.addEventListener('pointerdown', onDown, true);
  panel.addEventListener('keydown', onKey);
  cancel.addEventListener('click', () => close(true));
  const submit = async () => {
    msg.textContent = '';
    go.disabled = true; cancel.disabled = true;
    let out = null;
    try { out = await o.onConfirm(input ? input.value.trim() : ''); } catch (err) { out = String(/** @type {any} */ (err)?.message ?? err); }
    go.disabled = false; cancel.disabled = false;
    if (out === null) { close(false); return; }
    msg.textContent = out;
    place();
  };
  go.addEventListener('click', submit);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  place();
  (input ?? cancel).focus();
  input?.select();
  return { panel, close: closer };
}

/**
 * Rename (or save) a map, from the map page or the home. Resolves to the map's new view URL, or null.
 * @param {HTMLElement} anchor @param {{ fetch: typeof fetch, tenant: string, id: string, name: string, align?: 'left'|'right' }} o
 * @returns {Promise<string|null>}
 */
export function renameFlow(anchor, { fetch: f, tenant, id, name, align }) {
  const t = renameTexts(id);
  return new Promise((resolve) => {
    const { panel } = openPanel(anchor, {
      title: t.title, hint: t.hint, confirm: t.confirm, align,
      input: { label: t.label, value: isDraftId(id) ? slugName(name) : id },
      onConfirm: async (value) => {
        const bad = nameProblem(value);
        if (bad) return bad;
        if (value === id) return 'That is its name already.';
        const r = await renameMap(f, tenant, id, value);
        if (!r.ok) return failText(r);
        resolve(String(r.body?.viewUrl ?? ''));
        return null;
      },
    });
    watchGone(panel, () => resolve(null));
  });
}

/**
 * Delete a map (to the trash), after the confirmation. Resolves true when it was deleted.
 * @param {HTMLElement} anchor @param {{ fetch: typeof fetch, tenant: string, id: string, name: string, align?: 'left'|'right' }} o
 * @returns {Promise<boolean>}
 */
export function deleteFlow(anchor, { fetch: f, tenant, id, name, align }) {
  const t = deleteTexts(name || id);
  return new Promise((resolve) => {
    const { panel } = openPanel(anchor, {
      title: t.title, text: t.text, confirm: t.confirm, align,
      onConfirm: async () => {
        const r = await deleteMap(f, tenant, id);
        if (!r.ok) return failText(r);
        resolve(true);
        return null;
      },
    });
    watchGone(panel, () => resolve(false));
  });
}

/** Call `fn` once the panel leaves the page (closed without confirming). @param {HTMLElement} panel @param {() => void} fn */
function watchGone(panel, fn) {
  const mo = new MutationObserver(() => { if (!panel.isConnected) { mo.disconnect(); fn(); } });
  mo.observe(document.body, { childList: true });
}

/**
 * The map page's "All maps" link, before the map name: "‹ All maps", or just "‹" (with the same
 * accessible name) where the top bar has no room for the words (shell.css decides by width).
 * @param {HTMLElement} nameEl the top bar's #map-name
 */
export function mountAllMaps(nameEl) {
  const a = document.createElement('a');
  a.id = 'all-maps';
  a.href = '/';
  a.className = 'all-maps';
  a.setAttribute('aria-label', 'All maps');
  a.title = 'All maps';
  const chev = document.createElement('span');
  chev.className = 'all-maps-chev';
  chev.setAttribute('aria-hidden', 'true');
  chev.textContent = '‹';
  const text = document.createElement('span');
  text.className = 'all-maps-text';
  text.setAttribute('aria-hidden', 'true');
  text.textContent = 'All maps';
  a.append(chev, text);
  nameEl.before(a);
  return a;
}

/**
 * Show "All maps" in words only while the top bar still fits on one row with them; otherwise just the
 * chevron (class `compact`). Re-checked when the window or the bar changes size and when the name changes.
 * @param {HTMLElement} link #all-maps @param {HTMLElement} bar #topbar @param {HTMLElement} nameEl #map-name
 */
export function fitAllMaps(link, bar, nameEl) {
  /** Whether any item in the bar sits on a row below the link's. */
  const wrapped = () => {
    const r = link.getBoundingClientRect();
    return [...bar.children].some((k) => {
      const b = k.getBoundingClientRect();
      return b.width > 0 && getComputedStyle(k).position !== 'absolute' && b.top >= r.bottom - 1;
    });
  };
  let pending = false;
  const fit = () => {
    pending = false;
    link.classList.remove('compact');
    if (wrapped()) link.classList.add('compact');
  };
  const later = () => { if (!pending) { pending = true; requestAnimationFrame(fit); } };
  addEventListener('resize', later);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(later).observe(bar);
  new MutationObserver(later).observe(nameEl, { childList: true, characterData: true, subtree: true });
  fit();
  return fit;
}

/**
 * The map name as a button with a menu: Rename… (#map-rename) and Delete… (#map-delete). Items the
 * caller's scopes do not allow are shown disabled, with the scope they need. After a rename the page
 * goes to the new address; after a delete, to the maps home.
 * @param {HTMLElement} nameEl @param {{ tenant: string, id: string, name: () => string, fetch?: typeof fetch }} o
 */
export function mountMapMenu(nameEl, { tenant, id, name, fetch: f = globalThis.fetch.bind(globalThis) }) {
  addStyle();
  nameEl.setAttribute('role', 'button');
  nameEl.tabIndex = 0;
  nameEl.setAttribute('aria-haspopup', 'menu');
  nameEl.setAttribute('aria-expanded', 'false');
  nameEl.style.cursor = 'pointer';
  const menu = document.createElement('div');
  menu.className = 'map-menu';
  menu.id = 'map-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'This map');
  menu.hidden = true;
  nameEl.setAttribute('aria-controls', menu.id);
  const draft = isDraftId(id);
  const items = [['map-rename', draft ? 'Save as…' : 'Rename…'], ['map-delete', 'Delete…']].map(([itemId, text]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = itemId;
    b.textContent = text;
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    return b;
  });
  menu.append(...items);
  document.body.append(menu);
  const [renameItem, deleteItem] = items;
  // Grey out what the token cannot do (the server refuses it anyway).
  getSession(f).then((s) => {
    if (!s.ok) return;
    const can = allowed(s.body?.scopes ?? [], draft);
    if (!can.rename) { renameItem.setAttribute('aria-disabled', 'true'); renameItem.title = 'This token needs the build scope.'; }
    if (!can.remove) { deleteItem.setAttribute('aria-disabled', 'true'); deleteItem.title = `This token needs the ${draft ? 'build' : 'admin'} scope.`; }
  });

  const focusItem = (/** @type {number} */ i) => items[i]?.focus();
  const open = (/** @type {number} */ at = 0) => {
    menu.hidden = false;
    nameEl.setAttribute('aria-expanded', 'true');
    fitTo(menu, nameEl, { align: 'left' });
    focusItem(at);
  };
  const close = (/** @type {boolean} */ toName) => {
    if (menu.hidden) return;
    menu.hidden = true;
    nameEl.setAttribute('aria-expanded', 'false');
    if (toName) nameEl.focus();
  };
  addEventListener('resize', () => { if (!menu.hidden) fitTo(menu, nameEl, { align: 'left' }); });
  nameEl.addEventListener('click', () => (menu.hidden ? open(0) : close(true)));
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); open(0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); open(items.length - 1); }
  });
  menu.addEventListener('keydown', (e) => {
    const step = menuStep(items.indexOf(/** @type {any} */ (document.activeElement)), e.key, items.length);
    if (step.handled) e.preventDefault();
    if (step.close) close(step.toButton);
    else if (step.focus !== undefined) focusItem(step.focus);
  });
  document.addEventListener('pointerdown', (e) => {
    const t = /** @type {Node} */ (e.target);
    if (!menu.hidden && !menu.contains(t) && !nameEl.contains(t)) close(false);
  }, true);
  renameItem.addEventListener('click', async () => {
    if (renameItem.getAttribute('aria-disabled') === 'true') return;
    close(false);
    const url = await renameFlow(nameEl, { fetch: f, tenant, id, name: name() });
    if (url) location.href = url;
  });
  deleteItem.addEventListener('click', async () => {
    if (deleteItem.getAttribute('aria-disabled') === 'true') return;
    close(false);
    if (await deleteFlow(nameEl, { fetch: f, tenant, id, name: name() })) location.href = '/';
  });
  return { menu };
}
