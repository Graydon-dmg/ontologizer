// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { familiesPrompt, placementPrompt } from '../../src/core/engine/prompts-organize.js';
import { genItems } from './fixtures/items/gen.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,119}$/;
/** @param {any} it */
function itemProblem(it) {
  if (typeof it.id !== 'string' || !ID_RE.test(it.id)) return 'bad id';
  if (it.id in Object.prototype) return 'prototype id';
  if (typeof it.label !== 'string' || it.label.length < 1 || it.label.length > 80) return 'bad label';
  if (/[\u0000-\u001f\u007f]/.test(it.label)) return 'control char';
  if (it.text !== undefined && (typeof it.text !== 'string' || it.text.length > 500)) return 'bad text';
  return null;
}

const fams = [
  { key: 'lending', label: 'Lending', path: 'Finance › Lending', description: 'Loans and credit.' },
  { key: 'cards', label: 'Cards', path: 'Finance › Cards', description: 'Card payments.' },
];
const items = [{ id: 'pay.refund', label: 'Refund', text: 'Give money back.' }, { id: 'crm:lead-score', label: 'Lead Score' }];

test('routing phrases do not cross', () => {
  const f = familiesPrompt({ name: 'x', items, depth: 3, maxDeepest: 40, total: 2 });
  const p = placementPrompt({ name: 'x', families: fams, items });
  assert.ok(f.system.includes('family tree'));
  assert.ok(!f.system.includes('Place each item'));
  assert.ok(p.system.includes('Place each item'));
  assert.ok(!p.system.includes('family tree'));
  assert.ok(!f.prompt.includes('Place each item') && !p.prompt.includes('family tree'));
});

test('familiesPrompt carries depth, maxDeepest, problems, sample note', () => {
  const problems = ['Top level had 3 families', 'Duplicate label "Cards"'];
  const a = familiesPrompt({ name: 'x', items, depth: 4, maxDeepest: 37, total: 5000, problems });
  const all = a.system + a.prompt;
  assert.ok(all.includes('37'));
  assert.ok(all.includes('4 levels below the root'));
  for (const p of problems) assert.ok(a.prompt.includes(p));
  assert.ok(a.prompt.includes('5000'));
  const b = familiesPrompt({ name: 'x', items, depth: 2, maxDeepest: 9, total: 2 });
  assert.ok(!b.prompt.includes('last attempt'), 'planted fault: no problems section without problems');
  assert.ok(!b.system.includes('2 to 12 children'));
  assert.ok(a.system.includes('2 to 12 children'));
});

test('placementPrompt carries every id and family key; retry sentence only on retry', () => {
  const p = placementPrompt({ name: 'x', families: fams, items });
  for (const it of items) assert.ok(p.prompt.includes(JSON.stringify(it.id)));
  for (const f of fams) assert.ok(p.prompt.includes(JSON.stringify(f.key)));
  assert.ok(!p.prompt.includes('missed last time'));
  assert.ok(placementPrompt({ name: 'x', families: fams, items, retry: true }).prompt.includes('missed last time'));
  assert.ok(!p.prompt.includes('"ghost"'));
});

test('validator rejects planted bad items', () => {
  const ok = { id: 'a.b', label: 'L' };
  assert.equal(itemProblem(ok), null);
  for (const bad of [{ id: 'a/b', label: 'L' }, { id: '_a', label: 'L' }, { id: 'constructor', label: 'L' }, { id: 'a', label: '' }, { id: 'a', label: 'x'.repeat(81) }, { id: 'a', label: 'a\nb' }, { id: 'a', label: 'L', text: 'x'.repeat(501) }]) {
    assert.notEqual(itemProblem(bad), null, JSON.stringify(bad));
  }
});

test('sample-120.json is valid', () => {
  const arr = JSON.parse(readFileSync(new URL('./fixtures/items/sample-120.json', import.meta.url), 'utf8'));
  assert.equal(arr.length, 120);
  for (const it of arr) assert.equal(itemProblem(it), null, it.id);
  assert.equal(new Set(arr.map((/** @type {any} */ i) => i.id)).size, 120);
  assert.ok(new Set(arr.map((/** @type {any} */ i) => i.label[0].toLowerCase())).size >= 10);
});

test('genItems: 10000 unique valid, deterministic', () => {
  const a = genItems(10000);
  assert.equal(a.length, 10000);
  assert.equal(new Set(a.map((i) => i.id)).size, 10000);
  for (const it of a) assert.equal(itemProblem(it), null, it.id);
  assert.deepEqual(genItems(10000), a);
  assert.notDeepEqual(genItems(50, { seed: 2 }), genItems(50, { seed: 1 }));
  assert.equal(genItems(3, { text: false })[0].text, undefined);
  assert.ok(new Set(a.map((i) => i.label[0])).size > 10);
});
