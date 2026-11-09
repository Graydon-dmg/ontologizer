// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, TENANT_RE } from '../../src/core/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-'));

/** @param {string} dir @param {string} [rel] @returns {string[]} */
function files(dir, rel = '') {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...files(dir, r)); else out.push(r.split(path.sep).join('/'));
  }
  return out.sort();
}

/** Run the same operations on a store. @param {ReturnType<typeof openStore>} store */
function work(store) {
  const id = store.createDraft('plants');
  store.append(id, [{ type: 'root', name: 'Plants' }]);
  store.save(id, 'plants');
  return id;
}

/** Problems: the default tenant must lay files out exactly like the plain store, no tenants/ dir. @param {(home: string) => ReturnType<typeof openStore>} open */
function defaultLayoutProblems(open) {
  const a = tmp(); const b = tmp();
  work(openStore(a));
  work(open(b));
  const fa = files(a).map((f) => f.replace(/draft-\d{8}-\d{6}/, 'draft'));
  const fb = files(b).map((f) => f.replace(/draft-\d{8}-\d{6}/, 'draft'));
  const problems = [];
  if (JSON.stringify(fa) !== JSON.stringify(fb)) problems.push(`file lists differ: ${fa} vs ${fb}`);
  if (fs.existsSync(path.join(b, 'tenants'))) problems.push('tenants/ dir appeared');
  return problems;
}

test('openStore(home) and the default tenant write the same files', () => {
  assert.deepEqual(defaultLayoutProblems((h) => openStore(h, { tenant: 'default' })), []);
  // fault: a "default" that lives under tenants/default is reported
  const faulty = defaultLayoutProblems((h) => openStore(path.join(h, 'tenants', 'default')));
  assert.ok(faulty.length > 0);
});

test('a non-default tenant writes only under tenants/<tenant>/', () => {
  const home = tmp();
  work(openStore(home, { tenant: 'acme' }));
  const fs1 = files(home);
  assert.ok(fs1.length > 0);
  assert.ok(fs1.every((f) => f.startsWith('tenants/acme/')), fs1.join(','));
  // fault check: a default store would put index.json at the top
  const other = tmp();
  work(openStore(other));
  assert.ok(!files(other).every((f) => f.startsWith('tenants/acme/')));
  // tenants are isolated
  assert.equal(openStore(home, { tenant: 'acme' }).list({ drafts: true }).length, 1);
  assert.equal(openStore(home, { tenant: 'other' }).list({ drafts: true }).length, 0);
});

test('bad tenant names throw', () => {
  for (const t of ['../x', 'A', '', '-a', 'a/b', 'a'.repeat(64)]) {
    assert.throws(() => openStore(tmp(), { tenant: t }), /Invalid tenant/, `"${t}"`);
  }
  assert.ok(TENANT_RE.test('a'.repeat(63)) && TENANT_RE.test('team-1'));
  assert.ok(!TENANT_RE.test('../x'));
});
