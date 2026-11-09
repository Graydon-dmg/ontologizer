// @ts-check
// The four export formats (Part I4 checks), each with its planted fault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { exportMap, exportSnapshot, FORMATS } from '../../src/core/export/index.js';
import { readMapData } from '../../web/embed/data.js';
import { bundleText, demo, externalUrlProblems, privateMarkProblems, dataTagText, sizeProblems } from './build-check.js';

const LIVE = 'http://127.0.0.1:8787/?map=demo&x=1';

test('html and embed exports of the demo load nothing from outside; only liveUrl is linked, in an <a href>', async () => {
  const bundle = await bundleText();
  for (const format of /** @type {const} */ (['html', 'embed'])) {
    assert.deepEqual(externalUrlProblems(exportMap(demo(), { format, bundle })), [], format);
    const withLive = exportMap(demo(), { format, bundle, liveUrl: LIVE });
    assert.deepEqual(externalUrlProblems(withLive, { liveUrl: LIVE }), [], `${format} with liveUrl`);
    assert.match(withLive, /<a slot="live" href="http:\/\/127\.0\.0\.1:8787\/\?map=demo&amp;x=1"[^>]*>Open live<\/a>/);
  }
  const page = exportMap(demo(), { format: 'html', bundle: await bundleText(true) });
  assert.deepEqual(externalUrlProblems(page), [], 'html --3d');
});

test('planted fault: an export that loads d3 from a CDN (script, import, css, stray link) is reported', async () => {
  const good = exportMap(demo(), { format: 'html', bundle: await bundleText() });
  const faults = [
    good.replace('</head>', '<script src="https://cdn.example.net/d3@7.9.0/dist/d3.min.js"></script></head>'),
    good.replace('</head>', '<script type="module">import { select } from "https://cdn.example.net/d3-selection";</script></head>'),
    good.replace('</head>', '<style>@font-face{src:url(//fonts.example.net/a.woff2)}</style></head>'),
    good.replace('</head>', '<link rel="stylesheet" href="https://cdn.example.net/x.css"></head>'),
    good.replace('</head>', '<script>import("https://cdn.example.net/x.js")</script></head>'),
  ];
  for (const f of faults) assert.ok(externalUrlProblems(f).length > 0, f.slice(f.indexOf('</style>') - 80, f.indexOf('</head>')));
  // liveUrl is allowed only as that <a href>: the same URL as a script src is still reported.
  const sneaky = good.replace('</head>', `<script src="${LIVE}"></script></head>`);
  assert.ok(externalUrlProblems(sneaky, { liveUrl: LIVE }).length > 0);
});

test('the 2D html export of the demo is under 400 KB', async () => {
  const html = exportMap(demo(), { format: 'html', bundle: await bundleText() });
  assert.deepEqual(sizeProblems(html), []);
});

test('planted fault: a 2D export that bundles three.js is over the limit', async () => {
  const html = exportMap(demo(), { format: 'html', bundle: await bundleText(true) });
  assert.ok(sizeProblems(html).length > 0, `3D page is ${Math.round(html.length / 1024)} KB`);
});

test('with visibility "private", every format carries the Private mark; without it none does', async () => {
  const bundle = await bundleText();
  const priv = { ...demo(), visibility: 'private' };
  for (const format of FORMATS) {
    assert.deepEqual(privateMarkProblems(format, exportMap(/** @type {any} */ (priv), { format, bundle })), [], format);
    assert.ok(privateMarkProblems(format, exportMap(demo(), { format, bundle })).length > 0, `${format} without visibility`);
  }
});

test('planted fault: a json path that skips visibility is reported', () => {
  const priv = /** @type {any} */ ({ ...demo(), visibility: 'private' });
  const faulty = JSON.stringify({ name: priv.name, root: priv.root, nodes: priv.nodes, edges: priv.edges });
  assert.ok(privateMarkProblems('json', faulty).length > 0);
  assert.ok(privateMarkProblems('html', exportMap(priv, { format: 'html', bundle: 'void 0' }).replace(/slot="banner"/, 'slot="x"')).length > 0);
});

test('json is the snapshot exactly as /api/snapshot returns it', () => {
  const o = demo();
  assert.equal(exportMap(o, { format: 'json' }), JSON.stringify(o));
});

test("the embed's data reader parses the demo export's data tag back to the same snapshot", async () => {
  const bundle = await bundleText();
  for (const format of /** @type {const} */ (['html', 'embed'])) {
    const text = dataTagText(exportMap(demo(), { format, bundle }));
    const r = readMapData(text);
    assert.ok(r.ok, format);
    assert.deepEqual(r.ok && r.ontology, exportSnapshot(demo()));
  }
  // For the demo (no chat, every job finished) the exported snapshot is the snapshot itself.
  assert.deepEqual(exportSnapshot(demo()), demo());
});

test('planted fault: a malformed data tag is a clear error, never an empty map', async () => {
  const html = exportMap(demo(), { format: 'embed', bundle: await bundleText() });
  const text = /** @type {string} */ (dataTagText(html));
  const broken = readMapData(text.slice(0, text.length / 2));
  assert.equal(broken.ok, false);
  assert.match(/** @type {any} */ (broken).error, /^The map data is not valid JSON/);
  const wrong = readMapData('{"nodes":{}}');
  assert.equal(wrong.ok, false);
  assert.match(/** @type {any} */ (wrong).error, /^The map data is not a map/);
  // The fault itself: a reader that falls back to an empty map is caught by the same assertion.
  const badReader = (/** @type {string} */ t) => { try { return { ok: true, ontology: JSON.parse(t) }; } catch { return { ok: true, ontology: { nodes: {} } }; } };
  assert.notEqual(badReader(text.slice(0, 10)).ok, false, 'the planted reader really is wrong');
});

test('a label that tries to close the script tag stays data, and round-trips', async () => {
  const o = demo();
  const id = Object.keys(o.nodes)[1];
  const evil = '</script><script>alert(1)</script><!--  ';
  const m = { ...o, nodes: { ...o.nodes, [id]: { ...o.nodes[id], label: evil } } };
  for (const format of /** @type {const} */ (['html', 'embed'])) {
    const out = exportMap(m, { format, bundle: 'void 0' });
    assert.equal((out.match(/<\/script>/g) || []).length, 2, `${format}: only the data tag and the bundle tag close`);
    assert.ok(!out.includes('<!--'));
    const r = readMapData(dataTagText(out));
    assert.ok(r.ok);
    assert.equal(r.ok && r.ontology.nodes[id].label, evil);
  }
  // Planted fault: plain JSON.stringify in the tag would let the label close it early.
  assert.ok(`<script type="application/json">${JSON.stringify(m)}</script>`.match(/<\/script>/g).length > 1);
});

test('planted fault: exportMap refuses a bundle containing "<!--<script>" (second guard after the build)', () => {
  for (const bundle of ['var s="<!--<script>";', 'var s="<!--";', 'var s="<Script>";']) {
    for (const format of /** @type {const} */ (['html', 'embed'])) {
      assert.throws(() => exportMap(demo(), { format, bundle }), /cannot be inlined in a <script> safely/, `${format}: ${bundle}`);
    }
  }
  // A plain </script inside the code is still split, not refused.
  assert.ok(exportMap(demo(), { format: 'embed', bundle: 'var s="</script>";' }).includes('var s="<\\/script>";'));
});

test('the map name and a hostile liveUrl are escaped or refused', () => {
  const o = { ...demo(), name: '"><img src=x onerror=alert(1)>' };
  const html = exportMap(o, { format: 'html', bundle: 'void 0', liveUrl: 'javascript:alert(1)' });
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(!html.includes('slot="live"'));
});

test('html and embed without a bundle explain how to build it; an unknown format is refused', () => {
  assert.throws(() => exportMap(demo(), { format: 'html' }), /npm run build/);
  assert.throws(() => exportMap(demo(), { format: 'embed', bundle: '' }), /npm run build/);
  assert.throws(() => exportMap(demo(), { format: /** @type {any} */ ('pdf') }), /Unknown export format/);
});

test('src/core/export/ stays pure: no Node or DOM imports', () => {
  for (const f of ['index.js', 'html.js', 'context.js']) {
    const src = fs.readFileSync(new URL(`../../src/core/export/${f}`, import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^(?:import|export) .* from '([^']+)';$/gm)].map((x) => x[1]);
    assert.ok(imports.every((m) => m.startsWith('./')), `${f}: ${imports.join(', ')}`);
    assert.ok(!/\b(document|window|process|require)\b/.test(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')), f);
  }
});
