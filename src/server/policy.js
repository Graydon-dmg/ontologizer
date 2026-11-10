// @ts-check
// The default policy port: I1's scope ladder plus the read rule for private maps.
// A config's `policy.can(principal, action, { tenant, mapId, map })` replaces it. The tenant rule is
// the router's and no policy can widen it: a principal reaches only its own tenant.
import { hasScope } from './tokens.js';

/** @typedef {'read'|'build'|'ask'|'job'|'save'|'export'|'admin'|'delete'|'restore'} Action */
// 'admin' is asked for status's admin-only fields. 'export' is reserved and never asked: the server has
// no export route (exports are made in the page or the CLI from a map already read, so read allows them).
// 'delete' and 'restore' (I5) are asked with `draft` in the context once the map is known.
/** @typedef {{ actor: { id: string, kind: string, via?: string }, tenant: string, scopes: string[], sources: string[] }} Principal */

export const ACTIONS = /** @type {const} */ (['read', 'build', 'ask', 'job', 'save', 'export', 'admin', 'delete', 'restore']);

/**
 * The scope each action needs on the I1 ladder (read < ask < build < admin). `delete` and `restore`
 * (I5) need build for a draft and admin for a named map: the router passes `draft` in the context
 * once it knows the map (before that, the route's first check, only the lower bound applies).
 * @type {Record<Action, string>}
 */
export const ACTION_SCOPE = { read: 'read', export: 'read', ask: 'ask', build: 'build', job: 'build', save: 'build', admin: 'admin', delete: 'build', restore: 'build' };

/** The scope a delete or restore needs: build for a draft, admin for a named map. @param {boolean} draft */
export const removeScope = (draft) => (draft ? 'build' : 'admin');

/**
 * Whether a principal may read a map: always for a public map; for a private map only if it holds
 * every private source the map used, or is admin. A private map with no named source: admin only.
 * @param {Principal} principal @param {any} map a folded ontology, an index row's { visibility, privateSources }, or null
 */
export function canRead(principal, map) {
  if (!map || map.visibility !== 'private') return true;
  if (hasScope(principal.scopes, 'admin')) return true;
  const names = Array.isArray(map.privateSources) ? map.privateSources : [];
  // A private map that names no source (a fused or damaged one) cannot be checked by sources: admin only.
  if (!names.length) return false;
  const held = new Set(Array.isArray(principal.sources) ? principal.sources : []);
  return names.every((name) => held.has(name));
}

export const defaultPolicy = {
  name: 'default',
  /**
   * @param {Principal} principal @param {Action} action
   * @param {{ tenant: string, mapId?: string|null, map?: any, draft?: boolean }} ctx
   *   draft (delete and restore only): whether the map is a draft; a named map needs admin.
   * @returns {boolean}
   */
  can(principal, action, ctx) {
    const scope = ACTION_SCOPE[action];
    if (!scope || !hasScope(principal.scopes, scope)) return false;
    if ((action === 'delete' || action === 'restore') && ctx?.draft === false && !hasScope(principal.scopes, removeScope(false))) return false;
    return canRead(principal, ctx?.map ?? null);
  },
};

/**
 * The action a map route needs (the table in the contract).
 * @param {string} sub the path after /maps/:id/ ("snapshot", "actions", "api/chat", ...)
 * @returns {Action}
 */
export function actionFor(sub) {
  if (sub === 'actions' || sub === 'api/action') return 'job';
  if (sub === 'chat' || sub === 'api/chat') return 'ask';
  if (sub === 'save') return 'save';
  if (sub === 'export' || sub === 'context') return 'export'; // I3: the map in another format (read scope by default)
  return 'read';
}
