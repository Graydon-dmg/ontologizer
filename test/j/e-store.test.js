// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// E: the file store appends in linear time and loads a log of any length. Planted faults prove the
// checks can fail.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../../src/core/store.js';
import { fold, foldInto, foldAll, emptyOntology } from '../../src/core/events.js';

/** @type {string[]} */
const homes = [];
const tmp = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-e-')); homes.push(h); return h; };
after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });

const created = { t: 'ontology.created', at: 0, name: 'Big', root: 'root', brief: { topic: 'big' }, categories: [] };
/** @param {number} i */
const node = (i) => ({ t: 'node.added', at: i + 1, node: { id: `n${i}`, label: `Node ${i}`, parent: 'root', category: 'c', summary: '', tags: [], sources: [{ title: `s${i}`, url: `https://example.com/${i}` }] } });

test('append is linear: 10,000 node.added events through the store take under 2 s and read back equal the oracle', () => {
  const store = openStore(tmp());
  const id = store.createDraft({ topic: 'big' });
  const all = [created, { t: 'node.added', at: 1, node: { id: 'root', label: 'Root', parent: null } }];
  for (let i = 0; i < 10000; i++) all.push(node(i));
  const t = performance.now();
  for (const e of all) store.append(id, e);
  const ms = performance.now() - t;
  console.log(`store.append x ${all.length}: ${ms.toFixed(0)} ms`);
  assert.ok(ms < 2000, `appends took ${ms.toFixed(0)} ms`);
  // foldAll is proven equal to the 1.8.0 oracle in e-fold.test.js (the oracle itself takes seconds here)
  assert.equal(JSON.stringify(store.read(id)), JSON.stringify(foldAll(all)));
  store.close();

  // planted fault: the copying fold that append used before is quadratic. On 3,000 nodes it is
  // already far slower than foldInto, so restoring it in append would blow the 2 s budget at 10k.
  const some = all.slice(0, 3002);
  const t1 = performance.now(); const o1 = emptyOntology(); for (const e of some) foldInto(o1, e);
  const into = performance.now() - t1;
  const t2 = performance.now(); let o2 = emptyOntology(); for (const e of some) o2 = fold(o2, e);
  const pure = performance.now() - t2;
  console.log(`foldInto loop ${into.toFixed(1)} ms, pure fold loop ${pure.toFixed(0)} ms`);
  assert.ok(pure >= 5 * Math.max(into, 1), `pure fold ${pure.toFixed(0)} ms vs foldInto ${into.toFixed(1)} ms`);
});

test('a 150,000-event log loads and reads without a RangeError', () => {
  // planted fault: spreading 150,000 numbers into Math.max overflows the stack on this Node
  const nums = Array.from({ length: 150000 }, (_, i) => i);
  assert.throws(() => Math.max(...nums), RangeError, `Math.max(...150k) did not throw on Node ${process.version}`);

  const home = tmp();
  const s1 = openStore(home);
  const id = s1.createDraft({ topic: 'big' });
  s1.append(id, created);
  s1.append(id, { t: 'node.added', at: 1, node: { id: 'root', label: 'Root', parent: null } });
  s1.flush();
  s1.close();
  const lines = [];
  for (let i = 0; i < 150000; i++) lines.push(JSON.stringify(i % 10 ? { t: 'insight', at: i + 2, text: `i${i}` } : node(i)));
  fs.appendFileSync(path.join(home, id, 'events.jsonl'), lines.join('\n') + '\n');
  const s2 = openStore(home);
  const o = s2.read(id);
  assert.equal(Object.keys(o.nodes).length, 1 + 15000); // the root, then every tenth line
  assert.equal(o.insights.length, 135000);
  s2.append(id, { t: 'insight', at: 200000, text: 'one more' });
  assert.equal(s2.read(id).insights.length, 135001);
  assert.ok(s2.now(id) >= 200000);
  s2.close();
});

