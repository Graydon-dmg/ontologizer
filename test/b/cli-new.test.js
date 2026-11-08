// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli/main.js';
import { openStore } from '../../src/core/store.js';
import { foldAll } from '../../src/core/events.js';
import { fixtureEvents } from './helpers.js';

process.env.ONTOLOGIZER_STUB_SPEED = '1000';
const fx = fixtureEvents('plastic-modeling');
const fxNodes = Object.keys(foldAll(fx).nodes).length;
const fxCats = fx.filter((e) => e.t === 'category.added').length;

const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-'));
const cap = () => ({ out: '', write(/** @type {string} */ s) { this.out += s; return true; } });
const fakeKeyring = () => ({ v: null, get() { return this.v; }, set(/** @type {any} */ k) { this.v = k; }, delete() { const had = this.v != null; this.v = null; return had; } });
const index = (/** @type {string} */ home) => JSON.parse(fs.readFileSync(path.join(home, 'index.json'), 'utf8'));

/** @param {string} home @param {string[]} args @param {any} [over] */
async function run(home, args, over = {}) {
  const stdout = cap();
  const stderr = cap();
  const code = await main(args, {
    env: { ...process.env, ONTOLOGIZER_HOME: home, ANTHROPIC_API_KEY: 'sk-ant-test-0000' },
    home, stdout, stderr, interactive: false, keyring: fakeKeyring(),
    openBrowser: async () => {}, onSignal: () => () => {}, ...over,
  });
  return { code, out: stdout.out, err: stderr.out };
}

const NEW = ['new', '--context', 'plastic modeling for a beginner', '--yes', '--no-open'];

test('new --yes builds the fixture fast, one "+ " line per category, current = draft', async () => {
  const home = mkHome();
  const t0 = Date.now();
  const r = await run(home, [...NEW, '--exit-after-build']);
  assert.ok(Date.now() - t0 < 5000, 'speed env must be honored (speed 1 would take ~25 s)');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.split('\n').filter((l) => l.startsWith('  + ')).length, fxCats);
  assert.equal(fxCats, 8);
  const idx = index(home);
  assert.equal(idx.ontologies.length, 1);
  const row = idx.ontologies[0];
  assert.equal(row.draft, true);
  assert.equal(idx.current, row.id);
  const store = openStore(home);
  assert.equal(Object.keys(store.read(row.id).nodes).length, fxNodes);
  store.flush(row.id);
});

test('new with no key: exit 1, "No Anthropic API key", no draft created', async () => {
  const home = mkHome();
  const env = { ...process.env, ONTOLOGIZER_HOME: home };
  delete env.ANTHROPIC_API_KEY;
  const r = await run(home, [...NEW, '--exit-after-build'], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /No Anthropic API key/);
  const f = path.join(home, 'index.json');
  const rows = fs.existsSync(f) ? index(home).ontologies : [];
  assert.equal(rows.length, 0, 'draft must not exist before the key check passes');
});

test('save, list, list --drafts, and save with no draft', async () => {
  const home = mkHome();
  assert.equal((await run(home, ['save'])).code, 1);
  assert.equal((await run(home, [...NEW, '--exit-after-build'])).code, 0);
  assert.match((await run(home, ['list'])).out, /No saved maps yet/);
  const s = await run(home, ['save']);
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /Saved as plastic-modeling/);
  const l = await run(home, ['list']);
  assert.match(l.out, /plastic-modeling/);
  const ld = await run(home, ['list', '--drafts']);
  assert.equal(ld.out.trim().split('\n').length, 1);
  assert.ok(!/\(draft\)/.test(ld.out));
  const again = await run(home, ['save']);
  assert.equal(again.code, 1);
  assert.match(again.err, /No current draft to save/);
});

/** @param {boolean} yes */
async function ctrlC(yes) {
  const home = mkHome();
  const lastAt = fx[fx.length - 1].at;
  const r = await run(home, ['new', '--context', 'plastic modeling', '--yes', '--no-open'], {
    interactive: true,
    prompts: async () => ({ confirm: async () => yes, input: async () => '', select: async () => '' }),
    onSignal: (/** @type {string} */ _s, /** @type {() => void} */ fn) => {
      const iv = setInterval(() => {
        try {
          const rows = index(home).ontologies;
          const f = path.join(home, rows[0].id, 'events.jsonl');
          const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
          if (lines.length >= fx.length && JSON.parse(lines[lines.length - 1]).at === lastAt) { clearInterval(iv); fn(); }
        } catch { /* not there yet */ }
      }, 20);
      return () => clearInterval(iv);
    },
  });
  return { home, r };
}

test('Ctrl-C then confirm yes saves as plastic-modeling', async () => {
  const { r } = await ctrlC(true);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Saved as plastic-modeling/);
});

test('Ctrl-C then confirm no keeps the draft, still listed', async () => {
  const { home, r } = await ctrlC(false);
  assert.equal(r.code, 0, r.err);
  const m = r.out.match(/Draft kept: (draft-[\w-]+)/);
  assert.ok(m, r.out);
  const ld = await run(home, ['list', '--drafts']);
  assert.ok(ld.out.includes(m[1]));
  assert.match(ld.out, /\(draft\)/);
});
