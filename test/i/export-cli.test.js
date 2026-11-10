// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// `ontologizer export` and the server's /dist/ route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli/main.js';
import { openStore } from '../../src/core/store.js';
import { startServer } from '../../src/server/index.js';
import { complete } from '../../src/cli/complete.js';
import { estimateTokens } from '../../src/core/export/index.js';
import { bundleText, fixtureEvents, externalUrlProblems, dataTagText } from './build-check.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-i4-'));
const cap = () => ({ out: '', write(/** @type {string} */ s) { this.out += s; return true; } });

/** @param {string} home @param {string[]} args */
async function run(home, args) {
  await bundleText(); // the html and embed formats read the built bundle
  const stdout = cap(); const stderr = cap();
  const code = await main(args, { home, stdout, stderr, interactive: false, env: { ...process.env, ONTOLOGIZER_HOME: home } });
  return { code, stdout: stdout.out, stderr: stderr.out };
}

test('export demo --format context --budget 1500 prints the pack within budget and imports nothing', async () => {
  const home = tmp();
  const r = await run(home, ['export', 'demo', '--format', 'context', '--budget', '1500']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^# /);
  assert.ok(estimateTokens(r.stdout.replace(/\n$/, '')) <= 1500);
  assert.deepEqual(openStore(home).list({ drafts: true }), [], 'a bundled map is read, not imported');
});

test('export demo --format html writes an offline page; --3d is bigger and says so', async () => {
  const home = tmp();
  const out = path.join(tmp(), 'demo.html');
  const r = await run(home, ['export', 'demo', '--format', 'html', '--out', out, '--live-url', 'http://127.0.0.1:9/']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Wrote the page to .*demo\.html \(\d+ KB\)/);
  const html = fs.readFileSync(out, 'utf8');
  assert.deepEqual(externalUrlProblems(html, { liveUrl: 'http://127.0.0.1:9/' }), []);
  const out3 = path.join(path.dirname(out), 'demo3d.html');
  const r3 = await run(home, ['export', 'demo', '--format', 'html', '--3d', '--out', out3]);
  assert.match(r3.stdout, /page with the 3D view .* \(\d+ KB\)/);
  assert.ok(fs.statSync(out3).size > 3 * fs.statSync(out).size);
});

test('export of a saved map by prefix: embed and json', async () => {
  const home = tmp();
  openStore(home).importEvents('plastic-modeling', fixtureEvents('plastic-modeling'));
  const dir = tmp();
  const r = await run(home, ['export', 'plastic', '--format', 'embed', '--out', path.join(dir, 'p.embed.html')]);
  assert.equal(r.code, 0, r.stderr);
  const embed = fs.readFileSync(path.join(dir, 'p.embed.html'), 'utf8');
  assert.match(embed, /^<ontologizer-map style="display:block;height:480px"/);
  assert.ok(dataTagText(embed));
  const j = await run(home, ['export', 'plastic-modeling', '--format', 'json']);
  assert.equal(JSON.parse(j.stdout).root, openStore(home).read('plastic-modeling').root);
});

test('export refuses bad flag combinations with a clear message', async () => {
  const home = tmp();
  for (const [args, msg] of /** @type {[string[], RegExp][]} */ ([
    [['export', 'demo', '--format', 'json', '--3d'], /--3d only applies/],
    [['export', 'demo', '--format', 'context', '--budget', '10'], /--budget must be/],
    [['export', 'demo', '--format', 'html', '--live-url', 'javascript:alert(1)'], /--live-url must be an http/],
    [['export', 'demo', '--format', 'pdf'], /Invalid values/],
    [['export', 'nosuch', '--format', 'json'], /No map named "nosuch"/],
  ])) {
    const r = await run(home, args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, msg);
  }
});

test('tab completion knows export: its flags, the format values and map names', () => {
  assert.deepEqual(complete(['export', '--f']), ['--format', '--force']);
  assert.deepEqual(complete(['export', 'demo', '--format', 'c']), ['context']);
});

test('the server serves the built bundle at /dist/ and nothing outside it', async () => {
  const code = await bundleText();
  const store = { read: () => ({}), sessions: { set() {}, remove() {} }, subscribe: () => () => {} };
  const srv = await startServer({ store, engine: {}, id: 'x' });
  try {
    const res = await fetch(new URL('dist/embed.js', srv.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /javascript/);
    assert.equal(await res.text(), code);
    const esc = await fetch(new URL('dist/..%2F..%2Fpackage.json', srv.url));
    assert.equal(esc.status, 404);
  } finally {
    await srv.close();
  }
});
