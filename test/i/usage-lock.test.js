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
  // A long lock wait (a busy machine can hold the other writer up for a while), a fixed day, and the
  // exit flush every real process does: no count can be lost however slow the machine is.
  const code = `import { createUsage } from ${JSON.stringify(new URL('../../src/server/usage.js', import.meta.url).href)};
const u = createUsage({ home: process.argv[1], now: () => Number(process.argv[2]), lockWaitMs: 30000 });
for (let i = 0; i < 200; i++) u.record('default', { calls: 1, inputTokens: 2 });
if (!u.flush({ waitMs: 30000 })) process.exit(3);`;
  const run = () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code, home, String(DAY)], { stdio: 'inherit' });
    c.on('exit', (n) => (n === 0 ? resolve(undefined) : reject(new Error(`exit ${n}`))));
  });
  await Promise.all([run(), run()]);
  const day = readUsageFile(home).tenants.default?.[today];
  assert.equal(day?.calls, 400);
  assert.equal(day?.inputTokens, 800);
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

/**
 * A process that recorded while another held the lock, then stopped: what reached the file.
 * The test holds the lock and frees it 300 ms into the stop, as a slow writer would.
 * @param {'flush' | 'exit'} stop how the process stops: the exit flush, or simply exiting (the fault)
 */
async function exitProblems(stop) {
  const home = tempHome();
  const lockFile = `${usagePath(home)}.lock`;
  fs.writeFileSync(lockFile, '1');
  const code = `import { createUsage } from ${JSON.stringify(new URL('../../src/server/usage.js', import.meta.url).href)};
const u = createUsage({ home: process.argv[1], now: () => Number(process.argv[2]), lockWaitMs: 20 });
for (let i = 0; i < 3; i++) u.record('default', { calls: 1 });
process.stdout.write(String(u.pendingCalls()) + '\\n');
if (process.argv[3] === 'flush') u.flush({ waitMs: 20000 });`;
  const c = spawn(process.execPath, ['--input-type=module', '-e', code, home, String(DAY), stop], { stdio: ['ignore', 'pipe', 'inherit'] });
  const held = await new Promise((resolve) => c.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  setTimeout(() => fs.rmSync(lockFile, { force: true }), 300);
  await new Promise((resolve) => c.on('exit', resolve));
  /** @type {string[]} */
  const p = [];
  if (held !== 3) p.push(`the counts were not held while the lock was busy (${held})`);
  const calls = readUsageFile(home).tenants.default?.[today]?.calls ?? 0;
  if (calls !== 3) p.push(`a process stopped with ${3 - calls} of its 3 calls unwritten`);
  return p;
}

test('counts held while the lock was busy are written when the process stops (planted fault: exiting without the flush)', async () => {
  assert.deepEqual(await exitProblems('flush'), []);
  assert.deepEqual(await exitProblems('exit'), ['a process stopped with 3 of its 3 calls unwritten']);
});

test('serve\'s graceful stop writes the counts a busy lock held back', async () => {
  const { startService } = await import('../../src/server/service.js');
  const { stubEngine } = await import('./helpers-service.js');
  const home = tempHome();
  const usage = createUsage({ home, now: () => DAY, lockWaitMs: 20 });
  const srv = await startService({ home, host: '127.0.0.1', port: 0, tokensFile: null, version: 'test', usage, makeEngine: async (/** @type {any} */ x) => stubEngine(x) });
  const lockFile = `${usagePath(home)}.lock`;
  fs.writeFileSync(lockFile, '1');
  usage.record('default', { calls: 2 });
  assert.equal(usage.pendingCalls(), 2);
  assert.equal(readUsageFile(home).tenants.default?.[today]?.calls ?? 0, 0, 'held back by the busy lock');
  setTimeout(() => fs.rmSync(lockFile, { force: true }), 300);
  await srv.close();
  assert.equal(readUsageFile(home).tenants.default?.[today]?.calls, 2);
  assert.equal(usage.pendingCalls(), 0);
});
