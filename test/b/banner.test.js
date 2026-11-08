// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderBanner, showBanner, visibleWidth, bannerMode, BANNER_ART } from '../../src/cli/banner.js';
import { complete } from '../../src/cli/complete.js';
import { openStore } from '../../src/core/store.js';
import { startServer } from '../../src/server/index.js';
import { tempHome, fixtureEvents } from './helpers.js';

const INDEX = fileURLToPath(new URL('../../src/cli/index.js', import.meta.url));
const ESC = '\x1b';
const PKG_VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

/** A fake TTY stream that records writes. @param {number} columns */
function tty(columns) {
  return { isTTY: true, columns, out: '', write(/** @type {string} */ s) { this.out += s; return true; } };
}

test('no banner line is ever wider than the terminal (80, 50, 30 and every width 10..140)', () => {
  for (const color of [false, true]) {
    for (let columns = 10; columns <= 140; columns++) {
      for (const line of renderBanner({ columns, color, version: '0.1.0' })) {
        assert.ok(visibleWidth(line) <= columns, `width ${visibleWidth(line)} > ${columns} (color ${color}): ${JSON.stringify(line)}`);
      }
    }
  }
  assert.equal(renderBanner({ columns: 80 }).length, 9);   // full art
  assert.equal(renderBanner({ columns: 50 }).length, 3);   // compact mark
  assert.deepEqual(renderBanner({ columns: 30, version: '0.1.0' }), ['ontologizer 0.1.0']);
  // Every character is plain ASCII, so the display width is the character count everywhere.
  for (const l of renderBanner({ columns: 80, version: '0.1.0' })) assert.match(l, /^[\x20-\x7e]*$/);
  // Planted fault: a renderer that ignores the width (always the full art) is too wide at 30.
  const ignoresWidth = renderBanner({ columns: 80, version: '0.1.0' });
  assert.ok(ignoresWidth.some((l) => visibleWidth(l) > 30));
});

test('the static frame is exported plain (for the README) and is the 9-row mark', () => {
  assert.equal(BANNER_ART.split('\n').length, 9);
  assert.ok(!BANNER_ART.includes(ESC));
  assert.ok(BANNER_ART.includes('@'));
});

test('no ANSI escapes and no banner when stdout is not a TTY', async () => {
  const piped = { isTTY: false, columns: 80, out: '', write(/** @type {string} */ s) { this.out += s; return true; } };
  await showBanner({ stdout: piped, env: { FORCE_COLOR: '1' } }, { version: '0.1.0', stepMs: 1 });
  assert.equal(piped.out, '');
  const plain = tty(80);
  await showBanner({ stdout: plain, env: { NO_COLOR: '1' } }, { version: '0.1.0', stepMs: 1 });
  assert.ok(plain.out.includes('ontologizer 0.1.0'));
  assert.ok(!plain.out.includes(ESC), 'NO_COLOR printed an escape');
  // Real CLI, piped: --version is the bare version; the start menu says to use --help; no escapes.
  const env = { ...process.env, ONTOLOGIZER_HOME: tempHome(), FORCE_COLOR: '1' };
  const v = spawnSync(process.execPath, [INDEX, '--version'], { env, encoding: 'utf8' });
  assert.equal(v.stdout, `${PKG_VERSION}\n`);
  const bare = spawnSync(process.execPath, [INDEX], { env, encoding: 'utf8' });
  assert.ok(!(bare.stdout + bare.stderr).includes(ESC));
  // Planted fault: a TTY with colour does produce escapes, so the checks above can see them.
  const coloured = tty(80);
  await showBanner({ stdout: coloured, env: { ONTOLOGIZER_NO_ANIM: '1' } }, { version: '0.1.0' });
  assert.ok(coloured.out.includes(`${ESC}[38;2;`));
});

test('__complete output is byte-identical to complete(), with no banner or escapes', () => {
  const home = tempHome();
  openStore(home).importEvents('plastic-modeling', fixtureEvents('plastic-modeling'));
  for (const words of [['load', 'pla'], ['lo'], ['key', '']]) {
    const r = spawnSync(process.execPath, [INDEX, '__complete', ...words], {
      env: { ...process.env, ONTOLOGIZER_HOME: home, FORCE_COLOR: '1' }, encoding: 'utf8',
    });
    const prev = process.env.ONTOLOGIZER_HOME;
    process.env.ONTOLOGIZER_HOME = home;
    const expected = complete(words).map((c) => `${c}\n`).join('');
    if (prev === undefined) delete process.env.ONTOLOGIZER_HOME; else process.env.ONTOLOGIZER_HOME = prev;
    assert.equal(r.stdout, expected, words.join(' '));
    assert.equal(r.stderr, '');
  }
  // Planted fault: a banner printed before the candidates breaks byte identity.
  const withBanner = `${renderBanner({ columns: 30, version: '0.1.0' }).join('\n')}\nplastic-modeling\n`;
  assert.notEqual(withBanner, 'plastic-modeling\n');
});

test('animation: the centre, then 8 nodes clockwise; skipped under CI / NO_COLOR / ONTOLOGIZER_NO_ANIM', async () => {
  const anim = tty(80);
  await showBanner({ stdout: anim, env: {} }, { version: '0.1.0', stepMs: 1 });
  assert.equal(anim.out.split(`${ESC}[9A`).length - 1, 8, 'expected 8 redraws after the first frame');
  assert.ok(anim.out.startsWith(`${ESC}[?25l`) && anim.out.endsWith(`${ESC}[?25h`), 'cursor hidden and restored');
  for (const env of [{ CI: 'true' }, { NO_COLOR: '1' }, { ONTOLOGIZER_NO_ANIM: '1' }]) {
    const still = tty(80);
    await showBanner({ stdout: still, env }, { version: '0.1.0', stepMs: 1 });
    assert.ok(!still.out.includes(`${ESC}[9A`), JSON.stringify(env));
    assert.equal(bannerMode(still, env).animate, false);
  }
  // Clockwise from the top: node 0 (north) shows before node 2 (east).
  const one = renderBanner({ columns: 80, shown: 1 });
  assert.equal(one[0].trim(), 'o');          // north node grown
  assert.ok(!one[4].endsWith('o') || one[4].startsWith('o') === false); // east node not yet
  assert.equal(renderBanner({ columns: 80, shown: -1 }).slice(0, 4).join('').trim(), '');
});

test('GET /favicon.ico serves web/shared/brand/favicon-32.png as image/png (404 if missing)', async () => {
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-web-'));
  const store = openStore(tempHome());
  store.importEvents('plastic-modeling', fixtureEvents('plastic-modeling'));
  let srv = await startServer({ store, engine: { enqueue: () => 'j' }, id: 'plastic-modeling', webDir });
  assert.equal((await fetch(new URL('favicon.ico', srv.url))).status, 404);
  await srv.close();
  fs.mkdirSync(path.join(webDir, 'shared', 'brand'), { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(path.join(webDir, 'shared', 'brand', 'favicon-32.png'), png);
  srv = await startServer({ store, engine: { enqueue: () => 'j' }, id: 'plastic-modeling', webDir });
  const r = await fetch(new URL('favicon.ico', srv.url));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(png));
  await srv.close();
});
