// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageDir, resolveVendorPath } from '../../src/core/vendor.js';
import { startDevServer } from '../../scripts/dev-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const importmap = JSON.parse(readFileSync(path.join(here, '../../web/shared/importmap.json'), 'utf8'));
const require = createRequire(import.meta.url);

/**
 * Check that a package-dir resolver returns the folder whose package.json names the package.
 * @param {(pkg: string) => string} resolveFn
 * @returns {string[]} problems (empty = ok)
 */
function checkResolver(resolveFn) {
  /** @type {string[]} */
  const problems = [];
  for (const pkg of ['d3-force', 'three']) {
    try {
      const out = resolveFn(pkg);
      const pj = path.join(out.endsWith('package.json') ? path.dirname(out) : out, 'package.json');
      const name = JSON.parse(readFileSync(pj, 'utf8')).name;
      if (name !== pkg) problems.push(`${pkg}: package.json name is ${name}`);
    } catch (err) {
      problems.push(`${pkg}: ${/** @type {NodeJS.ErrnoException} */ (err).code || /** @type {Error} */ (err).message}`);
    }
  }
  return problems;
}

test('packageDir finds d3-force and three', () => {
  assert.deepEqual(checkResolver(packageDir), []);
});

test('planted fault: naive <pkg>/package.json resolver is caught', () => {
  const naive = (/** @type {string} */ pkg) => require.resolve(pkg + '/package.json');
  const problems = checkResolver(naive);
  assert.ok(problems.length > 0, 'naive resolver should fail the check');
  assert.ok(problems.some((p) => p.includes('ERR_PACKAGE_PATH_NOT_EXPORTED')), problems.join('; '));
});

test('every importmap entry resolves to a real file or dir', () => {
  const entries = Object.entries(importmap.imports);
  assert.ok(entries.length >= 13);
  for (const [name, url] of entries) {
    const abs = resolveVendorPath(/** @type {string} */ (url));
    assert.ok(abs, `${name} -> ${url} did not resolve`);
    assert.ok(existsSync(abs), `${name} -> ${abs} missing`);
    if (name.endsWith('/')) assert.ok(statSync(abs).isDirectory(), `${name} should be a dir`);
    else assert.ok(statSync(abs).isFile(), `${name} should be a file`);
  }
  for (const p of ['color', 'dispatch', 'drag', 'ease', 'force', 'interpolate', 'quadtree', 'selection', 'timer', 'transition', 'zoom']) {
    assert.ok(importmap.imports['d3-' + p], `d3-${p} missing from map`);
  }
});

test('specific vendor paths resolve', () => {
  const f = resolveVendorPath(importmap.imports['d3-force']);
  assert.ok(f && statSync(f).isFile());
  const t = resolveVendorPath('/vendor/three/build/three.module.js');
  assert.ok(t && statSync(t).isFile());
});

test('resolveVendorPath rejects traversal', () => {
  assert.equal(resolveVendorPath('/vendor/d3-force/../../package.json'), null);
  assert.equal(resolveVendorPath('/vendor/d3-force/%2e%2e/%2e%2e/package.json'), null);
  assert.equal(resolveVendorPath('/vendor/nope-not-a-pkg/x.js'), null);
  assert.equal(resolveVendorPath('/other/d3-force/x.js'), null);
});

test('dev server smoke', async () => {
  const { server, url } = await startDevServer({ port: 0 });
  try {
    const html = await fetch(url + '/dev/');
    assert.equal(html.status, 200);
    const text = await html.text();
    assert.ok(text.includes('<script type="importmap">'));
    assert.ok(!text.includes('<!--importmap-->'));

    const js = await fetch(url + importmap.imports['d3-force']);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') || '', /javascript/);
    await js.arrayBuffer();

    const miss = await fetch(url + '/fixtures/missing.jsonl');
    assert.equal(miss.status, 404);
    await miss.arrayBuffer();

    const trav = await fetch(url + '/vendor/d3-force/..%2f..%2fpackage.json');
    assert.equal(trav.status, 404);
    await trav.arrayBuffer();
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
