// @ts-check
// I5 · the page side of manage maps, without a DOM: the deleted-map banner ("This map was deleted.
// All maps ›"), the event source that stops for good on the stream's `deleted` event, and the
// request and text helpers the map page and the maps home share. Each check has a planted fault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connBanner, LOST_TEXT } from '../../web/shell/conn.js';
import { createSource } from '../../web/shell/source.js';
import { isDraftId, slugName, renameTexts, deleteTexts, nameProblem, allowed, purgeText, renameMap, deleteMap, listTrash, restoreMap, request, failText } from '../../web/shell/manage.js';

const VIEW = '/v1/t/default/maps/demo/view';
const flush = () => new Promise((r) => setTimeout(r, 20));

/** @param {typeof connBanner} banner @returns {string[]} */
function deletedBannerProblems(banner) {
  const p = [];
  const out = banner('deleted', VIEW);
  if (!out) return ['nothing shown for a deleted map'];
  if (`${out.text}${out.link?.text ?? ''}` !== 'This map was deleted. All maps ›') p.push(`says "${out.text}${out.link?.text ?? ''}"`);
  if (out.link?.href !== '/') p.push(`links to ${out.link?.href}`);
  if (out.delayMs !== 0) p.push('waits before showing');
  if (banner('lost', VIEW)?.text !== LOST_TEXT) p.push('the lost-connection banner changed');
  return p;
}

test('the deleted banner says so and links to the maps home', () => {
  assert.deepEqual(deletedBannerProblems(connBanner), []);
  // Planted fault: a banner that treats a deleted map as a lost connection.
  assert.ok(deletedBannerProblems((s, v) => connBanner(s === 'deleted' ? 'lost' : s, v)).length >= 2);
});

/** A fake EventSource that delivers a named `deleted` event, then the error a closed stream gives. */
function deletingES() {
  const made = { n: 0 };
  class ES {
    constructor() {
      made.n++;
      /** @type {Record<string, Function>} */ this.named = {};
      queueMicrotask(() => { this.onopen?.(); this.named.deleted?.({ data: '{"deleted":true}' }); this.onerror?.(); });
    }
    /** @param {string} name @param {Function} fn */
    addEventListener(name, fn) { this.named[name] = fn; }
    close() {}
  }
  return { made, ES };
}

/** The page stops for good: status deleted, no retry, no second stream. @param {any} src @param {any[]} timers @param {{ n: number }} made */
function stopProblems(src, timers, made) {
  const p = [];
  if (src.status() !== 'deleted') p.push(`status ${src.status()}`);
  if (timers.length) p.push('a reconnect was scheduled');
  if (made.n !== 1) p.push(`${made.n} streams were opened`);
  return p;
}

test('the stream\'s deleted event stops the page for good: no reconnect, the status stays deleted', async () => {
  const d = deletingES();
  /** @type {Array<() => void>} */ const timers = [];
  const src = createSource({ search: '', base: '/b', EventSource: d.ES, setTimeout: (fn) => { timers.push(fn); return 0; }, checkAccess: async () => true });
  await flush();
  assert.deepEqual(stopProblems(src, timers, d.made), []);
  /** @type {any} */ (src).reconnect(); // an expired explain request asks for a reconnect: a deleted map stays closed
  assert.deepEqual(stopProblems(src, timers, d.made), []);
  // Planted fault: an EventSource whose named events are never delivered (the page only sees the drop).
  const blind = deletingES();
  class Blind extends blind.ES { addEventListener() {} }
  /** @type {Array<() => void>} */ const t2 = [];
  const src2 = createSource({ search: '', base: '/b', EventSource: Blind, setTimeout: (fn) => { t2.push(fn); return 0; }, checkAccess: async () => true });
  await flush();
  assert.deepEqual(stopProblems(src2, t2, blind.made), ['status lost', 'a reconnect was scheduled']);
});

test('names, drafts and texts', () => {
  assert.equal(isDraftId('draft-20261109-153012'), true);
  assert.equal(isDraftId('draft-20261109-153012-2'), true);
  assert.equal(isDraftId('sourdough'), false);
  assert.equal(slugName('Home Espresso!'), 'home-espresso');
  assert.equal(slugName('x'.repeat(80)).length, 63);
  assert.equal(renameTexts('draft-20261109-153012').confirm, 'Save');
  assert.equal(renameTexts('sourdough').confirm, 'Rename');
  assert.equal(deleteTexts('Sourdough').text, 'Delete “Sourdough”? It moves to the trash, and can be restored for 30 days.');
  assert.equal(nameProblem('ok-name'), '');
  assert.match(nameProblem('Bad Name'), /lowercase/);
  assert.match(nameProblem(''), /name/);
  assert.deepEqual(allowed(['read'], true), { rename: false, remove: false });
  assert.deepEqual(allowed(['read', 'build'], true), { rename: true, remove: true });
  assert.deepEqual(allowed(['read', 'build'], false), { rename: true, remove: false });
  assert.deepEqual(allowed(['admin'], false), { rename: true, remove: true });
  const now = Date.UTC(2026, 10, 9);
  assert.equal(purgeText(now + 12 * 86400000, now), 'purged in 12 days');
  assert.equal(purgeText(now + 3600000, now), 'purged in 1 day');
  assert.equal(purgeText(now - 1, now), 'purged today');
});

test('the requests: the save route renames, DELETE trashes, the trash routes; errors never throw', async () => {
  /** @type {Array<{ url: string, method: string, body: any }>} */ const seen = [];
  const f = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ o) => { seen.push({ url, method: o.method, body: o.body ? JSON.parse(o.body) : null }); return { status: 200, json: async () => ({ ok: true }) }; });
  await renameMap(f, 'default', 'draft-20261109-153012', 'glue');
  await deleteMap(f, 'default', 'glue');
  await listTrash(f, 'default');
  await restoreMap(f, 'default', 'glue--20261109-153012z', 'glue-2');
  await restoreMap(f, 'default', 'glue--20261109-153012z');
  assert.deepEqual(seen, [
    { url: '/v1/t/default/maps/draft-20261109-153012/save', method: 'POST', body: { name: 'glue' } },
    { url: '/v1/t/default/maps/glue', method: 'DELETE', body: null },
    { url: '/v1/t/default/trash', method: 'GET', body: null },
    { url: '/v1/t/default/trash/glue--20261109-153012z/restore', method: 'POST', body: { as: 'glue-2' } },
    { url: '/v1/t/default/trash/glue--20261109-153012z/restore', method: 'POST', body: {} },
  ]);
  const busy = await request(/** @type {any} */ (async () => ({ status: 409, json: async () => ({ ok: false, error: 'The map is busy: try again when it is idle.' }) })), '/x');
  assert.deepEqual([busy.ok, failText(busy)], [false, 'The map is busy: try again when it is idle.']);
  const down = await request(/** @type {any} */ (async () => { throw new Error('ECONNREFUSED'); }), '/x');
  assert.equal(down.status, 0);
  assert.match(failText(down), /Cannot reach the server/);
  assert.match(failText({ ok: false, status: 401 }), /signed out/);
});
