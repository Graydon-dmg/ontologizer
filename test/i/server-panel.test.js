// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { panelRows, tokenLines, tokenLine } from '../../web/shell/server-panel.js';

const STATUS = {
  tenant: 'default', home: '/x/home', store: 'files', maps: 3,
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
    { label: 'Maps', value: '3' }, { label: 'Version', value: '1.2.3' },
  ]);
  assert.deepEqual(tokenLines([]), []);
  assert.deepEqual(tokenLines(undefined), []);
  assert.equal(tokenLine({ name: 'a', scopes: ['read', 5] }), 'a — read');
});
