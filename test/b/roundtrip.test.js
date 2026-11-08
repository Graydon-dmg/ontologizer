// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../src/core/store.js';
import { foldAll } from '../../src/core/events.js';
import { startServer } from '../../src/server/index.js';
import { tempHome, fixtureEvents } from './helpers.js';

/** @param {string} url @param {any} body */
async function post(url, body) {
  const r = await fetch(new URL('api/action', url), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.status;
}

test('real store + server: build, collapse and focus via /api/action, save, read back folds the same', async () => {
  const home = tempHome();
  const store = openStore(home);
  const events = fixtureEvents('plastic-modeling');
  const id = store.createDraft(events[0].brief, 'plastic-modeling');
  for (const e of events) store.append(id, e);
  const engine = { enqueue: () => 'job-1' };
  const srv = await startServer({ store, engine, id });
  const cat = events.find((e) => e.t === 'category.added').category.id;
  const focus = events.filter((e) => e.t === 'node.added')[5].node.id;
  assert.equal(await post(srv.url, { type: 'collapse', nodeId: cat }), 202);
  assert.equal(await post(srv.url, { type: 'focus', nodeId: focus }), 202);
  await srv.close();
  store.save(id, 'plastic-modeling');

  const again = openStore(home);
  const back = again.read('plastic-modeling');
  assert.deepEqual(back.view.collapsed, [cat]);
  assert.equal(back.view.focus, focus);
  const stored = [];
  for await (const e of again.events('plastic-modeling')) stored.push(e);
  assert.deepEqual(back, foldAll(stored));
  // `at` stays monotonic, so a later replay never waits backwards or for hours.
  for (let i = 1; i < stored.length; i++) assert.ok(stored[i].at >= stored[i - 1].at, `at drops at ${i}`);
  assert.ok(stored[stored.length - 1].at - stored[0].at < 60_000);
  // Planted fault: a save that drops view.changed events loses the collapsed set and focus.
  const lossy = foldAll(stored.filter((e) => e.t !== 'view.changed'));
  assert.notDeepEqual(lossy.view, back.view);
});
