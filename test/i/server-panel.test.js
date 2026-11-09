// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { panelRows, tokenLines, tokenLine, noteText } from '../../web/shell/server-panel.js';

const STATUS = {
  tenant: 'default', home: '/x/home', store: 'files', maps: 3, auth: 'tokens',
  tokens: [
    { name: 'ci', tenant: 'default', scopes: ['read', 'build'], hash: 'HASHVALUE', token: 'SECRETTOKEN', secret: 's3' },
    { name: 'viewer', tenant: 'default', scopes: ['read'], hash: 'HASH2' },
  ],
  server: { version: '1.2.3', startedAt: 5 },
};

/** @param {(t: any) => string[]} lines @param {(s: any) => {label: string, value: string}[]} rows @returns {string[]} */
function scan(lines, rows) {
  const out = JSON.stringify([lines(STATUS.tokens), rows(STATUS)]);
  return ['HASHVALUE', 'SECRETTOKEN', 's3', 'HASH2', '/x/home'].filter((s) => out.includes(s)).map((s) => `leaked ${s}`);
}

test('token lines and rows never contain hash, token or secret', () => {
  assert.deepEqual(scan(tokenLines, panelRows), []);
  assert.deepEqual(tokenLines(STATUS.tokens), ['ci — read, build', 'viewer — read']);
});

test('planted fault: a formatter that prints the whole token object is caught', () => {
  const bad = (/** @type {any[]} */ t) => t.map((x) => JSON.stringify(x));
  assert.ok(scan(bad, panelRows).length > 0);
});

test('panel rows show tenant, store, maps, version; no tokens gives an empty list', () => {
  assert.deepEqual(panelRows(STATUS), [
    { label: 'Tenant', value: 'default' }, { label: 'Store', value: 'files' },
    { label: 'Auth', value: 'tokens' }, { label: 'Maps', value: '3' }, { label: 'Version', value: '1.2.3' },
  ]);
  assert.deepEqual(tokenLines([]), []);
  assert.deepEqual(tokenLines(undefined), []);
  assert.equal(tokenLine({ name: 'a', scopes: ['read', 5] }), 'a — read');
});

test('the Auth row shows the mode; unknown or missing is unknown', () => {
  const auth = (/** @type {any} */ s) => panelRows(s).find((r) => r.label === 'Auth')?.value;
  assert.equal(auth({ auth: 'open' }), 'open (no tokens, loopback only)');
  assert.equal(auth({ auth: 'tokens' }), 'tokens');
  assert.equal(auth({ auth: 'weird' }), 'unknown');
  assert.equal(auth({}), 'unknown');
  assert.equal(auth(undefined), 'unknown');
  assert.deepEqual(panelRows({ auth: 'open' }).map((r) => r.label), ['Tenant', 'Store', 'Auth', 'Maps', 'Version']);
});

/** @param {(s: any) => string} note @returns {string[]} */
function noteProblems(note) {
  const problems = [];
  if (note({ note: 'tokens found: restart serve to require them' }) !== 'tokens found: restart serve to require them') problems.push('a note is not shown');
  for (const s of [{}, { note: 5 }, undefined, null]) if (note(s) !== '') problems.push(`shown for ${JSON.stringify(s)}`);
  return problems;
}

test('the note shows only when present', () => {
  assert.deepEqual(noteProblems(noteText), []);
  // Planted faults: a formatter that stringifies a missing note, and one that drops the note.
  assert.ok(noteProblems((s) => String(s?.note)).length >= 2);
  assert.deepEqual(noteProblems(() => ''), ['a note is not shown']);
});
