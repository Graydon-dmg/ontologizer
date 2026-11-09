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
//   mcp         { name, description } | null     the MCP tool (null: HTTP only)
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
const id = str('The map id (a saved map\'s name, or a draft id from list_maps or build_map)');
const nodeId = str('A node id, exactly as the outline or a search result shows it');
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
 * @typedef {{ name: string, http: Http, mcp: { name: string, description: string } | null, input: any, output: any,
 *   scope: 'read'|'ask'|'build'|'admin'|null, callsModel: boolean, cli: string, ui: { page: string, id: string },
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
  { name: 'list_maps', summary: 'The maps the caller may read',
    http: { method: 'GET', path: '/v1/t/{tenant}/maps' },
    mcp: { name: 'list_maps', description: 'List the maps on this server that you may read: id, name, root, node count, whether it is a draft, and its visibility. Use an id with the other tools.' },
    input: obj({ tenant }, ['tenant']), output: { type: 'array', items: MAP_ROW },
    scope: 'read', callsModel: false, cli: 'list', ui: { page: HOME, id: 'maps-list' } },
  { name: 'check_context', summary: 'Check a topic description: a brief to build from, or questions to answer first',
    http: { method: 'POST', path: '/v1/t/{tenant}/maps/check' },
    mcp: { name: 'check_context', description: `Check a description of the topic you want mapped. Answers { ready, brief, name } when it is clear enough to build, or { ready: false, questions } to answer: call again with the same context and your answers (up to three rounds), then pass the brief to build_map. ${COST_NOTE}` },
    input: obj({ tenant, context: str('What the map is about and for whom (at most 4000 characters)'),
      answers: { type: 'array', items: ANY, description: 'Answers to earlier questions, as { question, answer }' } }, ['tenant', 'context']),
    output: obj({ ready: { type: 'boolean' }, brief: BRIEF, name: { type: 'string' }, questions: { type: 'array', items: ANY } }, ['ready']),
    scope: 'build', callsModel: true, cli: 'new', ui: { page: HOME, id: 'new-map' } },
  { name: 'build_map', summary: 'Start building a map from a brief; answers at once (202) with its id',
    http: { method: 'POST', path: '/v1/t/{tenant}/maps' },
    mcp: { name: 'build_map', description: `Start building a map from a brief that check_context returned. Answers at once with the map's id and viewUrl (open it to watch it grow); call wait_for_map to know when it is done. ${COST_NOTE}` },
    input: obj({ tenant, brief: BRIEF, name: str('A display name'), depth: { type: 'integer', minimum: 1, maximum: 5, description: 'How deep to build (default 2)' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Configured sources to build from (default: every one you hold)' } }, ['tenant', 'brief']),
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
    mcp: { name: 'wait_for_map', description: 'Wait until the map is idle: its build, its jobs and any answer being written are done, or the timeout passes. Answers { state: "idle" | "busy", jobs, error? }. Call again while it says busy.' },
    input: mapIn({ timeout: { type: 'integer', minimum: 0, maximum: 300000, description: 'Milliseconds to wait at most (default 30000)' } }),
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
    mcp: { name: 'research', description: `Research one node of a map: the model adds child nodes under it. mode "context" keeps to the map's brief; "general" covers the topic broadly. Answers at once with a jobId; call wait_for_map for the result. ${COST_NOTE}` },
    input: mapIn({ nodeId, mode: { enum: ['context', 'general'], default: 'context', description: '"context" keeps to the brief (default); "general" covers the topic broadly' } }, ['nodeId']),
    output: JOB, scope: 'build', callsModel: true, cli: 'research', ui: { page: PAGE, id: 'research-context' } },
  { name: 'explain', summary: 'Explain a node: write its article',
    http: { method: 'POST', path: `${MAP}/actions`, fixed: { type: 'explain' } },
    mcp: { name: 'explain', description: `Explain one node: the model writes its article (summary, key facts, why it matters, sources). Answers at once with a jobId; call wait_for_map, then get_node. ${COST_NOTE}` },
    input: mapIn({ nodeId }, ['nodeId']), output: JOB, scope: 'build', callsModel: true, cli: 'explain', ui: { page: PAGE, id: 'explain' } },
  { name: 'sources', summary: 'Find web sources for a node',
    http: { method: 'POST', path: `${MAP}/actions`, fixed: { type: 'sources' } },
    mcp: { name: 'sources', description: `Find web sources for one node and attach them to it. Answers at once with a jobId; call wait_for_map, then get_node. ${COST_NOTE}` },
    input: mapIn({ nodeId }, ['nodeId']), output: JOB, scope: 'build', callsModel: true, cli: 'explain', ui: { page: PAGE, id: 'sources' } },
  { name: 'fuse', summary: 'Fuse this map with another into a new draft map',
    http: { method: 'POST', path: `${MAP}/actions`, fixed: { type: 'fuse' } },
    mcp: { name: 'fuse', description: `Fuse this map with another one (by id or name) into a new draft map that links the two. Answers at once with a jobId and the new map's id and url; call wait_for_map on the new map. ${COST_NOTE}` },
    input: mapIn({ with: str('The other map\'s id or name'), into: str('The new map\'s id (lowercase letters, digits, hyphens)') }, ['with']),
    output: ANY, scope: 'build', callsModel: true, cli: 'fuse', ui: { page: PAGE, id: 'fuse' } },
  { name: 'rosetta', summary: 'Add a lens: the map retold for a persona',
    http: { method: 'POST', path: `${MAP}/actions`, fixed: { type: 'rosetta' } },
    mcp: { name: 'rosetta', description: `Add a lens to a map: every node gets an analog for a persona ("a chef", "a guitarist"). Answers at once with a jobId and the lensId; call wait_for_map for the result. ${COST_NOTE}` },
    input: mapIn({ persona: str('Who the map is retold for (at most 120 characters)'), name: str('A short lens id') }, ['persona']),
    output: ANY, scope: 'build', callsModel: true, cli: 'rosetta', ui: { page: PAGE, id: 'lens-switcher' } },
  { name: 'ask_map', summary: 'Ask the map a question; the answer streams as server-sent events',
    http: { method: 'POST', path: `${MAP}/chat`, type: 'text/event-stream' },
    mcp: { name: 'ask_map', description: `Ask a question about a map. The model answers from the map first (and the web for what it lacks), citing nodes. Answers with the full text and the cited nodes and sources. ${COST_NOTE}` },
    input: mapIn({ text: str('The question (at most 4000 characters)'), chatId: str('Continue an earlier conversation'), lens: str('Answer through a lens id') }, ['text']),
    output: { type: 'string' }, scope: 'ask', callsModel: true, cli: 'load', ui: { page: PAGE, id: 'chat-btn' } },
  { name: 'save_map', summary: 'Save (or rename) a map under a name',
    http: { method: 'POST', path: `${MAP}/save` },
    mcp: { name: 'save_map', description: 'Save a map (a draft, or a saved map under a new name). The name becomes its id: lowercase letters, digits and hyphens. Fails while anything runs on the map: call wait_for_map first.' },
    input: mapIn({ name: str('lowercase letters, digits and hyphens') }, ['name']),
    output: obj({ ok: { type: 'boolean' }, id: { type: 'string' }, viewUrl: { type: 'string' } }, ['ok', 'id']),
    scope: 'build', callsModel: false, cli: 'save', ui: { page: PAGE, id: 'map-name' } },
  { name: 'get_outline', summary: 'The map as an indented outline (one line per node), as text',
    http: { method: 'GET', path: `${MAP}/outline`, type: 'text/markdown' },
    mcp: { name: 'get_outline', description: 'The whole map as an indented outline: one line per node, "- Label (id): summary". Cheap and read-only: start here to see what a map holds.' },
    input: mapIn(), output: TEXT, scope: 'read', callsModel: false, cli: 'export', ui: { page: PAGE, id: 'export-context' } },
  { name: 'search_map', summary: 'Search the map\'s nodes by keywords',
    http: { method: 'GET', path: `${MAP}/search` },
    mcp: { name: 'search_map', description: 'Search one map\'s nodes by keywords (labels, summaries, articles, source titles). Answers the best matches with id, label, path and a snippet. Read-only.' },
    input: mapIn({ q: str('Keywords'), limit: { type: 'integer', minimum: 1, maximum: 50, description: 'At most this many results (default 8)' } }, ['q']),
    output: obj({ results: { type: 'array', items: obj({ id: { type: 'string' }, label: { type: 'string' }, path: { type: 'string' }, snippet: { type: 'string' } }) } }, ['results']),
    scope: 'read', callsModel: false, cli: 'load', ui: { page: PAGE, id: 'search' } },
  { name: 'get_node', summary: 'One node in full: summary, article, sources, children, neighbours',
    http: { method: 'GET', path: `${MAP}/nodes/{nodeId}` },
    mcp: { name: 'get_node', description: 'One node of a map in full: its path, summary, article (if explained), sources, children and cross-links. Read-only.' },
    input: mapIn({ nodeId }, ['nodeId']), output: ANY, scope: 'read', callsModel: false, cli: 'load', ui: { page: PAGE, id: 'explain' } },
  { name: 'get_context', summary: 'The context pack: the map as markdown sized for an agent\'s context',
    http: { method: 'GET', path: `${MAP}/context`, type: 'text/markdown' },
    mcp: { name: 'get_context', description: 'The map as a context pack: markdown with its brief, outline, bridges, insights, thin areas and sources, trimmed to a token budget. Cheap and read-only: the best way to bring a map into your own context.' },
    input: mapIn({ budget: { type: 'integer', minimum: 300, maximum: 200000, description: 'Estimated tokens at most (default 4000)' } }),
    output: TEXT, scope: 'read', callsModel: false, cli: 'export', ui: { page: PAGE, id: 'export-context' } },
  { name: 'export_map', summary: 'The map exported as json, context, or a self-contained html page or embed',
    http: { method: 'GET', path: `${MAP}/export` },
    mcp: { name: 'export_map', description: 'Export a map: "json" (the snapshot), "context" (the context pack), "html" (one self-contained page that works offline) or "embed" (a fragment for any page). Read-only.' },
    input: mapIn({ format: { enum: ['json', 'context', 'html', 'embed'] }, budget: { type: 'integer', minimum: 300, maximum: 200000, description: 'context only (default 4000)' },
      threeD: { type: 'boolean', description: 'html and embed only: add the 3D view (a bigger file)' } }, ['format']),
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
