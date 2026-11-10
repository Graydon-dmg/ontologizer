// @ts-check
// The 3D view's Height control (no DOM): its options, the remembered choice, and the legend line.

export const HEIGHT_KEY = 'ontologizer.height';

/** Menu order. `key` is the legend line shown while that mode is on. */
export const HEIGHT_OPTIONS = /** @type {const} */ ([
  { value: 'off', label: 'Off', key: '' },
  { value: 'learning', label: 'Learning order', key: 'learning order (higher = needs more first)' },
  { value: 'coverage', label: 'Coverage', key: 'coverage (higher = better researched)' },
  { value: 'connectedness', label: 'Connectedness', key: 'connectedness (higher = more links)' },
]);

/** @param {any} v @returns {'off'|'learning'|'coverage'|'connectedness'} */
export function normalizeHeight(v) {
  const o = HEIGHT_OPTIONS.find((x) => x.value === v);
  return o ? o.value : 'off';
}

/** @param {{ getItem: (k: string) => string|null }|null|undefined} storage */
export function loadHeight(storage) {
  try { return normalizeHeight(storage ? storage.getItem(HEIGHT_KEY) : null); } catch { return 'off'; }
}

/** @param {{ setItem: (k: string, v: string) => void }|null|undefined} storage @param {string} mode */
export function saveHeight(storage, mode) {
  try { if (storage) storage.setItem(HEIGHT_KEY, normalizeHeight(mode)); } catch { /* private mode */ }
}

/**
 * The legend's one-line key: "Height: …" while a mode is on in a view that draws height, else ''.
 * @param {string} mode @param {boolean} viewHasHeight
 */
export function heightLegendLine(mode, viewHasHeight) {
  if (!viewHasHeight) return '';
  const o = HEIGHT_OPTIONS.find((x) => x.value === normalizeHeight(mode));
  return o && o.key ? `Height: ${o.key}` : '';
}

/** Whether a mounted view draws height (it implements the optional setHeight). @param {any} view */
export function hasHeight(view) {
  return !!view && typeof view.setHeight === 'function';
}
