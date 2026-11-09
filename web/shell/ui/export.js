// @ts-check
// "Export" in the top bar: the page's side of `ontologizer export`. It runs the same exportMap on the
// map the page is showing; the page and embed formats inline the built bundle from /dist/embed.js.
import { exportMap, estimateTokens } from '../../../src/core/export/index.js';

/** The menu items, in order. `id` is the element id; `#export-context` is "Copy for an agent". */
export const EXPORT_ITEMS = /** @type {const} */ ([
  { id: 'export-html', label: 'Download page', format: 'html', action: 'download' },
  { id: 'export-embed', label: 'Copy embed', format: 'embed', action: 'copy' },
  { id: 'export-json', label: 'Download JSON', format: 'json', action: 'download' },
  { id: 'export-context', label: 'Copy for an agent', format: 'context', action: 'copy' },
]);

/** The context pack size the menu copies, in estimated tokens. */
export const MENU_BUDGET = 4000;

/**
 * A download file name for a map: its name as a slug, plus the format's extension.
 * @param {string} name @param {'html'|'json'} format
 */
export function exportFileName(name, format) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'map';
  return `${slug}.${format}`;
}

/** @type {Promise<string>|null} */
let bundleText = null;
/** The 2D bundle, fetched once. Rejects with a readable message when it was never built. */
function loadBundle() {
  bundleText ??= fetch('/dist/embed.js').then((r) => {
    if (!r.ok) throw new Error('the embed bundle is missing: run `npm run build` in the ontologizer folder');
    return r.text();
  }).catch((err) => { bundleText = null; throw err; });
  return bundleText;
}

/** @param {string} text */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch { /* fall back below */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('the browser did not allow copying');
}

/** @param {string} text @param {string} file @param {string} type */
function download(text, file, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** @param {HTMLElement} el @param {any} shell */
export function mountExport(el, shell) {
  el.classList.add('fuse'); // the Fuse popover's look: same button, same panel
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fuse-btn';
  btn.textContent = 'Export';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');

  const pop = document.createElement('div');
  pop.className = 'fuse-pop';
  pop.hidden = true;
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', 'Export this map');
  const head = document.createElement('div');
  head.className = 'fuse-head';
  head.textContent = 'Export this map';
  const list = document.createElement('div');
  list.className = 'fuse-list';
  const msg = document.createElement('div');
  msg.className = 'fuse-msg';
  msg.setAttribute('role', 'status');
  pop.append(head, list, msg);
  el.append(btn, pop);

  for (const item of EXPORT_ITEMS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = item.id;
    b.className = 'fuse-item';
    b.setAttribute('role', 'menuitem');
    b.textContent = item.label;
    b.addEventListener('click', () => run(item));
    list.append(b);
  }

  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const open = () => { pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); msg.textContent = ''; /** @type {HTMLElement|null} */ (list.firstElementChild)?.focus(); };
  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus(); } });
  document.addEventListener('mousedown', (e) => { if (!pop.hidden && !el.contains(/** @type {Node} */ (e.target))) close(); }, true);

  /** @param {typeof EXPORT_ITEMS[number]} item */
  async function run(item) {
    msg.textContent = 'Working…';
    try {
      const snap = shell.snapshot();
      const bundle = item.format === 'html' || item.format === 'embed' ? await loadBundle() : undefined;
      const text = exportMap(snap, { format: item.format, bundle, budget: MENU_BUDGET, liveUrl: location.href });
      if (item.format === 'html') {
        download(text, exportFileName(snap.name, 'html'), 'text/html');
        msg.textContent = 'Downloaded a page that works offline.';
      } else if (item.format === 'json') {
        download(text, exportFileName(snap.name, 'json'), 'application/json');
        msg.textContent = 'Downloaded the map as JSON.';
      } else if (item.format === 'embed') {
        await copyText(text);
        msg.textContent = 'Copied the embed: paste it into any page.';
      } else {
        await copyText(text);
        msg.textContent = `Copied the map for an agent (about ${estimateTokens(text).toLocaleString()} tokens).`;
      }
    } catch (err) {
      const text = `Could not export: ${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : err}`;
      msg.textContent = text;
      shell.emit('notice', { text });
    }
  }
}
