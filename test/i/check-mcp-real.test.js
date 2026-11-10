// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// Smoke: MCP check_context on the REAL engine (a scripted model client, no network) returns a brief.
// The stub engine never ran the real check's code, which is how ":check" failed only in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startService } from '../../src/server/service.js';
import { createEngine } from '../../src/core/engine/index.js';
import { createUsage } from '../../src/server/usage.js';
import { createFakeClient } from '../c/fake.js';
import { tempHome } from './helpers-service.js';

const READY = { ready: true, brief: { subject: 'Home espresso', scope: 'machines and technique', purpose: 'start', level: 'beginner' }, name: 'home-espresso' };

test('MCP check_context on the real engine returns the model\'s brief, metered', async () => {
  const home = tempHome();
  /** @type {any[]} */ const calls = [];
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, version: 'test', usage: createUsage({ home, now: () => Date.UTC(2026, 10, 9, 12) }),
    makeEngine: async (/** @type {any} */ { store, id, meter }) => createEngine({
      store, id, client: meter(createFakeClient({ respond: (p) => { calls.push(p); return { text: `${JSON.stringify(READY)}\n` }; } })),
    }),
  });
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/v1/mcp`)));
  try {
    const r = /** @type {any} */ (await c.callTool({ name: 'check_context', arguments: { context: 'I want to get into home espresso' } }));
    assert.ok(!r.isError, r.content?.[0]?.text);
    assert.equal(r.structuredContent.ready, true);
    assert.equal(r.structuredContent.brief.subject, 'Home espresso');
    assert.ok(!/Invalid ontology id/.test(r.content[0].text));
    assert.equal(calls.length, 1);
    await new Promise((x) => setTimeout(x, 10));
    const u = srv.usage.today('default');
    assert.equal(u.calls, 1, 'the call was metered');
    assert.ok(u.inputTokens > 0 && u.outputTokens > 0, 'a fake answer with no usage is counted by estimate');
  } finally { await c.close(); await srv.close(); }
});
