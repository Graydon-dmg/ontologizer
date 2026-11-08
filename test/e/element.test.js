// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

test('graph view imports in Node without touching HTMLElement', async () => {
  await import('../../web/views/graph/index.js');
});

test('planted fault: a module extending HTMLElement at top level would throw in Node', async () => {
  await assert.rejects(import('data:text/javascript,class X extends HTMLElement {}'));
});
