// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// Review fixes to the usage counter: a busy lock never stalls the server, a lock is only ever released
// by its owner, lock errors say what they are, and a corrupt usage.json is moved aside, never overwritten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createUsage, lock, readUsageFile, usagePath } from '../../src/server/usage.js';
import { tempHome } from './helpers-service.js';

const DAY = Date.UTC(2026, 10, 9, 12);
const today = '2026-11-09';
const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

test('a held lock never blocks record(); limits see the counts at once; a timer writes them when it frees', async () => {
  const home = tempHome();
  const lockFile = `${usagePath(home)}.lock`;
  fs.writeFileSync(lockFile, 'someone-else');
  const u = createUsage({ home, now: () => DAY, limitCalls: 3 });
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) u.record('default', { calls: 1 });
  const took = Date.now() - t0;
  assert.ok(took < 200, `record() blocked for ${took} ms on a held lock`);
  assert.equal(u.today('default').calls, 3);
  assert.ok(u.over('default'), 'enforcement sees the in-memory counts');
  assert.equal(readUsageFile(home).tenants.default?.[today]?.calls ?? 0, 0);
  fs.rmSync(lockFile);
  await wait(1600);
  assert.equal(readUsageFile(home).tenants.default?.[today]?.calls, 3, 'written by the retry, no flush');
  assert.equal(u.pendingCalls(), 0);
});

test('release() leaves a lock it no longer owns; a stale lock is replaced by a unique one', () => {
  const home = tempHome();
  const file = usagePath(home);
  const lockFile = `${file}.lock`;
  fs.writeFileSync(lockFile, 'crashed-writer');
  const old = (Date.now() - 60_000) / 1000;
  fs.utimesSync(lockFile, old, old);
  const release = lock(file, 0);
  assert.ok(release, 'the stale lock is taken over');
  const mine = fs.readFileSync(lockFile, 'utf8');
  assert.notEqual(mine, 'crashed-writer');
  assert.match(mine, new RegExp(`^${process.pid}-`));
  // Someone else took it over meanwhile (we were too slow): our release must not delete theirs.
  fs.writeFileSync(lockFile, 'new-owner');
  release();
  assert.equal(fs.readFileSync(lockFile, 'utf8'), 'new-owner');
  fs.rmSync(lockFile);
  const r2 = lock(file, 0);
  assert.ok(r2);
  r2();
  assert.ok(!fs.existsSync(lockFile), 'the owner releases its own lock');
});

test('a lock error that is not "held" says so; old temp files are cleaned up on load', { skip: process.getuid?.() === 0 }, () => {
  const home = tempHome();
  fs.chmodSync(home, 0o500);
  /** @type {string[]} */
  const logs = [];
  try {
    const u = createUsage({ home, now: () => DAY, log: (l) => logs.push(l) });
    u.record('default', { calls: 1 });
    assert.equal(u.today('default').calls, 1);
  } finally { fs.chmodSync(home, 0o700); }
  const text = logs.join('\n');
  assert.doesNotMatch(text, /another process holds it/);
  assert.match(text, /EACCES|EPERM/);

  const h2 = tempHome();
  const oldTmp = `${usagePath(h2)}.123.456.tmp`;
  const newTmp = `${usagePath(h2)}.789.1011.tmp`;
  fs.writeFileSync(oldTmp, '{}');
  fs.writeFileSync(newTmp, '{}');
  const old = (Date.now() - 5 * 60_000) / 1000;
  fs.utimesSync(oldTmp, old, old);
  createUsage({ home: h2, now: () => DAY });
  assert.ok(!fs.existsSync(oldTmp), 'a leftover temp file older than a minute is removed');
  assert.ok(fs.existsSync(newTmp), 'a fresh one (another writer, mid-write) is kept');
});

test('a corrupt usage.json is moved aside, not overwritten, and limits keep what is known', () => {
  const home = tempHome();
  const file = usagePath(home);
  /** @type {string[]} */
  const logs = [];
  const u = createUsage({ home, now: () => DAY, limitCalls: 6, log: (l) => logs.push(l) });
  u.record('x', { calls: 5 });
  u.record('y', { calls: 2 });
  assert.equal(readUsageFile(home).tenants.x[today].calls, 5);
  fs.writeFileSync(file, '{"version":1,"tenants":{"x":{"2026-11-09":{"calls":5');
  assert.equal(u.today('x').calls, 5, 'a corrupt file does not reset what this process knows');
  u.record('x', { calls: 1 });
  assert.ok(u.over('x'), 'still over the limit: 6 calls known');
  const aside = fs.readdirSync(home).filter((n) => n.startsWith('usage.json.corrupt-'));
  assert.equal(aside.length, 1, 'the corrupt file is moved aside');
  assert.equal(fs.readFileSync(path.join(home, aside[0]), 'utf8'), '{"version":1,"tenants":{"x":{"2026-11-09":{"calls":5');
  const now = readUsageFile(home);
  assert.equal(now.tenants.x[today].calls, 6);
  assert.equal(now.tenants.y[today].calls, 2);
  assert.equal(logs.filter((l) => /corrupt/.test(l)).length, 1, 'logged once');

  // A process that starts on a corrupt file moves it aside before its first write.
  const h2 = tempHome();
  fs.writeFileSync(usagePath(h2), 'garbage');
  const v = createUsage({ home: h2, now: () => DAY });
  v.record('z', { calls: 1 });
  assert.equal(fs.readdirSync(h2).filter((n) => n.startsWith('usage.json.corrupt-')).length, 1);
  assert.equal(readUsageFile(h2).tenants.z[today].calls, 1);
});
