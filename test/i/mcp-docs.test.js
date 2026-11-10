// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// The MCP tools explain themselves: a lint over every tool, the prompts and the server instructions,
// and the guide's tool catalog (docs/MCP.md) is the one generated from src/ops.js. Every rule has a
// planted fault that it must report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { COST_NOTE } from '../../src/ops.js';
import { toolList, MCP_OPS, PROMPTS, INSTRUCTIONS } from '../../src/server/mcp.js';
import { GUIDE, withCatalog } from '../../scripts/mcp-catalog.js';

/** POST routes that write nothing (the context check only answers). */
const WRITES_NOTHING = new Set(['check_context']);

/** @param {any} s a property schema */
const needsExample = (s) => !s.enum && s.type !== 'boolean';

/**
 * Problems in the tool list. `ops` gives each tool's op (by MCP name).
 * @param {any[]} tools @param {(name: string) => any} opOf @returns {string[]}
 */
export function toolDocProblems(tools, opOf) {
  /** @type {string[]} */
  const p = [];
  for (const t of tools) {
    const op = opOf(t.name);
    if (!op) { p.push(`${t.name}: no op`); continue; }
    const d = String(t.description ?? '');
    if (!t.title) p.push(`${t.name}: no title`);
    if (!/\bUse when\b/.test(d)) p.push(`${t.name}: no "Use when"`);
    if (!/\bDon't use when\b/.test(d)) p.push(`${t.name}: no "Don't use when"`);
    if (!/\bReturns\b/.test(d)) p.push(`${t.name}: no "Returns"`);
    if (!/\bNext: /.test(d)) p.push(`${t.name}: no "Next:"`);
    if (op.callsModel && !d.endsWith(COST_NOTE)) p.push(`${t.name}: calls the model but does not end with the cost line`);
    if (!op.callsModel && d.includes(COST_NOTE)) p.push(`${t.name}: carries the cost line but does not call the model`);
    for (const [name, s] of Object.entries(t.inputSchema?.properties ?? {})) {
      const desc = String(/** @type {any} */ (s).description ?? '');
      if (!desc) p.push(`${t.name}.${name}: no description`);
      else if (needsExample(s) && !/\bE\.g\. /.test(desc)) p.push(`${t.name}.${name}: no example ("E.g. …")`);
    }
    const a = t.annotations ?? {};
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      if (typeof a[k] !== 'boolean') p.push(`${t.name}: annotation ${k} not set`);
    }
    const writes = op.http.method !== 'GET' && !WRITES_NOTHING.has(op.name);
    if (op.scope === 'read' && a.readOnlyHint !== true) p.push(`${t.name}: a read-only tool without readOnlyHint true`);
    if (writes && a.readOnlyHint !== false) p.push(`${t.name}: writes but claims readOnlyHint`);
    if (a.readOnlyHint === true && a.destructiveHint !== false) p.push(`${t.name}: a read-only tool must not be destructive`);
    if (a.openWorldHint !== Boolean(op.callsModel)) p.push(`${t.name}: openWorldHint must be ${Boolean(op.callsModel)} (it ${op.callsModel ? 'calls' : 'never calls'} the model)`);
    if (a.idempotentHint === true && writes) p.push(`${t.name}: a write that claims to be idempotent`);
    const json = !op.http.type && op.output?.type !== 'string'; // export_map's type follows its format
    if (json && !t.outputSchema) p.push(`${t.name}: answers JSON but has no outputSchema`);
    if (t.outputSchema && t.outputSchema.type !== 'object') p.push(`${t.name}: outputSchema must be an object schema`);
  }
  return p;
}

/** Tool-like words (snake_case) in a text that are not tools. @param {string} text @param {Set<string>} names */
const unknownTools = (text, names) => [...new Set([...text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((m) => m[0]))].filter((w) => !names.has(w));

/** @param {typeof PROMPTS} prompts @param {Set<string>} names */
export function promptProblems(prompts, names) {
  /** @type {string[]} */
  const p = [];
  for (const pr of prompts) {
    if (!pr.title || !pr.description) p.push(`${pr.name}: no title or description`);
    for (const a of pr.arguments) if (!a.description) p.push(`${pr.name}.${a.name}: no description`);
    const filled = Object.fromEntries(pr.arguments.map((a) => [a.name, `<${a.name}>`]));
    const text = pr.text(filled);
    for (const w of unknownTools(text, names)) p.push(`${pr.name}: names a tool that does not exist: ${w}`);
    for (const a of pr.arguments.filter((x) => x.required)) if (!text.includes(`<${a.name}>`)) p.push(`${pr.name}: does not use its argument ${a.name}`);
  }
  return p;
}

const toolNames = () => new Set(toolList().map((t) => t.name));
const opOf = (/** @type {string} */ n) => MCP_OPS.find((o) => o.mcp?.name === n);

test('every tool has a title, the description shape, described inputs with examples, truthful annotations, an output schema for JSON', () => {
  assert.deepEqual(toolDocProblems(toolList(), opOf), []);
});

test('planted faults: one per rule is reported', () => {
  const base = toolList();
  /** @param {string} name @param {(t: any) => any} change */
  const faulty = (name, change) => toolDocProblems(base.map((t) => (t.name === name ? change(structuredClone(t)) : t)), opOf);
  /** @param {string[]} got @param {RegExp} want */
  const has = (got, want) => assert.ok(got.some((x) => want.test(x)), `expected ${want} in ${JSON.stringify(got)}`);
  has(faulty('get_node', (t) => { delete t.title; return t; }), /get_node: no title/);
  has(faulty('get_node', (t) => ({ ...t, description: t.description.replace('Use when', 'Handy when') })), /get_node: no "Use when"/);
  has(faulty('get_node', (t) => ({ ...t, description: t.description.replace("Don't use when", 'Avoid when') })), /no "Don't use when"/);
  has(faulty('get_node', (t) => ({ ...t, description: t.description.replace('Returns', 'Gives') })), /get_node: no "Returns"/);
  has(faulty('get_node', (t) => ({ ...t, description: t.description.replace('Next: ', 'Then ') })), /get_node: no "Next:"/);
  has(faulty('research', (t) => ({ ...t, description: t.description.replace(` ${COST_NOTE}`, '') })), /research: calls the model but does not end with the cost line/);
  has(faulty('get_outline', (t) => ({ ...t, description: `${t.description} ${COST_NOTE}` })), /get_outline: carries the cost line/);
  has(faulty('search_map', (t) => { delete t.inputSchema.properties.q.description; return t; }), /search_map\.q: no description/);
  has(faulty('search_map', (t) => { t.inputSchema.properties.q.description = 'Keywords'; return t; }), /search_map\.q: no example/);
  has(faulty('get_context', (t) => { t.annotations.readOnlyHint = false; return t; }), /get_context: a read-only tool without readOnlyHint true/);
  has(faulty('build_map', (t) => { t.annotations.readOnlyHint = true; return t; }), /build_map: writes but claims readOnlyHint/);
  has(faulty('ask_map', (t) => { t.annotations.openWorldHint = false; return t; }), /ask_map: openWorldHint must be true/);
  has(faulty('get_outline', (t) => { t.annotations.openWorldHint = true; return t; }), /get_outline: openWorldHint must be false/);
  has(faulty('research', (t) => { t.annotations.idempotentHint = true; return t; }), /research: a write that claims to be idempotent/);
  has(faulty('get_node', (t) => { t.annotations.destructiveHint = true; return t; }), /get_node: a read-only tool must not be destructive/);
  has(faulty('fuse', (t) => { delete t.annotations.destructiveHint; return t; }), /fuse: annotation destructiveHint not set/);
  has(faulty('wait_for_map', (t) => { delete t.outputSchema; return t; }), /wait_for_map: answers JSON but has no outputSchema/);
});

test('the prompts name only real tools and use their arguments; the instructions name every tool', () => {
  const names = toolNames();
  assert.deepEqual(promptProblems(PROMPTS, names), []);
  for (const want of ['learn-a-field', 'brainstorm-from-map', 'map-for-a-doc']) assert.ok(PROMPTS.some((p) => p.name === want), want);
  assert.deepEqual(unknownTools(INSTRUCTIONS, names), []);
  for (const n of names) assert.ok(INSTRUCTIONS.includes(n), `the instructions mention ${n}`);
  assert.ok(INSTRUCTIONS.length < 4000, 'the instructions stay short');
  // Planted faults: a prompt that names a tool that does not exist, and one that drops its argument.
  const bad = [{ ...PROMPTS[0], text: () => 'Call make_map, then read it.' }];
  const p = promptProblems(bad, names);
  assert.ok(p.some((x) => /names a tool that does not exist: make_map/.test(x)));
  assert.ok(p.some((x) => /does not use its argument topic/.test(x)));
});

test('the guide\'s tool catalog is the generated one (run node scripts/mcp-catalog.js after changing a tool)', () => {
  const text = fs.readFileSync(GUIDE, 'utf8');
  assert.equal(withCatalog(text), text, 'docs/MCP.md is stale: run node scripts/mcp-catalog.js');
  for (const t of toolList()) assert.ok(text.includes(`### \`${t.name}\`: ${t.title}`), t.name);
  // Planted fault: a hand edit inside the catalog is caught.
  const edited = text.replace('### `get_node`: Read one node', '### `get_node`: Read a node');
  assert.notEqual(withCatalog(edited), edited);
});

test('the guide is linked from README, AGENTS.md and the install guide', () => {
  const read = (/** @type {string} */ f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
  /** @param {Record<string, string>} files */
  const unlinked = (files) => Object.entries(files).filter(([, t]) => !t.includes('docs/MCP.md') && !t.includes('(MCP.md)')).map(([f]) => f);
  const files = { 'README.md': read('README.md'), 'AGENTS.md': read('AGENTS.md'), 'docs/AGENT-INSTALL.md': read('docs/AGENT-INSTALL.md') };
  assert.deepEqual(unlinked(files), []);
  // Near the top: within the first 20 lines of README, the first 3 of AGENTS.md.
  assert.ok(files['README.md'].split('\n').slice(0, 20).join('\n').includes('docs/MCP.md'), 'README links it near the top');
  assert.ok(files['AGENTS.md'].split('\n').slice(0, 3).join('\n').includes('docs/MCP.md'), 'AGENTS.md points to it first');
  // Planted fault: a file without the link is reported.
  assert.deepEqual(unlinked({ 'x.md': '# nothing here' }), ['x.md']);
});

test('live: the instructions arrive at initialize, the prompts expand, build_map lists the sources this caller holds', async () => {
  const { startService } = await import('../../src/server/service.js');
  const { createToken, tokensPath } = await import('../../src/server/tokens.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { tempHome, stubEngine } = await import('./helpers-service.js');
  const home = tempHome();
  const team = createToken(tokensPath(home), { name: 'team', scopes: ['read', 'build'], sources: ['wiki', 'docs'] }).token;
  const reader = createToken(tokensPath(home), { name: 'reader', scopes: ['read'] }).token;
  const entries = [
    { name: 'wiki', url: 'https://wiki.example/mcp', visibility: 'private', allowTools: ['search'] },
    { name: 'docs', url: 'https://docs.example/mcp', visibility: 'public', allowTools: ['search'] },
  ];
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, tokensFile: tokensPath(home), version: 'test', config: { sources: entries },
    sources: /** @type {any} */ ({ entries, names: () => ['wiki', 'docs'], status: async () => [], toolset: async () => null, close: async () => {} }),
    makeEngine: async (/** @type {any} */ x) => stubEngine(x),
  });
  /** @param {string} token */
  const connect = async (token) => {
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/v1/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  const a = await connect(team);
  const b = await connect(reader);
  try {
    assert.equal(a.getInstructions(), INSTRUCTIONS);
    const sourcesOf = async (/** @type {any} */ c) => (await c.listTools()).tools.find((/** @type {any} */ t) => t.name === 'build_map').inputSchema.properties.sources;
    const held = await sourcesOf(a);
    assert.deepEqual(held.items.enum, ['wiki', 'docs']);
    assert.match(held.description, /You hold: wiki \(private\), docs \(public\)$/);
    // A token without a sources list holds the public ones only: the private name is never shown to it.
    const pub = await sourcesOf(b);
    assert.deepEqual(pub.items.enum, ['docs']);
    assert.match(pub.description, /You hold: docs \(public\)$/); // ("wiki" appears only as the static example)
    const tools = (await a.listTools()).tools;
    assert.equal(tools.find((/** @type {any} */ t) => t.name === 'get_context').title, 'Bring a map into your context');
    assert.equal(tools.find((/** @type {any} */ t) => t.name === 'get_context').annotations.readOnlyHint, true);
    const { prompts } = await a.listPrompts();
    assert.deepEqual(prompts.map((/** @type {any} */ p) => p.name), PROMPTS.map((p) => p.name));
    const got = await a.getPrompt({ name: 'learn-a-field', arguments: { topic: 'home espresso' } });
    assert.match(/** @type {any} */ (got.messages[0].content).text, /^Help me learn home espresso\. First call list_maps/);
    await assert.rejects(a.getPrompt({ name: 'learn-a-field', arguments: {} }), /needs: topic/);
  } finally { await a.close(); await b.close(); await srv.close(); }
});
