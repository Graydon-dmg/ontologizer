// @ts-check
// `ontologizer list` reads only the index (never a map's event log), keeps the 1.4.0 columns in
// place, and adds a last visibility column only when some map is private.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import list from '../../src/cli/commands/list.js';

/** @param {any[]} rows */
async function runList(rows) {
  let out = '';
  const store = {
    list: () => rows,
    read: () => { throw new Error('list must not read event logs'); },
  };
  await list.handler({ drafts: false, deps: { store: () => store, stdout: { write: (/** @type {string} */ s) => { out += s; return true; } } } });
  return out;
}

const AT = Date.UTC(2026, 0, 2, 3, 4, 5);
const ISO = new Date(AT).toISOString();

test('list: all public prints exactly the 1.4.0 lines (no visibility column), without reading any map', async () => {
  const out = await runList([
    { id: 'glue', name: 'Glue Map', nodes: 12, updatedAt: AT },
    { id: 'draft-1', name: 'draft-1', nodes: 0, updatedAt: AT, draft: true },
  ]);
  assert.equal(out, `glue  Glue Map  12 nodes  ${ISO}\ndraft-1  (draft)  0 nodes  ${ISO}\n`);
});

test('list: with a private map, visibility is the last column on every row, from the index row', async () => {
  const out = await runList([
    { id: 'glue', name: 'Glue Map', nodes: 12, updatedAt: AT },
    { id: 'secret', name: 'secret', nodes: 3, updatedAt: AT, visibility: 'private', privateSources: ['wiki'] },
  ]);
  assert.equal(out, `glue  Glue Map  12 nodes  ${ISO}  public\nsecret  3 nodes  ${ISO}  private\n`);
});
