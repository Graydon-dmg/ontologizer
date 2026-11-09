// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import { contextPack, estimateTokens, CONTEXT_HEADINGS } from '../../src/core/export/context.js';
import { checkContextPack } from './context-check.js';

/** @param {string} name */
const load = (name) => foldAll(readFileSync(new URL(`../../fixtures/${name}.events.jsonl`, import.meta.url), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));

const demo = load('demo');
const lastLine = (/** @type {string} */ t) => t.trimEnd().split('\n').pop() ?? '';

test('the demo pack passes the checker at three budgets, and says when it trimmed', () => {
  for (const budget of [4000, 1500, 800]) {
    const text = contextPack(demo, { budget });
    assert.deepEqual(checkContextPack(text, demo, budget), [], `budget ${budget}`);
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
    if (budget < 4000) assert.ok(lastLine(text).startsWith('_Trimmed'), `budget ${budget}`);
  }
  assert.equal(contextPack(demo, { budget: 4000 }), contextPack(demo, { budget: 4000 }), 'deterministic');
});

test('planted fault: a trim that deletes a root-child line is reported', () => {
  const text = contextPack(demo, { budget: 1500 });
  const child = Object.values(demo.nodes).find((n) => n.parent === demo.root);
  assert.ok(child);
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`  - ${child.label}`));
  assert.ok(i > 0);
  lines.splice(i, 1);
  assert.ok(checkContextPack(lines.join('\n'), demo, 1500).some((p) => p.includes('root child missing')));
});

test('planted fault: swapped headings and padding past the budget are reported', () => {
  const text = contextPack(demo, { budget: 1500 });
  const swapped = text.replace('## Bridges', '## @@').replace('## Insights', '## Bridges').replace('## @@', '## Insights');
  assert.ok(checkContextPack(swapped, demo, 1500).some((p) => p.includes('headings')));
  const padded = text + 'x'.repeat(4 * 1500);
  assert.ok(checkContextPack(padded, demo, 1500).some((p) => p.includes('over budget')));
});

test('planted fault: a trimmer that cuts the top level first fails the checker', () => {
  const text = contextPack(demo, { budget: 1500 });
  const wrong = text.split('\n').filter((l) => !l.startsWith('  - ') || l.startsWith('    ')).join('\n');
  assert.ok(checkContextPack(wrong, demo, 1500).length > 0);
});

const depthOf = (/** @type {string} */ l) => (l.length - l.trimStart().length) / 2;
const outlineOf = (/** @type {string} */ t) => {
  const ls = t.split('\n');
  return ls.slice(ls.indexOf('## Outline') + 1, ls.indexOf('## Bridges')).filter((l) => l.trim());
};

test('trim order: deepest depth goes first, depth 1 stays, shallow summaries outlive deep ones', () => {
  const deep = load('plastic-modeling');
  const full = outlineOf(contextPack(deep, { budget: 100000 }));
  const maxFull = Math.max(...full.map(depthOf));
  assert.ok(maxFull >= 3);
  const cut = contextPack(deep, { budget: 1500 });
  const lines = outlineOf(cut);
  assert.ok(Math.max(...lines.map(depthOf)) < maxFull, 'deepest depth dropped');
  assert.ok(lines.some((l) => depthOf(l) === 1));
  assert.equal(lines.filter((l) => depthOf(l) === 1).length, full.filter((l) => depthOf(l) === 1).length);

  // summaries are only cut after the depths are, deepest first, the root's last
  const sums = (/** @type {number} */ b) => {
    const ls = outlineOf(contextPack(deep, { budget: b }));
    const at = (/** @type {number} */ d) => ls.filter((l) => depthOf(l) === d && l.includes(': ')).length;
    return { deepest: Math.max(...ls.map(depthOf)), d0: at(0), d1: at(1), total: ls.filter((l) => l.includes(': ')).length };
  };
  const roomy = sums(1200);
  assert.equal(roomy.deepest, 1);
  assert.ok(roomy.d1 > 0, 'depth-1 summaries survive after the deeper depths are gone');
  const tight = sums(1000);
  assert.equal(tight.d1, 0, 'depth-1 summaries go next');
  assert.equal(tight.d0, 1, 'the root summary outlives them');
  let prev = Infinity;
  for (let b = 4000; b >= 400; b -= 100) {
    const t = sums(b).total;
    assert.ok(t <= prev, `summaries never come back as the budget shrinks (${b})`);
    prev = t;
  }
});

test('private maps carry the mark on line 1; public ones start with the title', () => {
  const plastic = { ...demo, name: 'Scale Plastic Modeling' };
  const pub = contextPack(plastic, { budget: 1500 });
  assert.equal(pub.split('\n')[0], '# Scale Plastic Modeling');
  const priv = /** @type {any} */ ({ ...plastic, visibility: 'private' });
  const text = contextPack(priv, { budget: 1500 });
  assert.ok(text.split('\n')[0].includes('Private'));
  assert.deepEqual(checkContextPack(text, priv, 1500), []);
  assert.ok(checkContextPack(text.split('\n').slice(2).join('\n'), priv, 1500).some((p) => p.includes('Private')));
});

/** @returns {any} */
function synthetic() {
  const mk = (/** @type {string} */ id, /** @type {string|null} */ parent, /** @type {string} */ category, depth, /** @type {any} */ extra = {}) =>
    ({ id, label: id.toUpperCase(), parent, category, depth, summary: `About ${id}`, hook: '', origin: 'seed', sources: [], article: null, status: 'done', createdBy: 'wave0', ...extra });
  const art = (/** @type {string} */ url) => ({ summary: 's', keyFacts: [], whyItMatters: '', seeAlso: [], sources: [{ title: 'Same', url }] });
  return {
    name: 'Synthetic', root: 'r', version: 1,
    brief: { context: 'c', subject: 's', scope: 'sc', purpose: 'p', level: 'beginner' },
    categories: [{ id: 'a', label: 'Alpha', index: 0, family: 0 }, { id: 'b', label: 'Beta', index: 1, family: 0 }],
    nodes: {
      r: mk('r', null, '', 0),
      a: mk('a', 'r', 'a', 1, { article: art('https://a.example/x'), sources: [{ title: 'First', url: 'https://a.example/x' }] }),
      a1: mk('a1', 'a', 'a', 2),
      b: mk('b', 'r', 'b', 1, { article: art('https://a.example/x/#top') }),
    },
    edges: [
      { id: 'e1', from: 'a', to: 'a1', type: 'influences', why: 'same category' },
      { id: 'e2', from: 'a1', to: 'b', type: 'requires', why: 'cross category' },
    ],
    lenses: {}, view: {}, jobs: {}, insights: [{ at: 1, text: 'An insight', nodeId: 'a1' }], chat: [],
  };
}

test('bridges list only cross-category edges; sources dedupe by normalized URL', () => {
  const text = contextPack(synthetic(), { budget: 4000 });
  assert.ok(text.includes('- A1 → B (requires): cross category'));
  assert.ok(!text.includes('same category'));
  const urls = text.split('\n').filter((l) => l.includes('https://a.example/x'));
  assert.equal(urls.length, 1);
  assert.equal(urls[0], '- First: https://a.example/x');
  assert.ok(text.includes('- An insight (A1)'));
  assert.ok(text.includes('[explained]'));
});

test('planted fault: a checker given the same-category edge as a bridge would be wrong', () => {
  const text = contextPack(synthetic(), { budget: 4000 });
  const bridges = text.split('## Bridges')[1].split('## Insights')[0];
  assert.equal(bridges.split('\n').filter((l) => l.startsWith('- ')).length, 1);
});

test('empty sections say None yet; a tiny budget does not throw and keeps all headings', () => {
  const text = contextPack(demo, { budget: 800 });
  assert.ok(text.includes('## Sources\nNone yet.'));
  const tiny = contextPack(demo, { budget: 5 });
  assert.deepEqual(tiny.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3)), CONTEXT_HEADINGS);
  assert.ok(estimateTokens(tiny) > 5);
});

test('thin areas list categories for the demo', () => {
  const text = contextPack(demo, { budget: 4000 });
  const thin = text.split('## Thin areas\n')[1].split('\n## ')[0];
  assert.ok(!thin.startsWith('None yet.'));
  for (const c of demo.categories) assert.ok(thin.includes(`- ${c.label}: `), c.label);
});

test('context.js is pure: no node: imports, no document or process', () => {
  const src = readFileSync(new URL('../../src/core/export/context.js', import.meta.url), 'utf8');
  assert.ok(!/import[^;]*from\s+['"]node:/.test(src));
  assert.ok(!/\bdocument\b|\bprocess\b/.test(src.replace(/\/\/.*$/gm, '')));
});
