// @ts-check
// "Export" in the top bar: the page's side of `ontologizer export`. It runs the same exportMap on the
// map the page is showing; the page and embed formats inline the built bundle from /dist/embed.js.
import { exportMap, estimateTokens } from '../../../src/core/export/index.js';
import { keepFitted } from './fit.js';

/** The menu items, in order. `id` is the element id; `#export-context` is "Copy for an agent". */
export const EXPORT_ITEMS = /** @type {const} */ ([
  { id: 'export-html', label: 'Download page', format: 'html', action: 'download' },
  { id: 'export-embed', label: 'Copy embed', format: 'embed', action: 'copy' },
  { id: 'export-json', label: 'Download JSON', format: 'json', action: 'download' },
  { id: 'export-context', label: 'Copy for an agent', format: 'context', action: 'copy' },
]);

/**
 * The box the menu opens from: the button's columns, but the whole top bar's bottom, so the menu
 * opens under every row of a wrapped bar instead of over the rows below the button.
 * @param {{ left: number, right: number, top: number, bottom: number }} btn
 * @param {{ bottom: number }|null} bar
 */
export function menuAnchor(btn, bar) {
  const bottom = bar ? Math.max(btn.bottom, bar.bottom) : btn.bottom;
  return { left: btn.left, right: btn.right, width: btn.right - btn.left, top: btn.top, bottom, height: bottom - btn.top };
}

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

/** A small "download" glyph drawn in the button's own text color. */
function exportIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13h10');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/** @param {HTMLElement} el @param {any} shell */
export function mountExport(el, shell) {
  el.classList.add('fuse'); // the Fuse popover's look: same button, same panel
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fuse-btn';
  btn.setAttribute('aria-label', 'Export');
  btn.title = 'Export this map';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  const text = document.createElement('span');
  text.textContent = 'Export';
  btn.append(text, exportIcon());
  // Between 1280 and 1366 px the top bar fits on one row only if Export is an icon (as the search
  // box and map name give way there too); everywhere else it says "Export".
  const band = globalThis.matchMedia?.('(min-width: 1280px) and (max-width: 1366px)');
  const fit = () => {
    const small = Boolean(band?.matches);
    text.hidden = small;
    /** @type {SVGElement} */ (btn.lastElementChild).style.display = small ? 'block' : 'none';
    btn.style.padding = small ? '3px 4px' : '';
    // and sits 4 px from Fuse (the spacing inside a control group) instead of the bar's 8 px
    el.style.marginLeft = small ? '-4px' : '';
  };
  band?.addEventListener?.('change', fit);
  fit();

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

  // The shell's placement for top-bar panels: fixed, inside the window with an 8 px margin, capped
  // with its own scroll, placed again on resize (and below, when its status line changes).
  // Anchored under the whole top bar, not just the button: on a narrow window the bar wraps to
  // several rows, and a menu opened mid-bar would cover the buttons on the rows below.
  const bar = el.closest('#topbar');
  const anchor = /** @type {HTMLElement} */ (/** @type {unknown} */ ({
    getBoundingClientRect: () => menuAnchor(btn.getBoundingClientRect(), bar ? bar.getBoundingClientRect() : null),
  }));
  const place = keepFitted(pop, anchor, { align: 'right' });
  /** A status line changes the menu's height: place it again. @param {string} text */
  const say = (text) => { msg.textContent = text; place(); };
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const open = () => { pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); msg.textContent = ''; place(); /** @type {HTMLElement|null} */ (list.firstElementChild)?.focus(); };
  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus(); } });
  document.addEventListener('mousedown', (e) => { if (!pop.hidden && !el.contains(/** @type {Node} */ (e.target))) close(); }, true);

  /** @param {typeof EXPORT_ITEMS[number]} item */
  async function run(item) {
    say('Working…');
    try {
      const snap = shell.snapshot();
      const bundle = item.format === 'html' || item.format === 'embed' ? await loadBundle() : undefined;
      const text = exportMap(snap, { format: item.format, bundle, budget: MENU_BUDGET, liveUrl: location.href });
      if (item.format === 'html') {
        download(text, exportFileName(snap.name, 'html'), 'text/html');
        say('Downloaded a page that works offline.');
      } else if (item.format === 'json') {
        download(text, exportFileName(snap.name, 'json'), 'application/json');
        say('Downloaded the map as JSON.');
      } else if (item.format === 'embed') {
        await copyText(text);
        say('Copied the embed: paste it into any page.');
      } else {
        await copyText(text);
        say(`Copied the map for an agent (about ${estimateTokens(text).toLocaleString()} tokens).`);
      }
    } catch (err) {
      const text = `Could not export: ${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : err}`;
      say(text);
      shell.emit('notice', { text });
    }
  }
}
