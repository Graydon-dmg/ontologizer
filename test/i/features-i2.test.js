// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FEATURES } from '../../src/features.js';

const ROOT = new URL('../../', import.meta.url);
const EXPECT = ['sources-picker', 'private-badge', 'source-refs', 'sources-status'];

/** @param {string} dir @returns {string[]} */
function jsUnder(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...jsUnder(p)); else if (e.name.endsWith('.js')) out.push(fs.readFileSync(p, 'utf8'));
  }
  return out;
}

/** @param {Array<{ id: string, epic: string, ui: { page: string, id: string } }>} rows @returns {string[]} */
function problems(rows) {
  const root = new URL('.', ROOT).pathname;
  const mods = [...jsUnder(`${root}web/shell`), ...jsUnder(`${root}web/home`)].join('\n');
  const out = [];
  for (const id of EXPECT) {
    const f = rows.find((r) => r.id === id);
    if (!f) { out.push(`${id}: missing`); continue; }
    if (f.epic !== 'I2') out.push(`${id}: epic ${f.epic}`);
    const html = fs.readFileSync(new URL(f.ui.page, ROOT), 'utf8');
    if (!new RegExp(`\\bid=["']${f.ui.id}["']`).test(html) && !new RegExp(`['"\`]${f.ui.id}['"\`]`).test(mods)) out.push(`${id}: no element #${f.ui.id}`);
  }
  return out;
}

test('every I2 feature row exists with epic I2 and its button id is found', () => {
  assert.deepEqual(problems(FEATURES), []);
  assert.ok(FEATURES.some((f) => f.id === 'serve' && f.epic === 'I1'));
});

test('planted faults: a missing row, a wrong epic and a missing button are reported', () => {
  assert.deepEqual(problems(FEATURES.filter((f) => f.id !== 'private-badge')), ['private-badge: missing']);
  assert.deepEqual(problems(FEATURES.map((f) => (f.id === 'source-refs' ? { ...f, epic: 'I1' } : f))), ['source-refs: epic I1']);
  assert.deepEqual(problems(FEATURES.map((f) => (f.id === 'sources-picker' ? { ...f, ui: { ...f.ui, id: 'nope' } } : f))), ['sources-picker: no element #nope']);
});
