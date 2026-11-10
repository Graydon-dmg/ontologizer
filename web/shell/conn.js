// @ts-check
// What the connection banner says (no DOM). Two different troubles, two different messages:
// the server cannot be reached (it retries), or, in service mode, the page lost access (a revoked
// token or an ended session: it stops and offers sign-in).

export const LOST_TEXT = 'Lost the connection to ontologizer. Is it still running? Retrying…';
export const SIGNED_OUT_TEXT = "You're signed out: ";
export const SIGN_IN_LINK = 'sign in again';
export const DELETED_TEXT = 'This map was deleted. ';
export const ALL_MAPS_LINK = 'All maps ›';

/**
 * @param {string} status the source's status: 'connecting' | 'live' | 'lost' | 'signed-out' | 'deleted'
 * @param {string} path this page's path (for the sign-in link's ?next=)
 * @returns {null | { text: string, link?: { text: string, href: string }, delayMs: number }}
 */
export function connBanner(status, path) {
  if (status === 'signed-out') {
    return { text: SIGNED_OUT_TEXT, link: { text: SIGN_IN_LINK, href: `/?next=${encodeURIComponent(path)}` }, delayMs: 0 };
  }
  // Service mode: the map went to the trash while this page was open (its stream ended with `deleted`).
  if (status === 'deleted') return { text: DELETED_TEXT, link: { text: ALL_MAPS_LINK, href: '/' }, delayMs: 0 };
  if (status === 'lost') return { text: LOST_TEXT, delayMs: 1500 };
  return null;
}

/**
 * Service mode's access check after a dropped stream: false only on a 401 (signed out); a network
 * error or any other status is a connection problem, not a sign-out.
 * @param {typeof fetch} fetchFn @param {string} url the map's snapshot URL
 */
export async function stillSignedIn(fetchFn, url) {
  try {
    const r = await fetchFn(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' });
    return r.status !== 401;
  } catch {
    return true;
  }
}
