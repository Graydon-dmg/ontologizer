// @ts-check
// Filter control logic (no DOM).

/**
 * @param {string[]} checkedIds  categories ticked
 * @param {string[]} allIds      every category
 * @param {string} depth         '' for any, else a number
 * @returns {{ categories: string[]|null, maxDepth: number|null }}
 */
export function filterValue(checkedIds, allIds, depth) {
  const categories = checkedIds.length === allIds.length ? null : checkedIds.slice();
  const n = Number(depth);
  return { categories, maxDepth: depth !== '' && Number.isFinite(n) ? n : null };
}

/**
 * Apply a filter to the view now and record it on the server (view.changed), so it persists:
 * views re-read the filter from the snapshot.
 * @param {{ activeView: () => any, act: (a: any) => any }} shell
 * @param {{ categories: string[]|null, maxDepth: number|null }} value
 */
export function sendFilter(shell, value) {
  const v = shell.activeView();
  if (v && typeof v.setFilter === 'function') v.setFilter(value);
  return shell.act({ type: 'filter', value });
}
