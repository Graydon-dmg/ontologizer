// @ts-check
// The JS client for service mode (`ontologizer/client`). Every method is `call(opName, input)`
// over the shared op list (src/ops.js). Browser-safe: only fetch, TextDecoder, ReadableStream,
// AbortSignal and URL; nothing from node:.
import { opByName, requestFor } from '../ops.js';

/** Which op each client method calls. A renamed or removed op makes the client test fail. */
export const METHODS = {
  'maps.check': 'check_context',
  'maps.build': 'build_map',
  'maps.wait': 'wait_for_map',
  'maps.list': 'list_maps',
  'maps.snapshot': 'get_snapshot',
  'maps.events': 'map_events',
  'maps.actions': 'view_action',
  'maps.ask': 'ask_map',
  'maps.save': 'save_map',
  'maps.delete': 'delete_map',
  'trash.list': 'list_trash',
  'trash.restore': 'restore_map',
  'maps.export': 'export_map',
  'maps.context': 'get_context',
  'maps.outline': 'get_outline',
  'maps.search': 'search_map',
  'maps.node': 'get_node',
  usage: 'get_usage',
  status: 'get_status',
  sources: 'list_sources',
  session: 'get_session',
};

/** The jobs that have their own op (they share POST .../actions with view_action). */
export const JOB_TYPES = ['research', 'explain', 'sources', 'fuse', 'rosetta'];

export class OntologizerError extends Error {
  /** @param {string} message @param {{ status?: number, error?: string, retryAfter?: number | null, body?: any }} [o] */
  constructor(message, { status = 0, error = message, retryAfter = null, body = null } = {}) {
    super(message);
    this.name = 'OntologizerError';
    /** @type {number} */ this.status = status;
    /** @type {string} */ this.error = error;
    /** @type {number | null} */ this.retryAfter = retryAfter;
    /** @type {any} */ this.body = body;
  }
}

/**
 * Parse a server-sent event stream: one parsed JSON value per event. Handles many events in one
 * chunk, an event split across chunks, \r\n line ends, and comment lines.
 * @param {{ getReader: () => { read: () => Promise<{ done: boolean, value?: Uint8Array }>, cancel?: () => any, releaseLock?: () => void } }} body
 * @returns {AsyncGenerator<any, void, undefined>}
 */
export async function* parseSse(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  /** @param {string} block */
  const parse = (block) => {
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return undefined;
    const text = data.join('\n');
    try { return { value: JSON.parse(text) }; } catch { return { value: text }; }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      if (done) buf += dec.decode();
      buf = buf.replace(/\r\n?/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = parse(buf.slice(0, i));
        buf = buf.slice(i + 2);
        if (ev) yield ev.value;
      }
      if (done) break;
    }
    const last = parse(buf);
    if (last) yield last.value;
  } finally {
    try { await reader.cancel?.(); } catch { /* already closed */ }
  }
}

/**
 * @param {{ url: string, token?: string, tenant?: string, fetch?: typeof fetch }} [o]
 */
export function createClient({ url, token, tenant, fetch: f = globalThis.fetch } = /** @type {any} */ ({})) {
  if (!url) throw new Error('createClient: url is required');
  /** @type {string | undefined} */
  let tenantName = tenant;
  /** @type {Promise<string> | null} */
  let tenantLookup = null;

  /** @param {Response} res */
  async function fail(res) {
    const text = await res.text().catch(() => '');
    /** @type {any} */ let body = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    const message = (body && typeof body === 'object' && typeof body.error === 'string') ? body.error : (text || `HTTP ${res.status}`);
    const ra = res.headers.get('retry-after');
    const secs = ra !== null && ra !== '' && Number.isFinite(Number(ra)) ? Number(ra) : null;
    return new OntologizerError(message, { status: res.status, error: message, retryAfter: secs, body });
  }

  /** @param {any} op @param {Record<string, any>} input @param {AbortSignal} [signal] */
  async function send(op, input, signal) {
    const given = { ...input };
    if (op.http.path.includes('{tenant}') && given.tenant === undefined) given.tenant = await tenantOf();
    const r = requestFor(op, given);
    /** @type {Record<string, string>} */
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (r.body !== null) headers['content-type'] = 'application/json';
    const res = await f(new URL(r.path, url), { method: r.method, headers, ...(r.body !== null ? { body: JSON.stringify(r.body) } : {}), ...(signal ? { signal } : {}) });
    if (!res.ok) throw await fail(res);
    return res;
  }

  async function tenantOf() {
    if (tenantName) return tenantName;
    tenantLookup ??= (async () => {
      const s = await call('get_session', {});
      if (!s?.tenant) throw new OntologizerError('The server did not say which tenant this is');
      return s.tenant;
    })();
    try { tenantName = await tenantLookup; } catch (e) { tenantLookup = null; throw e; }
    return /** @type {string} */ (tenantName);
  }

  /**
   * An async iterator over an SSE op. Breaking out of the loop cancels the reader and aborts the request.
   * @param {any} op @param {Record<string, any>} input @param {AbortSignal} [signal]
   * @returns {AsyncGenerator<any, void, undefined>}
   */
  async function* stream(op, input, signal) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal?.aborted) return;
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await send(op, input, ctl.signal);
      if (!res.body) return;
      try { yield* parseSse(res.body); } catch (e) { if (!ctl.signal.aborted) throw e; }
    } catch (e) {
      if (!ctl.signal.aborted) throw e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      ctl.abort();
    }
  }

  /**
   * Call any op by name. JSON answers are parsed, other answers are text; an SSE op answers an async iterator.
   * @param {string} opName @param {Record<string, any>} [input] @param {{ signal?: AbortSignal }} [o]
   * @returns {Promise<any>}
   */
  async function call(opName, input = {}, { signal } = {}) {
    const op = opByName(opName);
    if (!op) throw new Error(`Unknown op: ${opName}`);
    if (op.http.type === 'text/event-stream') {
      if (op.http.path.includes('{tenant}') && input.tenant === undefined) input = { ...input, tenant: await tenantOf() };
      return stream(op, input, signal);
    }
    const res = await send(op, input, signal);
    const type = res.headers.get('content-type') ?? '';
    return /json/.test(type) ? res.json() : res.text();
  }

  /** @param {string} key @param {Record<string, any>} input @param {{ signal?: AbortSignal }} [o] */
  const via = (key, input, o) => call(/** @type {string} */ (/** @type {any} */ (METHODS)[key]), input, o);

  /** An SSE method as an iterator at once (the request goes out on the first next()). @param {string} key @param {Record<string, any>} input @param {{ signal?: AbortSignal }} o @returns {AsyncGenerator<any, void, undefined>} */
  async function* iterate(key, input, o) { yield* await via(key, input, o); }

  const maps = {
    /** Check a topic description. @param {string} context @param {Array<{ question: string, answer: string }>} [answers] @returns {Promise<{ ready: boolean, brief?: any, name?: string, questions?: any[] }>} */
    check: (context, answers) => via('maps.check', { context, ...(answers ? { answers } : {}) }),
    /** Start a build. @param {any} brief @param {{ name?: string, depth?: number, sources?: string[] }} [o] @returns {Promise<{ id: string, viewUrl: string, eventsUrl?: string }>} */
    build: (brief, o = {}) => via('maps.build', { brief, ...o }),
    /** Wait until idle (timeout in ms). @param {string} id @param {{ timeout?: number }} [o] @returns {Promise<{ state: 'idle' | 'busy', jobs: any[], error?: string }>} */
    wait: (id, o = {}) => via('maps.wait', { id, ...o }),
    /** The maps you may read. @returns {Promise<Array<{ id: string, name: string, root?: string, nodes: number, draft: boolean }>>} */
    list: () => via('maps.list', {}),
    /** The whole map as JSON. @param {string} id @returns {Promise<any>} */
    snapshot: (id) => via('maps.snapshot', { id }),
    /** The map's events, parsed. @param {string} id @param {{ from?: number, signal?: AbortSignal }} [o] @returns {AsyncGenerator<any, void, undefined>} */
    events: (id, { from, signal } = {}) => iterate('maps.events', { id, ...(from !== undefined ? { from } : {}) }, { signal }),
    /** Change the view or start a job; the op follows body.type. @param {string} id @param {{ type: string, [k: string]: any }} body @returns {Promise<any>} */
    actions: (id, body) => call(JOB_TYPES.includes(body.type) ? body.type : 'view_action', { ...body, id }),
    /** Ask the map; yields the chat's items. @param {string} id @param {string} text @param {{ chatId?: string, lens?: string, signal?: AbortSignal }} [o] @returns {AsyncGenerator<any, void, undefined>} */
    ask: (id, text, { chatId, lens, signal } = {}) => iterate('maps.ask', { id, text, ...(chatId ? { chatId } : {}), ...(lens ? { lens } : {}) }, { signal }),
    /** Save under a name. @param {string} id @param {string} name @returns {Promise<{ ok: boolean, id: string, viewUrl?: string }>} */
    save: (id, name) => via('maps.save', { id, name }),
    /** Move to the trash (restorable for 30 days). @param {string} id @returns {Promise<{ ok: boolean, trashId: string }>} */
    delete: (id) => via('maps.delete', { id }),
    /** Export. @param {string} id @param {{ format?: 'json' | 'context' | 'html' | 'embed', budget?: number, threeD?: boolean }} [o] @returns {Promise<string>} */
    export: async (id, { format = 'json', ...rest } = {}) => {
      const r = await via('maps.export', { id, format, ...rest });
      return typeof r === 'string' ? r : JSON.stringify(r); // json arrives parsed: hand back the text
    },
    /** The context pack (markdown). @param {string} id @param {{ budget?: number }} [o] @returns {Promise<string>} */
    context: (id, o = {}) => via('maps.context', { id, ...o }),
    /** The indented outline. @param {string} id @returns {Promise<string>} */
    outline: (id) => via('maps.outline', { id }),
    /** Search nodes. @param {string} id @param {string} q @param {{ limit?: number }} [o] @returns {Promise<{ results: Array<{ id: string, label: string, path?: string, snippet?: string }> }>} */
    search: (id, q, o = {}) => via('maps.search', { id, q, ...o }),
    /** One node in full. @param {string} id @param {string} nodeId @returns {Promise<any>} */
    node: (id, nodeId) => via('maps.node', { id, nodeId }),
  };

  const trash = {
    /** The deleted maps you could restore. @returns {Promise<Array<{ trashId: string, id: string, name: string, draft: boolean, deletedAt: number, purgeAt: number }>>} */
    list: () => via('trash.list', {}),
    /** Bring one back, under its own id or `as`. @param {string} trashId @param {{ as?: string }} [o] @returns {Promise<{ ok: boolean, id: string, viewUrl?: string }>} */
    restore: (trashId, o = {}) => via('trash.restore', { trashId, ...o }),
  };

  return {
    call,
    maps,
    trash,
    /** Today's usage and limits. @returns {Promise<any>} */
    usage: () => via('usage', {}),
    /** The tenant's server status. @returns {Promise<any>} */
    status: () => via('status', {}),
    /** The configured sources you hold. @returns {Promise<Array<{ name: string, visibility?: string }>>} */
    sources: () => via('sources', {}),
    /** Who you are: tenant, scopes, open. @returns {Promise<{ ok: boolean, tenant: string, scopes: string[], open: boolean }>} */
    session: () => via('session', {}),
  };
}
