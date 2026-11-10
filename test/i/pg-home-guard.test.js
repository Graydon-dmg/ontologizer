// @ts-check
// The Postgres tests never touch the real home. A Postgres store's default attachments root is
// <ONTOLOGIZER_HOME or ~/.ontologizer>/pg/<tenant>; a test that forgets to pass its own root (or a store
// that made that folder at open) would litter the user's home. Here the Postgres-store test files run
// with HOME pointed at an empty folder and ONTOLOGIZER_HOME unset, and the folder must stay empty.
// Planted fault: a store opened with no root that stores an attachment is reported.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PG_URL = process.env.ONTOLOGIZER_PG_URL;
const PG_FILES = ['store-contract', 'store-pg-durability', 'store-recovery', 'service-recovery', 'ports']
  .map((f) => path.join(ROOT, 'test', 'i', `${f}.test.js`));

/** Everything created under a folder that should have stayed empty. @param {string} dir @returns {string[]} */
function homeLeaks(dir) {
  /** @type {string[]} */ const out = [];
  /** @param {string} d */
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(path.relative(dir, p));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

/** The environment of a child whose home is `home`: HOME there, no ONTOLOGIZER_HOME. @param {string} home */
function envWithHome(home) {
  /** @type {Record<string, string>} */ const env = {};
  // NODE_TEST_CONTEXT is how the test runner talks to its own children: a nested `node --test` that
  // inherits it does not run as a normal test run.
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ONTOLOGIZER_HOME' && k !== 'NODE_TEST_CONTEXT') env[k] = v;
  env.HOME = home;
  env.USERPROFILE = home;
  return env;
}

test('planted fault: a Postgres store opened with no root that stores an attachment writes under HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-guard-home-'));
  try {
    const script = `
      import { openPostgresStore } from ${JSON.stringify(path.join(ROOT, 'src', 'store-postgres', 'index.js'))};
      import { storeAttachment } from ${JSON.stringify(path.join(ROOT, 'src', 'server', 'chat.js'))};
      const pool = { query: async () => ({ rows: [] }) };          // no database needed
      const s = openPostgresStore({ pool, tenant: 'tleak' });     // no root: the fault
      await s.ready;
      storeAttachment(s.root, 'draft-1', { buf: Buffer.from('x'), ext: 'png', mime: 'image/png' });
      await s.close();
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: envWithHome(home), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const leaks = homeLeaks(home);
    assert.ok(leaks.some((p) => p.startsWith(path.join('.ontologizer', 'pg', 'tleak'))), `the guard missed the leak: ${leaks.join(', ')}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a store opened with no root creates nothing at open (the attachments folder is made on first use)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-guard-home-'));
  try {
    const script = `
      import { openPostgresStore } from ${JSON.stringify(path.join(ROOT, 'src', 'store-postgres', 'index.js'))};
      const s = openPostgresStore({ pool: { query: async () => ({ rows: [] }) }, tenant: 'tquiet' });
      await s.ready; await s.close();
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: envWithHome(home), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(homeLeaks(home), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the Postgres-store tests, run with HOME pointed at an empty folder, leave it empty',
  PG_URL ? {} : { skip: 'ONTOLOGIZER_PG_URL is not set' }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-guard-home-'));
    try {
      const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...PG_FILES], { cwd: ROOT, env: envWithHome(home), encoding: 'utf8', timeout: 240000 });
      // Each failing nested test with its error lines, so a failure here says what broke.
      const lines = String(r.stdout).split('\n');
      const failing = lines.flatMap((l, i) => (/^\s*not ok /.test(l) && !/\.test\.js$/.test(l)
        ? [l, ...lines.slice(i + 1, i + 30).filter((x) => /error|expected|actual|Error|missing|timed/.test(x))] : [])).join('\n');
      assert.equal(r.status, 0, `the Postgres tests failed under the guard:\n${failing}\n${String(r.stdout).slice(-1500)}`);
      // They really ran, Postgres parts included (a nested run that ran nothing proves nothing).
      const pass = Number(/^# pass (\d+)/m.exec(String(r.stdout))?.[1] ?? 0);
      const skipped = Number(/^# skipped (\d+)/m.exec(String(r.stdout))?.[1] ?? -1);
      assert.ok(pass >= 40, `only ${pass} tests ran under the guard`);
      assert.equal(skipped, 0, 'Postgres tests were skipped under the guard');
      assert.deepEqual(homeLeaks(home), [], 'a Postgres test wrote under HOME');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
