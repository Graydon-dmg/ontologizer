// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { fuseCandidates, fuseAction, slugName, submitFuse } from '../../web/shell/fuse.js';

const MAPS = [
  { id: 'plastic-modeling', name: 'plastic-modeling', nodes: 91, updatedAt: 3, draft: false, current: true },
  { id: 'manga', name: 'manga', nodes: 38, updatedAt: 5, draft: false },
  { id: 'draft-20261108-1203', name: 'draft-20261108-1203', nodes: 12, updatedAt: 9, draft: true },
  { id: 'espresso', name: 'espresso', nodes: 72, updatedAt: 1, draft: false },
];

/** @param {typeof fuseCandidates} list */
function checkList(list) {
  const rows = list(MAPS, '', {});
  assert.deepEqual(rows.map((m) => m.id), ['manga', 'draft-20261108-1203', 'espresso'], 'all but this map, in the server order');
  assert.equal(rows[1].draft, true);
  assert.deepEqual(list(MAPS, 'ESP', {}).map((m) => m.id), ['espresso']);
  assert.deepEqual(list([], '', {}), []);
}

test('the list renders from /api/maps: every other map, searchable, newest first', () => {
  checkList(fuseCandidates);
  // Without a `current` flag the shell falls back to the map's name.
  assert.deepEqual(fuseCandidates([{ id: 'a', name: 'A', nodes: 1 }, { id: 'b', name: 'B', nodes: 1 }], '', { currentName: 'A' }).map((m) => m.id), ['b']);
});

test('planted fault: a list that includes the current map is caught', () => {
  assert.throws(() => checkList((maps, q) => maps.filter((m) => !q || m.name.includes(q.toLowerCase()))));
});

/** @param {typeof submitFuse} submit */
async function checkSubmit(submit) {
  /** @type {string[]} */ const order = [];
  /** @type {any[]} */ const acts = [];
  const tab = { location: { href: 'about:blank' }, closed: false, close() { this.closed = true; } };
  const deps = {
    openTab: () => { order.push('open'); return tab; },
    act: async (/** @type {any} */ a) => { order.push('post'); acts.push(a); return { ok: true, jobId: 'fuse-1', draftId: 'draft-x', url: 'http://127.0.0.1:5555/' }; },
  };
  // Empty selection: no tab, no post.
  const none = await submit(deps, { withId: null });
  assert.equal(none.ok, false);
  assert.deepEqual(acts, []);
  assert.deepEqual(order, []);
  // A real submit: the tab opens before the POST (popup blockers), the body is exact.
  const r = await submit(deps, { withId: 'manga', into: slugName('Gunpla Workshop!'), withName: 'manga' });
  assert.equal(r.ok, true);
  assert.deepEqual(order, ['open', 'post']);
  assert.deepEqual(acts, [{ type: 'fuse', with: 'manga', into: 'gunpla-workshop' }]);
  assert.equal(tab.location.href, 'http://127.0.0.1:5555/');
}

test('submit opens the tab first, posts { type: fuse, with, into } and sends the tab to the new map; empty selection posts nothing', async () => {
  await checkSubmit(submitFuse);
});

test('planted fault: a submit that posts even with nothing selected is caught', async () => {
  const sloppy = /** @type {typeof submitFuse} */ (async (deps, form) => { deps.openTab(); await deps.act({ type: 'fuse', with: form.withId }); return submitFuse(deps, form); });
  await assert.rejects(() => checkSubmit(sloppy));
});

test('planted fault: a submit that opens the tab only after the POST answers (popup-blocked) is caught', async () => {
  const late = /** @type {typeof submitFuse} */ (async (deps, form) => {
    if (!form.withId) return { ok: false };
    const r = await deps.act(fuseAction(form.withId, form.into));
    const tab = deps.openTab(); tab.location.href = r.url; return { ok: true };
  });
  await assert.rejects(() => checkSubmit(late));
});

test('an error closes the tab and reports it; a bad name posts nothing', async () => {
  const tab = { location: { href: '' }, closed: false, close() { this.closed = true; } };
  /** @type {string[]} */ const notices = [];
  const r = await submitFuse({ openTab: () => tab, act: async () => ({ ok: false, error: 'fuse takes two maps' }), notice: (t) => notices.push(t) }, { withId: 'manga' });
  assert.deepEqual([r.ok, r.error, tab.closed], [false, 'fuse takes two maps', true]);
  assert.match(notices[0], /Could not fuse: fuse takes two maps/);
  assert.equal(fuseAction('manga', 'Bad Name'), null);
  assert.equal(slugName('  Café Mélange  '), 'cafe-melange');
  assert.equal(slugName(''), '');
});

test('a 202 without a url waits for job.done to carry it', async () => {
  const tab = { location: { href: 'about:blank' }, close() {} };
  const r = await submitFuse({ openTab: () => tab, act: async () => ({ ok: true, jobId: 'fuse-2' }),
    waitForUrl: async (id) => (id === 'fuse-2' ? 'http://127.0.0.1:6000/' : null) }, { withId: 'manga' });
  assert.equal(r.ok, true);
  assert.equal(tab.location.href, 'http://127.0.0.1:6000/');
});
