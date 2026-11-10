// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsage, UsageLimitError, usagePath, secondsToNextUtcDay, readUsageFile } from '../../src/server/usage.js';
import { main } from '../../src/cli/main.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-usage-'));
const T0 = Date.parse('2026-03-10T10:00:00Z');

/** A fake client: stream() and create() each answer with the given usage. @param {any} usage */
function fakeClient(usage) {
  return { messages: {
    stream: () => ({ [Symbol.asyncIterator]: async function* () {}, on() {}, finalMessage: async () => ({ usage }) }),
    create: async () => ({ usage }),
  } };
}

test('wrap counts one call per stream() and create(), and the tokens of the final message', async () => {
  const home = tmp();
  const u = createUsage({ home, now: () => T0 });
  const c = u.wrap(fakeClient({ input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 7 }), { tenant: 'a' });
  await c.messages.stream({}).finalMessage();
  await c.messages.create({});
  const t = u.today('a');
  assert.equal(t.calls, 2);
  assert.equal(t.inputTokens, 2 * 17);
  assert.equal(t.outputTokens, 14);
  assert.equal(u.today('b').calls, 0); // per tenant
});

test('counts survive a restart; the file is 0600 and keeps the last 31 days', () => {
  const home = tmp();
  let now = T0;
  const u = createUsage({ home, now: () => now });
  u.record('a', { calls: 1, inputTokens: 4, outputTokens: 1 });
  for (let i = 1; i <= 40; i++) { now = T0 - i * 86400000; u.record('a', { calls: 1 }); }
  now = T0;
  u.record('a', { calls: 1 });
  assert.equal(fs.statSync(usagePath(home)).mode & 0o777, 0o600);
  const again = createUsage({ home, now: () => T0 });
  assert.equal(again.today('a').calls, 2);
  assert.equal(again.today('a').inputTokens, 4);
  const days = Object.keys(JSON.parse(fs.readFileSync(usagePath(home), 'utf8')).tenants.a);
  assert.equal(days.length, 31);
});

test('over(): null with no limits; with a limit, an error and the seconds to the next UTC midnight', async () => {
  const none = createUsage({ home: tmp(), now: () => T0 });
  none.record('a', { calls: 1e6 });
  assert.equal(none.over('a'), null);
  const u = createUsage({ home: tmp(), limitCalls: 2, now: () => T0 });
  const c = u.wrap(fakeClient({ input_tokens: 1, output_tokens: 1 }), { tenant: 'a' });
  await c.messages.create({});
  assert.equal(u.over('a'), null);
  await c.messages.create({});
  const o = u.over('a');
  assert.ok(o);
  assert.equal(o.retryAfter, 14 * 3600);
  assert.equal(o.retryAfter, secondsToNextUtcDay(T0));
  assert.match(o.error, /limit/);
  await assert.rejects(() => c.messages.create({}), (/** @type {any} */ e) => e instanceof UsageLimitError && e.code === 'USAGE_LIMIT');
  assert.throws(() => c.messages.stream({}), (/** @type {any} */ e) => e.code === 'USAGE_LIMIT');
  assert.equal(u.over('b'), null);
});

/**
 * The token-limit check: input-heavy usage must trip a token limit.
 * @param {(o: any) => any} factory createUsage-like
 */
function tokenLimitProblems(factory) {
  const u = factory({ home: tmp(), limitTokens: 100, now: () => T0 });
  u.record('a', { calls: 1, inputTokens: 500, outputTokens: 1 });
  return u.over('a') ? [] : ['a token limit ignores input tokens'];
}

test('a token limit counts input tokens too (planted fault: output only)', () => {
  assert.deepEqual(tokenLimitProblems(createUsage), []);
  const faulty = (/** @type {any} */ o) => {
    const u = createUsage(o);
    return { ...u, record: (/** @type {string} */ t, /** @type {any} */ add) => u.record(t, { ...add, inputTokens: 0 }) };
  };
  assert.deepEqual(tokenLimitProblems(faulty), ['a token limit ignores input tokens']);
});

function cap() { return { out: '', write(/** @type {string} */ s) { this.out += s; return true; } }; }
/** @param {string[]} args @param {string} home */
async function run(args, home) {
  const stdout = cap(); const stderr = cap();
  const code = await main(args, { home, stdout, stderr, interactive: false, env: { ...process.env, ONTOLOGIZER_HOME: home }, openBrowser: async () => {}, onSignal: () => () => {} });
  return { code, stdout: stdout.out, stderr: stderr.out };
}

test('usage command: missing file, text, --json, --days; no prices', async () => {
  const home = tmp();
  const empty = await run(['usage', '--home', home], home);
  assert.equal(empty.code, 0, empty.stderr);
  assert.equal(empty.stdout, `No model usage recorded in ${home} yet.\n`);
  const u = createUsage({ home, now: () => T0 });
  u.record('acme', { calls: 3, inputTokens: 120, outputTokens: 45 });
  fs.writeFileSync(usagePath(home), JSON.stringify({ version: 1, tenants: {
    ...JSON.parse(fs.readFileSync(usagePath(home), 'utf8')).tenants,
    old: { '2026-01-01': { calls: 1, inputTokens: 1, outputTokens: 1 }, '2026-01-02': { calls: 2, inputTokens: 2, outputTokens: 2 } },
  } }));
  const day = '2026-03-10'; // T0's UTC day
  const r = await run(['usage', '--home', home, '--days', '1'], home);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`${day}  3 calls  120 in  45 out tokens`));
  assert.ok(r.stdout.indexOf('2026-01-02') < r.stdout.indexOf('not money') && !r.stdout.includes('2026-01-01'));
  assert.deepEqual(r.stdout.split('\n').filter((l) => /\$|dollar|price|cost/i.test(l)), []);
  assert.match(r.stdout.trim().split('\n').pop() ?? '', /calls and tokens, not money/);
  const j = JSON.parse((await run(['usage', '--home', home, '--json', '--days', '1'], home)).stdout);
  assert.equal(j.home, home);
  assert.deepEqual(j.tenants.acme[day], { calls: 3, inputTokens: 120, outputTokens: 45 });
  assert.deepEqual(Object.keys(j.tenants.old), ['2026-01-02']);
  // planted fault: the money scan catches a line with a price
  assert.ok('2026-03-10  3 calls  $0.02'.split('\n').some((l) => /\$|dollar|price|cost/i.test(l)));
});

test('one tenth of a second before midnight UTC: Retry-After is 1, and the next record counts on the new day', () => {
  const home = tmp();
  let t = Date.UTC(2026, 10, 9, 23, 59, 59, 900);
  const u = createUsage({ home, limitCalls: 1, now: () => t });
  u.record('a', { calls: 1 });
  assert.deepEqual(u.over('a')?.retryAfter, 1);
  assert.equal(u.today('a').day, '2026-11-09');
  t += 200;
  assert.equal(u.over('a'), null);
  assert.deepEqual([u.today('a').day, u.today('a').calls], ['2026-11-10', 0]);
  u.record('a', { calls: 1 });
  assert.deepEqual(Object.keys(readUsageFile(home).tenants.a).sort(), ['2026-11-09', '2026-11-10']);
});
