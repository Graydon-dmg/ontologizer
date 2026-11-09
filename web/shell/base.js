// @ts-check
// The page's base path, from <meta name="ontologizer-base">, which the server fills:
//   ""                          on the one-map server (ontologizer new / load)
//   "/v1/t/<tenant>/maps/<id>"  in service mode (ontologizer serve)
// Every call to the map's own /api/... routes goes through api(), so the page works under either.
// No DOM needed: in Node (tests) BASE is "".

/** @type {any} */
const meta = /** @type {any} */ (globalThis).document?.querySelector?.('meta[name="ontologizer-base"]');

/** @type {string} */
export const BASE = typeof meta?.content === 'string' ? meta.content : '';

/** api('/api/events?from=0') -> '<base>/api/events?from=0' @param {string} path */
export const api = (path) => `${BASE}${path}`;

/**
 * The tenant in a service-mode base, else null (the one-map server).
 * @param {string} base
 * @returns {string|null}
 */
export function tenantOf(base) {
  const m = /^\/v1\/t\/([a-z0-9][a-z0-9-]{0,62})\/maps\/[a-z0-9][a-z0-9-]*$/.exec(String(base ?? ''));
  return m ? m[1] : null;
}

/** The page's tenant in service mode, or null on the one-map server. */
export const TENANT = tenantOf(BASE);
