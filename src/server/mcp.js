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
  ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { OPS, opByName, requestFor, COST_NOTE } from '../ops.js';

/**
 * @typedef {{ status: number, type: string, text: string, headers: Record<string, string> }} CallResult
 * @typedef {(op: import('../ops.js').Op, input: Record<string, any>) => Promise<CallResult>} Call
 */

export const MCP_OPS = OPS.filter((o) => o.mcp);
export { COST_NOTE };

/** The tools: name, description (verbatim from the op), and the op's input schema without `tenant`. */
export function toolList() {
  return MCP_OPS.map((op) => {
    const { tenant: _t, ...properties } = op.input.properties ?? {};
    const required = (op.input.required ?? []).filter((/** @type {string} */ k) => k !== 'tenant');
    return {
      name: /** @type {{ name: string }} */ (op.mcp).name,
      description: /** @type {{ description: string }} */ (op.mcp).description,
      inputSchema: { ...op.input, properties, required },
    };
  });
}

/** @param {string} s */
const tryJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
/** @param {string} text @param {boolean} [isError] */
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

/** The server's error string of a non-2xx answer (plus the wait for a 429). @param {CallResult} r */
function errorText(r) {
  const j = tryJson(r.text);
  let msg = j && typeof j === 'object' && typeof j.error === 'string' ? j.error : (r.text.trim() || `HTTP ${r.status}`);
  if (r.status === 429) {
    const n = Number(r.headers['retry-after']);
    if (Number.isFinite(n) && n >= 0) msg += ` (try again in ${n} seconds)`;
  }
  return msg;
}

/** The text an SSE chat stream carries. @param {string} body */
export function collectChat(body) {
  let answer = '';
  /** @type {Array<{ label: string, id: string }>} */
  const cited = [];
  /** @type {Array<{ title: string, url: string }>} */
  const sources = [];
  /** @type {string|null} */
  let error = null;
  for (const block of body.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const item = tryJson(line.slice(5).trim());
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'delta') answer += String(item.text ?? '');
    else if (item.type === 'citation' && !cited.some((c) => c.id === item.nodeId)) cited.push({ label: String(item.label ?? item.nodeId), id: String(item.nodeId) });
    else if (item.type === 'source' && !sources.some((s) => s.url === item.url)) sources.push({ title: String(item.title ?? item.url), url: String(item.url) });
    else if (item.type === 'error') error = String(item.error ?? 'error');
  }
  let out = answer.trim();
  if (cited.length) out += `${out ? '\n\n' : ''}Cited nodes:\n${cited.map((c) => `- ${c.label} (${c.id})`).join('\n')}`;
  if (sources.length) out += `${out ? '\n\n' : ''}Sources:\n${sources.map((s) => `- ${s.title}: ${s.url}`).join('\n')}`;
  if (error) out += `${out ? '\n\n' : ''}Error: ${error}`;
  return { text: out, isError: error !== null && !answer.trim(), error };
}

/**
 * @param {{ call: Call, version?: string, baseUrl?: string }} o
 * @returns {Server}
 */
export function createMcpServer({ call, version = '0.0.0', baseUrl = '' }) {
  const server = new Server({ name: 'ontologizer', version }, { capabilities: { tools: {}, resources: {} } });
  const tools = toolList();
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const op = MCP_OPS.find((o) => o.mcp?.name === name);
    if (!op) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    const args = request.params.arguments ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) return textResult('arguments must be an object', true);
    /** @type {CallResult} */
    let r;
    try {
      const { tenant: _ignored, ...rest } = /** @type {Record<string, any>} */ (args);
      r = await call(op, { ...rest, tenant: await tenant() });
    } catch (/** @type {any} */ err) {
      return textResult(String(err?.message ?? err), true);
    }
    if (r.status < 200 || r.status >= 300) return textResult(errorText(r), true);
    if (op.name === 'ask_map') {
      const c = collectChat(r.text);
      return textResult(c.text || 'The map gave no answer.', c.isError || !c.text);
    }
    const isJson = /json/i.test(r.type) || (op.http.type ?? 'application/json') === 'application/json';
    if (!isJson) return textResult(r.text);
    const j = tryJson(r.text);
    if (j === undefined) return textResult(r.text);
    if (op.name === 'build_map' && j && typeof j === 'object') {
      if (j.viewUrl) j.viewUrl = abs(j.viewUrl);
      if (j.eventsUrl) j.eventsUrl = abs(j.eventsUrl);
    }
    const plain = j !== null && typeof j === 'object' && !Array.isArray(j);
    return { content: [{ type: 'text', text: JSON.stringify(j, null, 2) }], ...(plain ? { structuredContent: j } : {}) };
  });

  const uriFor = (/** @type {string} */ t, /** @type {string} */ id) => `ontologizer://${t}/maps/${encodeURIComponent(id)}/snapshot`;

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const t = await tenant().catch((e) => { throw new McpError(ErrorCode.InternalError, String(e?.message ?? e)); });
    const r = await call(/** @type {any} */ (opByName('list_maps')), { tenant: t });
    if (r.status < 200 || r.status >= 300) throw new McpError(ErrorCode.InternalError, errorText(r));
    const rows = tryJson(r.text);
    return { resources: (Array.isArray(rows) ? rows : []).map((m) => ({
      uri: uriFor(t, String(m.id)), name: String(m.name ?? m.id), mimeType: 'application/json',
      description: `The whole map as JSON (${m.nodes ?? 0} nodes${m.draft ? ', draft' : ''})`,
    })) };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{ uriTemplate: 'ontologizer://{tenant}/maps/{id}/snapshot', name: 'Map snapshot', mimeType: 'application/json',
      description: 'The whole map as JSON: the folded event log' }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const m = /^ontologizer:\/\/([^/]+)\/maps\/([^/]+)\/snapshot$/.exec(uri);
    if (!m) throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
    let id;
    try { id = decodeURIComponent(m[2]); } catch { throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`); }
    const r = await call(/** @type {any} */ (opByName('get_snapshot')), { tenant: m[1], id });
    if (r.status < 200 || r.status >= 300) throw new McpError(ErrorCode.InvalidParams, errorText(r));
    return { contents: [{ uri, mimeType: 'application/json', text: r.text }] };
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
