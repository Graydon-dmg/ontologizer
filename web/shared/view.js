// @ts-check
// A view is a custom element. The shell owns all interaction chrome (menus, panels, search,
// filters, jobs tray, ticker, legend, view switcher). A view only draws, hit-tests and emits.
//
// The layout is fed by the page, never by a view. The shell (and the dev harness) creates ONE
// layout per page. For every event it first updates the layout, then calls view.apply(event):
//   node.added -> layout.add(node)      edge.added -> layout.addEdge(edge)
//   view.changed with collapsed -> layout.setCollapsed(ids); with focus -> layout.setFocus(id)
// The layout survives view switches. A newly mounted view draws every node already in
// ctx.snapshot() at ctx.layout.positions(), then follows layout ticks. Views only READ the layout.
/** @typedef {{
 *   snapshot: () => import('../../src/core/schema.js').Ontology,
 *   subscribe: (fn: (e: object) => void) => () => void,
 *   tokens: typeof import('./tokens.js'),
 *   layout: ReturnType<typeof import('./layout/graph.js').createGraphLayout>,
 *   emit: (name: 'select'|'hover'|'focus', detail: { nodeId: string|null, x?: number, y?: number }) => void
 * }} ViewContext */
// Every view element implements:
//   mount(el: HTMLElement, ctx: ViewContext): void
//   apply(event): void                 incremental update; never a full redraw per event
//   setFocus(nodeId: string): void
//   setLens(lensId: string|null): void
//   setFilter(filter: { categories: string[]|null, maxDepth: number|null }): void
//   highlight(nodeIds: string[]): void  [] clears
//   cite?(nodeIds: string[] | null): void  optional (1.2.0, chat citations). Emphasise exactly these
//                                      nodes plus the links between them, always show their labels,
//                                      dim the rest; null clears. It survives incoming events and
//                                      coexists with highlight() (cite wins visually on its nodes).
//                                      The shell skips views that do not implement it.
//   setHeight?(mode: 'off'|'learning'|'coverage'|'connectedness'): void  optional (1.8.0, 3D view).
//                                      Lift nodes by one measure; 'off' is the flat floor. The shell
//                                      shows its Height control only for views that implement it.
//   mountMinimap?(el: HTMLElement): void  optional
//   unmount(): void

/** @typedef {{ id: string, label: string, elementName: string }} ViewEntry */

/** @type {ViewEntry[]} */
const views = [];

/**
 * Register a view; re-registering an id replaces it in place.
 * @param {string} id
 * @param {string} label
 * @param {string} elementName
 */
export function registerView(id, label, elementName) {
  const entry = { id, label, elementName };
  const i = views.findIndex((v) => v.id === id);
  if (i >= 0) views[i] = entry;
  else views.push(entry);
}

/** @returns {ViewEntry[]} copy, in registration order */
export function listViews() {
  return views.map((v) => ({ ...v }));
}

/**
 * @param {string} id
 * @returns {ViewEntry|null}
 */
export function getView(id) {
  const v = views.find((x) => x.id === id);
  return v ? { ...v } : null;
}
