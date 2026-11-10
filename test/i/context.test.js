// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import { contextPack, estimateTokens, CONTEXT_HEADINGS } from '../../src/core/export/context.js';
import { checkContextPack, missingLabels, sameNameBridges } from './context-check.js';

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

test('at a budget that fits labels but not summaries, every node label is still there', () => {
  // 2000, not the menu's 4000: the outline carries node ids, so the demo's labels and ids alone need about 1900.
  const text = contextPack(demo, { budget: 2000 });
  // Leaf summaries go first; the root's children lose theirs last, from the end, only as many as needed.
  const m = lastLine(text).match(/^_Trimmed to fit 2000 tokens: summaries at depth 2(?: and (\d+) of 9 at depth 1)?\._$/);
  assert.ok(m, lastLine(text));
  assert.deepEqual(missingLabels(text, demo), []);
  assert.deepEqual(checkContextPack(text, demo, 2000), []);
  const children = Object.values(demo.nodes).filter((x) => x.parent === demo.root);
  /** The outline line of a root child with its summary: "  - Label (…/id): summary". @param {any} n */
  const withSummary = (n) => text.includes(`  - ${n.label} (…/${n.id.slice(demo.root.length + 1)}): `);
  const kept = children.filter(withSummary);
  assert.equal(kept.length, children.length - Number(m[1] ?? 0));
  assert.ok(kept.length >= 7, `${kept.length} of the root's children keep their summaries`);
  assert.ok(withSummary(children[0]), 'cut from the end of the outline');
});

test('planted fault: the old depth-first trim (leaf labels cut before summaries) is reported', () => {
  const full = contextPack(demo, { budget: 4000 });
  const old = full.split('\n').filter((l) => !l.startsWith('    - ')).join('\n') + '\n_Trimmed to fit 1500 tokens: outline depth 2 (72 nodes)._\n';
  assert.ok(estimateTokens(old) <= 1500, 'the old trim did fit the budget');
  assert.equal(missingLabels(old, demo).length, 72);
});

test('trim order: summaries deepest first (the root before its children), then bridges and sources, then labels', () => {
  const deep = load('plastic-modeling');
  const full = outlineOf(contextPack(deep, { budget: 100000 }));
  const maxFull = Math.max(...full.map(depthOf));
  assert.ok(maxFull >= 3);
  const at = (/** @type {string[]} */ ls, /** @type {number} */ d) => ({
    rows: ls.filter((l) => depthOf(l) === d).length,
    sums: ls.filter((l) => depthOf(l) === d && l.includes(': ')).length,
  });
  let prevLabels = Infinity;
  let prevSums = Infinity;
  let sawLabelsOnly = false;
  for (let b = 4000; b >= 300; b -= 50) {
    const text = contextPack(deep, { budget: b });
    const ls = outlineOf(text);
    const note = lastLine(text);
    const sums = ls.filter((l) => l.includes(': ')).length;
    assert.ok(ls.length <= prevLabels && sums <= prevSums, `nothing comes back as the budget shrinks (${b})`);
    prevLabels = ls.length;
    prevSums = sums;
    if (ls.length === full.length) {
      if (sums === 0) sawLabelsOnly = true;
    } else {
      // Labels only go after every summary and after the bridges were cut.
      assert.equal(sums, 0, `labels dropped while summaries remain (${b})`);
      assert.match(note, /bridges/, `labels dropped before bridges (${b})`);
      assert.equal(at(ls, 1).rows, at(full, 1).rows, `root children stay (${b})`);
    }
    // Deepest summaries go first; any depth-1 summary outlives the root's and every deeper one.
    for (let d = 2; d <= maxFull; d++) {
      if (at(ls, d).sums > 0) assert.equal(at(ls, d - 1).sums, at(ls, d - 1).rows, `depth ${d - 1} summaries cut before depth ${d} (${b})`);
    }
    if (at(ls, 1).sums < at(ls, 1).rows) assert.equal(at(ls, 0).sums, 0, `root summary outlived its children's (${b})`);
  }
  assert.ok(sawLabelsOnly, 'some budget keeps every label with no summaries');
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

const thinOf = (/** @type {string} */ t) => t.split('## Thin areas\n')[1].split('\n## ')[0];

test('thin areas on a fresh map: one line, not one per category', () => {
  const thin = thinOf(contextPack(demo, { budget: 4000 }));
  assert.equal(thin.trim(), '- Nothing explained or sourced yet: every branch is thin.');
});

test('thin areas with partial coverage: a line per category, thinnest first, plus uncovered nodes there', () => {
  const id = Object.keys(demo.nodes).find((k) => demo.nodes[k].depth === 2);
  assert.ok(id);
  const n = demo.nodes[id];
  const partial = { ...demo, nodes: { ...demo.nodes, [id]: { ...n, article: { summary: 's', keyFacts: [], whyItMatters: '', seeAlso: [], sources: [] } } } };
  const thin = thinOf(contextPack(partial, { budget: 4000 }));
  assert.ok(!thin.includes('Nothing explained'));
  for (const c of demo.categories) assert.ok(thin.includes(`- ${c.label}: `), c.label);
  const cat = demo.categories.find((c) => c.id === n.category);
  assert.ok(thin.includes(`(${cat?.label}): no explanation, no sources`), 'uncovered nodes in the covered category are named');
  assert.ok(thin.includes(`- ${cat?.label}: 1 of `), 'the covered category shows its count');
  // Planted fault: a pack that kept the per-category lines on a fresh map would not match.
  assert.notEqual(thinOf(contextPack(demo, { budget: 4000 })).trim(), thin.trim());
});

test('a label shared by two nodes is named with its category; unique labels stay bare', () => {
  const text = contextPack(demo, { budget: 4000 });
  assert.ok(text.includes('- Panel Lining (Painting Techniques) → Panel Lining (Weathering Techniques) (analog): '), 'the shared label is told apart');
  assert.ok(text.includes('- Canopy Glue → Clear Coats (influences): '), 'unique labels unchanged');
  assert.deepEqual(sameNameBridges(text), []);
  // Outline lines stay bare: the tree already shows where each one sits.
  assert.equal(text.split('\n').filter((l) => /^- Panel Lining \(…\/panel-lining\):/.test(l.trim())).length, 2);
  // An insight that points at a shared label is qualified too.
  const pl = 'scale-plastic-modeling/weathering-techniques/panel-lining';
  const withInsight = { ...demo, insights: [...demo.insights, { at: 1, text: 'Lines read better after a gloss coat.', nodeId: pl }] };
  assert.ok(contextPack(withInsight, { budget: 4000 }).includes('- Lines read better after a gloss coat. (Panel Lining (Weathering Techniques))'));
});

test('two same-label nodes in the same category are told apart by their parent', () => {
  const a = 'scale-plastic-modeling/core-hand-tools';
  const kids = Object.values(demo.nodes).filter((n) => n.parent === a).slice(0, 2);
  assert.equal(kids.length, 2);
  const cat = /** @type {any} */ (demo.nodes[a]).category;
  // Make a grandchild of each with the same label, both in the same category.
  const mk = (/** @type {any} */ p, /** @type {string} */ id) => ({ id, label: 'Grip', parent: p.id, category: cat, depth: 3, origin: 'general', sources: [], article: null, status: 'done', createdBy: 'test', summary: 'x' });
  const g1 = mk(kids[0], `${kids[0].id}/grip`);
  const g2 = mk(kids[1], `${kids[1].id}/grip`);
  const o = { ...demo, nodes: { ...demo.nodes, [g1.id]: g1, [g2.id]: g2 }, edges: [...demo.edges, { id: 'e-grip', from: g1.id, to: 'scale-plastic-modeling/paints-and-finishes', type: 'influences', why: 'test' }],
    insights: [{ at: 1, text: 'Grip matters.', nodeId: g2.id }] };
  const text = contextPack(/** @type {any} */ (o), { budget: 100000 });
  assert.ok(text.includes(`- Grip (Core Hand Tools, under ${kids[0].label}) → `), text.split('## Bridges')[1].slice(0, 300));
  assert.ok(text.includes(`(Grip (Core Hand Tools, under ${kids[1].label}))`));
});

test('planted fault: a pack that only tells same-label nodes apart when both share a category is reported', () => {
  // The faulty rule: qualify a shared label only when both ends of the bridge are in one category.
  const faulty = demo.edges.map((e) => {
    const a = demo.nodes[e.from];
    const b = demo.nodes[e.to];
    const qualify = a.label === b.label && a.category === b.category;
    const name = (/** @type {any} */ n) => (qualify ? `${n.label} (${n.category})` : n.label);
    return `- ${name(a)} → ${name(b)} (${e.type}): ${e.why}`;
  });
  const text = contextPack(demo, { budget: 4000 });
  const lines = text.split('\n');
  const faultyPack = [...lines.slice(0, lines.indexOf('## Bridges') + 1), ...faulty, '', ...lines.slice(lines.indexOf('## Insights'))].join('\n');
  assert.deepEqual(sameNameBridges(faultyPack), ['- Panel Lining → Panel Lining (analog): Same technique listed in both branches: dark lines in recessed panel detail.']);
});

test('context.js is pure: no node: imports, no document or process', () => {
  const src = readFileSync(new URL('../../src/core/export/context.js', import.meta.url), 'utf8');
  assert.ok(!/import[^;]*from\s+['"]node:/.test(src));
  assert.ok(!/\bdocument\b|\bprocess\b/.test(src.replace(/\/\/.*$/gm, '')));
});
