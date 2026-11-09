// @ts-check
// The embed bundle: built before the tests, free of network calls, shipped by npm, never committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildEmbed } from '../../scripts/build-embed.js';
import { bundleText, networkProblems, ROOT } from './build-check.js';

const root = fileURLToPath(ROOT);

test('web/dist/embed.js and embed-3d.js contain no fetch(, XMLHttpRequest, EventSource, WebSocket or import(', async () => {
  assert.deepEqual(networkProblems(await bundleText()), []);
  assert.deepEqual(networkProblems(await bundleText(true)), []);
});

test('planted fault: a bundle that pings for updates is reported', async () => {
  const code = await bundleText();
  assert.ok(networkProblems(`${code};setInterval(()=>fetch("/api/snapshot"),5000)`).length > 0);
  assert.ok(networkProblems(`${code};new EventSource("/api/events")`).length > 0);
  assert.ok(networkProblems(`${code};import("./more.js")`).length > 0);
});

test('the bundles define the element once, carry their licences, and only the 3D one has three', async () => {
  const two = await bundleText();
  const three = await bundleText(true);
  for (const code of [two, three]) {
    assert.ok(code.startsWith('/*!\nOntologizer embed bundle.'), 'licence comment first');
    assert.ok(code.includes('if(!(globalThis.customElements&&customElements.get("ontologizer-map"))){'), 'one-definition guard');
    assert.match(code, /Includes [^\n]*d3-selection@/);
    assert.match(code, /Copyright 2010-\d{4} Mike Bostock/);
    assert.ok(!/<\/script/i.test(code) && !code.includes('<!--'), 'safe to inline in a <script>');
  }
  assert.match(three, /Includes three@/);
  assert.doesNotMatch(two, /three@/);
  assert.ok(two.length < three.length / 3, 'the 2D bundle leaves three.js out');
});

test('a fresh build from nothing works (no test needs web/dist/ to exist beforehand)', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-dist-'));
  try {
    const built = await buildEmbed({ outdir: out, quiet: true });
    assert.deepEqual(built.map((b) => path.basename(b.file)), ['embed.js', 'embed-3d.js']);
    assert.equal(fs.readFileSync(path.join(out, 'embed.js'), 'utf8'), await bundleText());
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

/** Problems with how package.json builds the bundle. @param {any} pkg @returns {string[]} */
function scriptProblems(pkg) {
  const s = pkg.scripts || {};
  const problems = [];
  const builds = (/** @type {string|undefined} */ cmd) => typeof cmd === 'string' && /^(node scripts\/build-embed\.js|npm run build)( |$)/.test(cmd);
  for (const name of ['check', 'check:i', 'dev', 'prepack']) if (!builds(s[name])) problems.push(`"${name}" does not build the bundle first`);
  if (s.build !== 'node scripts/build-embed.js') problems.push('"build" is not node scripts/build-embed.js');
  if (pkg.devDependencies?.esbuild !== '0.24.2') problems.push('esbuild is not pinned to exactly 0.24.2');
  if (pkg.exports?.['./export'] !== './src/core/export/index.js') problems.push('no "./export" in exports');
  return problems;
}

test('npm run check (and check:i, dev, prepack) builds the bundle first, so a clean clone passes', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(scriptProblems(pkg), []);
});

test('planted fault: a check script that assumes web/dist/ exists is reported', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const faulty = { ...pkg, scripts: { ...pkg.scripts, check: 'node scripts/test.js test' } };
  assert.deepEqual(scriptProblems(faulty), ['"check" does not build the bundle first']);
});

test('git ignores the bundle', () => {
  const r = spawnSync('git', ['check-ignore', '-q', 'web/dist/embed.js'], { cwd: root });
  assert.equal(r.status, 0, 'web/dist/embed.js is ignored');
  // Planted fault: a committed source file is not ignored, so check-ignore really answers.
  assert.equal(spawnSync('git', ['check-ignore', '-q', 'web/embed/index.js'], { cwd: root }).status, 1);
});

/** @param {string} dir @returns {string[]} */
const packed = (dir) => JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
}))[0].files.map((/** @type {{ path: string }} */ f) => f.path);

/** @param {string[]} files */
const packProblems = (files) => (files.includes('web/dist/embed.js') ? [] : ['the package does not ship web/dist/embed.js']);

test('npm pack ships web/dist/embed.js (prepack builds it)', () => {
  assert.deepEqual(packProblems(packed(root)), []);
});

test('planted fault: a pack without the prepack build is reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-pack-'));
  try {
    fs.mkdirSync(path.join(dir, 'web', 'embed'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'web', 'embed', 'index.js'), '// entry\n');
    const pkg = { name: 'pack-fault', version: '0.0.0', files: ['web'], scripts: {} };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    assert.equal(packProblems(packed(dir)).length, 1, 'no prepack: no bundle');
    // Positive control: with a prepack that writes the bundle, the same pack ships it.
    const build = "require('fs').mkdirSync('web/dist',{recursive:true});require('fs').writeFileSync('web/dist/embed.js','x')";
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, scripts: { prepack: `node -e "${build}"` } }));
    assert.deepEqual(packProblems(packed(dir)), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
