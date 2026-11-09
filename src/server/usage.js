// @ts-check
// Usage per tenant per UTC day: model calls and tokens, counted from the SDK responses' `usage`
// fields by wrapping every model client the engine gets. Optional daily limits refuse further model
// calls until the next UTC day. Dollars are never counted (no price table): a usage limit, not a
// spend cap. Counters persist in <home>/usage.json (atomic writes, mode 0600, the last 31 days).
import fs from 'node:fs';
import path from 'node:path';

const KEEP_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

/** @typedef {{ calls: number, inputTokens: number, outputTokens: number }} Counts */
/** @typedef {{ version: 1, tenants: Record<string, Record<string, Counts>> }} UsageFile */

/** The UTC day of a time, as YYYY-MM-DD. @param {number} ms */
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
/** The next UTC midnight after a time, in ms. @param {number} ms */
export const nextUtcDay = (ms) => (Math.floor(ms / DAY_MS) + 1) * DAY_MS;
/** Whole seconds until the next UTC day (at least 1). @param {number} ms */
export const secondsToNextUtcDay = (ms) => Math.max(1, Math.ceil((nextUtcDay(ms) - ms) / 1000));

/** @param {string} home */
export const usagePath = (home) => path.join(home, 'usage.json');

/** A model call refused because the tenant is over its daily limit. */
export class UsageLimitError extends Error {
  /** @param {string} message @param {number} retryAfter */
  constructor(message, retryAfter) {
    super(message);
    this.name = 'UsageLimitError';
    this.code = 'USAGE_LIMIT';
    this.retryAfter = retryAfter;
  }
}

/** @param {any} n */
const count = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * The file, as written; an empty one when it is missing or unreadable (never throws).
 * @param {string} home @returns {UsageFile}
 */
export function readUsageFile(home) {
  try {
    const j = JSON.parse(fs.readFileSync(usagePath(home), 'utf8'));
    if (!j || typeof j !== 'object' || !j.tenants || typeof j.tenants !== 'object') return { version: 1, tenants: {} };
    /** @type {UsageFile} */
    const out = { version: 1, tenants: {} };
    for (const [t, days] of Object.entries(j.tenants)) {
      if (!days || typeof days !== 'object') continue;
      out.tenants[t] = {};
      for (const [d, c] of Object.entries(/** @type {any} */ (days))) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !c || typeof c !== 'object') continue;
        out.tenants[t][d] = { calls: count(c.calls), inputTokens: count(c.inputTokens), outputTokens: count(c.outputTokens) };
      }
    }
    return out;
  } catch { return { version: 1, tenants: {} }; }
}

/** Input tokens of one response: fresh input plus cache writes and reads. @param {any} u */
export const inputTokensOf = (u) => count(u?.input_tokens) + count(u?.cache_creation_input_tokens) + count(u?.cache_read_input_tokens);

/**
 * @param {{ home: string, limitCalls?: number|null, limitTokens?: number|null, now?: () => number, log?: (line: string) => void }} o
 *   limitCalls, limitTokens: per tenant per UTC day; null (or 0 and below) means no limit.
 */
export function createUsage({ home, limitCalls = null, limitTokens = null, now = () => Date.now(), log = () => {} }) {
  const file = usagePath(home);
  const limits = {
    calls: Number.isInteger(limitCalls) && /** @type {number} */ (limitCalls) > 0 ? /** @type {number} */ (limitCalls) : null,
    tokens: Number.isInteger(limitTokens) && /** @type {number} */ (limitTokens) > 0 ? /** @type {number} */ (limitTokens) : null,
  };
  /** Read once at start: a restart keeps today's counts. */
  const data = readUsageFile(home);
  let warned = false;
  let dirty = false; // a write failed: try again on the next record or flush

  /** @param {string} tenant @param {string} day @returns {Counts} */
  function slot(tenant, day) {
    const days = (data.tenants[tenant] ??= {});
    return (days[day] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
  }

  /** Write the file atomically (temp file, then rename), keeping the last KEEP_DAYS days. */
  function save() {
    const oldest = utcDay(now() - (KEEP_DAYS - 1) * DAY_MS);
    for (const days of Object.values(data.tenants)) {
      for (const d of Object.keys(days)) if (d < oldest) delete days[d];
    }
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
      warned = false;
      dirty = false;
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
      dirty = true;
      if (!warned) log(`could not write ${file}: ${/** @type {any} */ (err)?.code ?? /** @type {any} */ (err)?.message ?? err}`);
      warned = true;
    }
  }

  /**
   * Add to a tenant's counts for today.
   * @param {string} tenant @param {{ calls?: number, inputTokens?: number, outputTokens?: number }} add
   */
  function record(tenant, add) {
    const c = slot(tenant, utcDay(now()));
    c.calls += count(add.calls);
    c.inputTokens += count(add.inputTokens);
    c.outputTokens += count(add.outputTokens);
    save();
  }

  /** @param {string} tenant */
  function today(tenant) {
    const t = now();
    const c = data.tenants[tenant]?.[utcDay(t)] ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
    return { tenant, day: utcDay(t), calls: c.calls, inputTokens: c.inputTokens, outputTokens: c.outputTokens,
      limits: { ...limits }, resetsAt: new Date(nextUtcDay(t)).toISOString() };
  }

  /**
   * Null while the tenant is under its limits; else why, and the seconds to the next UTC day.
   * @param {string} tenant @returns {{ error: string, retryAfter: number } | null}
   */
  function over(tenant) {
    if (limits.calls === null && limits.tokens === null) return null;
    const u = today(tenant);
    const t = now();
    const retryAfter = secondsToNextUtcDay(t);
    const when = `It resets at 00:00 UTC (in ${Math.floor(retryAfter / 3600)} h ${Math.floor((retryAfter % 3600) / 60)} min).`;
    if (limits.calls !== null && u.calls >= limits.calls) {
      return { error: `Daily limit reached: ${u.calls} model calls today for tenant ${tenant} (limit ${limits.calls}). ${when}`, retryAfter };
    }
    const tokens = u.inputTokens + u.outputTokens;
    if (limits.tokens !== null && tokens >= limits.tokens) {
      return { error: `Daily limit reached: ${tokens} tokens today for tenant ${tenant} (limit ${limits.tokens}). ${when}`, retryAfter };
    }
    return null;
  }

  /**
   * A model client that counts every call and its tokens for a tenant, refuses calls over the limit,
   * and passes the engine's abort signal (the build timeout) to every request.
   * Wraps messages.stream (the engine's only call) and messages.create; everything else is the client's own.
   * @param {any} client @param {{ tenant: string, signal?: () => AbortSignal|null }} o
   */
  function wrap(client, { tenant, signal = () => null }) {
    if (!client || typeof client !== 'object' || !client.messages) return client;
    const messages = client.messages;
    /** @param {any} opts */
    const withSignal = (opts) => {
      const s = signal();
      if (!s) return opts;
      if (s.aborted) throw Object.assign(new Error('The build was stopped.'), { name: 'AbortError' });
      return { ...(opts ?? {}), signal: opts?.signal ? AbortSignal.any([opts.signal, s]) : s };
    };
    const gate = () => {
      const o = over(tenant);
      if (o) throw new UsageLimitError(o.error, o.retryAfter);
    };
    /** @param {any} u */
    const tokens = (u) => record(tenant, { inputTokens: inputTokensOf(u), outputTokens: count(u?.output_tokens) });
    const wrapped = new Proxy(messages, {
      get(target, prop, receiver) {
        if (prop === 'stream') {
          return (/** @type {any} */ params, /** @type {any} */ opts) => {
            gate();
            const o = withSignal(opts);
            const s = o === undefined ? target.stream(params) : target.stream(params, o);
            record(tenant, { calls: 1 });
            let counted = false;
            /** @param {any} m */
            const once = (m) => { if (!counted && m?.usage) { counted = true; tokens(m.usage); } };
            if (s && typeof s.on === 'function') {
              s.on('finalMessage', once);
            }
            if (s && typeof s.finalMessage === 'function') {
              const final = s.finalMessage.bind(s);
              s.finalMessage = async () => { const m = await final(); once(m); return m; };
            }
            return s;
          };
        }
        if (prop === 'create') {
          return async (/** @type {any} */ params, /** @type {any} */ opts) => {
            gate();
            const o = withSignal(opts);
            const p = o === undefined ? target.create(params) : target.create(params, o);
            record(tenant, { calls: 1 });
            const r = await p;
            // A streamed create returns events, not a message: its usage arrives in message_start/delta.
            if (r && r.usage && !params?.stream) tokens(r.usage);
            return r;
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === 'messages') return wrapped;
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  return { file, limits, record, today, over, wrap, flush: () => { if (dirty) save(); } };
}
