// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// `ontologizer mcp` without --url runs an open server (no sign-in): only for a plain single-user home.
// A home with tokens or a config must be reached through a running `serve` with --url and a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { needsSignIn } from '../../src/cli/commands/mcp.js';
import { createToken, tokensPath } from '../../src/server/tokens.js';
import { tempHome } from './helpers-service.js';

const CLI = fileURLToPath(new URL('../../src/cli/index.js', import.meta.url));
const ENV = { ...process.env, ONTOLOGIZER_ENGINE: 'stub', ONTOLOGIZER_KEYRING: 'none', ONTOLOGIZER_NO_UPDATE_CHECK: '1' };
delete ENV.ANTHROPIC_API_KEY; delete ENV.ONTOLOGIZER_CONFIG;

/** Three homes: plain, with a token, with a config. */
function homes() {
  const plain = tempHome();
  const tokens = tempHome();
  createToken(tokensPath(tokens), { name: 'team', scopes: ['read'] });
  const config = tempHome();
  fs.writeFileSync(path.join(config, 'ontologizer.config.js'), 'export default {};\n');
  return { plain, tokens, config };
}

/** What a guard gets wrong on the three homes. @param {(home: string, env: any) => string|null} guard */
function guardProblems(guard) {
  const h = homes();
  /** @type {string[]} */
  const p = [];
  if (guard(h.plain, {}) !== null) p.push('a plain home was refused');
  if (guard(h.tokens, {}) === null) p.push('a home with tokens.json was served open');
  if (guard(h.config, {}) === null) p.push('a home with a config was served open');
  return p;
}

test('the open in-process server refuses a home with tokens or a config (planted fault: the old guard that checked nothing)', () => {
  assert.deepEqual(guardProblems(needsSignIn), []);
  assert.deepEqual(guardProblems(() => null), ['a home with tokens.json was served open', 'a home with a config was served open']);
  // An unreadable tokens file, and a config named by ONTOLOGIZER_CONFIG, refuse too.
  const bad = tempHome();
  fs.writeFileSync(tokensPath(bad), '{not json');
  assert.match(String(needsSignIn(bad, {})), /tokens file it cannot read/);
  const cfg = path.join(tempHome(), 'elsewhere.config.js');
  fs.writeFileSync(cfg, 'export default {};\n');
  assert.match(String(needsSignIn(tempHome(), { ONTOLOGIZER_CONFIG: cfg })), /a config/);
});

test('ontologizer mcp on a home with tokens exits 1 before opening a port, and says to use --url with a token file', () => {
  const h = homes();
  for (const home of [h.tokens, h.config]) {
    const r = spawnSync(process.execPath, [CLI, 'mcp', '--home', home], { env: ENV, input: '', encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, '', 'nothing on stdout (the protocol channel)');
    assert.match(r.stderr, /Refusing to serve .* without sign-in/);
    assert.match(r.stderr, /ontologizer mcp --url http:\/\/127\.0\.0\.1:8787 --token-file <file>/);
    assert.ok(!/tools for/.test(r.stderr), 'no server was started');
  }
});
