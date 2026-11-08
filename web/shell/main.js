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
import { mountMenu } from './ui/menu.js';
import { mountExplain } from './ui/explain.js';
import { mountJobs } from './ui/jobs.js';
import { mountTicker } from './ui/ticker.js';
import { mountSearch } from './ui/search.js';
import { mountFilter } from './ui/filter.js';
import { mountLens } from './ui/lens.js';
import { mountMinimap } from './ui/minimap.js';

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

// Theme: dark by default; light if the OS asks for it.
const theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;
const th = tokens.THEME[theme];
for (const k of ['bg', 'fg', 'muted', 'panel']) document.documentElement.style.setProperty('--' + k, th[k]);

const layout = createGraphLayout({ width: innerWidth, height: innerHeight });
const source = createSource({ search: location.search });

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
  act: (/** @type {any} */ a) => source.act(a),
  layout,
  tokens,
  views: listViews(),
  activeView: () => activeView,
  activeViewId: () => activeId,
  switchView(/** @type {string} */ id) {
    if (!getView(id)) return;
    mountView(id);
    source.act({ type: 'layout', value: id });
  },
  on: bus.on,
  emit: bus.emit,
  openExplain: (/** @type {string} */ nodeId) => bus.emit('explain', { nodeId }),
};

function ctx() {
  return {
    snapshot: () => source.snapshot(),
    subscribe: (/** @type {(e: object) => void} */ fn) => source.subscribe((e) => fn(e)),
    tokens,
    layout,
    emit: (/** @type {'select'|'hover'|'focus'} */ name, /** @type {any} */ detail) => {
      bus.emit(name, detail);
      if (name === 'focus' && detail && detail.nodeId) source.act({ type: 'focus', nodeId: detail.nodeId });
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
  mini.replaceChildren();
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
const mounts = [
  ['view-switcher', mountViewSwitcher], ['legend', mountLegend], ['menu', mountMenu],
  ['explain', mountExplain], ['jobs', mountJobs], ['ticker', mountTicker], ['search', mountSearch],
  ['filter', mountFilter], ['lens-switcher', mountLens], ['minimap', mountMinimap],
];
for (const [id, fn] of mounts) {
  try { /** @type {Function} */ (fn)($(/** @type {string} */ (id)), shell); }
  catch (err) { console.error(`[shell] mount "${id}" failed`, err); }
}

// Subscribe before mounting the view, so the layout is always fed before any view sees an event.
source.subscribe((event, ontology) => {
  try { feedLayout(layout, event); } catch (err) { console.error('[shell] feedLayout failed', err); }
  try { activeView?.apply(event); } catch (err) { console.error('[shell] view.apply failed', err); }
  $('map-name').textContent = ontology?.name || source.snapshot().name || '';
  if (event.t === 'view.changed' && event.patch) {
    reapply();
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
