// @ts-check
// Every operation of the service-mode HTTP API, once. The router (src/server/service.js) serves
// these routes; this list describes them, and three things are made from it: GET /v1/openapi.json,
// the MCP tools (src/server/mcp.js), and the JS client (ontologizer/client). test/i/ops-*.test.js
// checks that every op is served by the router and that every /v1 route has an op.
//
// Pure data and pure functions: no Node imports, so the browser client can load it too.
//
// An op:
//   name        unique, snake_case
//   http        { method, path, fixed?, type? }  path uses {tenant}, {id}, {nodeId}, {path};
//               fixed: body fields the op always sends (several ops share POST .../actions);
//               type: the response's media type (default application/json)
//   mcp         { name, title, description, annotations } | null   the MCP tool (null: HTTP only);
//               the description has one shape (what it does, Use when, Don't use when, Returns,
//               Next, and COST_NOTE last when callsModel); test/i/mcp-docs.test.js lints it
//   input       JSON Schema of everything the caller gives: path params, then query (GET) or body (POST)
//   output      JSON Schema of the response
//   scope       the token scope it needs ('read' | 'ask' | 'build' | 'admin'), or null (no token)
//   callsModel  true when it calls the model (costs API credits; counted by the usage limits)
//   cli         the `ontologizer` command that does the same thing
//   ui          { page, id }: the button (or menu item, or panel) on the localhost page
//   internal    true for routes only the page itself uses (left out of OpenAPI)

export const COST_NOTE = 'Calls the model: costs API credits.';

const MAP = '/v1/t/{tenant}/maps/{id}';
const HOME = 'web/home/index.html';
const PAGE = 'web/index.html';

/** @param {string} description */
const str = (description) => ({ type: 'string', description });
const tenant = str('The tenant: a token\'s own tenant, or "default"');
const id = str('The map id, from list_maps or build_map: a saved map\'s name or a draft id. E.g. "sourdough" or "draft-20261109-153012"');
const nodeId = str('A node id exactly as get_outline, search_map or get_node shows it; ids are paths. E.g. "sourdough/starter/levain"');
const OK = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
const ANY = { type: 'object', additionalProperties: true };
const JOB = { type: 'object', properties: { ok: { type: 'boolean' }, jobId: { type: 'string' } }, required: ['ok'] };
const TEXT = { type: 'string', contentMediaType: 'text/markdown' };
/** @param {Record<string, any>} properties @param {string[]} [required] */
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const mapIn = (/** @type {Record<string, any>} */ more = {}, /** @type {string[]} */ req = []) => obj({ tenant, id, ...more }, ['tenant', 'id', ...req]);
const MAP_ROW = obj({
  id: { type: 'string' }, name: { type: 'string' }, root: { type: 'string' }, nodes: { type: 'integer' },
  updatedAt: { type: 'number' }, draft: { type: 'boolean' }, visibility: { enum: ['public', 'private'] },
}, ['id', 'name', 'nodes', 'draft']);
const BRIEF = { type: 'object', additionalProperties: true, description: 'The brief from check_context (context, subject, scope, purpose, level, size)' };

/**
 * @typedef {{ method: 'GET'|'POST'|'DELETE', path: string, fixed?: Record<string, any>, type?: string }} Http
 * @typedef {{ name: string, http: Http, mcp: { name: string, title?: string, description: string, annotations?: Record<string, boolean> } | null,
 *   input: any, output: any, scope: 'read'|'ask'|'build'|'admin'|null, callsModel: boolean, cli: string, ui: { page: string, id: string },
 *   internal?: boolean, summary: string }} Op
 */

/** @type {Op[]} */
export const OPS = [
  // ---- the server ----
  { name: 'get_session', summary: 'Who the caller is: tenant, scopes, and whether the server is open',
    http: { method: 'GET', path: '/v1/session' }, mcp: null,
    input: obj({}), output: obj({ ok: { type: 'boolean' }, tenant: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } }, open: { type: 'boolean' } }),
    scope: null, callsModel: false, cli: 'status', ui: { page: HOME, id: 'server-panel' } },
  { name: 'sign_in', summary: 'Trade a token for a browser session cookie',
    http: { method: 'POST', path: '/v1/session' }, mcp: null,
    input: obj({ token: str('A token from `ontologizer token create`') }, ['token']), output: ANY,
    scope: null, callsModel: false, cli: 'token', ui: { page: HOME, id: 'signin-form' } },
  { name: 'sign_out', summary: 'End the browser session',
    http: { method: 'DELETE', path: '/v1/session' }, mcp: null,
    input: obj({}), output: OK,
    scope: null, callsModel: false, cli: 'token', ui: { page: HOME, id: 'server-panel' } },
  { name: 'health_live', summary: 'The process is up',
    http: { method: 'GET', path: '/v1/health/live' }, mcp: null,
    input: obj({}), output: OK, scope: null, callsModel: false, cli: 'status', ui: { page: HOME, id: 'server-panel' } },
  { name: 'health_ready', summary: 'The home and every open store can serve',
    http: { method: 'GET', path: '/v1/health/ready' }, mcp: null,
    input: obj({}), output: OK, scope: null, callsModel: false, cli: 'status', ui: { page: HOME, id: 'server-panel' } },
  { name: 'openapi', summary: 'This API, as OpenAPI 3.1 (made from the same list as the MCP tools)',
    http: { method: 'GET', path: '/v1/openapi.json' }, mcp: null,
    input: obj({}), output: ANY, scope: null, callsModel: false, cli: 'serve', ui: { page: HOME, id: 'server-api' } },
  { name: 'mcp', summary: 'MCP over streamable HTTP: the tools below, with the caller\'s own credentials',
    http: { method: 'POST', path: '/v1/mcp' }, mcp: null,
    input: ANY, output: ANY, scope: 'read', callsModel: false, cli: 'mcp', ui: { page: PAGE, id: 'connect-agent' } },
  { name: 'get_status', summary: 'The tenant\'s server status: auth mode, map count, tokens (names and scopes), sources, ports',
    http: { method: 'GET', path: '/v1/t/{tenant}/status' }, mcp: null,
    input: obj({ tenant }, ['tenant']), output: ANY, scope: 'read', callsModel: false, cli: 'status', ui: { page: HOME, id: 'server-panel' } },
  { name: 'get_usage', summary: 'Today\'s model calls and tokens for the tenant (UTC day), and the limits',
    http: { method: 'GET', path: '/v1/t/{tenant}/usage' }, mcp: null,
    input: obj({ tenant }, ['tenant']),
    output: obj({ tenant: { type: 'string' }, day: { type: 'string' }, calls: { type: 'integer' }, inputTokens: { type: 'integer' },
      outputTokens: { type: 'integer' }, limits: obj({ calls: { type: ['integer', 'null'] }, tokens: { type: ['integer', 'null'] } }),
      resetsAt: { type: 'string' } }),
    scope: 'read', callsModel: false, cli: 'usage', ui: { page: HOME, id: 'server-usage' } },
  { name: 'list_sources', summary: 'The configured sources the caller holds',
    http: { method: 'GET', path: '/v1/t/{tenant}/sources' }, mcp: null,
    input: obj({ tenant }, ['tenant']), output: { type: 'array', items: obj({ name: { type: 'string' }, visibility: { enum: ['public', 'private'] } }) },
    scope: 'read', callsModel: false, cli: 'sources', ui: { page: HOME, id: 'sources-picker' } },

  // ---- maps ----
  // MCP descriptions are written for a model, in one shape: what it does. "Use when …". "Don't use
  // when … (use X instead)". "Returns …". "Next: …". And, for a tool that calls the model, COST_NOTE last.
  { name: 'list_maps', summary: 'The maps the caller may read',
    http: { method: 'GET', path: '/v1/t/{tenant}/maps' },
    mcp: { name: 'list_maps', title: 'List maps',
      description: 'List the maps on this server that you may read. Use when you start, to find a map by name, or to check that a map you built exists and whether it is private. Don\'t use when you already have the map id. Returns { maps: [{ id, name, root, nodes, draft, visibility? }] }: drafts are kept like saved maps; visibility "private" means only holders of its sources can read it. Next: get_context or get_outline on an id.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    input: obj({ tenant }, ['tenant']), output: { type: 'array', items: MAP_ROW },
    scope: 'read', callsModel: false, cli: 'list', ui: { page: HOME, id: 'maps-list' } },
  { name: 'check_context', summary: 'Check a topic description: a brief to build from, or questions to answer first',
    http: { method: 'POST', path: '/v1/t/{tenant}/maps/check' },
    mcp: { name: 'check_context', title: 'Check a topic before building',
      description: 'Turn a plain description of a topic into a brief that build_map can use. Use when you want a new map: it is always the first step of building. Don\'t use when a map of the topic already exists (list_maps, then read it). Returns { ready: true, brief, name } when the topic is clear, or { ready: false, questions: [{ id, text, options }] }: ask your user (or answer from what you know), then call again with the same context and all answers so far, at most three rounds (if it still asks, add detail to the context and start again). Your context goes to the model as plain text; it never uses configured sources and writes nothing. Next: build_map with the brief. ' + COST_NOTE,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
    input: obj({ tenant,
      context: str('What the map is about and for whom, in plain words; at most 4000 characters. E.g. "Home espresso for a complete beginner: machines, grinders, beans, technique"'),
      answers: { type: 'array', items: ANY, maxItems: 30, description: 'Every answer so far to the questions check_context asked, as { id, answer } with the question\'s id (add question: its text, if you like). E.g. [{ "id": "budget", "answer": "Under 500 dollars" }]. Omit on the first call.' } }, ['tenant', 'context']),
    output: obj({ ready: { type: 'boolean' }, brief: BRIEF, name: { type: 'string' }, questions: { type: 'array', items: ANY } }, ['ready']),
    scope: 'build', callsModel: true, cli: 'new', ui: { page: HOME, id: 'new-map' } },
  { name: 'build_map', summary: 'Start building a map from a brief; answers at once (202) with its id',
    http: { method: 'POST', path: '/v1/t/{tenant}/maps' },
    mcp: { name: 'build_map', title: 'Build a map',
      description: 'Start building a new map (a tree of categories and nodes, with cross-links and sources) from the brief check_context returned. Use when check_context said ready. Don\'t use when you have no brief yet (call check_context first) or a map of the topic exists (list_maps). Returns at once with { id, viewUrl, eventsUrl }: the build goes on in the background (a minute or two at depth 2) and viewUrl shows it growing. The map is kept as a draft under id; building from a private source makes it private for good, before its first node is written. Next: wait_for_map with the id. ' + COST_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
    input: obj({ tenant,
      brief: { ...BRIEF, description: 'The brief object exactly as check_context returned it; pass it through unchanged. E.g. { "context": "...", "subject": "Home espresso", "level": "beginner" }' },
      name: str('A display name for the map, at most 120 characters. E.g. "Home espresso". Default: the name check_context suggested'),
      depth: { type: 'integer', minimum: 1, maximum: 5, default: 2, description: 'How many levels to build, 1 to 5 (default 2: categories and their nodes). E.g. 3 for more detail; each level costs more' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Configured sources (your operator\'s MCP servers) to build from, by name. E.g. ["wiki"]. Default: every source you hold. Naming a private source makes the map private for good. Names you may use are listed in this description when the server has any' } }, ['tenant', 'brief']),
    output: obj({ id: { type: 'string' }, viewUrl: { type: 'string' }, eventsUrl: { type: 'string' } }, ['id', 'viewUrl']),
    scope: 'build', callsModel: true, cli: 'new', ui: { page: HOME, id: 'new-map' } },
  { name: 'get_snapshot', summary: 'The whole map as JSON (the folded event log)',
    http: { method: 'GET', path: `${MAP}/snapshot` }, mcp: null,
    input: mapIn(), output: ANY, scope: 'read', callsModel: false, cli: 'export', ui: { page: PAGE, id: 'export-json' } },
  { name: 'map_events', summary: 'The map\'s events as a server-sent event stream, from event n',
    http: { method: 'GET', path: `${MAP}/events`, type: 'text/event-stream' }, mcp: null,
    input: mapIn({ from: { type: 'integer', minimum: 0, description: 'The first event to send (default 0)' } }), output: { type: 'string' },
    scope: 'read', callsModel: false, cli: 'load', ui: { page: PAGE, id: 'conn' } },
  { name: 'wait_for_map', summary: 'Wait until nothing runs on the map (its build, jobs, a chat), or the timeout',
    http: { method: 'GET', path: `${MAP}/wait` },
    mcp: { name: 'wait_for_map', title: 'Wait for a map to finish',
      description: 'Wait until nothing runs on a map: its build, its jobs (research, explain, sources, fuse, rosetta) and any answer being written. Use when build_map or a job answered with an id or jobId and you need the result; jobs have no id of their own to wait on, so wait on the map. Don\'t use when you only want to read a finished map. Returns { state: "idle" | "busy", jobs: [{ id, kind, state }], error? }: "busy" means the timeout passed first, so call again; error says why a build failed. Next: get_context, get_outline or get_node.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    input: mapIn({ timeout: { type: 'integer', minimum: 0, maximum: 300000, default: 30000, description: 'Milliseconds to wait at most, 0 to 300000 (default 30000). E.g. 120000 for a build' } }),
    output: obj({ state: { enum: ['idle', 'busy'] }, jobs: { type: 'array', items: ANY }, error: { type: 'string' } }, ['state', 'jobs']),
    scope: 'read', callsModel: false, cli: 'load', ui: { page: PAGE, id: 'jobs' } },
  { name: 'map_view', summary: 'The map page (HTML)',
    http: { method: 'GET', path: `${MAP}/view`, type: 'text/html' }, mcp: null,
    input: mapIn(), output: { type: 'string' }, scope: 'read', callsModel: false, cli: 'load', ui: { page: PAGE, id: 'view' } },
  { name: 'view_action', summary: 'Change the shared view (expand, collapse, focus, layout, lens, filter), or start a job (the ops below)',
    http: { method: 'POST', path: `${MAP}/actions` }, mcp: null,
    input: mapIn({ type: { enum: ['expand', 'collapse', 'focus', 'layout', 'lens', 'filter'] }, nodeId, value: {} }, ['type']),
    output: OK, scope: 'build', callsModel: false, cli: 'load', ui: { page: PAGE, id: 'menu' } },
  { name: 'research', summary: 'Research a node: add children to it',
    http: { method: 'POST', path: `${MAP}/actions`, fixed: { type: 'research' } },
    mcp: { name: 'research', title: 'Research a node (add nodes under it)',
      description: 'Grow a map under one node: the model adds new child nodes there, in place on this map. Use when a branch is thin or the user wants more depth on one part. Don\'t use when you only want to know what the map already says (get_node, free) or want one node written up in full (explain). Returns at once with { ok, jobId }; repeating the same request while it runs does not start a second one. On a private map it uses no web search. Next: wait_for_map, then get_node on the same node to see its new children. ' + COST_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
    input: mapIn({ nodeId, mode: { enum: ['context', 'general'], default: 'context', description: '"context" keeps to the map\'s brief (default); "general" covers the node\'s topic broadly. E.g. "general" when the user wants to go beyond the brief' } }, ['nodeId']),
    output: JOB, scope: 'build', callsModel: true, cli: 'research', ui: { page: PAGE, id: 'research-context' } },
  { name: 'explain', summary: 'Explain a node: write its article',
    http: { method: 'POST', path: `${MAP}/actions`, fixed: { type: 'explain' } },
    mcp: { name: 'explain', title: 'Explain a node (write its article)',
      description: 'Write the article for one node: a summary, key facts, why it matters, and sources, stored on the node. Use when get_node says the node is "Not explained yet" and you need more than its one-line summary. Don\'t use when the node already has an article (get_node shows it, free) or you want new nodes (research). Returns at once with { ok, jobId }. Next: wait_for_map, then get_node to read the article. ' + COST_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
    input: mapIn({ nodeId }, ['nodeId']), output: JOB, scope: 'build', callsModel: true, cli: 'explain', ui: { page: PAGE, id: 'explain' } },
  { name: 'sources', summary: 'Find web sources for a node',
    http: { method: 'POST', path: `${MAP}/actions`, fixed: { type: 'sources' } },
    mcp: { name: 'sources', title: 'Find web sources for a node',
      description: 'Find web pages that back up one node and attach them to it. Use when a node has no sources and you need citations to show the user. Don\'t use when get_node already lists sources, or on a private map whose content must not go to a web search. Returns at once with { ok, jobId }. Next: wait_for_map, then get_node to see the sources. ' + COST_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
    input: mapIn({ nodeId }, ['nodeId']), output: JOB, scope: 'build', callsModel: true, cli: 'explain', ui: { page: PAGE, id: 'sources' } },
  { name: 'fuse', summary: 'Fuse this map with another into a new draft map',
    http: { method: 'POST', path: `${MAP}/actions`, fixed: { type: 'fuse' } },
    mcp: { name: 'fuse', title: 'Fuse two maps (find where they connect)',
      description: 'Make a new map that joins two existing maps and adds bridges: cross-links saying where and why the two fields connect. Use when the user asks how two fields relate and both have maps. Don\'t use when one of the maps does not exist yet (build it first), or a quick comparison of two context packs is enough (get_context on each, free). The two maps are not changed; if either is private, the new map is private. Returns at once with { ok, jobId, draftId, url }: draftId is the new map\'s id (a draft id) and url its page. Next: wait_for_map on draftId, then get_context on it (its Bridges section). ' + COST_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
    input: mapIn({ with: str('The other map, by id or name. E.g. "fermentation-science"'),
      into: str('A name for the new map (its root), lowercase letters, digits and hyphens, at most 40 characters; the map\'s id is still a draft id. E.g. "bread-science". Default: the model picks a name') }, ['with']),
    output: obj({ ok: { type: 'boolean' }, jobId: { type: 'string' }, draftId: { type: 'string' }, url: { type: 'string' } }, ['ok']),
    scope: 'build', callsModel: true, cli: 'fuse', ui: { page: PAGE, id: 'fuse' } },
  { name: 'rosetta', summary: 'Add a lens: the map retold for a persona',
    http: { method: 'POST', path: `${MAP}/actions`, fixed: { type: 'rosetta' } },
    mcp: { name: 'rosetta', title: 'Add a lens for a persona',
      description: 'Add a lens to a map: every node gets an analog from a persona\'s own world ("a chef": a grinder is like a pepper mill). Use when the user learns best through something they already know. Don\'t use when you just need the map\'s content (get_context). Returns at once with { ok, jobId, lensId }. Next: wait_for_map, then ask_map with lens set to lensId, or get_node. ' + COST_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
    input: mapIn({ persona: str('Who the map is retold for, at most 120 characters. E.g. "a jazz guitarist"'),
      name: str('A short id for the lens: lowercase letters, digits and hyphens, at most 40 characters. E.g. "guitarist". Default: made from the persona') }, ['persona']),
    output: obj({ ok: { type: 'boolean' }, jobId: { type: 'string' }, lensId: { type: 'string' } }, ['ok']),
    scope: 'build', callsModel: true, cli: 'rosetta', ui: { page: PAGE, id: 'lens-switcher' } },
  { name: 'ask_map', summary: 'Ask the map a question; the answer streams as server-sent events',
    http: { method: 'POST', path: `${MAP}/chat`, type: 'text/event-stream' },
    mcp: { name: 'ask_map', title: 'Ask a map a question',
      description: 'Ask one question about a map and get a written answer that cites the map\'s nodes (and web pages for what the map lacks; none on a private map). The question and answer are saved in the map\'s chat. Use when the user wants an answer in prose grounded in the map, with citations. Don\'t use when you can answer from get_context or get_node yourself (free), or to change the map (research, explain). Returns { answer, citedNodes: [{ id, label }], sources: [{ title, url }], chatId }. Next: get_node on a cited node, or ask_map again with the same chatId to follow up. ' + COST_NOTE,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
    input: mapIn({ text: str('The question, at most 4000 characters. E.g. "Which grinder settings matter most for a beginner?"'),
      chatId: str('A conversation name: questions with the same chatId see the earlier questions and answers. Letters, digits, hyphens. E.g. "espresso-agent". Default "main", the conversation the map page shows'),
      lens: str('Answer through a lens: a lensId from rosetta. E.g. "guitarist". Default: no lens') }, ['text']),
    output: { type: 'string' }, scope: 'ask', callsModel: true, cli: 'load', ui: { page: PAGE, id: 'chat-btn' } },
  { name: 'save_map', summary: 'Save (or rename) a map under a name',
    http: { method: 'POST', path: `${MAP}/save` },
    mcp: { name: 'save_map', title: 'Save or rename a map',
      description: 'Give a map a name, which becomes its id: a draft becomes a saved map, a saved map is renamed. Use when the user wants to keep a map under a memorable name. Don\'t use when you only want to keep it (drafts are kept too) or while anything runs on it (wait_for_map first). The old id and its viewUrl stop working; visibility does not change (a private map stays private). Returns { ok, id, viewUrl } with the new id. Next: use the new id with every other tool.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
    input: mapIn({ name: str('The new name and id: lowercase letters, digits and hyphens, at most 63 characters. E.g. "home-espresso"') }, ['name']),
    output: obj({ ok: { type: 'boolean' }, id: { type: 'string' }, viewUrl: { type: 'string' } }, ['ok', 'id']),
    scope: 'build', callsModel: false, cli: 'save', ui: { page: PAGE, id: 'map-name' } },
  { name: 'get_outline', summary: 'The map as an indented outline (one line per node), as text',
    http: { method: 'GET', path: `${MAP}/outline`, type: 'text/markdown' },
    mcp: { name: 'get_outline', title: 'Read a map\'s outline',
      description: 'Read a whole map as an indented outline, one line per node: "- Label (nodeId): summary". Use when you need every node and its id, e.g. to pick a node for get_node, research or explain. Don\'t use when you want the map\'s meaning in your context with its cross-links and gaps (get_context is better for that). Returns markdown text. Free: no model call. Next: get_node on a node id.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    input: mapIn(), output: TEXT, scope: 'read', callsModel: false, cli: 'export', ui: { page: PAGE, id: 'export-context' } },
  { name: 'search_map', summary: 'Search the map\'s nodes by keywords',
    http: { method: 'GET', path: `${MAP}/search` },
    mcp: { name: 'search_map', title: 'Search a map',
      description: 'Find the nodes of one map that match some words (labels, summaries, articles, source titles). Use when you know what you are looking for but not its node id. Don\'t use when you need the whole map (get_outline, get_context). Returns { results: [{ id, label, path, snippet }] }, best first; empty when nothing matches. Free: no model call. Next: get_node with a result\'s id.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    input: mapIn({ q: str('Keywords, at most 500 characters. E.g. "levain starter"'),
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 8, description: 'At most this many results, 1 to 50 (default 8). E.g. 3' } }, ['q']),
    output: obj({ results: { type: 'array', items: obj({ id: { type: 'string' }, label: { type: 'string' }, path: { type: 'string' }, snippet: { type: 'string' } }) } }, ['results']),
    scope: 'read', callsModel: false, cli: 'load', ui: { page: PAGE, id: 'search' } },
  { name: 'get_node', summary: 'One node in full: summary, article, sources, children, neighbours',
    http: { method: 'GET', path: `${MAP}/nodes/{nodeId}` },
    mcp: { name: 'get_node', title: 'Read one node',
      description: 'Read everything a map says about one node: its path, summary, article (or "Not explained yet"), sources, children and cross-links to other nodes. Use when you need the detail behind one line of the outline, or to see what research or explain added. Don\'t use when you do not know the node id (search_map or get_outline first). Returns the node as an object; an unknown id is an error that suggests close ids. Free: no model call. Next: explain or research on the node if it is thin.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    input: mapIn({ nodeId }, ['nodeId']), output: ANY, scope: 'read', callsModel: false, cli: 'load', ui: { page: PAGE, id: 'explain' } },
  { name: 'get_context', summary: 'The context pack: the map as markdown sized for an agent\'s context',
    http: { method: 'GET', path: `${MAP}/context`, type: 'text/markdown' },
    mcp: { name: 'get_context', title: 'Bring a map into your context',
      description: 'Read a map as a context pack: markdown with its brief, outline, bridges (cross-links between categories), insights, thin areas and sources, trimmed to a token budget. Use when you want to learn, teach, brainstorm or write from a map: this is the best first read. Don\'t use when you need one node in depth (get_node) or a file for a person (export_map). Returns markdown text; its last line says what was trimmed. Free: no model call. Next: brainstorm or answer from it yourself; get_node for detail.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    input: mapIn({ budget: { type: 'integer', minimum: 300, maximum: 200000, default: 4000, description: 'Estimated tokens at most, 300 to 200000 (default 4000). E.g. 8000 for a big map you want in full' } }),
    output: TEXT, scope: 'read', callsModel: false, cli: 'export', ui: { page: PAGE, id: 'export-context' } },
  { name: 'export_map', summary: 'The map exported as json, context, or a self-contained html page or embed',
    http: { method: 'GET', path: `${MAP}/export` },
    mcp: { name: 'export_map', title: 'Export a map for a page or a file',
      description: 'Export a map for people: "embed" is an HTML fragment (an interactive map: pan, zoom, click a node) to paste into a document or web page; "html" is a whole page; both work offline with nothing loaded from the network, keep their styles inside their own element (they do not clash with the page), and are a snapshot that does not update (export again after the map changes). "json" is the full data; "context" is the same pack as get_context. Use when the map must go into a document, a page or a file. Don\'t use when you want to read the map yourself (get_context, get_outline). A private map\'s export says "Private": share it only with people who may read it. Returns the exported text (html and embed are large, about 150 KB). Free: no model call. Next: write it into the user\'s file.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    input: mapIn({ format: { enum: ['json', 'context', 'html', 'embed'], description: 'One of "embed" (a fragment for a document or page), "html" (a whole page), "json", "context". E.g. "embed"' },
      budget: { type: 'integer', minimum: 300, maximum: 200000, default: 4000, description: 'For "context" only: estimated tokens at most, 300 to 200000 (default 4000). E.g. 2000' },
      threeD: { type: 'boolean', default: false, description: 'For "html" and "embed" only: add the 3D view (default false; about five times bigger). E.g. false' } }, ['format']),
    output: { type: 'string' }, scope: 'read', callsModel: false, cli: 'export', ui: { page: PAGE, id: 'export' } },

  // ---- the map page's own routes (today's /api/* under the map's base) ----
  { name: 'page_api_get', summary: 'The map page\'s reads: api/snapshot, api/events, api/maps (fuse picker), api/attachments/<sha256>',
    http: { method: 'GET', path: `${MAP}/api/{path}` }, mcp: null, internal: true,
    input: mapIn({ path: str('snapshot | events | maps | attachments/<sha256>') }, ['path']), output: ANY,
    scope: 'read', callsModel: false, cli: 'load', ui: { page: PAGE, id: 'view' } },
  { name: 'page_api_post', summary: 'The map page\'s writes: api/action and api/chat',
    http: { method: 'POST', path: `${MAP}/api/{path}` }, mcp: null, internal: true,
    input: mapIn({ path: str('action | chat') }, ['path']), output: ANY,
    scope: 'build', callsModel: true, cli: 'load', ui: { page: PAGE, id: 'view' } },
];

/** @param {string} name */
export const opByName = (name) => OPS.find((o) => o.name === name) ?? null;

/** The {params} of a path, in order. @param {string} p */
export const pathParams = (p) => [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

/**
 * The request for an op: its URL path (params encoded), query and body.
 * @param {Op} op @param {Record<string, any>} input
 * @returns {{ method: string, path: string, body: Record<string, any> | null }}
 */
export function requestFor(op, given = {}) {
  const params = pathParams(op.http.path);
  // A field with a default the server needs (research's mode) is always sent.
  /** @type {Record<string, any>} */
  const input = { ...given };
  for (const [k, schema] of Object.entries(op.input?.properties ?? {})) {
    if (input[k] === undefined && schema && /** @type {any} */ (schema).default !== undefined) input[k] = /** @type {any} */ (schema).default;
  }
  for (const p of params) {
    if (input[p] === undefined || input[p] === null || input[p] === '') throw new Error(`${op.name}: ${p} is required`);
  }
  // {path} keeps its slashes (api/attachments/<hash>); every other param is one segment.
  const url = op.http.path.replace(/\{(\w+)\}/g, (_, p) => (p === 'path' ? String(input[p]).split('/').map(encodeURIComponent).join('/') : encodeURIComponent(String(input[p]))));
  const rest = Object.fromEntries(Object.entries(input).filter(([k, v]) => !params.includes(k) && v !== undefined));
  if (op.http.method === 'GET' || op.http.method === 'DELETE') {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(rest)) q.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    const qs = q.toString();
    return { method: op.http.method, path: qs ? `${url}?${qs}` : url, body: null };
  }
  return { method: op.http.method, path: url, body: { ...rest, ...(op.http.fixed ?? {}) } };
}

/**
 * OpenAPI 3.1 for every op that is not internal. Ops that share a route (the jobs on POST
 * .../actions) become one operation whose body is oneOf their inputs.
 * @param {{ version?: string, serverUrl?: string }} [o]
 */
export function openApi({ version = '0.0.0', serverUrl } = {}) {
  /** @type {Record<string, Record<string, any>>} */
  const paths = {};
  /** @type {Map<string, Op[]>} */
  const groups = new Map();
  for (const op of OPS) {
    if (op.internal) continue;
    const key = `${op.http.method} ${op.http.path}`;
    groups.set(key, [...(groups.get(key) ?? []), op]);
  }
  for (const [key, ops] of groups) {
    const [method, p] = key.split(' ');
    const main = ops.find((o) => !o.http.fixed) ?? ops[0];
    const params = pathParams(p);
    /** @param {Op} op */
    const bodySchema = (op) => {
      const props = Object.fromEntries(Object.entries(op.input.properties ?? {}).filter(([k]) => !params.includes(k)));
      for (const [k, v] of Object.entries(op.http.fixed ?? {})) props[k] = { const: v };
      // Fields with a default are always sent (requestFor fills them), so the body requires them.
      const defaulted = Object.entries(props).filter(([, v]) => v && v.default !== undefined).map(([k]) => k);
      const required = [...(op.input.required ?? []).filter((/** @type {string} */ k) => !params.includes(k)), ...defaulted, ...Object.keys(op.http.fixed ?? {})];
      return { type: 'object', properties: props, ...(required.length ? { required: [...new Set(required)] } : {}) };
    };
    /** @type {any[]} */
    const parameters = params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' }, description: main.input.properties?.[name]?.description ?? name }));
    if (method === 'GET' || method === 'DELETE') {
      for (const [name, schema] of Object.entries(main.input.properties ?? {})) {
        if (params.includes(name)) continue;
        parameters.push({ name, in: 'query', required: (main.input.required ?? []).includes(name), schema, ...(schema.description ? { description: schema.description } : {}) });
      }
    }
    const type = main.http.type ?? 'application/json';
    /** @type {Record<string, any>} */
    const operation = {
      operationId: main.name,
      summary: main.summary,
      description: [main.mcp?.description, ...ops.filter((o) => o !== main).map((o) => `${o.name}: ${o.summary}${o.callsModel ? `. ${COST_NOTE}` : ''}`)].filter(Boolean).join('\n\n') || main.summary,
      ...(parameters.length ? { parameters } : {}),
      responses: {
        200: { description: 'OK', content: { [type]: { schema: main.output } } },
        ...(main.scope ? { 401: { description: 'No credentials, or not accepted' }, 403: { description: 'Missing scope, or a foreign Origin' }, 404: { description: 'Not found, or not yours to see' } } : {}),
        ...(ops.some((o) => o.callsModel) ? { 429: { description: 'Over a limit; Retry-After says when to try again' } } : {}),
      },
      'x-ontologizer': { scope: main.scope, callsModel: ops.some((o) => o.callsModel), ops: ops.map((o) => o.name), cli: main.cli },
      ...(main.scope ? { security: [{ bearer: [] }, { cookie: [] }] } : {}),
    };
    if (method === 'POST') {
      const schemas = ops.map(bodySchema);
      operation.requestBody = { required: true, content: { 'application/json': { schema: schemas.length === 1 ? schemas[0] : { oneOf: schemas } } } };
    }
    if (method === 'POST' && main.name === 'build_map') operation.responses = { 202: operation.responses[200], ...operation.responses, 200: undefined };
    if (operation.responses[200] === undefined) delete operation.responses[200];
    paths[p] = { ...(paths[p] ?? {}), [method.toLowerCase()]: operation };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Ontologizer service API', version,
      description: 'Every route of `ontologizer serve`. The MCP tools at /v1/mcp and the JS client (ontologizer/client) are made from the same list. Operations marked callsModel cost API credits.' },
    ...(serverUrl ? { servers: [{ url: serverUrl }] } : {}),
    components: { securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer', description: 'A token from `ontologizer token create`' },
      cookie: { type: 'apiKey', in: 'cookie', name: 'ontologizer_session', description: 'The browser session from POST /v1/session' },
    } },
    paths,
  };
}
