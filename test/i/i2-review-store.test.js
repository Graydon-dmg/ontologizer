// @ts-check
// A draft created with its first events writes events.jsonl durably: a temp file in the same
// directory, fsynced, then renamed into place (a crash can't keep the index row but lose the raise).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../../src/core/store.js';
import { makeEvent } from '../../src/core/events.js';

const BRIEF = { context: 'glue', subject: 'Glue', scope: 's', purpose: 'p', level: 'beginner' };

test('createDraft with events: temp file fsynced, then renamed onto events.jsonl; no temp left; private row', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-i2r-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = openStore(home);
  /** @type {string[]} */ const ops = [];
  const realFsync = fs.fsyncSync; const realRename = fs.renameSync; const realOpen = fs.openSync;
  /** @type {Map<number, string>} */ const fds = new Map();
  fs.openSync = /** @type {any} */ ((/** @type {any} */ p, /** @type {any[]} */ ...rest) => { const fd = realOpen(p, ...rest); fds.set(fd, String(p)); return fd; });
  fs.fsyncSync = (fd) => { ops.push(`fsync ${path.basename(fds.get(/** @type {number} */ (fd)) ?? '?')}`); return realFsync(fd); };
  fs.renameSync = (a, b) => { ops.push(`rename ${path.basename(String(a)).replace(/\.\d+\.\d+\.tmp$/, '.TMP')} -> ${path.basename(String(b))}`); return realRename(a, b); };
  let id = '';
  try {
    id = store.createDraft(BRIEF, 'x', { events: [
      makeEvent('ontology.created', { name: 'Glue Map', root: 'glue', brief: BRIEF, categories: [] }, 0),
      makeEvent('visibility.raised', { to: 'private', reason: 'sources-picked', sources: ['wiki'] }, 0),
    ] });
  } finally {
    fs.fsyncSync = realFsync; fs.renameSync = realRename; fs.openSync = realOpen;
  }
  const evOps = ops.slice(0, ops.findIndex((o) => o === 'rename events.jsonl.TMP -> events.jsonl') + 1);
  assert.ok(evOps.length > 0, `events.jsonl was renamed into place: ${JSON.stringify(ops)}`);
  const fsyncTmp = evOps.findIndex((o) => /^fsync events\.jsonl\.\d+\.\d+\.tmp$/.test(o));
  assert.ok(fsyncTmp >= 0 && fsyncTmp < evOps.length - 1, `the temp file is fsynced before the rename: ${JSON.stringify(ops)}`);
  const files = fs.readdirSync(path.join(store.root, id)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(files, [], 'no temp file left behind');
  const lines = fs.readFileSync(path.join(store.root, id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).t, 'visibility.raised');
  const row = store.list({ drafts: true }).find((r) => r.id === id);
  assert.equal(row?.visibility, 'private');
});
