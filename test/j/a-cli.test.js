// @ts-check
// Epic A: `ontologizer organize` on a temp home with the stub engine.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli/main.js';
import { openStore } from '../../src/core/store.js';

const SAMPLE = new URL('./fixtures/items/sample-120.json', import.meta.url).pathname;
const items = /** @type {any[]} */ (JSON.parse(fs.readFileSync(SAMPLE, 'utf8')));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-a-cli-'));
function cap() { return { out: '', write(/** @type {string} */ s) { this.out += s; return true; } }; }
const drafts = (/** @type {string} */ home) => openStore(home).list({ drafts: true });

/** @param {string[]} args @param {string} home */
async function run(args, home) {
  const stdout = cap(); const stderr = cap();
  const code = await main(args, {
    home, stdout, stderr, interactive: false, env: { ...process.env, ONTOLOGIZER_HOME: home },
    openBrowser: async () => {}, onSignal: () => () => {},
  });
  return { code, stdout: stdout.out, stderr: stderr.out };
}
/** The draft's leaves (items by id). @param {string} home @param {string} id */
const leafIds = (home, id) => {
  const map = /** @type {any} */ (openStore(home).read(id));
  const want = new Set(items.map((i) => i.id));
  return Object.keys(map.nodes).filter((k) => want.has(k));
};

test('organize <file> --name writes a draft with all 120 items and prints the summary', async () => {
  const home = tmp();
  const r = await run(['organize', SAMPLE, '--name', 'sample', '--home', home], home);
  assert.equal(r.code, 0, r.stderr);
  const m = r.stdout.match(/Organised 120 items into (\d+) families: (\S+)/);
  assert.ok(m, r.stdout);
  const list = drafts(home);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, m[2]);
  assert.equal(leafIds(home, m[2]).length, 120);
  // planted fault: a bare summary line would not match
  assert.ok(!/Organised 120 items into (\d+) families: (\S+)/.test('Organised 12 items'));
});

test('a { "items": [...] } file works, and so does stdin (-)', async () => {
  const home = tmp();
  const wrapped = path.join(tmp(), 'w.json');
  fs.writeFileSync(wrapped, JSON.stringify({ items: items.slice(0, 30) }));
  const r = await run(['organize', wrapped, '--name', 'w', '--home', home], home);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Organised 30 items into/);

  // stdin: the command reads file descriptor 0, so feed it a real pipe via a child process
  const { spawnSync } = await import('node:child_process');
  const home2 = tmp();
  const c = spawnSync(process.execPath, [new URL('../../src/cli/index.js', import.meta.url).pathname, 'organize', '-', '--name', 'in', '--home', home2], {
    input: JSON.stringify(items.slice(0, 40)), encoding: 'utf8',
    env: { ...process.env, ONTOLOGIZER_ENGINE: 'stub', ONTOLOGIZER_KEYRING: 'none', ONTOLOGIZER_NO_UPDATE_CHECK: '1', ONTOLOGIZER_HOME: home2 },
  });
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /Organised 40 items into/);
  assert.equal(drafts(home2).length, 1);
});

test('bad input (id a/b) exits 1 with the item error and creates no draft', async () => {
  const home = tmp();
  const f = path.join(tmp(), 'bad.json');
  fs.writeFileSync(f, JSON.stringify([{ id: 'a/b', label: 'A' }]));
  const r = await run(['organize', f, '--name', 'x', '--home', home], home);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes('item 0: id must be'), r.stderr);
  assert.equal(drafts(home).length, 0);
});

test('a server running on the home: exit 1 with the refusal, no draft; a dead one does not block', async () => {
  const home = tmp();
  const s = openStore(home);
  const key = s.sessions.addServer({ pid: process.ppid, port: 8787, url: 'http://127.0.0.1:8787/', startedAt: Date.now() });
  const r = await run(['organize', SAMPLE, '--name', 'x', '--home', home], home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /A server is running on this home \(pid \d+/);
  assert.equal(drafts(home).length, 0);
  // planted fault: with the server entry gone (or dead) the same command succeeds
  s.sessions.remove(key);
  s.sessions.addServer({ pid: 2 ** 22 + 12345, port: 8787, url: 'http://127.0.0.1:8787/', startedAt: Date.now() });
  assert.equal((await run(['organize', SAMPLE, '--name', 'x', '--home', home], home)).code, 0);
});
