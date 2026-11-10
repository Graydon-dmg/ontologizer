// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// Daily usage limits through the live router: 429 with Retry-After, restart, per tenant, the usage route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from '../../src/server/service.js';
import { createUsage, secondsToNextUtcDay, readUsageFile } from '../../src/server/usage.js';
import { createToken, tokensPath } from '../../src/server/tokens.js';
import { tempHome, req, seed, stubEngine } from './helpers-service.js';

/** A fake model stream whose final message carries a small usage. */
const fakeClient = () => ({ messages: {
  stream: () => ({ [Symbol.asyncIterator]: async function* () {}, on() {}, finalMessage: async () => ({ usage: { input_tokens: 3, output_tokens: 2 } }) }),
} });

/** An engine whose check, build and enqueue each make one metered model call. @param {any} x */
async function meteredEngine(x) {
  const client = x.meter(fakeClient());
  const call = async () => { await client.messages.stream({}).finalMessage(); };
  const e = stubEngine(x);
  return {
    ...e,
    async check() { await call(); return { ready: true, brief: { context: 'c', subject: 's' }, name: 's' }; },
    async build() { await call(); },
    enqueue() { call().catch(() => {}); return 'job-1'; },
  };
}

/** Every test here runs on a fixed clock: the UTC day, Retry-After and the rollover never depend on when it runs. */
const NOON = Date.UTC(2026, 10, 9, 12);

/** @param {any} o  o.now: the usage clock (default NOON) */
async function start(o) {
  const { now = () => NOON, ...rest } = o;
  const usage = rest.usage ?? createUsage({ home: rest.home, limitCalls: rest.limitCalls ?? null, limitTokens: rest.limitTokens ?? null, now });
  return startService({ port: 0, host: '127.0.0.1', allowHosts: [], maxBuilds: 2, version: 'test', makeEngine: meteredEngine, ...rest, usage });
}
const check = (/** @type {string} */ url, /** @type {Record<string, string>} */ headers = {}, tenant = 'default') =>
  req(url, `/v1/t/${tenant}/maps/check`, { method: 'POST', headers, body: { context: 'plastic' } });

test('500 calls, then 429 with Retry-After on every model route; view actions still work; a restart keeps the count', async () => {
  const home = tempHome();
  let srv = await start({ home, limitCalls: 500, tokensFile: null });
  try {
    await seed(home, 'default', 'plastic');
    for (let i = 0; i < 500; i++) assert.equal((await check(srv.url)).status, 200, `call ${i + 1}`);
    /** @param {string} url */
    const refused = async (url) => {
      const rows = [
        ['check', await check(url)],
        ['build', await req(url, '/v1/t/default/maps', { method: 'POST', body: { brief: { context: 'c', subject: 's' }, name: 's' } })],
        ['research', await req(url, '/v1/t/default/maps/plastic/api/action', { method: 'POST', body: { type: 'research', nodeId: 'n1', mode: 'context' } })],
        ['chat', await req(url, '/v1/t/default/maps/plastic/api/chat', { method: 'POST', body: { content: 'hi' } })],
      ];
      const problems = [];
      for (const [name, r] of /** @type {Array<[string, any]>} */ (rows)) {
        const ra = Number(r.headers['retry-after']);
        if (r.status !== 429) problems.push(`${name}: ${r.status}`);
        else if (ra !== secondsToNextUtcDay(NOON)) problems.push(`${name}: Retry-After ${r.headers['retry-after']}, not ${secondsToNextUtcDay(NOON)}`);
        else if (!/limit/i.test(r.json().error)) problems.push(`${name}: error does not name the limit`);
      }
      return problems;
    };
    assert.deepEqual(await refused(srv.url), []);
    const view = await req(srv.url, '/v1/t/default/maps/plastic/api/action', { method: 'POST', body: { type: 'focus', nodeId: 'n1' } });
    assert.equal(view.status, 202);
    await srv.close();
    srv = await start({ home, limitCalls: 500, tokensFile: null });
    assert.deepEqual(await refused(srv.url), []); // still over after a restart
    // planted fault: the check reports a router that is not limited
    const open = await start({ home: tempHome(), tokensFile: null });
    try { assert.ok((await refused(open.url)).length >= 1); } finally { await open.close(); }
  } finally { await srv.close(); }
});

/**
 * Tenant a is exhausted; tenant b must still be served.
 * @param {(o: any) => any} usageFactory
 */
async function isolationProblems(usageFactory) {
  const home = tempHome();
  const tok = (/** @type {string} */ name, /** @type {string} */ tenant, /** @type {string[]} */ scopes) => createToken(tokensPath(home), { name, tenant, scopes }).token;
  const a = tok('a', 'a', ['read', 'build']); const b = tok('b', 'b', ['read', 'build']);
  const srv = await start({ home, limitCalls: 3, tokensFile: tokensPath(home), usage: usageFactory({ home, limitCalls: 3, now: () => NOON }) });
  const problems = [];
  try {
    for (let i = 0; i < 3; i++) await check(srv.url, { authorization: `Bearer ${a}` }, 'a');
    if ((await check(srv.url, { authorization: `Bearer ${a}` }, 'a')).status !== 429) problems.push('tenant a not limited');
    if ((await check(srv.url, { authorization: `Bearer ${b}` }, 'b')).status !== 200) problems.push('tenant b limited by tenant a');
  } finally { await srv.close(); }
  return problems;
}

test('limits are per tenant (planted fault: one counter for everyone)', async () => {
  assert.deepEqual(await isolationProblems(createUsage), []);
  const perProcess = (/** @type {any} */ o) => {
    const u = createUsage(o);
    return { ...u, wrap: (/** @type {any} */ c, /** @type {any} */ w) => u.wrap(c, { ...w, tenant: 'x' }), over: () => u.over('x'), today: () => u.today('x') };
  };
  assert.deepEqual(await isolationProblems(perProcess), ['tenant b limited by tenant a']);
});

test('GET /v1/t/:tenant/usage: own tenant only; a read token may read it', async () => {
  const home = tempHome();
  const tok = (/** @type {string} */ name, /** @type {string} */ tenant, /** @type {string[]} */ scopes) => createToken(tokensPath(home), { name, tenant, scopes }).token;
  const a = tok('a', 'a', ['read', 'build']); const b = tok('b', 'b', ['read', 'build']); const ro = tok('ro', 'a', ['read']);
  const srv = await start({ home, limitCalls: 100, tokensFile: tokensPath(home) });
  try {
    await check(srv.url, { authorization: `Bearer ${a}` }, 'a');
    const mine = await req(srv.url, '/v1/t/a/usage', { headers: { authorization: `Bearer ${a}` } });
    assert.equal(mine.status, 200);
    assert.equal(mine.json().calls, 1);
    assert.equal(mine.json().inputTokens, 3);
    assert.equal((await req(srv.url, '/v1/t/a/usage', { headers: { authorization: `Bearer ${b}` } })).status, 404);
    const read = await req(srv.url, '/v1/t/a/usage', { headers: { authorization: `Bearer ${ro}` } });
    assert.equal(read.status, 200);
    assert.equal(read.json().calls, 1);
  } finally { await srv.close(); }
});

test('the day rolls over at 00:00 UTC: a clock at 23:59:59.900 is limited with Retry-After 1, then served 200 ms later', async () => {
  const home = tempHome();
  let t = Date.UTC(2026, 10, 9, 23, 59, 59, 900);
  const srv = await start({ home, limitCalls: 2, tokensFile: null, now: () => t });
  try {
    assert.equal((await check(srv.url)).status, 200);
    assert.equal((await check(srv.url)).status, 200);
    const over = await check(srv.url);
    assert.equal(over.status, 429);
    assert.equal(over.headers['retry-after'], '1', 'a tenth of a second to midnight is one second');
    assert.match(over.json().error, /in 0 h 0 min/);
    const before = (await req(srv.url, '/v1/t/default/usage')).json();
    assert.deepEqual([before.day, before.calls, before.resetsAt], ['2026-11-09', 2, '2026-11-10T00:00:00.000Z']);
    t += 200; // 00:00:00.100 on the 10th
    assert.equal((await check(srv.url)).status, 200, 'a new day, a new count');
    const after = (await req(srv.url, '/v1/t/default/usage')).json();
    assert.deepEqual([after.day, after.calls, after.resetsAt], ['2026-11-10', 1, '2026-11-11T00:00:00.000Z']);
    // Both days are kept in the file: yesterday's count was not rewritten as today's.
    const days = readUsageFile(home).tenants.default;
    assert.deepEqual([days['2026-11-09'].calls, days['2026-11-10'].calls], [2, 1]);
  } finally { await srv.close(); }
});
