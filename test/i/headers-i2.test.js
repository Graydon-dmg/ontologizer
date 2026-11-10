// @ts-check
// I2's HTML pages refuse framing too: the maps home (with the sources picker) and the "not found, or
// you don't have access" page a browser gets for a map it cannot see. Planted fault: a page without them.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, req } from './helpers-service.js';

/** What is missing from a page's headers. @param {Record<string, any>} h */
function framingProblems(h) {
  const problems = [];
  if (String(h['x-frame-options'] ?? '').toUpperCase() !== 'DENY') problems.push('no X-Frame-Options: DENY');
  if (!/frame-ancestors 'none'/.test(String(h['content-security-policy'] ?? ''))) problems.push("no CSP frame-ancestors 'none'");
  if (h['x-content-type-options'] !== 'nosniff') problems.push('no X-Content-Type-Options: nosniff');
  return problems;
}

test('the maps home (sources picker) and the not-found page refuse framing', async () => {
  // Planted fault: the not-found page as first written (nosniff only).
  assert.equal(framingProblems({ 'content-type': 'text/html', 'x-content-type-options': 'nosniff' }).length, 2);
  const { srv } = await boot();
  try {
    const home = await req(srv.url, '/', { headers: { accept: 'text/html' } });
    assert.equal(home.status, 200);
    assert.match(home.body, /id="sources-picker"/);
    assert.deepEqual(framingProblems(home.headers), [], 'home');
    const nf = await req(srv.url, '/v1/t/default/maps/no-such-map/view', { headers: { accept: 'text/html' } });
    assert.equal(nf.status, 404);
    assert.match(String(nf.headers['content-type']), /text\/html/);
    assert.match(nf.body, /Not found, or you don't have access/);
    assert.deepEqual(framingProblems(nf.headers), [], 'not-found page');
  } finally { await srv.close(); }
});
