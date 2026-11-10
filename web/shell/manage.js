// @ts-check
// Manage maps (I5): rename, delete and the trash, as the maps home and the service-mode map page use
// them. Requests and texts only, no DOM (tested in Node). `fetch` is passed in; every request helper
// answers { ok, status, body?, error? } and never throws.

/** How long a deleted map can be restored (the server purges it after this). */
export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A draft's id ("draft-20261109-153012", "-2" on a clash): a draft is saved, a named map is renamed. */
export const DRAFT_RE = /^draft-\d{8}-\d{6}(?:-\d+)?$/;
/** @param {string} id */
export const isDraftId = (id) => DRAFT_RE.test(String(id));

/** A map name as the server takes it: lowercase letters, digits and hyphens, at most 63 characters. */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A suggested name for a map, from its display name ("Home Espresso!" -> "home-espresso"). @param {string} name */
export function slugName(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '');
}

/** What the rename box says for a map: a draft is saved under a name, a named map moves to a new one. @param {string} id */
export function renameTexts(id) {
  return isDraftId(id)
    ? { title: 'Save this map', label: 'Name', confirm: 'Save', hint: 'The name becomes its address. Lowercase letters, digits and hyphens.' }
    : { title: 'Rename this map', label: 'New name', confirm: 'Rename', hint: 'Its address changes: links to the old name stop working.' };
}

/** @param {string} name the map's name as shown */
export function deleteTexts(name) {
  return {
    title: 'Delete this map?',
    text: `Delete “${name}”? It moves to the trash, and can be restored for ${TRASH_DAYS} days.`,
    confirm: 'Delete',
  };
}

/** Whether a name can be sent (the server checks again). @param {string} name @returns {string} an error, or '' */
export function nameProblem(name) {
  if (!name) return 'Give it a name.';
  if (!NAME_RE.test(name)) return 'Use lowercase letters, digits and hyphens (at most 63 characters).';
  return '';
}

/**
 * What the caller's scopes allow (the server decides; this only hides buttons that would fail).
 * A draft is saved or deleted with build; a named map is renamed with build and deleted with admin.
 * @param {string[]} scopes @param {boolean} draft
 */
export function allowed(scopes, draft) {
  const has = (/** @type {string} */ s) => Array.isArray(scopes) && (scopes.includes(s) || (s === 'build' && scopes.includes('admin')));
  return { rename: has('build'), remove: draft ? has('build') : has('admin') };
}

/** "purged in 12 days" (or "purged today"). @param {number} purgeAt @param {number} [now] */
export function purgeText(purgeAt, now = Date.now()) {
  const days = Math.ceil((purgeAt - now) / DAY_MS);
  if (days <= 0) return 'purged today';
  return `purged in ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * @typedef {{ ok: boolean, status: number, body?: any, error?: string }} Res
 * @param {typeof fetch} fetchFn @param {string} path @param {{ method?: string, body?: any }} [init] @returns {Promise<Res>}
 */
export async function request(fetchFn, path, init = {}) {
  /** @type {RequestInit} */
  const opts = { method: init.method ?? 'GET', credentials: 'same-origin', cache: 'no-store' };
  if (init.body !== undefined) {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = JSON.stringify(init.body);
  }
  try {
    const r = await fetchFn(path, opts);
    /** @type {any} */
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    const ok = r.status >= 200 && r.status < 300 && body?.ok !== false;
    return ok ? { ok, status: r.status, body } : { ok: false, status: r.status, body, error: typeof body?.error === 'string' ? body.error : `Request failed (${r.status}).` };
  } catch (err) {
    return { ok: false, status: 0, error: 'Cannot reach the server. Is ontologizer still running?' };
  }
}

/** @param {string} tenant */
const root = (tenant) => `/v1/t/${encodeURIComponent(tenant)}`;
/** @param {string} tenant @param {string} id */
const mapPath = (tenant, id) => `${root(tenant)}/maps/${encodeURIComponent(id)}`;

/** Save a draft under a name, or rename a named map (the save route). @param {typeof fetch} f @param {string} tenant @param {string} id @param {string} name */
export const renameMap = (f, tenant, id, name) => request(f, `${mapPath(tenant, id)}/save`, { method: 'POST', body: { name } });
/** Move a map to the trash. @param {typeof fetch} f @param {string} tenant @param {string} id */
export const deleteMap = (f, tenant, id) => request(f, mapPath(tenant, id), { method: 'DELETE' });
/** The trash, as the caller may see it. @param {typeof fetch} f @param {string} tenant */
export const listTrash = (f, tenant) => request(f, `${root(tenant)}/trash`);
/** Bring a map back. @param {typeof fetch} f @param {string} tenant @param {string} trashId @param {string} [as] */
export const restoreMap = (f, tenant, trashId, as) =>
  request(f, `${root(tenant)}/trash/${encodeURIComponent(trashId)}/restore`, { method: 'POST', body: as ? { as } : {} });
/** Who is calling (scopes). @param {typeof fetch} f */
export const getSession = (f) => request(f, '/v1/session');

/** A failed request as a line for the dialog. @param {Res} r */
export function failText(r) {
  if (r.status === 401) return 'You are signed out: reload the page to sign in again.';
  if (r.status === 403 && /scope/.test(String(r.error))) return r.error ?? 'This token cannot do that.';
  return r.error || `Request failed (${r.status}).`;
}
