// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// Tokens are counted from the stream's events as they arrive, so an answer aborted half way (a reader
// who leaves, a build timeout) still counts what it used, and a stream with no usage at all counts an
// estimate, never 0. Each check has a planted fault: the old counter that waited for finalMessage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createUsage, meterStream } from '../../src/server/usage.js';

const NOON = Date.UTC(2026, 10, 9, 12); // the usage clock: the day never depends on when the test runs
import { startService } from '../../src/server/service.js';
import { req, stubEngine, tempHome } from './helpers-service.js';

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/**
 * A stream that yields `events`, then (if `abortAfter`) throws as an abort; finalMessage resolves only
 * after a complete stream.
 * @param {any[]} events @param {{ abort?: boolean, final?: any }} [o]
 */
function fakeStream(events, { abort = false, final = null } = {}) {
  let done = false;
  async function* gen() {
    for (const e of events) yield e;
    if (abort) throw abortError();
    done = true;
  }
  const it = gen();
  return {
    [Symbol.asyncIterator]() { return it; },
    async finalMessage() { for await (const _ of it); if (!done) throw abortError(); return final; },
  };
}
const START = { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 1 } } };
const DELTA = (/** @type {string} */ t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });

/** The old counter: tokens only from finalMessage's usage. @type {typeof meterStream} */
function finalOnly(s, _params, add) {
  const fm = s.finalMessage.bind(s);
  s.finalMessage = async () => { const m = await fm(); if (m?.usage) add({ inputTokens: m.usage.input_tokens, outputTokens: m.usage.output_tokens }); return m; };
}

/** Consume a stream as the engine does (iterate, then finalMessage), ignoring an abort. @param {any} s */
async function consume(s) {
  try { for await (const _ of s); await s.finalMessage(); } catch (err) { if (/** @type {any} */ (err).name !== 'AbortError') throw err; }
}
const tick = () => new Promise((r) => setTimeout(r, 5));

/** What a meter counts for an answer aborted after message_start and 30 characters. @param {typeof meterStream} meter */
async function abortedCount(meter) {
  const got = { inputTokens: 0, outputTokens: 0 };
  const s = fakeStream([START, DELTA('0123456789'), DELTA('0123456789'), DELTA('0123456789')], { abort: true });
  meter(s, { max_tokens: 8000, messages: [] }, (a) => { got.inputTokens += a.inputTokens ?? 0; got.outputTokens += a.outputTokens ?? 0; });
  await consume(s);
  await tick();
  return got;
}

test('an answer aborted after message_start and some text is counted (planted fault: the finalMessage-only counter counts 0)', async () => {
  const got = await abortedCount(meterStream);
  assert.equal(got.inputTokens, 120, 'input and cache reads from message_start');
  assert.equal(got.outputTokens, 10, 'the streamed text, 30 characters / 3');
  assert.deepEqual(await abortedCount(finalOnly), { inputTokens: 0, outputTokens: 0 });
});

test('a stream with no usage at all is counted by estimate (max_tokens out, the request\'s size in), never 0', async () => {
  const got = { inputTokens: 0, outputTokens: 0 };
  const params = { max_tokens: 2048, system: 'x'.repeat(400), messages: [{ role: 'user', content: 'y'.repeat(400) }] };
  const s = fakeStream([], { abort: true });
  meterStream(s, params, (a) => { got.inputTokens += a.inputTokens ?? 0; got.outputTokens += a.outputTokens ?? 0; });
  await consume(s);
  assert.equal(got.outputTokens, 2048);
  assert.ok(got.inputTokens >= 200, `input estimated from the request: ${got.inputTokens}`);
});

test('a complete answer is counted exactly once, from events and the final message alike', async () => {
  const final = { usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 50 } };
  const events = [START, DELTA('hello'), { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }, { type: 'message_stop' }];
  const got = { inputTokens: 0, outputTokens: 0 };
  const add = (/** @type {any} */ a) => { got.inputTokens += a.inputTokens ?? 0; got.outputTokens += a.outputTokens ?? 0; };
  const s = fakeStream(events, { final });
  meterStream(s, {}, add);
  await consume(s);
  await tick();
  assert.deepEqual(got, { inputTokens: 120, outputTokens: 50 });
  // An SDK-style stream that also emits 'streamEvent' for the same events: still once.
  const got2 = { inputTokens: 0, outputTokens: 0 };
  const em = Object.assign(new EventEmitter(), fakeStream(events, { final }));
  meterStream(em, {}, (a) => { got2.inputTokens += a.inputTokens ?? 0; got2.outputTokens += a.outputTokens ?? 0; });
  for (const e of events) em.emit('streamEvent', e);
  await consume(em);
  em.emit('finalMessage', final); em.emit('end');
  await tick();
  assert.deepEqual(got2, { inputTokens: 120, outputTokens: 50 });
});

test('a build that times out is counted: its stream\'s message_start reached the usage file', async () => {
  const home = tempHome();
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, tokensFile: null, version: 'test', maxBuilds: 1, buildTimeoutMs: 150,
    usage: createUsage({ home, now: () => NOON }),
    makeEngine: async (/** @type {any} */ x) => {
      const client = x.meter({ messages: { stream: (/** @type {any} */ _p, /** @type {any} */ opts) => {
        const signal = opts?.signal;
        async function* gen() {
          yield START;
          yield DELTA('a'.repeat(30));
          await new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }));
        }
        const it = gen();
        return { [Symbol.asyncIterator]() { return it; }, async finalMessage() { for await (const _ of it); return null; } };
      } } });
      const e = stubEngine(x);
      return { ...e, async build() { const s = client.messages.stream({ max_tokens: 4000 }); for await (const _ of s); } };
    },
  });
  try {
    const id = (await req(srv.url, '/v1/t/default/maps', { method: 'POST', body: { brief: { context: 'x', subject: 'x' } } })).json().id;
    const w = (await req(srv.url, `/v1/t/default/maps/${id}/wait?timeout=3000`)).json();
    assert.match(w.error ?? '', /^Timed out after/);
    await tick();
    const u = createUsage({ home, now: () => NOON }).today('default');
    assert.equal(u.calls, 1);
    assert.equal(u.inputTokens, 120);
    assert.equal(u.outputTokens, 10);
  } finally { await srv.close(); }
});
