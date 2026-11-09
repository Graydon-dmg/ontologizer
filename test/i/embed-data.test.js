// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldAll } from '../../src/core/events.js';
import { readMapData } from '../../web/embed/data.js';
import { searchNodes, safeHref, nodeDetails, toggleCollapsed } from '../../web/embed/helpers.js';

const demo = foldAll(readFileSync(new URL('../../fixtures/demo.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));
const EMBED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'embed');

/** The same check applied to the real reader and to the planted bad one. @param {(t: any) => any} reader */
function assertRejectsMalformed(reader) {
  /** @type {[any, string][]} */
  const cases = [
    ['{"nodes": {', 'The map data is not valid JSON'],
    ['', 'No map data found'],
    [undefined, 'No map data found'],
    ['null', 'The map data is not a map'],
    ['[]', 'The map data is not a map'],
    ['{"root":"x"}', 'The map data is not a map'],
    ['{"nodes":[],"root":"x","categories":[],"edges":[]}', 'The map data is not a map'],
    ['{"nodes":{},"root":1,"categories":[],"edges":[]}', 'The map data is not a map'],
    ['{"nodes":{},"root":"x","categories":{},"edges":[]}', 'The map data is not a map'],
    ['{"nodes":{},"root":"x","categories":[],"edges":{}}', 'The map data is not a map'],
  ];
  for (const [text, prefix] of cases) {
    const r = reader(text);
    assert.equal(r.ok, false, `expected rejection of ${JSON.stringify(text)}`);
    assert.ok(r.error.startsWith(prefix), `error for ${JSON.stringify(text)}: ${r.error}`);
  }
}

test('readMapData returns the folded demo exactly, also with < escaped', () => {
  const r = readMapData(JSON.stringify(demo));
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.ontology, demo);
  // The demo has no angle bracket, so plant one in a summary; the exporter writes it escaped.
  const lt = String.fromCharCode(60);
  const withLt = structuredClone(demo);
  withLt.nodes[demo.root].summary = `a ${lt}b>bold${lt}/b> summary`;
  const text = JSON.stringify(withLt);
  const escaped = text.split(lt).join('\\u003c');
  assert.ok(text.includes(lt) && !escaped.includes(lt), 'the text has a bracket and the escaped form does not');
  const r2 = readMapData(escaped);
  assert.ok(r2.ok);
  assert.deepEqual(r2.ok && r2.ontology, withLt);
});

test('malformed tags are errors, never an empty map', () => {
  assertRejectsMalformed(readMapData);
});

test('planted fault: a reader that returns an empty map on parse failure is caught', () => {
  /** @param {any} text */
  const badReader = (text) => {
    try { return readMapData(text).ok ? readMapData(text) : { ok: true, ontology: { nodes: {} } }; } catch { return { ok: true, ontology: { nodes: {} } }; }
  };
  assert.throws(() => assertRejectsMalformed(badReader));
});

test('searchNodes: label matches come first, empty query gives nothing, limit holds', () => {
  assert.deepEqual(searchNodes(demo, ''), []);
  assert.deepEqual(searchNodes(demo, '   '), []);
  const nodes = Object.values(demo.nodes);
  const withSummary = nodes.find((n) => n.summary && n.id !== demo.root);
  assert.ok(withSummary);
  const word = withSummary.label.split(/\s+/)[0].toLowerCase();
  const ids = searchNodes(demo, word.toUpperCase(), 200);
  assert.ok(ids.includes(withSummary.id));
  const firstSummaryOnly = ids.findIndex((id) => !demo.nodes[id].label.toLowerCase().includes(word));
  const lastLabel = ids.map((id) => demo.nodes[id].label.toLowerCase().includes(word)).lastIndexOf(true);
  if (firstSummaryOnly >= 0) assert.ok(lastLabel < firstSummaryOnly, 'label matches precede summary matches');
  assert.ok(searchNodes(demo, word, 1).length <= 1);
  // planted: a summary-only match must come after a label match
  const o = /** @type {any} */ ({ nodes: {
    a: { id: 'a', label: 'Alpha', summary: 'mentions beta' },
    b: { id: 'b', label: 'Beta', summary: '' },
  } });
  assert.deepEqual(searchNodes(o, 'beta'), ['b', 'a']);
});

test('safeHref allows web links only', () => {
  assert.equal(safeHref('https://example.org/a?b=1'), 'https://example.org/a?b=1');
  assert.equal(safeHref('http://example.org/'), 'http://example.org/');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('JaVaScRiPt:alert(1)'), null);
  assert.equal(safeHref('data:text/html,<b>x</b>'), null);
  assert.equal(safeHref('not a url'), null);
  assert.equal(safeHref(''), null);
  assert.equal(safeHref(undefined), null);
});

test('nodeDetails dedupes sources by url and nulls unsafe hrefs', () => {
  const o = /** @type {any} */ ({
    root: 'r',
    nodes: {
      r: { id: 'r', label: 'Root', parent: null, category: '' },
      c: { id: 'c', label: 'Cat', parent: 'r', category: 'c' },
      n: {
        id: 'n', label: 'Node', parent: 'c', category: 'c', summary: 's',
        sources: [{ title: 'One', url: 'https://example.org/1' }, { title: 'Bad', url: 'javascript:alert(1)' }],
        article: { summary: 'as', keyFacts: ['f'], whyItMatters: 'w', seeAlso: [], sources: [{ title: 'One again', url: 'https://example.org/1' }, { title: 'Two', url: 'https://example.org/2' }] },
      },
    },
    view: { collapsed: ['c'] },
  });
  const d = nodeDetails(o, 'n');
  assert.ok(d);
  assert.deepEqual(d.sources, [
    { title: 'One', href: 'https://example.org/1' },
    { title: 'Bad', href: null },
    { title: 'Two', href: 'https://example.org/2' },
  ]);
  assert.equal(d.category, 'Cat');
  assert.deepEqual(d.article, { summary: 'as', keyFacts: ['f'], whyItMatters: 'w' });
  assert.equal(d.childCount, 0);
  const c = nodeDetails(o, 'c');
  assert.ok(c && c.childCount === 1 && c.collapsed === true && c.article === null);
  assert.equal(nodeDetails(o, 'missing'), null);
  const rd = nodeDetails(demo, demo.root);
  assert.ok(rd && rd.childCount > 0);
});

test('toggleCollapsed adds and removes without mutating', () => {
  const a = Object.freeze(['x']);
  const added = toggleCollapsed(/** @type {string[]} */ (a), 'y');
  assert.deepEqual(added, ['x', 'y']);
  assert.deepEqual(a, ['x']);
  const removed = toggleCollapsed(added, 'x');
  assert.deepEqual(removed, ['y']);
  assert.deepEqual(added, ['x', 'y']);
});

test('purity: data.js and helpers.js touch no DOM or network; no embed file names a network API', () => {
  for (const f of ['data.js', 'helpers.js']) {
    const src = readFileSync(path.join(EMBED, f), 'utf8');
    for (const w of ['document', 'window', 'fetch']) assert.ok(!src.includes(w), `${f} contains ${w}`);
  }
  const banned = ['fetch(', 'XMLHttpRequest', 'EventSource', 'WebSocket', 'import(', 'http://', 'https://'];
  const files = readdirSync(EMBED).filter((f) => statSync(path.join(EMBED, f)).isFile());
  assert.ok(files.length >= 5);
  for (const f of files) {
    const src = readFileSync(path.join(EMBED, f), 'utf8');
    for (const b of banned) assert.ok(!src.includes(b), `${f} contains ${b}`);
    assert.ok(!src.includes('url('), `${f} contains url(`);
  }
});
