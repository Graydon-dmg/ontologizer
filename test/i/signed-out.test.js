// @ts-check
// Service mode: when the page loses access (a 401), the banner says "You're signed out: sign in
// again" and the page stops retrying; a real connection loss keeps today's banner and retries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connBanner, stillSignedIn, LOST_TEXT } from '../../web/shell/conn.js';
import { createSource } from '../../web/shell/source.js';

const VIEW = '/v1/t/default/maps/demo/view';

/** @param {typeof connBanner} banner @returns {string[]} */
function bannerProblems(banner) {
  const problems = [];
  const out = banner('signed-out', VIEW);
  if (!out) problems.push('nothing shown when signed out');
  else {
    if (out.text.includes('Is it still running')) problems.push('the connection message is shown on a 401');
    if (!/signed out/.test(out.text)) problems.push('does not say signed out');
    if (out.link?.href !== `/?next=${encodeURIComponent(VIEW)}`) problems.push(`link ${out.link?.href}`);
    if (out.link?.text !== 'sign in again') problems.push('no "sign in again" link');
  }
  if (banner('lost', VIEW)?.text !== LOST_TEXT) problems.push('a real connection loss lost its message');
  if (banner('live', VIEW) !== null) problems.push('a banner while live');
  return problems;
}

test('the banner: signed out offers sign-in back to this page; a lost connection keeps its message', () => {
  assert.deepEqual(bannerProblems(connBanner), []);
  // Planted fault: a banner that shows the connection message on a 401.
  /** @type {typeof connBanner} */
  const oldBanner = (s) => (s === 'lost' || s === 'signed-out' ? { text: LOST_TEXT, delayMs: 1500 } : null);
  assert.ok(bannerProblems(oldBanner).includes('the connection message is shown on a 401'));
});

test('stillSignedIn: only a 401 means signed out', async () => {
  const f = (/** @type {number|null} */ status) => /** @type {any} */ (async () => { if (status === null) throw new Error('down'); return { status }; });
  assert.equal(await stillSignedIn(f(401), VIEW), false);
  for (const s of [200, 403, 404, 500, null]) assert.equal(await stillSignedIn(f(s), VIEW), true, String(s));
});

/** A fake EventSource that fails as soon as it opens; counts how many were made. */
function failingES() {
  const made = { n: 0 };
  class ES { constructor() { made.n++; queueMicrotask(() => this.onerror?.()); } close() {} }
  return { made, ES };
}
const flush = () => new Promise((r) => setTimeout(r, 20));

test('service mode: a dropped stream that is signed out stops retrying; one still signed in retries', async () => {
  const out = failingES();
  /** @type {Array<() => void>} */
  const timers = [];
  const src = createSource({ search: '', base: '/b', EventSource: out.ES, setTimeout: (fn) => { timers.push(fn); return 0; }, checkAccess: async () => false });
  await flush();
  assert.equal(src.status(), 'signed-out');
  assert.equal(timers.length, 0, 'no retry is scheduled');
  assert.equal(out.made.n, 1);

  const ok = failingES();
  /** @type {Array<() => void>} */
  const t2 = [];
  const src2 = createSource({ search: '', base: '/b', EventSource: ok.ES, setTimeout: (fn) => { t2.push(fn); return 0; }, checkAccess: async () => true });
  await flush();
  assert.equal(src2.status(), 'lost');
  assert.equal(t2.length, 1, 'a retry is scheduled');
});

test('service mode: an action answered 401 signs the page out; the one-map source (no checkAccess) never does', async () => {
  const quiet = class { close() {} };
  const fetch401 = /** @type {any} */ (async () => ({ status: 401, ok: false, json: async () => ({ ok: false, error: 'Sign in with a token.' }) }));
  const svc = createSource({ search: '', base: '/b', EventSource: quiet, fetch: fetch401, setTimeout: () => 0, checkAccess: async () => true });
  await svc.act({ type: 'focus', nodeId: 'x' });
  assert.equal(svc.status(), 'signed-out');

  const one = createSource({ search: '', base: '', EventSource: quiet, fetch: fetch401, setTimeout: () => 0 });
  await one.act({ type: 'focus', nodeId: 'x' });
  assert.equal(one.status(), 'connecting');
  /** @type {any} */ (one).signOut();
  assert.equal(one.status(), 'connecting', 'the one-map page has no sign-in');

  // The one-map source retries a dropped stream exactly as before, without asking anything.
  const drop = failingES();
  /** @type {Array<() => void>} */
  const t3 = [];
  const src = createSource({ search: '', base: '', EventSource: drop.ES, setTimeout: (fn) => { t3.push(fn); return 0; } });
  await flush();
  assert.equal(src.status(), 'lost');
  assert.equal(t3.length, 1);
});
