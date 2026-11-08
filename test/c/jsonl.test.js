// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonLines } from '../../src/core/engine/jsonl.js';

/** @param {AsyncGenerator<any>} gen */
async function collect(gen) { const out = []; for await (const o of gen) out.push(o); return out; }

test('a line split across chunks yields exactly one object', async () => {
  const out = await collect(jsonLines(['{"label":"Adhe', 'sives"}\n']));
  assert.deepEqual(out, [{ label: 'Adhesives' }]);
});

test('planted fault: a per-chunk parser would drop the split line', async () => {
  // The fault the check exists for: parsing each chunk on its own yields nothing.
  const naive = ['{"label":"Adhe', 'sives"}\n'].flatMap((c) => { try { return [JSON.parse(c)]; } catch { return []; } });
  assert.equal(naive.length, 0);
  assert.equal((await collect(jsonLines(['{"label":"Adhe', 'sives"}\n']))).length, 1);
});

test('skips fence lines, prose lines and blank lines without throwing', async () => {
  const text = '```json\nHere are the categories:\n\n{"label":"Tools"}\n[1,2]\n{"label":"Kits"}\n```\n';
  const out = await collect(jsonLines(text.match(/[\s\S]{1,5}/g) ?? []));
  assert.deepEqual(out, [{ label: 'Tools' }, { label: 'Kits' }]);
});

test('the last line parses without a trailing newline', async () => {
  assert.deepEqual(await collect(jsonLines(['{"a":1}\n{"b"', ':2}'])), [{ a: 1 }, { b: 2 }]);
});

test('yields each line as soon as it closes, before the input ends', async () => {
  let ended = false;
  async function* chunks() { yield '{"a":1}\n'; await new Promise((r) => setTimeout(r, 20)); ended = true; yield '{"b":2}\n'; }
  for await (const o of jsonLines(chunks())) { if (o.a) assert.equal(ended, false); }
});
