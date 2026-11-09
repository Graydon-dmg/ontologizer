// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// The build timeout: a hung build is failed, its model calls aborted, its slot freed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from '../../src/server/service.js';
import { main } from '../../src/cli/main.js';
import { tempHome, req, stubEngine } from './helpers-service.js';

process.env.ONTOLOGIZER_STUB_SPEED = '1000';

/**
 * Two builds on one slot; the first hangs. Reports what went wrong, with the signal its client saw.
 * @param {number} buildTimeoutMs
 */
async function timeoutProblems(buildTimeoutMs) {
  const home = tempHome();
  /** @type {AbortSignal[]} */
  const signals = [];
  let builds = 0;
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, allowHosts: [], maxBuilds: 1, tokensFile: null, version: 'test', buildTimeoutMs,
    makeEngine: async (/** @type {any} */ x) => {
      const client = x.meter({ messages: { stream: (/** @type {any} */ _p, /** @type {any} */ opts) => { signals.push(opts?.signal); return { [Symbol.asyncIterator]: async function* () {}, on() {}, finalMessage: async () => ({ usage: {} }) }; } } });
      const e = stubEngine(x);
      return { ...e, async build(/** @type {any} */ brief) {
        if (++builds === 1) { client.messages.stream({}); await new Promise(() => {}); } // never returns
        return e.build(brief);
      } };
    },
  });
  const problems = [];
  try {
    const post = (/** @type {string} */ n) => req(srv.url, '/v1/t/default/maps', { method: 'POST', body: { brief: { context: n, subject: n }, name: n } });
    const first = (await post('one')).json().id;
    const second = (await post('two')).json().id;
    const w = (await req(srv.url, `/v1/t/default/maps/${first}/wait?timeout=3000`)).json();
    if (!/^Timed out after/.test(w.error ?? '')) problems.push(`first build: ${JSON.stringify(w)}`);
    else {
      const snap = (await req(srv.url, `/v1/t/default/maps/${first}/snapshot`)).json();
      const failed = Object.values(snap.jobs ?? {}).some((/** @type {any} */ j) => j.kind === 'build' && /^Timed out after/.test(j.error ?? ''));
      if (!failed) problems.push(`no failed build job on the map: ${JSON.stringify(snap.jobs)}`);
      if (!signals[0]?.aborted) problems.push('the model call was not aborted');
    }
    const w2 = (await req(srv.url, `/v1/t/default/maps/${second}/wait?timeout=3000`)).json();
    if (w2.state !== 'idle' || w2.error || builds < 2) problems.push('the second build never started');
  } finally { await srv.close(); }
  return problems;
}

test('a build past the timeout fails, aborts its model call and frees the slot (planted fault: no timeout)', async () => {
  assert.deepEqual(await timeoutProblems(150), []);
  assert.ok((await timeoutProblems(3_600_000)).includes('the second build never started'));
});

function cap() { return { out: '', write(/** @type {string} */ s) { this.out += s; return true; } }; }
test('serve rejects a bad --build-timeout, --limit-calls and --limit-tokens', async () => {
  for (const flags of [['--build-timeout', '0'], ['--build-timeout', '1441'], ['--build-timeout', '1.5'], ['--limit-calls', '-1'], ['--limit-calls', '0'], ['--limit-tokens', '2.5']]) {
    const home = tempHome();
    const stdout = cap(); const stderr = cap();
    const code = await main(['serve', '--port', '0', '--home', home, '--exit-after', '10', ...flags], {
      home, stdout, stderr, interactive: false, env: { ...process.env, ONTOLOGIZER_HOME: home }, openBrowser: async () => {}, onSignal: () => () => {},
    });
    assert.equal(code, 1, flags.join(' '));
    assert.match(stderr.out, /must be/, flags.join(' '));
    assert.ok(!/Serving/.test(stdout.out));
  }
  const home = tempHome();
  const stdout = cap(); const stderr = cap();
  const code = await main(['serve', '--port', '0', '--home', home, '--exit-after', '10', '--limit-calls', '5', '--limit-tokens', '900'], {
    home, stdout, stderr, interactive: false, env: { ...process.env, ONTOLOGIZER_HOME: home }, openBrowser: async () => {}, onSignal: () => () => {},
  });
  assert.equal(code, 0, stderr.out);
  assert.match(stdout.out, /Serving[^\n]*\nDaily limits per tenant: 5 model calls, 900 tokens \(UTC day; counted, not priced\)\./);
});
