// @ts-check
import '../views/index.js';
import { listViews, getView } from '../shared/view.js';
import * as tokens from '../shared/tokens.js';
import { createGraphLayout } from '../shared/layout/graph.js';
import { createSource } from './source.js';
import { feedLayout } from './feed.js';
import { viewStateToApply, applyViewState } from './viewstate.js';
import { mountViewSwitcher } from './ui/views.js';
import { mountLegend } from './ui/legend.js';
import { mountHeight } from './ui/height.js';
import { mountMenu } from './ui/menu.js';
import { mountExplain } from './ui/explain.js';
import { mountJobs } from './ui/jobs.js';
import { mountTicker } from './ui/ticker.js';
import { mountSearch } from './ui/search.js';
import { mountFilter } from './ui/filter.js';
import { mountLens } from './ui/lens.js';
import { mountMinimap } from './ui/minimap.js';
import { mountTheme } from './ui/theme.js';
import { mountFuse } from './ui/fuse.js';
import { mountExport } from './ui/export.js';
import { mountTips } from './ui/tips.js';
import { mountSide } from './ui/side.js';
import { mountChat, mountChatButton } from './ui/chat.js';
import { computeInsets, sameInsets, tickerStrip } from './insets.js';
import { createExplainRequests, privateBadge } from './explain.js';
import { TENANT, BASE, api } from './base.js';
import { connBanner, stillSignedIn } from './conn.js';
import { mountServerPanel } from './ui/server.js';
import { mountBrandMenu } from './ui/brand.js';
import { mountAllMaps, fitAllMaps, mountMapMenu } from './ui/manage.js';

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

// The theme is applied by ui/theme.js (System / Light / Dark), mounted first below.

// Keep --topbar-bottom equal to the top bar's bottom edge: when the bar wraps to more rows,
// the legend and the explain panel move down with it.
{
  const bar = $('topbar');
  const publish = () => document.documentElement.style.setProperty('--topbar-bottom', Math.ceil(bar.getBoundingClientRect().bottom) + 'px');
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(publish).observe(bar);
  addEventListener('resize', publish);
  publish();
}

const layout = createGraphLayout({ width: innerWidth, height: innerHeight });
// Service mode: a dropped stream first asks whether the page is still signed in (a 401 stops it).
const source = createSource({
  search: location.search,
  ...(TENANT ? { checkAccess: () => stillSignedIn(fetch, api('/api/snapshot')) } : {}),
});

/** @type {Map<string, Set<Function>>} */
const handlers = new Map();
const bus = {
  on(/** @type {string} */ name, /** @type {Function} */ fn) {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name)?.add(fn);
    return () => { handlers.get(name)?.delete(fn); };
  },
  emit(/** @type {string} */ name, /** @type {any} */ detail) {
    for (const fn of [...(handlers.get(name) || [])]) {
      try { fn(detail); } catch (err) { console.error(`[shell] handler for "${name}" failed`, err); }
    }
  },
};

/** @type {any} */
let activeView = null;
/** @type {string|null} */
let activeId = null;

const shell = {
  source,
  snapshot: () => source.snapshot(),
  /** Send an action; a failure shows as a notice instead of failing silently. */
  act: (/** @type {any} */ a) => Promise.resolve()
    .then(() => source.act(a))
    .then((/** @type {any} */ r) => {
      if (r && r.ok === false) bus.emit('notice', { text: `Could not ${a && a.type}: ${r.error || 'refused by the server'}` });
      return r;
    })
    .catch((/** @type {any} */ err) => {
      bus.emit('notice', { text: `Could not ${a && a.type}: ${err && err.message ? err.message : err}` });
      return { ok: false, error: String(err) };
    }),
  layout,
  tokens,
  views: listViews(),
  activeView: () => activeView,
  activeViewId: () => activeId,
  switchView(/** @type {string} */ id) {
    if (!getView(id)) return;
    mountView(id);
    shell.act({ type: 'layout', value: id });
  },
  on: bus.on,
  emit: bus.emit,
  openExplain: (/** @type {string} */ nodeId) => bus.emit('explain', { nodeId }),
  /** @type {any} */ explainRequests: null,
  /** Write an explanation for a node unless one exists or is being written. */
  explainNode: (/** @type {string} */ nodeId) => shell.explainRequests.request(nodeId),
};

function ctx() {
  return {
    snapshot: () => source.snapshot(),
    subscribe: (/** @type {(e: object) => void} */ fn) => source.subscribe((e) => fn(e)),
    tokens,
    layout,
    emit: (/** @type {'select'|'hover'|'focus'} */ name, /** @type {any} */ detail) => {
      bus.emit(name, detail);
      if (name === 'focus' && detail && detail.nodeId) shell.act({ type: 'focus', nodeId: detail.nodeId });
    },
  };
}

function reapply() {
  if (activeView) applyViewState(activeView, viewStateToApply(source.snapshot().view));
}

/** @param {string|null} id */
function mountView(id) {
  const slot = $('view');
  const mini = $('minimap');
  if (activeView) {
    try { activeView.unmount(); } catch (err) { console.error('[shell] unmount failed', err); }
  }
  activeView = null;
  activeId = null;
  slot.replaceChildren();
  for (const c of [...mini.children]) if (!c.classList.contains('minimap-toggle') && !c.classList.contains('info')) c.remove();
  mini.hidden = true;
  const entry = id ? getView(id) : null;
  if (!entry) {
    const p = document.createElement('div');
    p.className = 'no-view';
    p.textContent = 'No view is registered yet.';
    slot.append(p);
    bus.emit('view', { id: null, view: null });
    return;
  }
  const el = /** @type {any} */ (document.createElement(entry.elementName));
  slot.append(el);
  try {
    el.mount(slot, ctx());
  } catch (err) {
    console.error('[shell] view mount failed', err);
  }
  activeView = el;
  activeId = entry.id;
  reapply();
  if (typeof el.mountMinimap === 'function') {
    mini.hidden = false;
    try { el.mountMinimap(mini); } catch (err) { console.error('[shell] mountMinimap failed', err); }
  }
  bus.emit('view', { id: entry.id, view: el });
}

// Mount the chrome first so every module sees the stream from its first event.
// The side panel (Explain | Chat) is set up first: both panes use it.
try { mountSide(shell); } catch (err) { console.error('[shell] side panel failed', err); }
const mounts = [
  ['chat', mountChat], ['chat-btn', mountChatButton],
  ['theme-switcher', mountTheme],
  ['view-switcher', mountViewSwitcher], ['height-switcher', mountHeight], ['legend', mountLegend], ['menu', mountMenu],
  ['explain', mountExplain], ['jobs', mountJobs], ['ticker', mountTicker], ['search', mountSearch],
  ['filter', mountFilter], ['lens-switcher', mountLens], ['fuse', mountFuse], ['export', mountExport], ['minimap', mountMinimap],
];
for (const [id, fn] of mounts) {
  try { /** @type {Function} */ (fn)($(/** @type {string} */ (id)), shell); }
  catch (err) { console.error(`[shell] mount "${id}" failed`, err); }
}
// Service mode only: the read-only Server panel (the one-map server leaves it hidden).
if (TENANT) {
  try { mountServerPanel($('server-panel'), { tenant: TENANT, popover: true, service: true }); }
  catch (err) { console.error('[shell] mount "server-panel" failed', err); }
  // The brand mark becomes a button: All maps, New map (the one-map page keeps it decorative).
  try { mountBrandMenu(/** @type {HTMLElement} */ (document.querySelector('#topbar .brand-mark'))); }
  catch (err) { console.error('[shell] mount "brand-menu" failed', err); }
  // Manage maps (I5): "‹ All maps" before the map name, and the name as a menu (Rename…, Delete…).
  document.body.classList.add('service');
  try {
    const mapId = decodeURIComponent(BASE.split('/maps/')[1] ?? '');
    const link = mountAllMaps($('map-name'));
    fitAllMaps(link, $('topbar'), $('map-name'));
    mountMapMenu($('map-name'), { tenant: TENANT, id: mapId, name: () => source.snapshot().name || mapId });
    // The Private badge hangs under the map name, which the link moved to the right.
    const badgeUnderName = () => { $('private-badge').style.left = `${$('map-name').offsetLeft}px`; };
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(badgeUnderName).observe($('topbar'));
    badgeUnderName();
  } catch (err) { console.error('[shell] mount "manage maps" failed', err); }
}
// The ⓘ tooltips go in once, after every control exists.
try { mountTips(shell); } catch (err) { console.error('[shell] tips failed', err); }

shell.explainRequests = createExplainRequests({
  act: (a) => shell.act(a),
  snapshot: () => source.snapshot(),
  onChange: () => bus.emit('explain-request', {}),
});
// A request the server accepted but whose job never arrived: re-open the stream once, then report it.
setInterval(() => {
  if (shell.explainRequests.expire() && /** @type {any} */ (source).reconnect) /** @type {any} */ (source).reconnect();
}, 1000);

// Connection banner: shown while the page cannot reach ontologizer.
{
  const banner = $('conn');
  /** @type {any} */
  let t = null;
  const show = (/** @type {string} */ s) => {
    clearTimeout(t);
    if (s === 'signed-out' || s === 'deleted') {
      // Service mode only: access was lost (a 401), or the map went to the trash. Offer sign-in, coming
      // back to this page, or the maps home.
      const b = /** @type {any} */ (connBanner(s, location.pathname));
      const a = document.createElement('a');
      a.href = b.link.href;
      a.textContent = b.link.text;
      a.style.color = 'inherit';
      banner.replaceChildren(b.text, a);
      banner.hidden = false;
      return;
    }
    if (s === 'lost') t = setTimeout(() => { banner.hidden = false; }, 1500);
    else banner.hidden = true;
  };
  if (/** @type {any} */ (source).onStatus) /** @type {any} */ (source).onStatus(show);
}

// Tell the view how much room the floating panels take: --onto-inset-* on the mount element, and
// an 'onto-insets' event there whenever they change (resize, panel open/close, legend collapse).
/** @type {any} */
let lastInsets = null;
function publishInsets() {
  const slot = $('view');
  const shown = (/** @type {Element|null} */ el) => !!el && !(/** @type {HTMLElement} */ (el)).hidden
    && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
  // The ticker is left out on purpose: it changes every few seconds and would make the map re-fit.
  const panels = ['topbar', 'legend', 'minimap', 'jobs'].map((id) => $(id));
  panels.push($('explain'), $('chat'), $('side-tabs'));
  const rects = panels.filter(shown).map((el) => el.getBoundingClientRect());
  // The ticker gets a fixed strip at the bottom left, reserved even while it is empty, so the map
  // never jumps when a line comes and goes (the ticker itself is not watched).
  rects.push(tickerStrip(innerWidth, innerHeight));
  // The explain panel's scroll area ends above the jobs tray (the tray stays on top so new jobs show).
  const tray = $('jobs');
  const trayTop = shown(tray) ? tray.getBoundingClientRect().top : innerHeight;
  document.documentElement.style.setProperty('--tray-space', Math.max(0, Math.ceil(innerHeight - trayTop + 8)) + 'px');
  const ins = computeInsets({ w: innerWidth, h: innerHeight }, rects);
  if (sameInsets(lastInsets, ins)) return;
  lastInsets = ins;
  for (const k of /** @type {const} */ (['top', 'right', 'bottom', 'left'])) slot.style.setProperty(`--onto-inset-${k}`, ins[k] + 'px');
  slot.dispatchEvent(new CustomEvent('onto-insets', { detail: { ...ins } }));
}
{
  let queued = false;
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; publishInsets(); }); } };
  const watched = ['topbar', 'legend', 'minimap', 'explain', 'chat', 'side-tabs', 'jobs'].map((id) => $(id));
  if (typeof ResizeObserver !== 'undefined') { const ro = new ResizeObserver(schedule); for (const el of watched) ro.observe(el); }
  const mo = new MutationObserver(schedule);
  for (const el of watched) mo.observe(el, { attributes: true, subtree: true, attributeFilter: ['hidden', 'class', 'style'] });
  addEventListener('resize', schedule);
  bus.on('view', () => { lastInsets = null; schedule(); });
  bus.on('explain', schedule);
  bus.on('side', schedule);
}

let badge = privateBadge(source.snapshot(), []);
$('private-badge').hidden = !badge.show;
$('private-badge').title = badge.title;

// Subscribe before mounting the view, so the layout is always fed before any view sees an event.
source.subscribe((event, ontology) => {
  try { feedLayout(layout, event); } catch (err) { console.error('[shell] feedLayout failed', err); }
  try { activeView?.apply(event); } catch (err) { console.error('[shell] view.apply failed', err); }
  const mapName = ontology?.name || source.snapshot().name || '';
  $('map-name').textContent = mapName;
  $('map-name').title = TENANT && mapName ? `${mapName}: rename or delete` : mapName; // the full name when it is truncated
  const title = mapName ? `${mapName} · Ontologizer` : 'Ontologizer';
  if (document.title !== title) document.title = title;
  badge = privateBadge(ontology, [event], badge);
  $('private-badge').hidden = !badge.show;
  $('private-badge').title = badge.title;
  $('loading').hidden = true; // the first event ends the loading state
  if (event.t === 'view.changed' && event.patch && activeView) {
    // Apply only what this event changed, so a filter tweak does not re-run the focus animation.
    const st = viewStateToApply(source.snapshot().view);
    const p = event.patch;
    try {
      if ('focus' in p && st.focus) activeView.setFocus?.(st.focus);
      if ('filter' in p) activeView.setFilter?.(st.filter);
      if ('lens' in p) activeView.setLens?.(st.lens);
    } catch (err) { console.error('[shell] applying view state failed', err); }
    const want = event.patch.layout;
    if (want && want !== activeId && getView(want)) mountView(want);
  }
  bus.emit('event', { event, ontology });
});

const first = (() => {
  const want = source.snapshot().view.layout;
  return getView(want) ? want : (shell.views[0]?.id ?? null);
})();
mountView(first);
