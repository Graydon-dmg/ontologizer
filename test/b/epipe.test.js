// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempHome } from './helpers.js';

const INDEX = fileURLToPath(new URL('../../src/cli/index.js', import.meta.url));

/**
 * Run a command with stdout piped to a reader that closes after the first line (like `| head -1`).
 * @param {string[]} args @param {Record<string, string>} env
 * @returns {Promise<{ code: number|null, stderr: string }>}
 */
function headOne(args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    c.stderr.on('data', (d) => { stderr += d; });
    let buf = '';
    c.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) c.stdout.destroy(); // the reader closes after one line
    });
    c.on('close', (code) => resolve({ code, stderr }));
  });
}

/** A store home with many saved maps, so `list` keeps writing after the reader has gone. */
function bigHome() {
  const home = tempHome();
  const ontologies = Array.from({ length: 3000 }, (_, i) => ({
    id: `map-${i}`, name: `Map ${i}`, root: `map-${i}`, nodes: i, updatedAt: i, draft: false,
  }));
  fs.writeFileSync(path.join(home, 'index.json'), JSON.stringify({ current: null, ontologies }));
  return home;
}

for (const [label, args, env] of /** @type {const} */ ([
  ['doctor', ['doctor'], {}],
  ['list', ['list'], {}],
  ['--help', ['--help'], {}],
  ['completion', ['completion', 'zsh'], {}],
  ['__complete', ['__complete', 'load', 'map'], {}],
])) {
  test(`\`ontologizer ${label} | head -1\` exits quietly: no stack trace`, async () => {
    const home = bigHome();
    const r = await headOne([INDEX, ...args], { ONTOLOGIZER_HOME: home, HOME: home, ...env });
    assert.doesNotMatch(r.stderr, /EPIPE|Error:|at .*\.js:\d+/, r.stderr);
    if (label !== 'doctor') assert.equal(r.code, 0); // doctor exits 1 here (no key) or 0 on EPIPE
    else assert.ok(r.code === 0 || r.code === 1, String(r.code));
  });
}

test('planted fault: the same closed pipe without the handler does print an EPIPE stack trace', async () => {
  const script = "let i=0;const t=setInterval(()=>{process.stdout.write('line '+(i++)+'\\n');if(i>2000)clearInterval(t)},1)";
  const r = await headOne(['-e', script], {});
  assert.match(r.stderr, /EPIPE/);
});
