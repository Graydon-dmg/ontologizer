// @ts-check
// Pure view-state helpers (no DOM).

/**
 * @param {{ focus?: string, filter?: { categories?: string[]|null, maxDepth?: number|null }, lens?: string|null }} view
 */
export function viewStateToApply(view) {
  const f = (view && view.filter) || {};
  return {
    focus: view?.focus,
    filter: {
      categories: Array.isArray(f.categories) ? [...f.categories] : (f.categories ?? null),
      maxDepth: f.maxDepth ?? null,
    },
    lens: view?.lens ?? null,
  };
}

/**
 * @param {any} viewEl
 * @param {{ focus?: string, filter: object, lens: string|null }} state
 */
export function applyViewState(viewEl, state) {
  if (!viewEl || !state) return;
  if (state.focus && typeof viewEl.setFocus === 'function') viewEl.setFocus(state.focus);
  if (typeof viewEl.setFilter === 'function') viewEl.setFilter(state.filter);
  if (typeof viewEl.setLens === 'function') viewEl.setLens(state.lens);
}
