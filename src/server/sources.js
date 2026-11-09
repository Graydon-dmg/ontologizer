// @ts-check
// MCP sources: connections, the read-only tool filter, results and refs.
// Nothing here calls a tool that was not offered, and status() never calls any tool.

/** @typedef {{ name: string, url?: string, command?: string, args?: string[], visibility: 'public'|'private', allowTools: string[], headers?: (principal: any) => Record<string, string> }} SourceEntry */
/** @typedef {{ source: string, ref: string, title?: string, url?: string }} SourceRef */
/** @typedef {{ text: string, isError: boolean, source: string, visibility: 'public'|'private', refs: SourceRef[] }} ToolResult */
/** @typedef {{ defs: { name: string, description: string, input_schema: any }[], names: string[],
 *   info: Record<string, { source: string, visibility: 'public'|'private' }>,
 *   call: (name: string, input: any) => Promise<ToolResult> }} ToolSet
 *   info: which source (and its visibility) each offered tool name belongs to. */

export const SEP = '__';
const JOINED_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TEXT_CAP = 20000;
const CALL_TIMEOUT_MS = 30000;

/**
 * For each tool the server lists: whether it is offered to the model, and why not.
 * @param {{ name: string, allowTools: string[] }} entry
 * @param {any[]} tools
 * @returns {{ name: string, offered: boolean, why: string }[]}
 */
export function offeredTools(entry, tools) {
  return (tools ?? []).map((tool) => {
    const name = String(tool?.name);
    if (!entry.allowTools.includes(name)) return { name, offered: false, why: 'not in allowTools' };
    if (tool?.annotations?.readOnlyHint !== true) return { name, offered: false, why: 'not marked readOnlyHint' };
    if (!JOINED_RE.test(`${entry.name}${SEP}${name}`)) return { name, offered: false, why: 'name not usable' };
    return { name, offered: true, why: 'offered' };
  });
}

/** @param {any} v @param {number} max @returns {string|undefined} */
function clean(v, max) {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t && t.length <= max ? t : undefined;
}

/** @param {any} v @returns {string|undefined} */
function httpUrl(v) {
  if (typeof v !== 'string') return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? v.trim() : undefined;
  } catch { return undefined; }
}

/** @param {any} v @param {number} depth @param {(o: any) => void} out */
function walk(v, depth, out) {
  if (depth > 4 || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1, out); return; }
  if (typeof v.ref === 'string') out(v);
  for (const x of Object.values(v)) walk(x, depth + 1, out);
}

/**
 * Refs a tool result names.
 * @param {string} sourceName @param {any} result @returns {SourceRef[]}
 */
export function refsFrom(sourceName, result) {
  if (!result || result.isError) return [];
  /** @type {Map<string, SourceRef>} */
  const found = new Map();
  /** @param {string|undefined} ref @param {string|undefined} title @param {string|undefined} url */
  const add = (ref, title, url) => {
    if (!ref || found.has(ref)) return;
    /** @type {SourceRef} */
    const r = { source: sourceName, ref };
    if (title) r.title = title;
    if (url) r.url = url;
    found.set(ref, r);
  };
  const content = Array.isArray(result.content) ? result.content : [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'resource_link') {
      const ref = clean(b.uri, 500);
      add(ref, clean(b.title, 200) ?? clean(b.name, 200), httpUrl(b.uri));
    } else if (b.type === 'resource' && b.resource) {
      const ref = clean(b.resource.uri, 500);
      add(ref, clean(b.resource.title, 200) ?? clean(b.resource.name, 200), httpUrl(b.resource.uri));
    } else if (b.type === 'text' && typeof b.text === 'string') {
      let parsed;
      try { parsed = JSON.parse(b.text); } catch { parsed = undefined; }
      if (parsed !== undefined) walk(parsed, 0, (o) => add(clean(o.ref, 500), clean(o.title, 200), httpUrl(o.url)));
    }
  }
  if (result.structuredContent) walk(result.structuredContent, 0, (o) => add(clean(o.ref, 500), clean(o.title, 200), httpUrl(o.url)));
  return [...found.values()];
}

/** The text the model sees. @param {any} result @returns {string} */
export function resultText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const texts = blocks.filter((/** @type {any} */ b) => b?.type === 'text' && typeof b.text === 'string').map((/** @type {any} */ b) => b.text);
  let text = texts.join('\n');
  if (!texts.length && result?.structuredContent !== undefined) text = JSON.stringify(result.structuredContent);
  return text.slice(0, TEXT_CAP);
}

/**
 * The sources a principal holds, among the configured entries.
 * @param {SourceEntry[]} entries @param {{ scopes?: string[], sources?: string[] }} principal @returns {string[]}
 */
export function heldSources(entries, principal) {
  if (principal?.scopes?.includes('admin')) return entries.map((e) => e.name);
  if (Array.isArray(principal?.sources)) return entries.map((e) => e.name).filter((n) => principal.sources?.includes(n));
  return entries.filter((e) => e.visibility === 'public').map((e) => e.name);
}

/** @template T @param {Promise<T>} p @param {number} ms @param {string} what @returns {Promise<T>} */
function withTimeout(p, ms, what) {
  /** @type {any} */ let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** @param {any} err @returns {string} */
const msg = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 300);

/** @param {SourceEntry} entry @param {Record<string, string>} headers */
async function defaultConnect(entry, headers) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const client = new Client({ name: 'ontologizer', version: '1.0.0' });
  if (entry.url) {
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers } }));
  } else {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    await client.connect(new StdioClientTransport({ command: /** @type {string} */ (entry.command), args: entry.args ?? [], stderr: 'ignore' }));
  }
  return client;
}

/**
 * @param {SourceEntry[]} entries
 * @param {{ connect?: (entry: SourceEntry, headers: Record<string, string>) => Promise<any>, log?: (line: string) => void, timeoutMs?: number, maxClients?: number }} [opts]
 */
export function createSources(entries, { connect = defaultConnect, log = () => {}, timeoutMs = 10000, maxClients = 32 } = {}) {
  /** @typedef {{ key: string, promise: Promise<any>, refs: number, used: number, forgotten: boolean, closed: boolean }} Rec */
  /** The cache, by (source, headers). @type {Map<string, Rec>} */
  const clients = new Map();
  /** Every client not yet closed, including forgotten ones still in use. @type {Set<Rec>} */
  const live = new Set();
  let tick = 0;

  /** @param {Rec} rec */
  async function closeRec(rec) {
    if (rec.closed) return;
    rec.closed = true;
    live.delete(rec);
    try { await (await rec.promise).close?.(); } catch { /* already gone */ }
  }

  /** Remove from the cache; close now only when nothing is using it. @param {Rec} rec */
  function forgetRec(rec) {
    if (clients.get(rec.key) === rec) clients.delete(rec.key);
    rec.forgotten = true;
    if (rec.refs === 0) void closeRec(rec);
  }

  /** Close least recently used idle clients while over the cap. */
  function trim() {
    while (clients.size > maxClients) {
      /** @type {Rec|undefined} */ let lru;
      for (const rec of clients.values()) if (rec.refs === 0 && (!lru || rec.used < lru.used)) lru = rec;
      if (!lru) return; // all in use: over the cap for now
      forgetRec(lru);
    }
  }

  /** Forget a cached client (a stdio child that exited, a dropped connection): the next call reconnects. @param {SourceEntry} entry @param {any} principal */
  function forget(entry, principal) {
    let headers;
    try { headers = entry.headers?.(principal) ?? {}; } catch { return; }
    const rec = clients.get(`${entry.name}${JSON.stringify(headers)}`);
    if (rec) forgetRec(rec);
  }

  /** Take a reference on the client for this source and principal. @param {SourceEntry} entry @param {any} principal */
  async function acquire(entry, principal) {
    const headers = entry.headers?.(principal) ?? {}; // a throwing headers function propagates: unreachable
    const key = `${entry.name}${JSON.stringify(headers)}`;
    let rec = clients.get(key);
    if (!rec) {
      /** @type {Rec} */
      const fresh = { key, promise: withTimeout(connect(entry, headers), timeoutMs, 'connect'), refs: 0, used: 0, forgotten: false, closed: false };
      rec = fresh;
      clients.set(key, fresh);
      live.add(fresh);
      fresh.promise.catch(() => { if (clients.get(key) === fresh) clients.delete(key); live.delete(fresh); });
    }
    const held = rec;
    held.refs++;
    held.used = ++tick;
    trim();
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      held.refs--;
      if (held.refs === 0) { if (held.forgotten) void closeRec(held); else trim(); }
    };
    try { return { client: await held.promise, rec: held, release }; } catch (err) { release(); throw err; }
  }

  /** @param {SourceEntry} entry @param {any} principal */
  async function listTools(entry, principal) {
    const h = await acquire(entry, principal);
    try {
      const res = await withTimeout(h.client.listTools(), timeoutMs, 'listTools');
      return /** @type {any[]} */ (res?.tools ?? []);
    } finally { h.release(); }
  }

  return {
    entries,
    names: () => entries.map((e) => e.name),
    get: (/** @type {string} */ name) => entries.find((e) => e.name === name),

    /** Never calls a tool. @param {{ names?: string[], principal?: any }} [o] */
    async status({ names, principal } = {}) {
      const pick = entries.filter((e) => !names || names.includes(e.name));
      return Promise.all(pick.map(async (e) => {
        /** @type {{ name: string, visibility: 'public'|'private', allowTools: string[], reachable: boolean, error?: string, tools?: { name: string, offered: boolean, why: string }[] }} */
        const row = { name: e.name, visibility: e.visibility, allowTools: e.allowTools, reachable: false };
        try {
          row.tools = offeredTools(e, await listTools(e, principal));
          row.reachable = true;
        } catch (err) { row.error = msg(err); }
        return row;
      }));
    },

    /** @param {any} principal @param {string[]} names @returns {Promise<ToolSet|null>} */
    async toolset(principal, names) {
      if (!names?.length) return null;
      /** @type {ToolSet['defs']} */
      const defs = [];
      /** @type {Map<string, { entry: SourceEntry, tool: string }>} */
      const offered = new Map();
      for (const e of entries.filter((x) => names.includes(x.name))) {
        let tools;
        try { tools = await listTools(e, principal); } catch (err) { log(`source ${e.name} skipped: ${msg(err)}`); continue; }
        const verdicts = new Map(offeredTools(e, tools).map((v) => [v.name, v]));
        for (const t of tools) {
          if (!verdicts.get(t.name)?.offered) continue;
          const full = `${e.name}${SEP}${t.name}`;
          offered.set(full, { entry: e, tool: t.name });
          defs.push({ name: full, description: `[${e.name}, ${e.visibility} source] ${t.description ?? ''}`, input_schema: t.inputSchema ?? { type: 'object' } });
        }
      }
      if (!defs.length) return null;
      return {
        defs,
        names: defs.map((d) => d.name),
        info: Object.fromEntries([...offered].map(([full, o]) => [full, { source: o.entry.name, visibility: o.entry.visibility }])),
        async call(name, input) {
          const hit = offered.get(name);
          if (!hit) return { isError: true, text: 'That tool is not offered.', source: String(name).split(SEP)[0], visibility: 'public', refs: [] };
          const { entry, tool } = hit;
          const base = { source: entry.name, visibility: entry.visibility };
          /** @type {Awaited<ReturnType<typeof acquire>>|undefined} */
          let h;
          const priv = entry.visibility === 'private';
          const hidden = { ...base, isError: true, text: `The source ${entry.name} returned an error.`, refs: [] };
          try {
            h = await acquire(entry, principal);
            const res = await withTimeout(h.client.callTool({ name: tool, arguments: input ?? {} }), CALL_TIMEOUT_MS, 'callTool');
            if (priv && res?.isError === true) return hidden;
            return { ...base, isError: res?.isError === true, text: resultText(res), refs: refsFrom(entry.name, res) };
          } catch (err) {
            if (h) forgetRec(h.rec);
            if (priv) { log(`source ${entry.name} call failed: ${msg(err)}`); return hidden; }
            return { ...base, isError: true, text: `The ${entry.name} source failed: ${msg(err)}`, refs: [] };
          } finally { h?.release(); }
        },
      };
    },

    async close() {
      const all = [...live];
      clients.clear();
      await Promise.all(all.map((rec) => closeRec(rec)));
    },
  };
}
