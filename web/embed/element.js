// @ts-check
// <ontologizer-map>: a read-only map for offline exports. Shadow DOM; data from the page; the
// existing 2D graph view, the shared layout and the shared tokens. Nothing is ever sent anywhere.
import { pageViews, viewsFor, VIEWS_EVENT } from './registry.js';
import * as tokens from '../shared/tokens.js';
import { createGraphLayout } from '../shared/layout/graph.js';
import { fold } from '../../src/core/events.js';
import { feedLayout } from '../shell/feed.js';
import { viewStateToApply, applyViewState } from '../shell/viewstate.js';
import { readMapData } from './data.js';
import { searchNodes, safeHref, nodeDetails, toggleCollapsed, revealPatch, panelBelowBar } from './helpers.js';

const TAG = 'ontologizer-map';
const MARGIN = 12;

/** @param {Record<string, string>} t */
const vars = (t) => `--bg:${t.bg};--fg:${t.fg};--muted:${t.muted};--panel:${t.panel};`;

const CSS = `
:host { ${vars(tokens.THEME.dark)} display:block; position:relative; overflow:hidden; background:var(--bg); color:var(--fg); font:13px system-ui, sans-serif; min-height:200px; }
@media (prefers-color-scheme: light) { :host { ${vars(tokens.THEME.light)} } }
* { box-sizing:border-box; }
.stage { position:absolute; inset:0; }
.msg { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; padding:16px; text-align:center; }
.banner { position:absolute; top:0; left:0; right:0; z-index:3; padding:4px 12px; text-align:center; background:var(--panel); color:var(--muted); border-bottom:1px solid var(--muted); font-size:12px; }
.banner.empty { display:none; }
::slotted([slot="banner"]) { display:block; }
.bar { position:absolute; left:${MARGIN}px; top:${MARGIN}px; z-index:2; display:flex; flex-wrap:wrap; align-items:center; gap:8px; max-width:calc(100% - ${2 * MARGIN}px); padding:6px 8px; background:var(--panel); color:var(--fg); border:1px solid var(--muted); border-radius:8px; }
.name { font-weight:600; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
input, button, ::slotted(a) { font:inherit; color:var(--fg); background:var(--bg); border:1px solid var(--muted); border-radius:6px; padding:3px 8px; cursor:pointer; text-decoration:none; }
input { cursor:text; width:150px; }
button:hover, ::slotted(a:hover) { border-color:var(--fg); }
.panel { position:absolute; top:${MARGIN}px; right:${MARGIN}px; bottom:${MARGIN}px; z-index:2; width:300px; max-width:calc(100% - ${2 * MARGIN}px); overflow:auto; padding:12px; background:var(--panel); color:var(--fg); border:1px solid var(--muted); border-radius:8px; }
.panel[hidden], .bar [hidden] { display:none; }
.panel h2 { margin:0 24px 2px 0; font-size:16px; }
.panel h3 { margin:12px 0 4px; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
.panel p { margin:4px 0; line-height:1.45; }
.panel ul { margin:4px 0; padding-left:18px; }
.panel a { color:var(--fg); }
.muted { color:var(--muted); }
.close { position:absolute; top:8px; right:8px; padding:0 8px; }
.actions { display:flex; gap:8px; margin-top:12px; }
`;

/** @param {string} tag @param {string} [text] @param {string} [cls] */
function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

/** @param {string} text @param {() => void} fn */
function button(text, fn) {
  const b = el('button', text);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}

// Node has no HTMLElement; the class is only defined there, never used.
const Base = /** @type {typeof HTMLElement} */ (globalThis.HTMLElement ?? class {});

class OntologizerMap extends Base {
  constructor() {
    super();
    this.started = false;
    this.waiting = false;
    /** @type {HTMLButtonElement|null} */ this.toggle = null;
    /** @type {any} */ this.onto = null;
    /** @type {any} */ this.layout = null;
    /** @type {any} */ this.view = null;
    /** @type {string|null} */ this.viewId = null;
    /** @type {Set<(e: object) => void>} */ this.listeners = new Set();
    /** @type {HTMLElement|null} */ this.stage = null;
    /** @type {HTMLElement|null} */ this.bar = null;
    /** @type {HTMLElement|null} */ this.banner = null;
    /** @type {HTMLElement|null} */ this.panel = null;
    /** @type {string|null} */ this.openId = null;
    /** @type {ResizeObserver|null} */ this.ro = null;
    /** A bundle added views after this map was drawn (a 3D export's own add-on runs last). */
    this.onViews = () => this.syncViews();
  }

  /** The views this export may use: those its data-views names, of the ones on the page. */
  views() {
    return viewsFor(this.getAttribute('data-views'), pageViews());
  }

  /** @param {string} id */
  viewEntry(id) {
    return this.views().find((v) => v.id === id) || null;
  }

  connectedCallback() {
    if (this.started) return;
    // An element the HTML parser creates after the bundle has run is connected before its children
    // (the data tag) are parsed: wait for the document, then read.
    if (this.readText() === null && document.readyState === 'loading') {
      if (!this.waiting) {
        this.waiting = true;
        document.addEventListener('DOMContentLoaded', () => { this.waiting = false; if (this.isConnected) this.connectedCallback(); }, { once: true });
      }
      return;
    }
    this.started = true;
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.append(style);

    const read = readMapData(this.readText());
    if (!read.ok) {
      root.append(el('div', `Could not show this map: ${read.error}`, 'msg'));
      return;
    }
    this.onto = read.ontology;
    this.build(root);
  }

  disconnectedCallback() {
    if (typeof document !== 'undefined') document.removeEventListener(VIEWS_EVENT, this.onViews);
    if (this.ro) this.ro.disconnect();
    this.ro = null;
    if (this.view) {
      try { this.view.unmount(); } catch { /* the page is going away */ }
    }
    this.view = null;
    if (this.layout && typeof this.layout.stop === 'function') this.layout.stop();
  }

  /** @returns {string|null} */
  readText() {
    for (const c of Array.from(this.children)) {
      if (c.tagName === 'SCRIPT' && c.getAttribute('type') === 'application/json') return c.textContent;
    }
    const page = document.getElementById('ontologizer-data');
    return page ? page.textContent : null;
  }

  /** @param {ShadowRoot} root */
  build(root) {
    const rect = this.getBoundingClientRect();
    const width = rect.width > 0 ? rect.width : 800;
    const height = rect.height > 0 ? rect.height : 480;
    const layout = createGraphLayout({ width, height });
    this.layout = layout;
    const onto = this.onto;

    // Seed the layout, parents before children, then settle so the map appears at rest.
    const list = Object.values(onto.nodes);
    list.sort((a, b) => (a.depth || 0) - (b.depth || 0));
    for (const n of list) layout.add(n);
    for (const e of onto.edges) layout.addEdge(e);
    const view0 = onto.view || {};
    layout.setCollapsed(Array.isArray(view0.collapsed) ? view0.collapsed : []);
    layout.setFocus(view0.focus || onto.root);
    layout.settle(300);

    const stage = el('div', undefined, 'stage');
    this.stage = stage;
    root.append(stage);

    const banner = el('div', undefined, 'banner empty');
    const bannerSlot = document.createElement('slot');
    bannerSlot.name = 'banner';
    banner.append(bannerSlot);
    this.banner = banner;
    const refreshBanner = () => {
      const has = bannerSlot.assignedNodes().some((n) => n.nodeType === 1 || (n.textContent || '').trim());
      banner.classList.toggle('empty', !has);
      this.publishInsets();
    };
    bannerSlot.addEventListener('slotchange', refreshBanner);
    root.append(banner);

    root.append(this.buildBar());
    const panel = el('aside', undefined, 'panel');
    panel.hidden = true;
    this.panel = panel;
    root.append(panel);

    this.mountView(this.firstViewId());
    document.addEventListener(VIEWS_EVENT, this.onViews);
    refreshBanner();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.publishInsets());
      // Placed again whenever the bar wraps or the element itself changes size.
      if (this.bar) this.ro.observe(this.bar);
      this.ro.observe(this);
    }
    this.publishInsets();
  }

  /** @returns {string|null} */
  firstViewId() {
    const all = this.views();
    const want = all.find((v) => v.id === 'graph-2d');
    return want ? want.id : (all[0] ? all[0].id : null);
  }

  /** Offer views a later bundle added: the toggle, or a first view if none could be drawn. */
  syncViews() {
    if (!this.stage) return;
    if (!this.viewId) { this.mountView(this.firstViewId()); return; }
    this.syncToggle();
  }

  /** The 2D / 3D toggle, present only when this export has more than one view on the page. */
  syncToggle() {
    const bar = this.bar;
    if (!bar) return;
    const many = this.views().length > 1;
    if (many && !this.toggle) {
      const toggle = /** @type {HTMLButtonElement} */ (button('', () => {
        const all = this.views();
        const i = all.findIndex((v) => v.id === this.viewId);
        this.mountView(all[(i + 1) % all.length].id);
      }));
      toggle.title = 'Switch between 2D and 3D';
      this.toggle = toggle;
      // before the "Open live" slot, which stays last
      bar.insertBefore(toggle, bar.querySelector('slot[name="live"]'));
    } else if (!many && this.toggle) {
      this.toggle.remove();
      this.toggle = null;
    }
    if (this.toggle) this.toggle.textContent = this.toggleLabel();
  }

  buildBar() {
    const bar = el('div', undefined, 'bar');
    this.bar = bar;
    bar.append(el('span', this.onto.name || '', 'name'));

    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Search';
    input.setAttribute('aria-label', 'Search the map');
    input.addEventListener('input', () => {
      const ids = searchNodes(this.onto, input.value);
      this.reveal(ids);
      if (this.view) this.view.highlight(ids);
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      const first = searchNodes(this.onto, input.value)[0];
      if (!first) return;
      this.reveal([first]);
      this.dispatch({ t: 'view.changed', at: 0, patch: { focus: first } });
      this.showDetails(first);
    });
    bar.append(input);

    bar.append(button('Fit', () => this.dispatch({ t: 'view.changed', at: 0, patch: { focus: this.onto.root } })));

    const live = document.createElement('slot');
    live.name = 'live';
    bar.append(live);
    this.syncToggle(); // labelled again by mountView, once a view is up
    return bar;
  }

  /**
   * Open the collapsed branches that hold any of these nodes, so a search match is drawn where it
   * is highlighted. Clearing the search leaves them open.
   * @param {string[]} ids
   */
  reveal(ids) {
    const patch = revealPatch(this.onto, ids);
    if (patch) this.dispatch({ t: 'view.changed', at: 0, patch });
  }

  /** Label for the toggle: the view it would switch to. */
  toggleLabel() {
    const all = this.views();
    const i = all.findIndex((v) => v.id === this.viewId);
    const next = all[(i + 1) % all.length];
    return next ? next.label : '';
  }

  /** @param {string|null} id */
  mountView(id) {
    const stage = this.stage;
    if (!stage) return;
    if (this.view) {
      try { this.view.unmount(); } catch { /* keep going */ }
    }
    this.view = null;
    this.viewId = null;
    stage.replaceChildren();
    const entry = id ? this.viewEntry(id) : null;
    if (!entry) {
      stage.append(el('div', 'No view is available.', 'msg'));
      return;
    }
    const v = /** @type {any} */ (document.createElement(entry.elementName));
    stage.append(v);
    const ctx = {
      snapshot: () => this.onto,
      subscribe: (/** @type {(e: object) => void} */ fn) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; },
      tokens,
      layout: this.layout,
      emit: (/** @type {'select'|'hover'|'focus'} */ name, /** @type {any} */ detail) => this.onViewEvent(name, detail),
    };
    this.publishInsets(); // the CSS variables are in place before the view reads them
    try {
      v.mount(stage, ctx);
    } catch (err) {
      // For example no WebGL for the 3D view: say so, and keep the toggle to go back.
      try { v.unmount(); } catch { /* it never fully mounted */ }
      stage.replaceChildren(el('div', `The ${entry.label} view could not start here: ${err instanceof Error ? err.message : String(err)}`, 'msg'));
      this.viewId = entry.id;
      this.syncToggle();
      return;
    }
    this.view = v;
    this.viewId = entry.id;
    this.syncToggle();
    applyViewState(v, viewStateToApply(this.onto.view));
  }

  /** @param {'select'|'hover'|'focus'} name @param {any} detail */
  onViewEvent(name, detail) {
    if (name === 'select') {
      if (detail && typeof detail.nodeId === 'string') this.showDetails(detail.nodeId);
      else this.hideDetails();
    } else if (name === 'focus') {
      if (detail && typeof detail.nodeId === 'string') this.dispatch({ t: 'view.changed', at: 0, patch: { focus: detail.nodeId } });
    }
  }

  /** The local stand-in for the server: fold, feed the layout, then tell the view. @param {any} e */
  dispatch(e) {
    this.onto = fold(this.onto, e);
    feedLayout(this.layout, e);
    const v = this.view;
    if (v) {
      v.apply(e);
      if (e.t === 'view.changed' && e.patch) {
        const st = viewStateToApply(this.onto.view);
        const p = e.patch;
        if ('focus' in p && st.focus && typeof v.setFocus === 'function') v.setFocus(st.focus);
        if ('filter' in p && typeof v.setFilter === 'function') v.setFilter(st.filter);
        if ('lens' in p && typeof v.setLens === 'function') v.setLens(st.lens);
      }
    }
    for (const fn of Array.from(this.listeners)) fn(e);
    if (this.openId) this.showDetails(this.openId);
  }

  hideDetails() {
    this.openId = null;
    if (this.panel) { this.panel.hidden = true; this.panel.replaceChildren(); }
    this.publishInsets();
  }

  /** @param {string} id */
  showDetails(id) {
    const d = nodeDetails(this.onto, id);
    const panel = this.panel;
    if (!d || !panel) { this.hideDetails(); return; }
    this.openId = id;
    panel.replaceChildren();
    panel.append(button('×', () => this.hideDetails()));
    /** @type {HTMLElement} */ (panel.lastChild).className = 'close';
    /** @type {HTMLElement} */ (panel.lastChild).setAttribute('aria-label', 'Close');
    panel.append(el('h2', d.label));
    if (d.category && d.category !== d.label) panel.append(el('div', d.category, 'muted'));
    if (d.summary) panel.append(el('p', d.summary));
    const a = d.article;
    if (a) {
      if (a.summary && a.summary !== d.summary) panel.append(el('p', a.summary));
      if (a.keyFacts.length) {
        panel.append(el('h3', 'Key facts'));
        const ul = el('ul');
        for (const f of a.keyFacts) ul.append(el('li', String(f)));
        panel.append(ul);
      }
      if (a.whyItMatters) {
        panel.append(el('h3', 'Why it matters'));
        panel.append(el('p', a.whyItMatters));
      }
    }
    if (d.sources.length) {
      panel.append(el('h3', 'Sources'));
      const ul = el('ul');
      for (const s of d.sources) {
        const li = el('li');
        if (s.href) {
          const link = document.createElement('a');
          link.href = s.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = s.title;
          li.append(link);
        } else {
          li.textContent = s.title;
        }
        ul.append(li);
      }
      panel.append(ul);
    }
    const actions = el('div', undefined, 'actions');
    if (d.childCount > 0) {
      actions.append(button(d.collapsed ? 'Expand' : 'Collapse', () => {
        this.dispatch({ t: 'view.changed', at: 0, patch: { collapsed: toggleCollapsed(this.onto.view.collapsed, id) } });
      }));
    }
    actions.append(button('Focus', () => this.dispatch({ t: 'view.changed', at: 0, patch: { focus: id } })));
    panel.append(actions);
    panel.hidden = false;
    this.publishInsets();
  }

  /** Tell the view where the panels are. */
  publishInsets() {
    const stage = this.stage;
    if (!stage) return;
    const bar = this.bar;
    const banner = this.banner;
    const bannerH = banner && !banner.classList.contains('empty') ? banner.offsetHeight : 0;
    const top = (bar ? bar.offsetHeight : 0) + MARGIN * 2 + bannerH;
    if (bar) bar.style.top = `${bannerH + MARGIN}px`;
    const panel = this.panel;
    if (panel) {
      // Beside the bar when there is room, below it when the element is too narrow for both, so
      // the details never cover the search box; its own scroll takes what does not fit.
      const below = !panel.hidden && bar !== null
        && panelBelowBar({ hostWidth: this.clientWidth, barWidth: bar.offsetWidth, panelWidth: panel.offsetWidth || 300, margin: MARGIN });
      panel.style.top = `${below ? top : bannerH + MARGIN}px`;
    }
    const right = panel && !panel.hidden ? (panel.offsetWidth || 300) + MARGIN * 2 : 0;
    const ins = { top, right, bottom: 0, left: 0 };
    for (const k of /** @type {const} */ (['top', 'right', 'bottom', 'left'])) stage.style.setProperty(`--onto-inset-${k}`, `${ins[k]}px`);
    stage.dispatchEvent(new CustomEvent('onto-insets', { detail: ins }));
  }
}

export function defineMapElement() {
  if (typeof customElements === 'undefined') return;
  if (customElements.get(TAG)) return;
  customElements.define(TAG, OntologizerMap);
}
