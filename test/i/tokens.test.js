// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TOKEN_RE, newToken, hashToken, readTokens, writeTokens, createToken, revokeToken, checkToken, publicRows, tokensPath,
} from '../../src/server/tokens.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-'));

/** Problems: the file text must not contain the secret. @param {string} text @param {string} secret */
function secretProblems(text, secret) {
  return text.includes(secret) ? ['secret present'] : [];
}

test('newToken shape and hash', () => {
  const t = newToken();
  assert.match(t, TOKEN_RE);
  assert.notEqual(t, newToken());
  assert.match(hashToken(t), /^sha256:[0-9a-f]{64}$/);
});

test('tokens.json holds only hashes, mode 0600', () => {
  const file = tokensPath(tmp());
  const { token, row } = createToken(file, { name: 'ci', now: new Date('2026-11-09T18:00:00.123Z') });
  assert.equal(row.created, '2026-11-09T18:00:00Z');
  assert.deepEqual(row.scopes, ['read', 'build']);
  assert.deepEqual(secretProblems(fs.readFileSync(file, 'utf8'), token), []);
  // fault: a row storing the token itself is detected
  writeTokens(file, [{ ...row, hash: token }]);
  assert.ok(secretProblems(fs.readFileSync(file, 'utf8'), token).length > 0);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('checkToken finds the row; wrong or malformed gives null', () => {
  const file = tokensPath(tmp());
  const a = createToken(file, { name: 'a', scopes: ['admin'] });
  const b = createToken(file, { name: 'b', tenant: 'acme' });
  const rows = readTokens(file);
  assert.equal(checkToken(rows, b.token)?.name, 'b');
  assert.equal(checkToken(rows, a.token)?.name, 'a');
  assert.equal(checkToken(rows, newToken()), null);
  for (const bad of ['', 'ont_short', undefined, null, 42, `${a.token}x`]) assert.equal(checkToken(rows, bad), null);
  assert.deepEqual(Object.keys(publicRows(rows)[0]).sort(), ['created', 'name', 'scopes', 'tenant']);
});

test('validation, duplicates, revoke, malformed file', () => {
  const file = tokensPath(tmp());
  assert.deepEqual(readTokens(file), []);
  createToken(file, { name: 'ci' });
  assert.throws(() => createToken(file, { name: 'ci' }), /already exists/);
  assert.throws(() => createToken(file, { name: 'Bad Name' }), /Invalid token name/);
  assert.throws(() => createToken(file, { name: 'x', tenant: '../y' }), /Invalid tenant/);
  assert.throws(() => createToken(file, { name: 'x', scopes: ['root'] }), /scopes/);
  assert.equal(revokeToken(file, 'nope'), false);
  assert.equal(revokeToken(file, 'ci'), true);
  assert.deepEqual(readTokens(file), []);
  fs.writeFileSync(file, '{nope');
  assert.throws(() => readTokens(file), /not valid JSON/);
  fs.writeFileSync(file, JSON.stringify([{ name: 'a' }]));
  assert.throws(() => readTokens(file), /row 1/);
});
