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

/** A file's identity now (changes when another process writes it). @param {string} file */
function stamp(file) {
  try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return 'missing'; }
}

export const LOCK_STALE_MS = 10_000;
/** How long a write waits for the lock (a busy lock keeps the counts in memory for the next write). */
export const LOCK_WAIT_MS = 1_000;
/** How long the last write, at exit, waits: past LOCK_STALE_MS, so even a crashed holder's lock is taken over. */
export const EXIT_WAIT_MS = LOCK_STALE_MS + 2_000;
const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Take <file>.lock (created with O_EXCL); a lock older than LOCK_STALE_MS is a crashed writer's and
 * is removed. Retries for up to `waitMs` (wall time: a lock's age is wall time too). Returns the
 * release function, or null.
 * @param {string} file @param {number} [waitMs] @returns {(() => void) | null}
 */
export function lock(file, waitMs = LOCK_WAIT_MS) {
  const lockFile = `${file}.lock`;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* reported by the write */ }
  const until = Date.now() + Math.max(0, waitMs);
  for (let first = true; first || Date.now() < until; first = false) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { fs.rmSync(lockFile, { force: true }); } catch { /* already gone */ } };
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== 'EEXIST') return null;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lockFile, { force: true }); continue; }
      } catch { continue; } // it went away: try again at once
      Atomics.wait(pause, 0, 0, 5);
    }
  }
  return null;
}

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

/** The input a request carries, estimated (characters / 4, rounded up). @param {any} params */
const requestTokens = (params) => {
  try { return Math.ceil(JSON.stringify({ system: params?.system, messages: params?.messages, tools: params?.tools }).length / 4); } catch { return 0; }
};

/**
 * Count one streamed answer's tokens as they arrive, once each, so an answer that is aborted or times
 * out still records what it used. The API reports input (with cache writes and reads) in message_start
 * and cumulative output (and, on newer models, input) in message_delta; the final message, when there
 * is one, tops the counts up to its own. A stream that ends with no usage at all (aborted before
 * message_start) is counted by estimate, never as nothing: the request's size for input and its
 * max_tokens for output. One that ends after message_start but before any output count is charged
 * for the text it streamed (characters / 3, rounded up: more tokens than it can have used).
 * Events come from the stream's own 'streamEvent' (the SDK's MessageStream, whoever consumes it) and
 * from its iterator as the caller reads it, whichever delivers first; usage counts are totals, so
 * seeing one twice changes nothing.
 * @param {any} s the stream @param {any} params the request @param {(add: { inputTokens?: number, outputTokens?: number }) => void} add
 */
export function meterStream(s, params, add) {
  if (!s || typeof s !== 'object') return;
  const acc = { in: 0, out: 0, sawInput: false, sawOutput: false, chars: 0, settled: false, from: '' };
  /** @param {number} total */
  const toIn = (total) => { if (total > acc.in) { add({ inputTokens: total - acc.in }); acc.in = total; } };
  /** @param {number} total */
  const toOut = (total) => { if (total > acc.out) { add({ outputTokens: total - acc.out }); acc.out = total; } };
  /** @param {string} from 'events' or 'iterator' @returns {(ev: any) => void} */
  const observeFrom = (from) => (ev) => {
    if (!ev || typeof ev !== 'object') return;
    // The first source to deliver an event is the one counted (the other sees the same events).
    if (!acc.from) acc.from = from;
    if (acc.from !== from) return;
    if (ev.type === 'message_start' && ev.message?.usage) {
      acc.sawInput = true;
      toIn(inputTokensOf(ev.message.usage));
      toOut(count(ev.message.usage.output_tokens));
    } else if (ev.type === 'message_delta' && ev.usage) {
      const u = ev.usage;
      if (u.input_tokens !== undefined || u.cache_creation_input_tokens !== undefined || u.cache_read_input_tokens !== undefined) {
        acc.sawInput = true;
        toIn(inputTokensOf(u));
      }
      if (u.output_tokens !== undefined) { acc.sawOutput = true; toOut(count(u.output_tokens)); }
    } else if (ev.type === 'content_block_delta' && ev.delta) {
      const d = ev.delta;
      acc.chars += String(d.text ?? d.partial_json ?? d.thinking ?? '').length;
    }
  };
  /** @param {any} m */
  const final = (m) => {
    if (!m?.usage) return;
    acc.sawInput = true;
    acc.sawOutput = true;
    toIn(inputTokensOf(m.usage));
    toOut(count(m.usage.output_tokens));
  };
  const settle = () => {
    if (acc.settled) return;
    acc.settled = true;
    if (!acc.sawInput) toIn(Math.max(acc.in, requestTokens(params)));
    if (!acc.sawOutput) {
      const streamed = Math.ceil(acc.chars / 3);
      const cap = Number.isInteger(params?.max_tokens) && params.max_tokens > 0 ? params.max_tokens : 4096;
      toOut(acc.sawInput || acc.chars > 0 ? Math.max(acc.out, streamed) : cap);
    }
  };
  if (typeof s.on === 'function') {
    // The SDK's MessageStream: every raw event, then finalMessage, then end (or abort / error, then end).
    s.on('streamEvent', observeFrom('events'));
    s.on('finalMessage', final);
    for (const e of ['abort', 'error', 'end']) s.on(e, settle);
  }
  // Also its iterator and its finalMessage (a stream whose events never fire: a test double, another client).
  const observe = observeFrom('iterator');
  const iter = s[Symbol.asyncIterator];
  if (typeof iter === 'function') {
    s[Symbol.asyncIterator] = function () {
      const it = iter.call(s);
      return {
        async next() {
          let r;
          try { r = await it.next(); } catch (err) { settle(); throw err; }
          if (r.done) setTimeout(settle, 0); // finalMessage, called right after the loop, tops up first
          else observe(r.value);
          return r;
        },
        async return(/** @type {any} */ v) { settle(); return typeof it.return === 'function' ? it.return(v) : { done: true, value: v }; },
        async throw(/** @type {any} */ e) { settle(); if (typeof it.throw === 'function') return it.throw(e); throw e; },
        [Symbol.asyncIterator]() { return this; },
      };
    };
  }
  if (typeof s.finalMessage === 'function') {
    const fm = s.finalMessage.bind(s);
    s.finalMessage = async () => {
      try { const m = await fm(); final(m); settle(); return m; } catch (err) { settle(); throw err; }
    };
  }
}

/**
 * @param {{ home: string, limitCalls?: number|null, limitTokens?: number|null, now?: () => number, log?: (line: string) => void, lockWaitMs?: number }} o
 *   limitCalls, limitTokens: per tenant per UTC day; null (or 0 and below) means no limit.
 *   now: the clock (ms) that decides the UTC day, the Retry-After and what is pruned; tests fix it.
 *   lockWaitMs: how long a write waits for the lock before keeping its counts for the next write.
 */
export function createUsage({ home, limitCalls = null, limitTokens = null, now = () => Date.now(), log = () => {}, lockWaitMs = LOCK_WAIT_MS }) {
  const file = usagePath(home);
  const limits = {
    calls: Number.isInteger(limitCalls) && /** @type {number} */ (limitCalls) > 0 ? /** @type {number} */ (limitCalls) : null,
    tokens: Number.isInteger(limitTokens) && /** @type {number} */ (limitTokens) > 0 ? /** @type {number} */ (limitTokens) : null,
  };
  /**
   * The counts as last merged with the file (a restart keeps them; another process's are picked up),
   * plus this process's additions not yet written (`pending`). Writes add `pending` to the file's
   * current counts under a lock, so two processes on one home never overwrite each other.
   */
  let data = readUsageFile(home);
  /** @type {Record<string, Record<string, Counts>>} */
  let pending = {};
  let seen = stamp(file);
  let warned = false;

  /** @param {Record<string, Record<string, Counts>>} map @param {string} tenant @param {string} day @returns {Counts} */
  const slotIn = (map, tenant, day) => ((map[tenant] ??= {})[day] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });

  /** Pick up another process's writes (the file changed since we last read or wrote it). */
  function refresh() {
    const st = stamp(file);
    if (st === seen) return;
    seen = st;
    data = readUsageFile(home);
  }

  /**
   * Add `pending` to the file's counts, under the lock, atomically; keep the last KEEP_DAYS days.
   * Counts kept because the lock was busy go out with the next write, or at the latest with flush().
   * @param {number} [waitMs] @returns {boolean} whether nothing is left pending
   */
  function save(waitMs = lockWaitMs) {
    if (!Object.keys(pending).length) return true;
    const release = lock(file, waitMs);
    if (!release) {
      if (!warned) log(`could not lock ${file}: another process holds it; the counts are kept and written next time`);
      warned = true;
      return false;
    }
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      const merged = readUsageFile(home);
      for (const [t, days] of Object.entries(pending)) {
        for (const [d, c] of Object.entries(days)) {
          const m = slotIn(merged.tenants, t, d);
          m.calls += c.calls; m.inputTokens += c.inputTokens; m.outputTokens += c.outputTokens;
        }
      }
      const oldest = utcDay(now() - (KEEP_DAYS - 1) * DAY_MS);
      for (const days of Object.values(merged.tenants)) {
        for (const d of Object.keys(days)) if (d < oldest) delete days[d];
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
      data = merged;
      pending = {};
      seen = stamp(file);
      warned = false;
      return true;
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
      if (!warned) log(`could not write ${file}: ${/** @type {any} */ (err)?.code ?? /** @type {any} */ (err)?.message ?? err}`);
      warned = true;
      return false;
    } finally {
      release();
    }
  }

  /**
   * Add to a tenant's counts for today.
   * @param {string} tenant @param {{ calls?: number, inputTokens?: number, outputTokens?: number }} add
   */
  function record(tenant, add) {
    const day = utcDay(now());
    const c = slotIn(pending, tenant, day);
    c.calls += count(add.calls);
    c.inputTokens += count(add.inputTokens);
    c.outputTokens += count(add.outputTokens);
    save();
  }

  /** The counts as this process knows them: the file's, plus what it has not written yet. @param {string} tenant @param {string} day */
  function current(tenant, day) {
    refresh();
    const f = data.tenants[tenant]?.[day];
    const p = pending[tenant]?.[day];
    return { calls: (f?.calls ?? 0) + (p?.calls ?? 0), inputTokens: (f?.inputTokens ?? 0) + (p?.inputTokens ?? 0), outputTokens: (f?.outputTokens ?? 0) + (p?.outputTokens ?? 0) };
  }

  /** @param {string} tenant */
  function today(tenant) {
    const t = now();
    const c = current(tenant, utcDay(t));
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
            meterStream(s, params, (/** @type {any} */ add) => record(tenant, add));
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

  return {
    file, limits, record, today, over, wrap,
    /**
     * Write every count still held in memory. At exit (serve's stop, mcp's), pass EXIT_WAIT_MS: it
     * outwaits a busy lock, and a lock left by a crashed writer goes stale and is taken over.
     * @param {{ waitMs?: number }} [o] @returns {boolean} whether nothing is left pending
     */
    flush: ({ waitMs = lockWaitMs } = {}) => save(waitMs),
    /** Counts held in memory, not yet in the file (tests). */
    pendingCalls: () => Object.values(pending).flatMap((d) => Object.values(d)).reduce((n, c) => n + c.calls, 0),
  };
}
