// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../../src/cli/main.js';
import { complete } from '../../src/cli/complete.js';
import { checkForUpdate } from '../../src/cli/notice.js';

const INDEX = new URL('../../src/cli/index.js', import.meta.url).pathname;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-'));
const cap = () => ({ out: '', write(/** @type {string} */ s) { this.out += s; } });

function seed(/** @type {string} */ home, n = 50) {
  const ontologies = [];
  for (let i = 0; i < n; i++) {
    const name = i === 7 ? 'plastic-modeling' : `topic-${String(i).padStart(2, '0')}`;
    // Real layout: a saved map's id is its kebab name; the row's name is the display name.
    ontologies.push({ id: name, name: name.replace(/-/g, ' '), root: name, nodes: 3, updatedAt: 1, draft: false });
    const d = path.join(home, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'snapshot.json'), '{{{ not json');
  }
  fs.writeFileSync(path.join(home, 'index.json'), JSON.stringify({ current: null, ontologies }));
}

/** @param {string} home @param {() => any} fn */
function withHome(home, fn) {
  process.env.ONTOLOGIZER_HOME = home;
  try { return fn(); } finally { delete process.env.ONTOLOGIZER_HOME; }
}

// Timing is checked in-process (the handler itself), never as a whole subprocess: node startup on a
// loaded machine is not ours to budget. The structural guarantee (index.json only, no snapshot reads)
// is the next test; the fast path's import list is checked here.
test('complete() answers within the 100 ms budget in-process, and the fast path loads no heavy modules', () => {
  const home = tmp(); seed(home);
  withHome(home, () => complete(['load', 'pla'])); // warm
  const times = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    const r = withHome(home, () => complete(['load', 'pla']));
    times.push(performance.now() - t);
    assert.deepEqual(r, ['plastic-modeling']);
  }
  times.sort((a, b) => a - b);
  const median = times[10];
  assert.ok(median < 100, `median ${median.toFixed(1)} ms`); // typically well under 1 ms
  // complete.js imports node builtins only (no yargs, prompts, SDK or store), so the subprocess stays fast.
  const src = fs.readFileSync(new URL('../../src/cli/complete.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0 && imports.every((m) => m.startsWith('node:')), imports.join(','));
  // Planted fault: an import of yargs (what a slow fast path would do) fails this rule.
  assert.ok(!['yargs', 'node:fs'].every((m) => m.startsWith('node:')));
});

test('__complete subprocess smoke: correct answer, exit 0, well under 3 s', () => {
  const home = tmp(); seed(home);
  const t = performance.now();
  const r = spawnSync(process.execPath, [INDEX, '__complete', 'load', 'pla'], { env: { ...process.env, ONTOLOGIZER_HOME: home }, encoding: 'utf8' });
  const ms = performance.now() - t;
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'plastic-modeling\n');
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
});

test('complete() never reads a snapshot (planted: invalid snapshots plus a read spy that does catch reads)', () => {
  const home = tmp(); seed(home);
  const orig = fs.readFileSync;
  /** @type {string[]} */ const reads = [];
  // @ts-ignore
  fs.readFileSync = (p, ...rest) => { reads.push(String(p)); return orig(p, ...rest); };
  try {
    assert.deepEqual(withHome(home, () => complete(['load', 'pla'])), ['plastic-modeling']);
    assert.ok(reads.length >= 1 && reads.every((p) => p.endsWith('index.json')), reads.join(','));
    // planted fault: reading a snapshot the way a broken implementation would is visible to the spy
    reads.length = 0;
    try { fs.readFileSync(path.join(home, 'ontologies', 'id0', 'snapshot.json'), 'utf8'); } catch { /* fine */ }
    assert.ok(reads.some((p) => p.endsWith('snapshot.json')));
  } finally { fs.readFileSync = orig; }
});

test('__complete with an empty home prints nothing and exits 0; bad index gives []', async () => {
  const home = tmp();
  const r = spawnSync('node', [INDEX, '__complete', 'load', ''], { env: { ...process.env, ONTOLOGIZER_HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
  fs.writeFileSync(path.join(home, 'index.json'), 'garbage');
  assert.deepEqual(withHome(home, () => complete(['load', ''])), []);
  seed(home); const out = cap();
  process.env.ONTOLOGIZER_HOME = home;
  // @ts-ignore
  const code = await main(['__complete', 'load', 'pla'], { env: { ...process.env, ONTOLOGIZER_HOME: home }, home, stdout: out, stderr: cap(), interactive: false });
  delete process.env.ONTOLOGIZER_HOME;
  assert.equal(code, 0); assert.equal(out.out, 'plastic-modeling\n');
});

test('command, flag, subcommand and fuse completion', () => {
  const home = tmp(); seed(home);
  withHome(home, () => {
    assert.deepEqual(complete(['']), ['new', 'load', 'save', 'list', 'fuse', 'rosetta', 'explain', 'research', 'update', 'key', 'doctor', 'completion']);
    assert.deepEqual(complete(['re']), ['research']);
    assert.deepEqual(complete(['load', '--r']), ['--replay']);
    assert.deepEqual(complete(['new', '-']), ['--context', '--yes']);
    assert.deepEqual(complete(['key', '']), ['set', 'clear']);
    assert.deepEqual(complete(['completion', 'b']), ['bash']);
    assert.deepEqual(complete(['fuse', 'topic-0']).slice(0, 2), ['topic-00', 'topic-01']);
    assert.deepEqual(complete(['fuse', 'topic-00', 'plas']), ['plastic-modeling']);
    assert.deepEqual(complete(['bogus', 'x']), []);
    assert.notDeepEqual(complete(['key', '']), ['set']); // planted: a wrong expectation is detected
  });
});

test('completion scripts call ontologizer __complete', async () => {
  for (const [sh, needle] of [['zsh', 'compdef _ontologizer ontologizer'], ['bash', 'complete -F _ontologizer ontologizer'], ['fish', 'complete -c ontologizer -f']]) {
    const out = cap();
    // @ts-ignore
    const code = await main(['completion', sh], { env: { ...process.env }, stdout: out, stderr: cap(), interactive: false });
    assert.equal(code, 0);
    assert.ok(out.out.includes(needle) && out.out.includes('__complete'), sh);
    assert.ok(out.out.startsWith('# Install'), sh);
  }
});

test('update notice: shows with cached newer version; silent and no fetch with NO_UPDATE_CHECK', async () => {
  const home = tmp();
  const cache = path.join(home, 'update-check.json');
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: Date.now() - 3600e3, latest: '9.9.9' }));
  let fetched = 0;
  const mk = (/** @type {any} */ env, interactive = true) => ({ env, home, stderr: cap(), interactive, fetch: async () => { fetched++; return { json: async () => ({ version: '1.0.0' }) }; } });
  const a = mk({ ONTOLOGIZER_HOME: home });
  // @ts-ignore
  checkForUpdate({ deps: a, current: '0.1.0' });
  assert.equal(a.stderr.out, 'ontologizer 9.9.9 is available: run ontologizer update\n');
  assert.equal(fetched, 0);
  // stale cache fires a fetch (proves the no-fetch cases below are real)
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: 0, latest: '9.9.9' }));
  // @ts-ignore
  checkForUpdate({ deps: mk({ ONTOLOGIZER_HOME: home }), current: '0.1.0' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetched, 1);
  fetched = 0;
  const b = mk({ ONTOLOGIZER_HOME: home, ONTOLOGIZER_NO_UPDATE_CHECK: '1' });
  // @ts-ignore
  checkForUpdate({ deps: b, current: '0.1.0' });
  assert.equal(b.stderr.out, ''); assert.equal(fetched, 0);
  const c = mk({ ONTOLOGIZER_HOME: home }, false);
  // @ts-ignore
  checkForUpdate({ deps: c, current: '0.1.0' });
  assert.equal(c.stderr.out, ''); assert.equal(fetched, 0);
});

test('completion offers the id of a map saved through the real store (display name differs)', async () => {
  const { openStore } = await import('../../src/core/store.js');
  const { tempHome, fixtureEvents } = await import('./helpers.js');
  const home = tempHome();
  const store = openStore(home);
  store.importEvents('plastic-modeling', fixtureEvents('plastic-modeling'));
  store.flush('plastic-modeling'); // the row's name becomes the display name "Plastic modeling"
  const prev = process.env.ONTOLOGIZER_HOME;
  process.env.ONTOLOGIZER_HOME = home;
  try {
    assert.deepEqual(complete(['load', 'pla']), ['plastic-modeling']);
    // Planted fault: completing display names (the old behavior) offers nothing for "pla".
    const rows = JSON.parse(fs.readFileSync(path.join(home, 'index.json'), 'utf8')).ontologies;
    assert.deepEqual(rows.map((r) => r.name).filter((n) => n.startsWith('pla')), []);
  } finally {
    if (prev === undefined) delete process.env.ONTOLOGIZER_HOME; else process.env.ONTOLOGIZER_HOME = prev;
  }
});
