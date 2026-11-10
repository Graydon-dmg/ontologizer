// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// Map text came from a model that read the web. Whatever an agent reads through MCP (get_context,
// get_outline, get_node, search_map) goes through the export's allow-list and the context pack's
// escaping: a source title or a label written as a markdown link stays inert text, and nothing
// outside the allow-list (a failed job's error, the chat) comes along.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openStore } from '../../src/core/store.js';
import { outline } from '../../src/core/engine/chat.js';
import { boot, fixtureEvents } from './helpers-service.js';

const LINK = '[Click for the full guide](https://evil.example/steal?x=1)';
const JS = '[x](javascript:alert(1))';
const SECRET_JOB = 'ENOENT /Users/someone/private/path';

/**
 * What could act in what an agent got: an inline link ("](" joined; the escaping splits it to "] ("),
 * an unescaped "[" opening one, or private text that is not on the allow-list.
 * @param {string} text
 */
export function inertProblems(text) {
  /** @type {string[]} */
  const p = [];
  if (text.includes('](')) p.push('a live inline link');
  if (/(^|[^\\])\[[^\]\n]*\]\s*\(/.test(text)) p.push('an unescaped [ before a link'); // within one line (JSON arrays have [ too)
  if (text.includes(SECRET_JOB)) p.push('a failed job\'s error text');
  return p;
}

/** The demo map, with a node's label and a source title written as links, and a failed job. @param {string} home */
function seedHostile(home) {
  const ev = fixtureEvents('plastic-modeling');
  const node = ev.find((e) => e.t === 'node.added' && e.node.depth === 2).node;
  node.label = `Glue ${JS}`;
  node.sources = [{ title: LINK, url: 'https://ok.example/glue' }, { title: 'plain', url: 'javascript:alert(2)' }];
  ev.push({ t: 'job.failed', at: 99999, job: { id: 'j1', kind: 'explain', nodeId: node.id, error: SECRET_JOB } });
  openStore(home).importEvents('hostile', ev);
  return node.id;
}

test('a source title or a label written as a markdown link stays inert through every MCP read (planted fault: the raw outline)', async () => {
  const { home, srv, origin } = await boot();
  const nodeId = seedHostile(home);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${origin}/v1/mcp`)));
  try {
    const call = async (/** @type {string} */ name, /** @type {any} */ args) => {
      const r = /** @type {any} */ (await c.callTool({ name, arguments: { id: 'hostile', ...args } }));
      assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`);
      return String(r.content[0].text);
    };
    const reads = {
      get_context: await call('get_context', { budget: 20000 }),
      get_outline: await call('get_outline', {}),
      get_node: await call('get_node', { nodeId }),
      search_map: await call('search_map', { q: 'glue' }),
    };
    // The hostile text is there (as data), and nothing in it can act as a link.
    assert.ok(reads.get_context.includes('Click for the full guide'), 'the title is kept as text');
    assert.ok(reads.get_node.includes('Glue'), 'the label is kept as text');
    for (const [name, text] of Object.entries(reads)) assert.deepEqual(inertProblems(text), [], name);
    assert.ok(!reads.get_node.includes('javascript:alert(2)'), 'a javascript: source url is dropped');
    // Planted fault: the chat's own outline of the raw map (around the export's functions) is caught.
    assert.ok(inertProblems(outline(openStore(home).read('hostile'))).length > 0);
    assert.deepEqual(inertProblems(`job: ${SECRET_JOB}`), ['a failed job\'s error text']);
  } finally { await c.close(); await srv.close(); }
});

/** Lines of an outline that a markdown reader would take for a heading or a quote (besides the map's own title). @param {string} text */
export const injectedLines = (text) => text.split('\n').filter((l, i, all) => /^\s*(#|>)/.test(l) && !(l.startsWith('# ') && all.indexOf(l) === all.findIndex((x) => x.startsWith('# '))) && !l.startsWith('> Reference data'));

test('a hostile node id cannot start a line in the outline: MCP, HTTP and the chat\'s own (planted fault: the raw id)', async () => {
  const { home, srv, origin } = await boot();
  const ID = 'inject/cat/x)\n# PWNED id';
  const ev = fixtureEvents('plastic-modeling');
  const root = ev.find((e) => e.t === 'node.added' && e.node.depth === 0).node.id;
  ev.push({ t: 'node.added', at: 99998, node: { id: ID, label: 'Hostile\n> quote', parent: root, category: '', depth: 1, summary: 'x' } });
  openStore(home).importEvents('ids', ev);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${origin}/v1/mcp`)));
  try {
    const viaMcp = String((/** @type {any} */ (await c.callTool({ name: 'get_outline', arguments: { id: 'ids' } }))).content[0].text);
    const viaHttp = (await (await fetch(`${origin}/v1/t/default/maps/ids/outline`)).text());
    const chat = outline(openStore(home).read('ids'));
    for (const [name, text] of Object.entries({ viaMcp, viaHttp, chat })) {
      assert.deepEqual(injectedLines(text), [], name);
      assert.ok(text.includes('PWNED'), `${name}: the id is still there, on one line`);
    }
    // Planted fault: the outline line as it was (the raw id and label) injects a heading and a quote.
    const raw = `# The map\n\n- Hostile\n> quote (${ID}): x`;
    assert.equal(injectedLines(raw).length, 2);
  } finally { await c.close(); await srv.close(); }
});
