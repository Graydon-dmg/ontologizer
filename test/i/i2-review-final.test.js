// @ts-check
// Final review fixes: an admin-only map is never widened by a later source; a closed files store is forgotten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fold } from '../../src/core/events.js';
import { openStore } from '../../src/core/store.js';

test('an admin-only private map stays admin only when a later private source is used', () => {
  let o = /** @type {any} */ ({ nodes: {}, edges: [], categories: [], visibility: 'public', privateSources: [] });
  o = fold(o, { t: 'visibility.raised', at: 1, to: 'private', reason: 'fuse', sources: [] });
  assert.equal(o.visibility, 'private');
  o = fold(o, { t: 'visibility.raised', at: 2, to: 'private', reason: 'source', sources: ['wiki'] });
  assert.deepEqual(o.privateSources, [], 'a later source widened an admin-only map');
});

test('a map private by a source still gains later sources (each one narrows who may read)', () => {
  let o = /** @type {any} */ ({ nodes: {}, edges: [], categories: [], visibility: 'public', privateSources: [] });
  o = fold(o, { t: 'visibility.raised', at: 1, to: 'private', reason: 'source', sources: ['a'] });
  o = fold(o, { t: 'visibility.raised', at: 2, to: 'private', reason: 'source', sources: ['b'] });
  assert.deepEqual(o.privateSources, ['a', 'b']);
});

test('a files store has close(), which can be called safely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-close-'));
  try {
    const s = /** @type {any} */ (openStore(dir));
    assert.equal(typeof s.close, 'function');
    s.close();
    s.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
