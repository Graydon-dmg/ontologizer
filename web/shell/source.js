// @ts-check
// Where the shell's data comes from. The mode comes from the URL:
//   ?fixture=<name>[&speed=<n>]  replay /fixtures/<name>.events.jsonl locally
//   otherwise                    fold EventSource(api('/api/events?from=0')) and POST api('/api/action')
// api() puts the page's base path in front ("" on the one-map server; see base.js). params.base overrides it.
// Both modes start from emptyOntology() and fold every event. Never /api/snapshot (double counts).
// No DOM here: Node tests inject fetch, EventSource and timers.
import { emptyOntology, fold } from '../../src/core/events.js';
import { JOB_ACTIONS, isValidAction, viewPatchFor } from './actions.js';
import { api } from './base.js';

/** @typedef {import('../../src/core/schema.js').Ontology} Ontology */
/** @typedef {(event: any, ontology: Ontology) => void} Listener */

/**
 * @param {{ search?: string, speed?: number, fetch?: typeof fetch, EventSource?: any,
 *           setTimeout?: (fn: () => void, ms: number) => any, base?: string,
 *           jobDelayMs?: number, reconnectMs?: number, actMs?: number,
 *           checkAccess?: () => Promise<boolean> }} [params]
 * checkAccess (service mode only): after the stream drops, whether the page may still read the map.
 *   false means it is signed out (a 401): the status becomes 'signed-out' and it stops retrying.
 */
export function createSource(params = {}) {
  const search = params.search ?? (globalThis.location ? globalThis.location.search : '');
  const q = new URLSearchParams(search);
  const fixture = q.get('fixture');
  const speed = Number(params.speed ?? q.get('speed')) || 1;
  const fetchFn = params.fetch ?? globalThis.fetch;
  const ES = params.EventSource ?? /** @type {any} */ (globalThis).EventSource;
  const later = params.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const base = params.base ?? '';
  /** The map's own routes: params.base when given (tests), else the page's base. @param {string} p */
  const route = (p) => (params.base !== undefined ? `${params.base}${p}` : api(p));
  const jobDelayMs = params.jobDelayMs ?? 1000;
  const reconnectMs = params.reconnectMs ?? 1000;
  const actMs = params.actMs ?? 10000;

  /** @type {Ontology} */
  let ontology = emptyOntology();
  /** @type {Set<Listener>} */
  const listeners = new Set();
  let received = 0; // events folded from the source (server mode resumes from here)
  let lastAt = 0;

  /** @param {any} e */
  function push(e) {
    if (!e || typeof e !== 'object') return;
    ontology = fold(ontology, e);
    if (typeof e.at === 'number' && e.at > lastAt) lastAt = e.at;
    for (const fn of listeners) {
      try { fn(e, ontology); } catch (err) { console.error('shell listener failed', err); }
    }
  }

  /** @type {'connecting'|'live'|'lost'|'signed-out'} */
  let status = 'connecting';
  /** @type {Set<(s: string) => void>} */
  const statusListeners = new Set();
  /** @param {'connecting'|'live'|'lost'|'signed-out'} s */
  const setStatus = (s) => {
    if (s === status || status === 'signed-out') return; // signed out is final until the page reloads
    status = s;
    for (const fn of statusListeners) { try { fn(s); } catch (err) { console.error(err); } }
  };

  const common = {
    snapshot: () => ontology,
    /** 'connecting' | 'live' | 'lost' | 'signed-out' (server mode: the event stream's state) */
    status: () => status,
    /** @param {(s: string) => void} fn */
    onStatus(fn) { statusListeners.add(fn); return () => { statusListeners.delete(fn); }; },
    /** @param {Listener} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };

  if (fixture) {
    let jobSeq = 0;
    setStatus('live');
    const done = (async () => {
      const res = await fetchFn(`${base}/fixtures/${encodeURIComponent(fixture)}.events.jsonl`);
      if (!res.ok) throw new Error(`fixture ${fixture}: HTTP ${res.status}`);
      const events = parseJsonl(await res.text());
      await new Promise((resolve) => {
        let i = 0;
        let prev = 0;
        const step = () => {
          if (i >= events.length) return resolve(undefined);
          const e = events[i++];
          const at = typeof e.at === 'number' ? e.at : prev;
          const wait = Math.max(0, (at - prev) / speed);
          prev = at;
          later(() => { received++; push(e); step(); }, wait);
        };
        step();
      });
    })();
    return {
      mode: /** @type {'fixture'} */ ('fixture'),
      ...common,
      done,
      /** @param {any} action */
      async act(action) {
        if (!isValidAction(action)) return { ok: false, error: `unknown action ${action && action.type}` };
        if (JOB_ACTIONS.includes(action.type)) {
          const job = { id: `local-${++jobSeq}`, kind: action.type, nodeId: action.nodeId };
          push({ t: 'job.queued', at: lastAt, job });
          later(() => push({ t: 'job.done', at: lastAt, job }), jobDelayMs);
          return { ok: true, jobId: job.id };
        }
        const patch = viewPatchFor(action, ontology);
        if (patch) push({ t: 'view.changed', at: lastAt, patch });
        return { ok: true };
      },
    };
  }

  // Server mode.
  /** @type {any} */
  let es = null;
  let closed = false;
  const open = () => {
    es = new ES(route(`/api/events?from=${received}`));
    es.onopen = () => setStatus('live');
    es.onmessage = (/** @type {{ data: string }} */ m) => {
      setStatus('live');
      let e;
      try { e = JSON.parse(m.data); } catch { return; }
      received++;
      push(e);
    };
    // The browser would reconnect to the same URL and replay from 0 (double counting).
    // Close and resume from the number of events already folded instead.
    es.onerror = () => {
      setStatus('lost');
      if (es) es.close();
      if (closed) return;
      if (!params.checkAccess) { later(open, reconnectMs); return; }
      // Service mode: a stream that ended because the token was revoked or the session ended
      // would only fail again. Ask once; signed out stops the retries.
      Promise.resolve().then(params.checkAccess).then(
        (ok) => { if (ok === false) signOut(); else if (!closed) later(open, reconnectMs); },
        () => { if (!closed) later(open, reconnectMs); },
      );
    };
  };
  const signOut = () => {
    closed = true;
    if (es) es.close();
    setStatus('signed-out');
  };
  open();
  return {
    mode: /** @type {'server'} */ ('server'),
    ...common,
    done: Promise.resolve(),
    /** @param {any} action */
    async act(action) {
      // A request the server never answers (it stopped, or the connection hangs) fails after actMs.
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl ? later(() => ctl.abort(), actMs) : null;
      let res;
      try {
        res = await fetchFn(route('/api/action'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(action),
          signal: ctl ? ctl.signal : undefined,
        });
      } catch (err) {
        const aborted = ctl && ctl.signal.aborted;
        return { ok: false, error: aborted ? 'the server did not answer. Is ontologizer still running?'
          : 'cannot reach the server. Is ontologizer still running?' };
      } finally {
        if (timer && typeof clearTimeout === 'function') { try { clearTimeout(timer); } catch { /* fake timer */ } }
      }
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (res.status === 401 && params.checkAccess) signOut();
      if (!res.ok) return { ok: false, error: (body && body.error) || `HTTP ${res.status}` };
      return body || { ok: true };
    },
    /** Service mode: the page lost access (a 401 anywhere). Stops the stream and its retries. */
    signOut() { if (params.checkAccess) signOut(); },
    /** Drop the event stream and resume from the last folded event. */
    reconnect() { if (es) es.close(); open(); },
    close() { closed = true; if (es) es.close(); },
  };
}

/** @param {string} text */
export function parseJsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip a bad line */ }
  }
  return out;
}
