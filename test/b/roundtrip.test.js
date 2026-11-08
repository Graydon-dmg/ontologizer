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

test('replay: view actions reach the live stream but never the store; jobs still enqueue', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const home = tempHome();
  const store = openStore(home);
  store.importEvents('demo', fixtureEvents('plastic-modeling'));
  const file = path.join(home, 'demo', 'events.jsonl');
  const before = fs.readFileSync(file);
  const jobs = [];
  const engine = { enqueue: (/** @type {any} */ j) => { jobs.push(j); return 'job-1'; } };
  const cat = fixtureEvents('plastic-modeling').find((e) => e.t === 'category.added').category.id;

  /** Open SSE and collect view.changed events. @param {string} url */
  const watch = async (url) => {
    const seen = [];
    const ctl = new AbortController();
    const r = await fetch(new URL('api/events?from=0', url), { signal: ctl.signal });
    const reader = r.body.getReader();
    (async () => {
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += Buffer.from(value).toString();
          const parts = buf.split('\n\n'); buf = parts.pop() ?? '';
          for (const p of parts) if (p.startsWith('data: ')) { const e = JSON.parse(p.slice(6)); if (e.t === 'view.changed') seen.push(e); }
        }
      } catch { /* aborted */ }
    })();
    return { seen, stop: () => ctl.abort() };
  };

  const srv = await startServer({ store, engine, id: 'demo', replay: { speed: 1000 } });
  const w = await watch(srv.url);
  assert.equal(await post(srv.url, { type: 'filter', value: { maxDepth: 1 } }), 202);
  assert.equal(await post(srv.url, { type: 'collapse', nodeId: cat }), 202);
  assert.equal(await post(srv.url, { type: 'expand', nodeId: cat }), 202);
  assert.equal(await post(srv.url, { type: 'explain', nodeId: cat }), 202);
  await new Promise((r) => setTimeout(r, 300));
  w.stop();
  await srv.close();
  store.flush('demo');
  assert.ok(fs.readFileSync(file).equals(before), 'replay changed events.jsonl');
  assert.deepEqual(w.seen.map((e) => e.patch), [{ filter: { maxDepth: 1 } }, { collapsed: [cat] }, { collapsed: [] }]);
  assert.equal(jobs.length, 1);

  // Planted fault: the same view action on a plain (non-replay) session is persisted.
  const plain = await startServer({ store, engine, id: 'demo' });
  assert.equal(await post(plain.url, { type: 'filter', value: { maxDepth: 1 } }), 202);
  await plain.close();
  assert.ok(!fs.readFileSync(file).equals(before), 'plain load should persist view actions');
});

test('rosetta action: validation, 202 with lensId, dedupe, job events, errors surface as job.failed', async () => {
  const home = tempHome();
  const store = openStore(home);
  store.importEvents('plastic-modeling', fixtureEvents('plastic-modeling'));
  const calls = [];
  let fail = null;
  /** @type {(() => void) | null} */
  let release = null;
  const engine = {
    enqueue: () => 'j',
    /** @param {string} id @param {string} persona @param {any} opts */
    rosetta: async (id, persona, opts) => {
      calls.push([id, persona, opts]);
      if (fail) throw fail;
      const lensId = opts.name ?? 'chef';
      store.append(id, { t: 'lens.added', at: store.now(id), lens: { id: lensId, persona, analogs: {} } });
      await new Promise((r) => { release = () => r(undefined); });
      return lensId;
    },
  };
  const srv = await startServer({ store, engine, id: 'plastic-modeling', replay: { speed: 1 } }); // allowed in replay too
  /** @param {any} body */
  const act = async (body) => {
    const r = await fetch(new URL('api/action', srv.url), { method: 'POST', body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  for (const bad of [{}, { persona: '' }, { persona: '   ' }, { persona: 7 }, { persona: 'x'.repeat(121) },
    { persona: 'a chef', name: 'Bad Name' }, { persona: 'a chef', name: 'a'.repeat(41) }, { persona: 'a chef', name: '../x' }]) {
    assert.equal((await act({ type: 'rosetta', ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal(calls.length, 0);

  const first = await act({ type: 'rosetta', persona: '  a home chef ', name: 'chef' });
  assert.equal(first.status, 202);
  assert.deepEqual(first.body, { ok: true, jobId: first.body.jobId, lensId: 'chef' });
  assert.deepEqual(calls, [['plastic-modeling', 'a home chef', { name: 'chef' }]]);
  // Same persona while running: reuses the run, no second engine call.
  const again = await act({ type: 'rosetta', persona: 'A HOME CHEF' });
  assert.equal(again.status, 202);
  assert.equal(again.body.jobId, first.body.jobId);
  assert.equal(calls.length, 1);
  release?.();
  await new Promise((r) => setTimeout(r, 50));
  const jobs = store.read('plastic-modeling').jobs;
  assert.equal(jobs[first.body.jobId].state, 'done');
  assert.equal(jobs[first.body.jobId].persona, 'a home chef'); // D's tray shows the persona after a reload

  // An engine error (401) ends the job as job.failed with the contract message.
  fail = Object.assign(new Error('401'), { status: 401 });
  const bad = await act({ type: 'rosetta', persona: 'a gardener' });
  assert.equal(bad.status, 202);
  await new Promise((r) => setTimeout(r, 50));
  const fj = store.read('plastic-modeling').jobs[bad.body.jobId];
  assert.equal(fj.state, 'failed');
  assert.equal(fj.error, 'Your Anthropic API key was rejected: run ontologizer key set');
  await srv.close();

  // Planted fault: a router that answers 400 to rosetta fails the 202 expectation above.
  const faultyRouter = (/** @type {any} */ b) => (b.type === 'rosetta' ? 400 : 202);
  assert.notEqual(faultyRouter({ type: 'rosetta', persona: 'a home chef' }), 202);
});
