import test from 'node:test';
import assert from 'node:assert/strict';
import { foldAll } from '../../src/core/events.js';
import { lineRows } from '../../web/shell/legend.js';
import * as tokens from '../../web/shared/tokens.js';
import { LINK_TYPES } from '../../src/core/engine/build.js';
import { wave2Prompt } from '../../src/core/engine/prompts.js';

const n = (id, parent, depth) => ({ t: 'node.added', at: 1, node: { id, label: id, parent, category: '', depth, origin: 'seed', sources: [], article: null, status: 'done', createdBy: 'build' } });
const edge = (id, type) => ({ t: 'edge.added', at: 2, edge: { id, from: 'a', to: 'b', type, why: '' } });
const base = [
  { t: 'ontology.created', at: 0, name: 'M', root: 'r', brief: {}, categories: [] },
  n('r', null, 0), n('a', 'r', 1), n('b', 'r', 1),
];

/** Every link type has a legend row with a label, a meaning and a distinct (non-default) style. */
function checkTable(types, kinds) {
  const byType = new Map(kinds.map((k) => [k.type, k]));
  const fallback = tokens.edgeStyle('__none__');
  for (const t of types) {
    const k = byType.get(t);
    assert.ok(k, `no legend row for link type "${t}"`);
    assert.ok(k.label && k.meaning, `row for "${t}" needs a label and a meaning`);
    assert.notDeepEqual(tokens.edgeStyle(t), fallback, `no edge style for "${t}"`);
  }
}

test('every model link type (LINK_TYPES) has a legend row and a style; a kind missing from the table fails', () => {
  checkTable(LINK_TYPES, tokens.EDGE_KINDS);
  assert.equal(tokens.EDGE_KINDS.length, LINK_TYPES.size);
  // planted fault: the table loses "analog"
  assert.throws(() => checkTable(LINK_TYPES, tokens.EDGE_KINDS.filter((k) => k.type !== 'analog')), /analog/);
});

test('the Lines key shows the branch row plus exactly the kinds present, in table order, with table labels', () => {
  const o = foldAll([...base, edge('e1', 'analog'), edge('e2', 'influences'), edge('e3', 'analog'), edge('e4', 'mystery')]);
  const rows = lineRows(o, tokens);
  assert.deepEqual(rows.map((r) => r.type), ['branch', 'influences', 'analog']);
  assert.equal(rows[0].label, 'branch');
  assert.equal(rows[0].meaning, 'idea and its parent');
  assert.equal(rows[0].style, null);
  for (const r of rows.slice(1)) {
    const k = tokens.EDGE_KINDS.find((x) => x.type === r.type);
    assert.equal(r.label, k.label);
    assert.equal(r.meaning, k.meaning);
    assert.deepEqual(r.style, tokens.edgeStyle(r.type));
  }
  // a map with no cross-links keeps only the branch row
  assert.deepEqual(lineRows(foldAll(base), tokens).map((r) => r.type), ['branch']);
  // planted fault: a key that always lists every kind is not "exactly the kinds present"
  const all = (oo, t) => [{ type: 'branch' }, ...t.EDGE_KINDS];
  assert.throws(() => assert.deepEqual(all(o, tokens).map((r) => r.type), rows.map((r) => r.type)), assert.AssertionError);
});

test("wave 2's prompt defines every link type with the legend's meaning, and keeps bridge apart from analog", () => {
  const { system } = wave2Prompt({ subject: 's', context: '', scope: '', purpose: '', level: 'beginner' }, ['A', 'B']);
  for (const k of tokens.EDGE_KINDS) {
    const line = system.split('\n').find((l) => l.startsWith(`- ${k.type}: `));
    assert.ok(line, `prompt has no definition line for "${k.type}"`);
    assert.ok(line.includes(k.meaning), `prompt's "${k.type}" line does not say "${k.meaning}"`);
  }
  assert.match(system, /bridge: .*concrete connection.*Not a likeness/);
  assert.match(system, /Use analog, not bridge, for likenesses/);
});
