// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// Two processes on one home (serve and an in-process mcp, or a restart that overlaps) add their counts
// up in usage.json: each write merges under usage.json.lock. Planted fault: the read-once writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createUsage, readUsageFile, usagePath } from '../../src/server/usage.js';
import { tempHome } from './helpers-service.js';

const DAY = Date.UTC(2026, 10, 9, 12);
const today = '2026-11-09';

/** The old writer: reads the file once, then writes its own copy whole. @param {{ home: string }} o */
function readOnceWriter({ home }) {
  const data = readUsageFile(home);
  return {
    /** @param {string} t @param {any} add */
    record(t, add) {
      const c = ((data.tenants[t] ??= {})[today] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
      c.calls += add.calls ?? 0;
      fs.writeFileSync(usagePath(home), JSON.stringify(data));
    },
  };
}

/** Two writers on one home, interleaved, 50 calls each: what the file says that it should not. @param {(o: any) => { record: Function }} factory */
function twoWriterProblems(factory) {
  const home = tempHome();
  const a = factory({ home, now: () => DAY });
  const b = factory({ home, now: () => DAY });
  for (let i = 0; i < 50; i++) { a.record('default', { calls: 1 }); b.record('default', { calls: 1 }); }
  const calls = readUsageFile(home).tenants.default?.[today]?.calls ?? 0;
  return calls === 100 ? [] : [`two writers left ${calls} calls in the file, not 100`];
}

test('two writers on one home add up (planted fault: the read-once writer loses half)', () => {
  assert.deepEqual(twoWriterProblems(createUsage), []);
  assert.deepEqual(twoWriterProblems(readOnceWriter), ['two writers left 50 calls in the file, not 100']);
  // Each one also sees the other's counts.
  const home = tempHome();
  const a = createUsage({ home, now: () => DAY });
  const b = createUsage({ home, now: () => DAY });
  a.record('t', { calls: 3, inputTokens: 10 });
  b.record('t', { calls: 2, outputTokens: 5 });
  assert.deepEqual([a.today('t').calls, b.today('t').calls, a.today('t').inputTokens, a.today('t').outputTokens], [5, 5, 10, 5]);
});

test('two real processes writing at once: no count is lost', async () => {
  const home = tempHome();
  const code = `import { createUsage } from ${JSON.stringify(new URL('../../src/server/usage.js', import.meta.url).href)};
const u = createUsage({ home: process.argv[1] });
for (let i = 0; i < 200; i++) u.record('default', { calls: 1, inputTokens: 2 });`;
  const run = () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code, home], { stdio: 'inherit' });
    c.on('exit', (n) => (n === 0 ? resolve(undefined) : reject(new Error(`exit ${n}`))));
  });
  await Promise.all([run(), run()]);
  const days = Object.values(readUsageFile(home).tenants.default ?? {});
  assert.equal(days.reduce((s, d) => s + d.calls, 0), 400);
  assert.equal(days.reduce((s, d) => s + d.inputTokens, 0), 800);
  assert.ok(!fs.existsSync(`${usagePath(home)}.lock`), 'the lock is released');
});

test('a stale lock (a crashed writer) is taken over; a live one keeps the counts until the next write', () => {
  const home = tempHome();
  const lockFile = `${usagePath(home)}.lock`;
  fs.writeFileSync(lockFile, '99999');
  const old = (Date.now() - 60_000) / 1000;
  fs.utimesSync(lockFile, old, old);
  const u = createUsage({ home, now: () => DAY });
  u.record('default', { calls: 1 });
  assert.equal(readUsageFile(home).tenants.default[today].calls, 1);
  assert.ok(!fs.existsSync(lockFile));
  // A fresh lock held by someone else: the count stays in memory (today() sees it), written once it is free.
  fs.writeFileSync(lockFile, '99999');
  /** @type {string[]} */
  const logs = [];
  const v = createUsage({ home, now: () => DAY, log: (l) => logs.push(l) });
  v.record('default', { calls: 1 });
  assert.equal(readUsageFile(home).tenants.default[today].calls, 1);
  assert.equal(v.today('default').calls, 2);
  assert.match(logs.join('\n'), /could not lock/);
  fs.rmSync(lockFile);
  v.record('default', { calls: 1 });
  assert.equal(readUsageFile(home).tenants.default[today].calls, 3);
});
