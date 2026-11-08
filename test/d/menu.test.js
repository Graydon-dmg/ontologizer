// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import { menuItems } from '../../web/shell/menu.js';

const events = readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const base = foldAll(events);
const ids = Object.keys(base.nodes);
const parentId = ids.find((id) => ids.some((o) => base.nodes[o].parent === id));
const article = { summary: 's', keyFacts: [], whyItMatters: 'w', seeAlso: [], sources: [] };
const withArticle = foldAll([...events, { t: 'node.updated', at: 1, id: parentId, patch: { article } }]);
const collapsed = foldAll([...events, { t: 'view.changed', at: 2, patch: { collapsed: [parentId] } }]);

const ACCEPTED = ['expand', 'collapse', 'focus', 'layout', 'lens', 'filter', 'research', 'explain', 'sources'];
const has = (items, id) => items.some((i) => i.id === id);

const alwaysExpand = (node, o) => [{ id: 'expand', label: 'Expand', action: { type: 'expand', nodeId: node.id } }, ...menuItems(node, o)];
const badType = (node, o) => menuItems(node, o).map((i) => (i.action?.type === 'explain' ? { ...i, action: { ...i.action, type: 'explainNode' } } : i));

function checkExpandRead(menu) {
  const open = menu(base.nodes[parentId], base);
  assert.ok(!has(open, 'expand'), 'open node has no Expand');
  assert.ok(has(open, 'collapse'));
  assert.ok(has(open, 'explain') && !has(open, 'read'));
  assert.ok(has(menu(collapsed.nodes[parentId], collapsed), 'expand'));
  assert.ok(!has(menu(collapsed.nodes[parentId], collapsed), 'collapse'));
  const read = menu(withArticle.nodes[parentId], withArticle);
  assert.ok(has(read, 'read') && !has(read, 'explain'));
  assert.deepEqual(read.find((i) => i.id === 'read').open, 'explain');
}

function allActions(menu) {
  const out = [];
  for (const o of [base, withArticle, collapsed]) for (const n of Object.values(o.nodes)) for (const i of menu(n, o)) if (i.action) out.push(i.action);
  return out;
}
function checkTypes(menu) {
  const acts = allActions(menu);
  assert.ok(acts.length > 0);
  for (const a of acts) {
    assert.ok(ACCEPTED.includes(a.type), `bad type ${a.type}`);
    if (a.type === 'research') assert.ok(['context', 'general'].includes(a.mode));
    assert.equal(typeof a.nodeId, 'string');
  }
  assert.ok(new Set(acts.map((a) => a.type)).size >= 5);
}

test('menuItems shows Expand only for collapsed nodes and Read explanation only when an article exists', () => {
  checkExpandRead(menuItems);
  assert.throws(() => checkExpandRead(alwaysExpand));
});

test("Every action the menu builds has a type that Epic B's server accepts", () => {
  checkTypes(menuItems);
  assert.throws(() => checkTypes(badType));
});
