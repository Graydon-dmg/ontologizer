// @ts-check
// The views every embed bundle on a page can use. A 2D export and a 3D export pasted into the same
// page each carry their own bundle, and only one of them defines <ontologizer-map>; the views live
// here, on one page-wide key, so the 3D bundle can add its view to the element the 2D one defined.
// Each export says which views it was made with (data-views, stamped by its bundle, see
// scripts/build-embed.js), so a 2D export never gets a 3D toggle it did not ask for.

/** @typedef {{ id: string, label: string, elementName: string }} ViewEntry */

/** One key for the whole page, the same in every bundle. */
export const REGISTRY_KEY = Symbol.for('ontologizer.embed.views');
/** Sent on document when a bundle adds views, so an element already drawn can offer them. */
export const VIEWS_EVENT = 'ontologizer-views';

/** @returns {Map<string, ViewEntry>} */
function store() {
  const g = /** @type {any} */ (globalThis);
  if (!(g[REGISTRY_KEY] instanceof Map)) {
    Object.defineProperty(globalThis, REGISTRY_KEY, { value: new Map(), configurable: false, enumerable: false, writable: false });
  }
  return g[REGISTRY_KEY];
}

/** Add views (from a bundle's own registry); an id already there keeps its place. @param {ViewEntry[]} entries */
export function addViews(entries) {
  const views = store();
  for (const e of entries) views.set(e.id, { id: e.id, label: e.label, elementName: e.elementName });
  if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    document.dispatchEvent(new CustomEvent(VIEWS_EVENT));
  }
}

/** @returns {ViewEntry[]} copies, in the order they were first added */
export function pageViews() {
  return [...store().values()].map((v) => ({ ...v }));
}

/**
 * The views one export may use: those its data-views attribute names, in page order. No attribute
 * (an older export, or a host that moved the script) means every view on the page; so does a list
 * naming none that are here, so a map is never left with nothing to draw.
 * @param {string|null|undefined} attr  space-separated view ids
 * @param {ViewEntry[]} all
 * @returns {ViewEntry[]}
 */
export function viewsFor(attr, all) {
  if (typeof attr !== 'string' || !attr.trim()) return all;
  const want = new Set(attr.trim().split(/\s+/));
  const some = all.filter((v) => want.has(v.id));
  return some.length ? some : all;
}
