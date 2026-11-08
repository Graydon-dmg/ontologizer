// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { generate } from '../../scripts/third-party-notices.js';

const root = new URL('../../', import.meta.url);
const MIT_SHA256 = '4125d87c000fb322022937c5a82593396eb90350f98e49d7a536ee7bb82df832';
const read = (/** @type {string} */ f) => readFileSync(new URL(f, root), 'utf8');

/** Problems with the committed notices against a freshly generated copy. @param {string} committed @param {string} fresh */
function checkNotices(committed, fresh) {
  return committed === fresh ? [] : ['THIRD_PARTY_NOTICES.md is stale: run node scripts/third-party-notices.js'];
}

test('LICENSE is the project MIT text, byte for byte, and package.json agrees', () => {
  // The MIT text first landed in 3dc0a85 (1071 bytes); restored unchanged.
  const buf = readFileSync(new URL('LICENSE', root));
  assert.equal(createHash('sha256').update(buf).digest('hex'), MIT_SHA256);
  assert.ok(buf.toString('utf8').startsWith('MIT License\n\nCopyright (c) 2026 Graydon Garden\n'));
  assert.equal(JSON.parse(read('package.json')).license, 'MIT');
});

test('THIRD_PARTY_NOTICES.md is generated from the lockfile and up to date', () => {
  assert.deepEqual(checkNotices(read('THIRD_PARTY_NOTICES.md'), generate()), []);
});

test('planted fault: a hand-edited notices file is reported stale', () => {
  const edited = read('THIRD_PARTY_NOTICES.md').replace('| d3-force |', '| d3-farce |');
  assert.equal(checkNotices(edited, generate()).length, 1);
});

test('every lockfile package is listed with a licence', () => {
  const lock = JSON.parse(read('package-lock.json'));
  const doc = read('THIRD_PARTY_NOTICES.md');
  for (const [path, meta] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.ok(meta.license, `${path} has no licence in the lockfile`);
    assert.ok(doc.includes(` | ${meta.version} | ${meta.license} | `), `${path} missing from notices`);
  }
});
