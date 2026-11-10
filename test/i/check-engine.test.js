// @ts-check
// The context check in service mode runs on the REAL engine (not the stub): its engine id ':check' is
// never a stored map, so the check must not read a map. And a run on a real map still fails closed
// when its store cannot be read: it never treats an unreadable map as public (which would offer web
// search on a private map). Each check has a planted fault.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from '../../src/server/service.js';
import { createEngine } from '../../src/core/engine/index.js';
import { createRun } from '../../src/core/engine/run.js';
import { runCall } from '../../src/core/engine/call.js';
import { openStore } from '../../src/core/store.js';
import { createFakeClient } from '../c/fake.js';
import { req, tempHome } from './helpers-service.js';

const READY = { ready: true, brief: { subject: 'Plastic model kits', scope: 'building', purpose: 'start', level: 'beginner' }, name: 'plastic-model-kits' };

/** What is wrong with a maps/check answer. @param {{ status: number, body: string }} r */
function checkProblems(r) {
  const p = [];
  if (r.status !== 200) p.push(`maps/check answered ${r.status}: ${r.body.slice(0, 160)}`);
  if (/Invalid ontology id/.test(r.body)) p.push('the check read a map that does not exist (its engine id)');
  let j = null;
  try { j = JSON.parse(r.body); } catch { /* reported above */ }
  if (r.status === 200 && !(j && j.ready === true && j.brief?.subject === READY.brief.subject)) p.push('the model\'s answer did not come back');
  return p;
}

test('service mode: POST maps/check on the real engine reaches the model and returns its answer', async () => {
  /** @type {any[]} */ const calls = [];
  const srv = await startService({
    home: tempHome(), host: '127.0.0.1', port: 0, version: 'test',
    makeEngine: async ({ store, id }) => createEngine({
      store, id, client: createFakeClient({ respond: (params) => { calls.push(params); return { text: `${JSON.stringify(READY)}\n` }; } }),
    }),
  });
  try {
    const r = await req(srv.url, '/v1/t/default/maps/check', { method: 'POST', body: { context: 'I want to build plastic model kits' } });
    assert.deepEqual(checkProblems(r), []);
    assert.equal(calls.length, 1, 'the model was asked once');
    assert.equal(calls[0].tools, undefined, 'the check offers no tools and no web search');
  } finally { await srv.close(); }

  // Planted fault: main's behaviour. The check's run asked the store for its engine id (':check').
  const store = openStore(tempHome());
  const broken = createRun({ emit: () => {}, read: () => store.read(':check') });
  let message = '';
  try { broken.restricted(); } catch (e) { message = /** @type {Error} */ (e).message; }
  assert.match(message, /Invalid ontology id ":check"/);
  const body = JSON.stringify({ ok: false, error: message });
  assert.ok(checkProblems({ status: 502, body }).length >= 2);
});

/** Problems if a private map's run offered web search, or answered at all, while its store could not be read. @param {{ rejected: boolean, requests: any[] }} r */
function failClosedProblems(r) {
  const p = [];
  for (const q of r.requests) if ((q.tools ?? []).some((/** @type {any} */ t) => t.name === 'web_search')) p.push('web_search was offered while the map could not be read');
  if (!r.rejected && !r.requests.length) p.push('the run neither failed nor ran');
  return p;
}

test('a run whose store cannot be read fails closed: no web search, the call is refused', async () => {
  const failed = Object.assign(new Error('The Postgres store stopped after a write failed: boom'), { code: 'STORE_FAILED' });
  /** @param {() => boolean} restricted */
  const attempt = async (restricted) => {
    /** @type {any[]} */ const requests = [];
    const client = createFakeClient({ respond: (params) => { requests.push(params); return { text: '{"summary":"x"}\n' }; } });
    let rejected = false;
    try {
      await runCall(() => client, { model: 'm', effort: 'low', system: 's', prompt: 'p', webSearch: true, restricted }, () => {});
    } catch (e) { rejected = /** @type {any} */ (e).code === 'STORE_FAILED'; }
    return { rejected, requests };
  };
  // The engine's own read: a store that throws makes restricted() throw, never answer "public".
  const run = createRun({ emit: () => {}, read: () => { throw failed; } });
  assert.throws(() => run.restricted(), (/** @type {any} */ e) => e.code === 'STORE_FAILED');
  const r = await attempt(run.restricted);
  assert.equal(r.rejected, true, 'the call was refused');
  assert.deepEqual(failClosedProblems(r), []);
  assert.equal(r.requests.length, 0, 'nothing reached the model');

  // Planted fault: a try/catch that treats an unreadable map as public offers web search.
  const swallow = () => { try { return run.restricted(); } catch { return false; } };
  assert.ok(failClosedProblems(await attempt(swallow)).length > 0);
});
