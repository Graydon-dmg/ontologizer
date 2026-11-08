// @ts-check
// The actions the shell sends. These are Epic B's /api/action types, exactly.

/** View actions: they only change the view state (answered with a view.changed event). */
export const VIEW_ACTIONS = ['expand', 'collapse', 'focus', 'layout', 'lens', 'filter'];
/** Job actions: they queue engine work (answered with job.* events). */
export const JOB_ACTIONS = ['research', 'explain', 'sources'];
export const ACTION_TYPES = [...VIEW_ACTIONS, ...JOB_ACTIONS];
export const RESEARCH_MODES = ['context', 'general'];

/**
 * True when Epic B's server would accept this action.
 * @param {any} a
 * @returns {boolean}
 */
export function isValidAction(a) {
  if (!a || typeof a !== 'object' || !ACTION_TYPES.includes(a.type)) return false;
  switch (a.type) {
    case 'expand': case 'collapse': case 'focus': case 'explain': case 'sources':
      return typeof a.nodeId === 'string' && a.nodeId.length > 0;
    case 'research':
      return typeof a.nodeId === 'string' && a.nodeId.length > 0 && RESEARCH_MODES.includes(a.mode);
    case 'layout':
      return typeof a.value === 'string';
    case 'lens':
      return a.value === null || typeof a.value === 'string';
    case 'filter':
      return !!a.value && typeof a.value === 'object';
    default:
      return false;
  }
}

/**
 * The view.changed patch a view action produces (what the server would write).
 * Returns null for job actions and unknown types.
 * @param {any} a
 * @param {import('../../src/core/schema.js').Ontology} o
 * @returns {Record<string, any>|null}
 */
export function viewPatchFor(a, o) {
  const collapsed = o.view.collapsed || [];
  switch (a && a.type) {
    case 'expand':
      return { collapsed: collapsed.filter((id) => id !== a.nodeId) };
    case 'collapse':
      return { collapsed: collapsed.includes(a.nodeId) ? collapsed.slice() : [...collapsed, a.nodeId] };
    case 'focus':
      return { focus: a.nodeId };
    case 'layout':
      return { layout: a.value };
    case 'lens':
      return { lens: a.value || null };
    case 'filter': {
      /** @type {Record<string, any>} */
      const filter = {};
      if (a.value && 'categories' in a.value) filter.categories = a.value.categories;
      if (a.value && 'maxDepth' in a.value) filter.maxDepth = a.value.maxDepth;
      return { filter };
    }
    default:
      return null;
  }
}
