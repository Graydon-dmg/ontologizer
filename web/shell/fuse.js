// @ts-check
// "Fuse with…" logic (no DOM): the map list, the new map's name, and the submit flow.

/** @typedef {{ id: string, name: string, nodes: number, updatedAt?: number, draft?: boolean, current?: boolean }} MapRow */

/** Slug rule shared with the server's `into`/`name`: lowercase letters, digits, hyphens, at most 40. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Turn what the user typed into a slug-safe map name ('' when empty).
 * @param {string} input
 */
export function slugName(input) {
  return String(input ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

/**
 * The maps you can fuse with, filtered by the search text, in the server's order (saved maps,
 * then drafts, newest first). The server already leaves out this map; `current` is honoured too.
 * @param {MapRow[]} maps
 * @param {string} query
 * @param {{ currentName?: string }} [here]
 * @returns {MapRow[]}
 */
export function fuseCandidates(maps, query, here = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  const list = (Array.isArray(maps) ? maps : []).filter((m) => m && m.id && !m.current
    && !(m.current === undefined && here.currentName && m.name === here.currentName));
  return list.filter((m) => !q || String(m.name || m.id).toLowerCase().includes(q) || String(m.id).toLowerCase().includes(q));
}

/**
 * The fuse action, or null when nothing is selected or the name is not slug-safe.
 * @param {string|null|undefined} withId
 * @param {string} [into]  already slugged; '' means let the server pick
 * @returns {{ type: 'fuse', with: string, into?: string }|null}
 */
export function fuseAction(withId, into = '') {
  if (!withId) return null;
  if (into && !SLUG_RE.test(into)) return null;
  return into ? { type: 'fuse', with: withId, into } : { type: 'fuse', with: withId };
}

/**
 * Submit: open the new tab FIRST, synchronously (inside the click, so no popup blocker), then
 * post; on success point the tab at the new map, on failure close it and report.
 * @param {{ act: (a: any) => Promise<any>, openTab: () => any, notice?: (t: string) => void,
 *           waitForUrl?: (jobId: string) => Promise<string|null> }} deps
 * @param {{ withId: string|null, into?: string, withName?: string }} form
 * @returns {Promise<{ ok: boolean, error?: string, jobId?: string, url?: string }>}
 */
export function submitFuse(deps, form) {
  const action = fuseAction(form.withId, form.into);
  if (!action) return Promise.resolve({ ok: false, error: form.withId ? 'Use lowercase letters, digits and hyphens for the name.' : 'Pick a map to fuse with.' });
  const tab = deps.openTab();
  return Promise.resolve()
    .then(() => deps.act(action))
    .catch((err) => ({ ok: false, error: String(err && err.message || err) }))
    .then(async (r) => {
      // The server answers within 5 s; if the draft was not ready yet, the url comes on job.done.
      if (r && r.ok !== false && !r.url && r.jobId && deps.waitForUrl) {
        const url = await deps.waitForUrl(r.jobId);
        if (url) r = { ...r, url };
      }
      if (r && r.ok !== false && r.url) {
        if (tab) { try { tab.location.href = r.url; } catch { /* closed by the user */ } }
        if (deps.notice) deps.notice(`Fusing with ${form.withName || form.withId}…`);
        return { ok: true, jobId: r.jobId, url: r.url };
      }
      if (tab) { try { tab.close(); } catch { /* already closed */ } }
      const error = (r && r.ok !== false && !r.url) ? 'the server did not say where the new map is' : ((r && r.error) || 'the server refused');
      if (deps.notice) deps.notice(`Could not fuse: ${error}`);
      return { ok: false, error };
    });
}
