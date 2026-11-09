// @ts-check
// Anti-framing headers: every HTML page of both servers refuses to be framed by another site.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, req, seed, stubEngine, tempHome, fixtureEvents } from './helpers-service.js';
import { startServer } from '../../src/server/index.js';
import { openStore } from '../../src/core/store.js';

/** What is missing from a page's headers. @param {import('node:http').IncomingHttpHeaders} h */
function framingProblems(h) {
  const problems = [];
  if (String(h['x-frame-options'] ?? '').toUpperCase() !== 'DENY') problems.push('no X-Frame-Options: DENY');
  if (!/frame-ancestors 'none'/.test(String(h['content-security-policy'] ?? ''))) problems.push("no CSP frame-ancestors 'none'");
  if (h['x-content-type-options'] !== 'nosniff') problems.push('no X-Content-Type-Options: nosniff');
  return problems;
}

test('one-map server: its page and any .html it serves refuse framing', async () => {
  const store = openStore(tempHome());
  store.importEvents('demo', fixtureEvents('plastic-modeling'));
  const one = await startServer({ store, engine: stubEngine({ store, id: 'demo' }), id: 'demo' });
  try {
    for (const p of ['/', '/dev/index.html']) {
      const r = await req(one.url, p);
      assert.equal(r.status, 200, p);
      assert.match(String(r.headers['content-type']), /text\/html/);
      assert.deepEqual(framingProblems(r.headers), [], p);
    }
    // Scripts are not pages: no page headers needed there.
    const js = await req(one.url, '/dev/dev.js');
    assert.equal(js.status, 200);
    assert.equal(js.headers['x-frame-options'], undefined);
  } finally { await one.close(); }
  // Planted fault: a page with no headers is reported.
  assert.equal(framingProblems({ 'content-type': 'text/html' }).length, 3);
});

test('service mode: the home page and a map view refuse framing', async () => {
  const { srv, home } = await boot();
  try {
    await seed(home, 'default', 'demo');
    for (const p of ['/', '/?new=1', '/v1/t/default/maps/demo/view', '/home/index.html']) {
      const r = await req(srv.url, p, { headers: { accept: 'text/html' } });
      assert.equal(r.status, 200, p);
      assert.deepEqual(framingProblems(r.headers), [], p);
    }
  } finally { await srv.close(); }
});
