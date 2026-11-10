// @ts-check
// The Export menu's "Open live" link (liveLink): none from this computer, never a query or hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveLink } from '../../web/shell/ui/export.js';

test('a page on this computer gets no "Open live" link (dead for readers)', () => {
  for (const href of [
    'http://127.0.0.1:4321/', 'http://127.8.9.10/x', 'http://localhost:4321/?map=a',
    'http://LOCALHOST./', 'http://app.localhost/', 'http://[::1]:4321/', 'http://[::ffff:127.0.0.1]/',
  ]) assert.equal(liveLink(href), null, href);
});

test('a served page links to its address without query, hash or credentials', () => {
  assert.equal(liveLink('https://maps.example.org/t/acme/m/42?token=abc&x=1#node=7'), 'https://maps.example.org/t/acme/m/42');
  assert.equal(liveLink('https://user:pw@maps.example.org:8443/m/'), 'https://maps.example.org:8443/m/');
  assert.equal(liveLink('http://10.0.0.5:4321/'), 'http://10.0.0.5:4321/');
});

test('not an ordinary web address: no link', () => {
  assert.equal(liveLink('file:///tmp/map.html'), null);
  assert.equal(liveLink('not a url'), null);
});

test('planted fault: passing location.href straight through leaks the query and the loopback host', () => {
  const raw = (/** @type {string} */ h) => h;
  assert.notEqual(raw('http://127.0.0.1:4321/?k=v'), liveLink('http://127.0.0.1:4321/?k=v'));
  assert.match(raw('https://h.example/m?token=abc'), /token/);
  assert.doesNotMatch(String(liveLink('https://h.example/m?token=abc')), /token/);
});

test('"any address" binds give no link either', () => {
  for (const href of ['http://0.0.0.0:8787/', 'http://0/', 'http://[::]:8787/', 'http://[::ffff:0.0.0.0]/']) assert.equal(liveLink(href), null, href);
});
