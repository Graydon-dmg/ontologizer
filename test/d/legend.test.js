import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import { legendGroups, isFused, fusedSwatches } from '../../web/shell/legend.js';
import * as tokens from '../../web/shared/tokens.js';

const cat = (id, index, family) => ({ t: 'category.added', at: 1, category: { id, label: id, index, family } });
const events = [
  { t: 'ontology.created', at: 0, name: 'Fused', root: 'r', brief: { context: '', subject: '', scope: '', purpose: '', level: 'beginner' }, categories: [] },
  cat('h', 0, 2), cat('a1', 1, 0), cat('b0', 0, 1), cat('a0', 0, 0), cat('b1', 1, 1),
];

// Planted fault: a legend that ignores family.
const ignoreFamily = (o, t) => [{
  family: 0, title: '',
  items: o.categories.map((c) => ({ id: c.id, label: c.label, color: t.categoryColor(c.index, 0) })),
}];

function checkThreeGroups(fn, o) {
  const g = fn(o, tokens);
  assert.deepEqual(g.map((x) => x.family), [0, 1, 2]);
  assert.ok(g[2].title.endsWith('Hybrids'));
}

test('A snapshot with categories of families 0, 1 and 2 renders a legend in three groups, in that order', () => {
  const o = foldAll(events);
  checkThreeGroups(legendGroups, o);
  assert.throws(() => checkThreeGroups(ignoreFamily, o), assert.AssertionError);
  const g = legendGroups(o, tokens);
  assert.deepEqual(g[0].items.map((i) => i.id), ['a0', 'a1']);
  assert.equal(g[2].items[0].color, tokens.categoryColor(0, 2));
  assert.equal(isFused(o), true);
  const s = fusedSwatches(tokens);
  assert.deepEqual(s.bridge, tokens.edgeStyle('bridge'));
  assert.equal(s.hybrid.double, true);
});

test('The plastic-modeling fixture gives one group of 8 items', () => {
  const evs = readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const o = foldAll(evs);
  const g = legendGroups(o, tokens);
  assert.equal(g.length, 1);
  assert.equal(g[0].items.length, 8);
  assert.equal(g[0].title, '');
  assert.equal(isFused(o), false);
  // planted fault: a legend that splits each category into its own group fails the shape check
  const splitting = (oo, t) => oo.categories.map((c) => ({ family: 0, title: '', items: [{ id: c.id }] }));
  assert.throws(() => assert.equal(splitting(o, tokens).length, 1), assert.AssertionError);
});

import { sourceMapName, shortName } from '../../web/shell/legend.js';

test('fused legend headings use the source map names (shortened), and keep "Hybrids"', async () => {
  const tokens = await import('../../web/shared/tokens.js');
  const { legendGroups: groups } = await import('../../web/shell/legend.js');
  const n = (/** @type {any} */ x) => ({ origin: 'fuse', sources: [], article: null, status: 'done', createdBy: 'fuse', ...x });
  const o = foldAll([
    { t: 'ontology.created', at: 0, name: 'gunpla', root: 'g', brief: {}, categories: [] },
    { t: 'category.added', at: 1, category: { id: 'manga/genres', label: 'Genres', index: 0, family: 1 } },
    { t: 'category.added', at: 1, category: { id: 'pm/tools', label: 'Tools', index: 0, family: 0 } },
    { t: 'category.added', at: 1, category: { id: 'hybrids', label: 'Hybrids', index: 1, family: 2 } },
    { t: 'node.added', at: 2, node: n({ id: 'g', label: 'Gunpla', parent: null, category: '', depth: 0 }) },
    { t: 'node.added', at: 2, node: n({ id: 'pm', label: 'Scale plastic modeling of 1/72 World War II aircraft kits', parent: 'g', category: '', depth: 1 }) },
    { t: 'node.added', at: 2, node: n({ id: 'manga', label: 'Japanese manga', parent: 'g', category: '', depth: 1 }) },
    { t: 'node.added', at: 3, node: n({ id: 'pm/tools', label: 'Tools', parent: 'pm', category: 'pm/tools', depth: 2 }) },
    { t: 'node.added', at: 3, node: n({ id: 'manga/genres', label: 'Genres', parent: 'manga', category: 'manga/genres', depth: 2 }) },
  ]);
  const titles = groups(o, tokens).map((g) => g.title);
  assert.equal(titles[1], 'Japanese manga');
  assert.equal(titles[2], 'Hybrids');
  assert.ok(titles[0].startsWith('Scale plastic modeling') && titles[0].length <= 28 && titles[0].endsWith('…'), titles[0]);
  // planted fault: generic headings
  assert.throws(() => assert.equal(['Map 1', 'Map 2', 'Hybrids'][1], titles[1]));
  // fallbacks: no category nodes -> depth-1 roots in order; nothing -> "Map N"
  assert.equal(sourceMapName({ categories: [], nodes: { a: { depth: 1, category: '', label: 'A map' } } }, 0), 'A map');
  assert.equal(sourceMapName({ categories: [], nodes: {} }, 1), 'Map 2');
  assert.equal(shortName('Short'), 'Short');
});
