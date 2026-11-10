// @ts-check
// MCP for agents: the map tools, made from src/ops.js. No code here calls an engine or a store:
// every tool call becomes one HTTP request to the router (requestFor), carrying the caller's own
// credentials, so the tenant, scope, read rule, policy, limits and Origin checks apply unchanged.
//   createMcpServer  the protocol server (tools + resources) over an injected `call`
//   handleMcpHttp    POST /v1/mcp: stateless streamable HTTP, one server per request
//   loopbackCaller   `call` through node:http to this machine, forwarding the caller's headers
//   remoteCaller     `call` through fetch to another server, with a bearer token
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema,
  McpError, ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { OPS, opByName, requestFor, COST_NOTE } from '../ops.js';
import { agentMap } from './reads.js';

/**
 * @typedef {{ status: number, type: string, text: string, headers: Record<string, string> }} CallResult
 * @typedef {(op: import('../ops.js').Op, input: Record<string, any>) => Promise<CallResult>} Call
 */

export const MCP_OPS = OPS.filter((o) => o.mcp);
export { COST_NOTE };

/** Sent in the initialize result: what the server holds and how the tools fit together. */
export const INSTRUCTIONS = `Ontologizer builds and serves topic maps: a tree of categories and nodes about one field (each node has an id like "sourdough/starter/levain", a label and a one-line summary), with cross-links between categories (bridges), insights, thin areas, and sources (web pages, or documents from configured sources). A map is built once by the model and then read for free.

Start with the free reads: list_maps (what exists), get_context (a whole map as markdown sized for your context: the best first read), get_outline (every node and its id), search_map (find a node), get_node (one node in full). They never call the model. get_context gives each node's id after its label, so you rarely need get_outline just for ids.

A new map is mostly one-line summaries: a node has an article only once someone calls explain on it. get_context and get_node say how much of the map is still one line; call explain on the nodes your task depends on (it costs credits), never on a whole map by default.

Tools that call the model cost the user API credits and say so: check_context, build_map, research, explain, sources, ask_map, fuse, rosetta. Use them only when the free reads cannot answer.

Usual workflows:
- Learn a field: list_maps; if no map fits, check_context (repeat with answers while it asks questions), build_map, wait_for_map, then get_context and teach or brainstorm from it yourself.
- Deepen one node: search_map or get_outline for its id, get_node, then explain (write its article) or research (add nodes under it), wait_for_map, get_node again.
- Deepen several nodes your task depends on: explain or sources with nodeIds (at most 8 in one call; each node is its own job and about one model call), then wait_for_map (it waits for all of them) and get_node on each.
- Put a map into a document or page: export_map with format "embed" (an offline, interactive fragment) or "html" (a whole page).
- Where two fields connect: fuse two existing maps, wait_for_map on the new map (draftId), get_context on it and read its Bridges.
- A question answered in prose with citations: ask_map. It is not a read: it adds the question and answer to the map's chat, which everyone who can open the map sees.

Jobs (build_map, research, explain, sources, fuse, rosetta) answer at once and run in the background: wait on the map with wait_for_map. Drafts are kept; save_map only names a map.

Private maps: a map built from a private source (build_map with sources) is private for good; only callers who hold its sources can read it, and to everyone else it does not exist ("not found", the same as a missing map). Runs on a private map use no web search. Its exports are marked Private: share them only with people who may read the map.

Errors come back as tool results that say what went wrong and what to call next.`;

/**
 * Starting points a client can offer. `text(args)` is the user message the prompt expands to.
 * @type {Array<{ name: string, title: string, description: string, arguments: Array<{ name: string, description: string, required?: boolean }>, text: (a: Record<string, string>) => string }>}
 */
export const PROMPTS = [
  { name: 'learn-a-field', title: 'Learn a field',
    description: 'Map a field you know nothing about, then learn it from the map.',
    arguments: [{ name: 'topic', description: 'The field, and who it is for. E.g. "home espresso for a complete beginner"', required: true }],
    text: (a) => `Help me learn ${a.topic}. First call list_maps and use a map that already covers it. If none does, call check_context with a description of the topic and who it is for; answer its questions (ask me if you cannot), call it again with the answers until it is ready, then build_map with the brief and wait_for_map until it is idle. Then call get_context and teach me the field from it: the big picture, the key ideas, and where to start. Use get_node for detail. Do not call research, explain or ask_map unless I ask.` },
  { name: 'brainstorm-from-map', title: 'Brainstorm from a map',
    description: 'Ground a brainstorm in a map you already have.',
    arguments: [{ name: 'map', description: 'The map id. E.g. "home-espresso"', required: true },
      { name: 'goal', description: 'What the ideas are for. E.g. "a weekend side project"' }],
    text: (a) => `Call get_context on the map "${a.map}" (budget 6000) and brainstorm${a.goal ? ` ideas for ${a.goal}` : ' ideas'} from it yourself. Use its thin areas and bridges for less obvious ideas, and name the nodes each idea builds on. Use search_map and get_node for detail. Do not call tools that call the model.` },
  { name: 'map-for-a-doc', title: 'Put a map into a document',
    description: 'An interactive map of a field, ready to paste into a document or web page.',
    arguments: [{ name: 'topic', description: 'The field, and who the document is for. E.g. "electric bicycles, for a product team"', required: true },
      { name: 'format', description: '"embed" (a fragment for a document, the default) or "html" (a whole page)' }],
    text: (a) => `I need a map of ${a.topic} in a document. Call list_maps and use a map that already covers it; otherwise check_context, build_map and wait_for_map until it is idle. Then call export_map with format "${a.format === 'html' ? 'html' : 'embed'}" and put the result into my document as it is: it works offline and loads nothing from the network. Use get_context if you also need to write about the map.` },
  { name: 'connect-two-fields', title: 'Find where two fields connect',
    description: 'Fuse two maps and read the bridges between them.',
    arguments: [{ name: 'a', description: 'The first map id. E.g. "sourdough"', required: true },
      { name: 'b', description: 'The second map id. E.g. "fermentation-science"', required: true }],
    text: (a) => `Find where "${a.a}" and "${a.b}" connect. Call list_maps to check both exist (build a missing one first). Call fuse on "${a.a}" with "${a.b}", then wait_for_map on the draftId it returns, then get_context on that new map and explain its Bridges to me, naming the nodes on each side.` },
  { name: 'deepen-a-node', title: 'Look into one node and go deeper',
    description: 'See what a map says about one node, then extend it.',
    arguments: [{ name: 'map', description: 'The map id. E.g. "sourdough"', required: true },
      { name: 'node', description: 'The node, in words. E.g. "levain"', required: true }],
    text: (a) => `On the map "${a.map}", call search_map for "${a.node}" and get_node on the best match, and tell me what the map says. Then, if it is thin, call explain (to write its article) or research (to add nodes under it), wait_for_map, and get_node again to show me what is new.` },
  { name: 'private-map', title: 'A private map from your own sources',
    description: 'Build a map from a private source and keep it private.',
    arguments: [{ name: 'topic', description: 'What the map is about. E.g. "our onboarding process"', required: true },
      { name: 'source', description: 'A private source you hold, as listed on build_map. E.g. "wiki"', required: true }],
    text: (a) => `Build a private map of ${a.topic} from the source "${a.source}": check_context with the topic (no private details in it), then build_map with the brief and sources ["${a.source}"], then wait_for_map. The map is private from the start because the source is private; list_maps shows visibility "private". Read it with get_context. Do not export it or call sources on it unless I say who may see it.` },
];

/** A schema without `additionalProperties: false` (an output may grow; the client checks against it). @param {any} s @returns {any} */
function loose(s) {
  if (Array.isArray(s)) return s.map(loose);
  if (!s || typeof s !== 'object') return s;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties' && v === false) continue;
    out[k] = loose(v);
  }
  return out;
}

const ASK_OUTPUT = { type: 'object', properties: {
  answer: { type: 'string' }, chatId: { type: 'string' },
  citedNodes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } } } },
  sources: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } } } },
  webSearch: { type: 'object', description: 'Whether the answer searched the web, and the error_code of a search that failed or ran out',
    properties: { used: { type: 'boolean' }, failed: { enum: ['max_uses_exceeded', 'too_many_requests', 'unavailable', 'query_too_long', 'invalid_input'] } }, required: ['used'] },
}, required: ['answer', 'citedNodes', 'sources'] };

/** The tool's output schema: the op's JSON object output (a list is wrapped as { maps }); none for text. @param {import('../ops.js').Op} op */
export function outputSchemaOf(op) {
  if (op.name === 'list_maps') return { type: 'object', properties: { maps: loose(op.output) }, required: ['maps'] };
  if (op.name === 'ask_map') return ASK_OUTPUT;
  if (op.output?.type === 'object' && !op.http.type) return loose(op.output);
  return undefined;
}

/** Names an agent is likely to guess, by the property they mean (suggested only when the tool has it). */
const ALIASES = {
  id: ['map', 'mapid', 'map_id', 'mapname', 'map_name', 'mapslug'],
  nodeId: ['node', 'node_id', 'nodeid', 'nodename', 'node_name'],
  q: ['query', 'search', 'keywords', 'keyword', 'term', 'terms', 'text'],
  text: ['question', 'prompt', 'message', 'query', 'ask', 'q'],
  timeout: ['timeoutms', 'timeout_ms', 'wait', 'waitms', 'ms'],
  context: ['topic', 'description', 'subject', 'prompt'],
  budget: ['tokens', 'maxtokens', 'max_tokens', 'limit'],
  with: ['other', 'b', 'second', 'withid', 'with_id'],
  persona: ['as', 'audience', 'who'],
};

/** Edit distance, for "did you mean". @param {string} a @param {string} b */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/** The property an unknown argument most likely meant, or null. @param {string} given @param {string[]} names */
export function nearestName(given, names) {
  const g = given.toLowerCase();
  for (const n of names) if (n.toLowerCase() === g) return n;
  for (const n of names) if ((/** @type {Record<string, string[]>} */ (ALIASES))[n]?.includes(g)) return n;
  const prefix = names.filter((n) => g.startsWith(n.toLowerCase()) || n.toLowerCase().startsWith(g));
  if (prefix.length === 1) return prefix[0];
  let best = null;
  let bestD = 3;
  for (const n of names) { const dd = distance(g, n.toLowerCase()); if (dd < bestD) { bestD = dd; best = n; } }
  return best;
}

/** @param {any} v @param {any} schema @returns {string|null} what is wrong with one value */
function valueProblem(v, schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (Array.isArray(schema.enum)) return schema.enum.includes(v) ? null : `must be one of ${schema.enum.map((/** @type {any} */ e) => JSON.stringify(e)).join(', ')}`;
  const range = (/** @type {string} */ what) => `must be ${what}${schema.minimum !== undefined && schema.maximum !== undefined ? ` from ${schema.minimum} to ${schema.maximum}` : schema.minimum !== undefined ? ` of at least ${schema.minimum}` : ''}`;
  switch (schema.type) {
    case 'string': return typeof v === 'string' ? null : 'must be a string';
    case 'boolean': return typeof v === 'boolean' ? null : 'must be true or false';
    case 'integer':
      if (!Number.isInteger(v) || (schema.minimum !== undefined && v < schema.minimum) || (schema.maximum !== undefined && v > schema.maximum)) return range('a whole number');
      return null;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v) || (schema.minimum !== undefined && v < schema.minimum) || (schema.maximum !== undefined && v > schema.maximum)) return range('a number');
      return null;
    case 'object': return v && typeof v === 'object' && !Array.isArray(v) ? null : 'must be an object';
    case 'array': {
      if (!Array.isArray(v)) return 'must be a list';
      if (schema.minItems !== undefined && v.length < schema.minItems) return `must have at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`;
      if (schema.maxItems !== undefined && v.length > schema.maxItems) return `must have at most ${schema.maxItems} items`;
      if (schema.uniqueItems === true) {
        const dup = v.find((x, i) => v.indexOf(x) !== i);
        if (dup !== undefined) return `lists ${JSON.stringify(dup)} twice`;
      }
      for (const [i, item] of v.entries()) {
        const p = valueProblem(item, schema.items);
        if (p) return `item ${i + 1} ${p}`;
      }
      return null;
    }
    default: return null;
  }
}

/**
 * Check a tool call's arguments against the tool's input schema (the subset the ops use: unknown
 * names, required ones, types, enums, ranges). The router checks values again; this catches a guessed
 * name, which the router would otherwise ignore. Returns the message for the agent, or null.
 * @param {{ name: string, inputSchema: any }} tool @param {Record<string, any>} args
 */
export function argumentProblems(tool, args) {
  const props = tool.inputSchema?.properties ?? {};
  const names = Object.keys(props);
  const required = /** @type {string[]} */ (tool.inputSchema?.required ?? []);
  const takes = `${tool.name} takes: ${names.map((n) => `${n}${required.includes(n) ? ' (required)' : ''}`).join(', ') || 'no arguments'}.`;
  /** @type {string[]} */
  const problems = [];
  for (const k of Object.keys(args)) {
    if (k in props) continue;
    const near = nearestName(k, names);
    problems.push(`Unknown argument \`${k}\`.${near ? ` Did you mean ${near}?` : ''}`);
  }
  for (const r of required) if (args[r] === undefined || args[r] === null) problems.push(`Missing argument \`${r}\`.`);
  for (const [k, v] of Object.entries(args)) {
    if (!(k in props) || v === undefined || v === null) continue;
    const p = valueProblem(v, props[k]);
    if (p) problems.push(`Argument \`${k}\` ${p}.`);
  }
  return problems.length ? `${problems.join(' ')} ${takes}` : null;
}

/** The tools: name, title, description and annotations (from the op), the op's input schema without `tenant`, the output schema. */
export function toolList() {
  return MCP_OPS.map((op) => {
    const { tenant: _t, ...properties } = op.input.properties ?? {};
    const required = (op.input.required ?? []).filter((/** @type {string} */ k) => k !== 'tenant');
    const m = /** @type {NonNullable<import('../ops.js').Op['mcp']>} */ (op.mcp);
    const outputSchema = outputSchemaOf(op);
    return {
      name: m.name,
      ...(m.title ? { title: m.title } : {}),
      description: m.description,
      inputSchema: { ...op.input, properties, required },
      ...(outputSchema ? { outputSchema } : {}),
      ...(m.annotations ? { annotations: { ...(m.title ? { title: m.title } : {}), ...m.annotations } } : {}),
    };
  });
}

/** @param {string} s */
const tryJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
/** @param {string} text @param {boolean} [isError] */
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

/**
 * A non-2xx answer as an actionable message: the server's own error first (so "not found" reads the same
 * as over HTTP, for a hidden map and a missing one alike), then what to call next. The hint depends only
 * on the status and the tool, never on whether a hidden map exists.
 * @param {CallResult} r @param {string} [tool]
 */
export function errorText(r, tool = '') {
  const j = tryJson(r.text);
  let msg = j && typeof j === 'object' && typeof j.error === 'string' ? j.error : (r.text.trim() || `HTTP ${r.status}`);
  const s = r.status;
  if (s === 429) {
    const n = Number(r.headers['retry-after']);
    if (Number.isFinite(n) && n >= 0) msg += ` (try again in ${n} seconds)`;
    msg += /Daily limit/.test(msg) ? ' Tools that do not call the model (get_context, get_outline, search_map, get_node, export_map) still work.' : '';
    return msg;
  }
  if (s === 404 && tool === 'get_node' && Array.isArray(j?.didYouMean)) {
    return `${msg}${j.didYouMean.length ? ` Close node ids: ${j.didYouMean.join(', ')}.` : ''} Call search_map or get_outline for node ids.`;
  }
  /** @type {Record<number, string>} */
  const next = {
    400: 'Check the arguments against this tool\'s input schema.',
    401: 'This server needs a token: send "Authorization: Bearer <token>" (HTTP) or start ontologizer mcp with --token-file.',
    403: 'Your token does not allow this. The free read tools (get_context, get_outline, search_map, get_node) may still work; for more, ask the server\'s operator for a token with that scope.',
    404: 'No map with that id exists that you may read. Call list_maps for the ids you can use.',
    409: 'Something is still running on the map: call wait_for_map, then try again.',
    413: 'The request is too large: send less text.',
    502: 'The model call failed: try again later; if it keeps failing, the server\'s API key may be missing or wrong.',
    503: 'The server cannot serve this right now (its store, or it is stopping): try again shortly.',
  };
  const hint = next[s] ?? (s >= 500 ? 'The server failed: try again later.' : '');
  return hint ? `${msg}${/[.!?)]$/.test(msg) ? '' : '.'} ${hint}` : msg;
}

/** The text an SSE chat stream carries, and its parts. @param {string} body */
export function collectChat(body) {
  let answer = '';
  /** @type {Array<{ label: string, id: string }>} */
  const cited = [];
  /** @type {Array<{ title: string, url: string }>} */
  const sources = [];
  /** @type {string|null} */
  let error = null;
  /** @type {{ used: boolean, failed?: string } | null} */
  let webSearch = null;
  let webNote = '';
  for (const block of body.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const item = tryJson(line.slice(5).trim());
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'delta') answer += String(item.text ?? '');
    else if (item.type === 'citation' && !cited.some((c) => c.id === item.nodeId)) cited.push({ label: String(item.label ?? item.nodeId), id: String(item.nodeId) });
    else if (item.type === 'source' && !sources.some((s) => s.url === item.url)) sources.push({ title: String(item.title ?? item.url), url: String(item.url) });
    else if (item.type === 'error') error = String(item.error ?? 'error');
    else if (item.type === 'websearch') {
      webSearch = { used: item.used === true, ...(typeof item.failed === 'string' && item.failed ? { failed: item.failed } : {}) };
      webNote = typeof item.note === 'string' ? item.note : '';
    }
  }
  let out = answer.trim();
  if (cited.length) out += `${out ? '\n\n' : ''}Cited nodes:\n${cited.map((c) => `- ${c.label} (${c.id})`).join('\n')}`;
  if (sources.length) out += `${out ? '\n\n' : ''}Sources:\n${sources.map((s) => `- ${s.title}: ${s.url}`).join('\n')}`;
  if (webNote) out += `${out ? '\n\n' : ''}Web search: ${webNote}`;
  if (error) out += `${out ? '\n\n' : ''}Error: ${error}`;
  return { text: out, isError: error !== null && !answer.trim(), error, answer: answer.trim(), cited, sources, webSearch };
}

/**
 * @param {{ call: Call, version?: string, baseUrl?: string }} o
 * @returns {Server}
 */
export function createMcpServer({ call, version = '0.0.0', baseUrl = '' }) {
  const server = new Server({ name: 'ontologizer', title: 'Ontologizer', version },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS });
  const abs = (/** @type {any} */ u) => (typeof u === 'string' && u.startsWith('/') ? `${baseUrl.replace(/\/+$/, '')}${u}` : u);

  /** The caller's tenant, asked once. @type {Promise<string>|null} */
  let tenantP = null;
  const tenant = () => {
    tenantP ??= (async () => {
      const r = await call(/** @type {any} */ (opByName('get_session')), {});
      const j = r.status >= 200 && r.status < 300 ? tryJson(r.text) : undefined;
      if (!j || typeof j.tenant !== 'string') throw new Error(r.status >= 200 && r.status < 300 ? 'the server did not say who you are' : errorText(r));
      return j.tenant;
    })();
    tenantP.catch(() => { tenantP = null; }); // a failure is not remembered
    return tenantP;
  };

  // build_map lists the sources this caller holds (the router's own answer), so an agent knows the names.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = toolList();
    try {
      const r = await call(/** @type {any} */ (opByName('list_sources')), { tenant: await tenant() });
      const held = r.status >= 200 && r.status < 300 ? tryJson(r.text) : null;
      if (Array.isArray(held) && held.length && held.every((x) => x && typeof x.name === 'string')) {
        const build = /** @type {any} */ (tools.find((t) => t.name === 'build_map'));
        const prop = build.inputSchema.properties.sources;
        build.inputSchema = { ...build.inputSchema, properties: { ...build.inputSchema.properties,
          sources: { ...prop, items: { type: 'string', enum: held.map((x) => x.name) },
            description: `${prop.description}. You hold: ${held.map((x) => `${x.name} (${x.visibility === 'private' ? 'private' : 'public'})`).join(', ')}` } } };
      }
    } catch { /* no sources to list: the static schema */ }
    return { tools };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments })),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const p = PROMPTS.find((x) => x.name === request.params.name);
    if (!p) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${request.params.name}. Prompts: ${PROMPTS.map((x) => x.name).join(', ')}.`);
    const args = /** @type {Record<string, string>} */ (request.params.arguments ?? {});
    const missing = p.arguments.filter((a) => a.required && !String(args[a.name] ?? '').trim()).map((a) => a.name);
    if (missing.length) throw new McpError(ErrorCode.InvalidParams, `The prompt ${p.name} needs: ${missing.join(', ')}.`);
    return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text(args) } }] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const op = MCP_OPS.find((o) => o.mcp?.name === name);
    if (!op) return textResult(`Unknown tool "${name}". The tools: ${MCP_OPS.map((o) => o.mcp?.name).join(', ')}.`, true);
    const args = request.params.arguments ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) return textResult('The arguments must be an object: see this tool\'s input schema.', true);
    // A guessed or misspelt argument is an error that names the right one, never silently ignored.
    const bad = argumentProblems(/** @type {any} */ (toolList().find((t) => t.name === name)), /** @type {Record<string, any>} */ (args));
    if (bad) return textResult(bad, true);
    /** @type {CallResult} */
    let r;
    try {
      const { tenant: _ignored, ...rest } = /** @type {Record<string, any>} */ (args);
      r = await call(op, { ...rest, tenant: await tenant() });
    } catch (/** @type {any} */ err) {
      return textResult(`Could not reach the server: ${String(err?.message ?? err)}. Try again shortly.`, true);
    }
    if (r.status < 200 || r.status >= 300) return textResult(errorText(r, name), true);
    if (op.name === 'ask_map') {
      const c = collectChat(r.text);
      if (c.isError || !c.text) return textResult(c.error ? `${c.error} Try again, or read the map with get_context.` : 'The map gave no answer. Try again, or read the map with get_context.', true);
      const structured = { answer: c.answer, chatId: String(/** @type {any} */ (args).chatId ?? 'main'), citedNodes: c.cited, sources: c.sources, ...(c.webSearch ? { webSearch: c.webSearch } : {}) };
      return { content: [{ type: 'text', text: c.text }], structuredContent: structured };
    }
    const isJson = /json/i.test(r.type) || (op.http.type ?? 'application/json') === 'application/json';
    if (!isJson) return textResult(r.text);
    const j = tryJson(r.text);
    if (j === undefined) return textResult(r.text);
    if (op.name === 'build_map' && j && typeof j === 'object') {
      if (j.viewUrl) j.viewUrl = abs(j.viewUrl);
      if (j.eventsUrl) j.eventsUrl = abs(j.eventsUrl);
    }
    if (op.name === 'fuse' && j && typeof j === 'object' && j.url) j.url = abs(j.url);
    const plain = j !== null && typeof j === 'object' && !Array.isArray(j);
    // list_maps answers a list: its structured result is { maps } (structured content is an object).
    const structured = op.name === 'list_maps' && Array.isArray(j) ? { maps: j } : plain ? j : null;
    return { content: [{ type: 'text', text: JSON.stringify(structured ?? j, null, 2) }], ...(structured ? { structuredContent: structured } : {}) };
  });

  const uriFor = (/** @type {string} */ t, /** @type {string} */ id) => `ontologizer://${t}/maps/${encodeURIComponent(id)}/snapshot`;

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const t = await tenant().catch((e) => { throw new McpError(ErrorCode.InternalError, String(e?.message ?? e)); });
    const r = await call(/** @type {any} */ (opByName('list_maps')), { tenant: t });
    if (r.status < 200 || r.status >= 300) throw new McpError(ErrorCode.InternalError, errorText(r));
    const rows = tryJson(r.text);
    return { resources: (Array.isArray(rows) ? rows : []).map((m) => ({
      uri: uriFor(t, String(m.id)), name: String(m.name ?? m.id), mimeType: 'application/json',
      description: `The map as JSON, as the read tools see it (${m.nodes ?? 0} nodes${m.draft ? ', draft' : ''})`,
    })) };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{ uriTemplate: 'ontologizer://{tenant}/maps/{id}/snapshot', name: 'Map snapshot', mimeType: 'application/json',
      description: 'The map as JSON, as the read tools see it: nodes, categories, cross-links, lenses and sources, escaped, with no chat or jobs' }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const m = /^ontologizer:\/\/([^/]+)\/maps\/([^/]+)\/snapshot$/.exec(uri);
    if (!m) throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
    let id;
    try { id = decodeURIComponent(m[2]); } catch { throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`); }
    // The export's json (no chat), then the read tools' own allow-list and escaping (agentMap): never
    // the raw snapshot, whose jobs, private source names and unescaped web text no read tool shows.
    const r = await call(/** @type {any} */ (opByName('export_map')), { tenant: m[1], id, format: 'json' });
    if (r.status < 200 || r.status >= 300) throw new McpError(ErrorCode.InvalidParams, errorText(r));
    const folded = tryJson(r.text);
    if (!folded || typeof folded !== 'object') throw new McpError(ErrorCode.InternalError, 'The server did not answer with a map.');
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(agentMap(folded)) }] };
  });

  return server;
}

const MAX_BODY = 1024 * 1024;

/** @param {http.IncomingMessage} req @returns {Promise<string>} rejects with { status } */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let n = 0;
    let over = false;
    req.on('data', (/** @type {Buffer} */ c) => {
      n += c.length;
      if (n > MAX_BODY) { over = true; chunks.length = 0; return; }
      if (!over) chunks.push(c);
    });
    req.on('end', () => (over ? reject({ status: 413 }) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

/** @param {http.ServerResponse} res @param {number} status @param {string} error */
function plainError(res, status, error) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: false, error }));
}

/**
 * Stateless streamable HTTP: a new server and transport per request.
 * @param {http.IncomingMessage} req @param {http.ServerResponse} res
 * @param {{ call: Call, version?: string, baseUrl?: string }} o
 */
export async function handleMcpHttp(req, res, { call, version, baseUrl }) {
  let text;
  try { text = await readBody(req); } catch (/** @type {any} */ e) {
    return plainError(res, e?.status === 413 ? 413 : 400, e?.status === 413 ? 'request too large' : 'could not read the request');
  }
  let body;
  try { body = JSON.parse(text); } catch { return plainError(res, 400, 'invalid JSON'); }
  const server = createMcpServer({ call, ...(version ? { version } : {}), ...(baseUrl ? { baseUrl } : {}) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (/** @type {any} */ err) {
    plainError(res, 500, String(err?.message ?? err));
  }
}

const DROP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-connection',
  'content-length', 'content-type', 'accept', 'accept-encoding', 'expect', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']);

/**
 * `call` through node:http to this machine, with the incoming request's headers (minus per-request ones).
 * @param {{ host: string, port: number, headers?: Record<string, any> }} o
 * @returns {Call}
 */
export function loopbackCaller({ host, port, headers = {} }) {
  /** @type {Record<string, string|string[]>} */
  const fwd = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || DROP.has(k.toLowerCase())) continue;
    fwd[k] = v;
  }
  return (op, input) => new Promise((resolve, reject) => {
    let r;
    try { r = requestFor(op, input); } catch (e) { reject(e); return; }
    const data = r.body === null ? null : JSON.stringify(r.body);
    const h = { ...fwd, ...(data !== null ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}) };
    const q = http.request({ host, port, path: r.path, method: r.method, headers: h }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({
        status: /** @type {number} */ (res.statusCode), type: String(res.headers['content-type'] ?? ''), text: d,
        headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')])),
      }));
      res.on('error', reject);
    });
    q.on('error', reject);
    if (data !== null) q.write(data);
    q.end();
  });
}

/**
 * `call` through fetch to another server.
 * @param {{ url: string, token?: string|null, fetch?: typeof fetch }} o
 * @returns {Call}
 */
export function remoteCaller({ url, token, fetch = globalThis.fetch }) {
  const base = url.replace(/\/+$/, '').replace(/\/v1\/mcp$/, '');
  return async (op, input) => {
    const r = requestFor(op, input);
    const res = await fetch(base + r.path, {
      method: r.method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(r.body !== null ? { 'content-type': 'application/json' } : {}) },
      ...(r.body !== null ? { body: JSON.stringify(r.body) } : {}),
    });
    return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text(), headers: Object.fromEntries(res.headers.entries()) };
  };
}
