// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// Every tool's inputSchema says additionalProperties: false, and the server holds to it: a guessed or
// misspelt argument is an error result that names the right one, never silently ignored (a live test
// found wait_for_map's timeoutMs quietly using the default, and search_map's query reading as "q must
// be non-empty"). Planted fault: a dispatcher that skips the check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { toolList, loopbackCaller, argumentProblems, MCP_OPS } from '../../src/server/mcp.js';
import { boot, seed } from './helpers-service.js';

/** @typedef {(name: string, args: any) => Promise<{ isError: boolean, text: string }>} CallTool */

/** What a dispatcher does with misnamed arguments that it should not. @param {CallTool} callTool */
async function misnamedProblems(callTool) {
  /** @type {string[]} */
  const p = [];
  /** @param {string} name @param {any} args @param {RegExp} want */
  const expect = async (name, args, want) => {
    const r = await callTool(name, args);
    if (!r.isError) p.push(`${name} ${JSON.stringify(args)} was accepted`);
    else if (!want.test(r.text)) p.push(`${name} ${JSON.stringify(args)}: "${r.text}"`);
  };
  await expect('wait_for_map', { id: 'demo', timeoutMs: 1000 }, /^Unknown argument `timeoutMs`\. Did you mean timeout\?.*wait_for_map takes: id \(required\), timeout\.$/);
  await expect('search_map', { id: 'demo', query: 'paint' }, /Unknown argument `query`\. Did you mean q\?.*search_map takes: id \(required\), q \(required\), limit\./);
  await expect('ask_map', { id: 'demo', question: 'Why?' }, /Unknown argument `question`\. Did you mean text\?/);
  await expect('get_outline', {}, /^Missing argument `id`\. get_outline takes: id \(required\)\.$/);
  await expect('search_map', { id: 'demo', q: 'paint', limit: 500 }, /Argument `limit` must be a whole number from 1 to 50\./);
  await expect('export_map', { id: 'demo', format: 'pdf' }, /Argument `format` must be one of "json", "context", "html", "embed"\./);
  return p;
}

test('a guessed argument name is an error that names the right one (planted fault: a dispatcher that skips the check)', async () => {
  const { home, srv, origin } = await boot();
  await seed(home, 'default', 'demo');
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${origin}/v1/mcp`)));
  try {
    /** @type {CallTool} */
    const viaMcp = async (name, args) => {
      const r = /** @type {any} */ (await c.callTool({ name, arguments: args }));
      return { isError: r.isError === true, text: String(r.content?.[0]?.text ?? '') };
    };
    assert.deepEqual(await misnamedProblems(viaMcp), []);
    // Right names still work.
    assert.equal((await viaMcp('wait_for_map', { id: 'demo', timeout: 100 })).isError, false);
    assert.equal((await viaMcp('search_map', { id: 'demo', q: 'paint' })).isError, false);
    // Planted fault: the old dispatch, straight to HTTP with whatever names the agent sent.
    const call = loopbackCaller({ host: '127.0.0.1', port: srv.port, headers: { host: `127.0.0.1:${srv.port}` } });
    /** @type {CallTool} */
    const unchecked = async (name, args) => {
      const op = /** @type {any} */ (MCP_OPS.find((o) => o.mcp?.name === name));
      try {
        const r = await call(op, { ...args, tenant: 'default' });
        return { isError: r.status >= 300, text: r.text };
      } catch (err) { return { isError: true, text: String(/** @type {any} */ (err).message) }; }
    };
    const p = await misnamedProblems(unchecked);
    assert.ok(p.some((x) => /^wait_for_map .*timeoutMs.* was accepted$/.test(x)), `timeoutMs silently ignored: ${p}`);
    assert.ok(p.some((x) => /^search_map .*query/.test(x)));
  } finally { await c.close(); await srv.close(); }
});

/** Schema keywords the argument check enforces or that carry no constraint. */
const KNOWN = new Set(['type', 'properties', 'required', 'additionalProperties', 'description', 'enum', 'default', 'minimum', 'maximum', 'minItems', 'maxItems', 'uniqueItems', 'items', 'contentMediaType']);

/** Problems in input schemas the argument check would not fully enforce. @param {{ name: string, inputSchema: any }[]} tools */
function schemaProblems(tools) {
  /** @type {string[]} */
  const p = [];
  /** @param {any} s @param {string} at */
  const walk = (s, at) => {
    if (!s || typeof s !== 'object') return;
    for (const k of Object.keys(s)) if (!KNOWN.has(k)) p.push(`${at}: "${k}" is not checked`);
    for (const [n, v] of Object.entries(s.properties ?? {})) walk(v, `${at}.${n}`);
    if (s.items) walk(s.items, `${at}[]`);
  };
  for (const t of tools) {
    if (t.inputSchema?.additionalProperties !== false) p.push(`${t.name}: inputSchema allows unknown arguments`);
    walk(t.inputSchema, t.name);
  }
  return p;
}

test('every input schema closes its arguments and uses only what the check enforces (planted faults: an open schema, a pattern)', () => {
  assert.deepEqual(schemaProblems(toolList()), []);
  const t = structuredClone(toolList().find((x) => x.name === 'save_map'));
  t.inputSchema.additionalProperties = true;
  t.inputSchema.properties.name.pattern = '^[a-z]+$';
  assert.deepEqual(schemaProblems([/** @type {any} */ (t)]), ['save_map: inputSchema allows unknown arguments', 'save_map.name: "pattern" is not checked']);
  // The check itself, on a tool with no arguments missing: nothing to say.
  assert.equal(argumentProblems(/** @type {any} */ (toolList().find((x) => x.name === 'list_maps')), {}), null);
});
