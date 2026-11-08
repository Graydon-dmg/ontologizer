// @ts-check
// Test helpers for Epic G: a fake Anthropic client, a fake store, a jsonLines stand-in, fixtures.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { foldAll, fold, emptyOntology } from '../../src/core/events.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** @param {string} name  e.g. 'manga' -> the fixture's events */
export function fixtureEvents(name) {
  return readFileSync(`${root}fixtures/${name}.events.jsonl`, 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/**
 * A fake client. `respond(params, callIndex)` returns the full text the "model" writes,
 * or { text, stop_reason }. The text is streamed in small chunks, split mid-line, with a
 * tiny delay between chunks so concurrent calls really overlap.
 * @param {(params: any, i: number) => string | { text: string, stop_reason?: string }} respond
 * @param {{ chunk?: number, delayMs?: number }} [opts]
 */
export function fakeClient(respond, { chunk = 7, delayMs = 1 } = {}) {
  const calls = /** @type {any[]} */ ([]);
  let inFlight = 0;
  const stats = { maxInFlight: 0 };
  const client = {
    calls,
    stats,
    messages: {
      /** @param {any} params */
      stream(params) {
        const i = calls.length;
        calls.push(params);
        const out = respond(params, i);
        const { text, stop_reason = 'end_turn' } = typeof out === 'string' ? { text: out } : out;
        inFlight++;
        stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
        let finished = false;
        const finish = () => { if (!finished) { finished = true; inFlight--; } };
        /** @type {Promise<any>} */
        let done;
        let resolveDone = /** @type {(v: any) => void} */ (() => {});
        done = new Promise((r) => { resolveDone = r; });
        const final = { role: 'assistant', stop_reason, content: [{ type: 'text', text }] };
        async function* events() {
          for (let k = 0; k < text.length; k += chunk) {
            await new Promise((r) => setTimeout(r, delayMs));
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(k, k + chunk) } };
          }
          finish();
          resolveDone(final);
        }
        const it = events();
        return {
          [Symbol.asyncIterator]() { return it; },
          async finalMessage() {
            // Drain anything not yet consumed, as the SDK does.
            if (!finished) { for await (const _ of it) { /* drain */ } }
            return done;
          },
        };
      },
    },
  };
  return client;
}

/**
 * An in-memory store with Epic B's shape (createDraft, append, read, events).
 * @param {Record<string, object[]>} [seed]  id -> events
 */
export function fakeStore(seed = {}) {
  /** @type {Map<string, object[]>} */
  const logs = new Map(Object.entries(seed).map(([k, v]) => [k, [...v]]));
  /** @type {Map<string, object>} */
  const briefs = new Map();
  let n = 0;
  return {
    logs,
    briefs,
    /** @param {object} brief @param {string} [suggestedName] */
    createDraft(brief, suggestedName) {
      const id = `draft-test-${++n}`;
      logs.set(id, []);
      briefs.set(id, { brief, suggestedName });
      return id;
    },
    /** @param {string} id @param {object} event */
    append(id, event) {
      if (!logs.has(id)) throw new Error(`fake store: no ontology ${id}`);
      /** @type {object[]} */ (logs.get(id)).push(event);
    },
    /** @param {string} id */
    read(id) {
      if (!logs.has(id)) throw new Error(`fake store: no ontology ${id}`);
      return foldAll(/** @type {object[]} */ (logs.get(id)));
    },
    /** @param {string} id */
    async *events(id) { for (const e of logs.get(id) ?? []) yield e; },
  };
}

/** A small jsonLines stand-in (Epic C owns the real one; ctx passes it in). */
export async function* jsonLines(/** @type {AsyncIterable<string>} */ chunks) {
  let buf = '';
  const parse = (/** @type {string} */ line) => {
    const t = line.trim();
    if (!t.startsWith('{')) return null;
    try { const o = JSON.parse(t); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
  };
  for await (const c of chunks) {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const o = parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (o) yield o;
    }
  }
  const o = parse(buf);
  if (o) yield o;
}

/** @param {{ store: any, client: any }} p */
export function makeCtx({ store, client }) {
  return {
    store,
    models: { fast: 'fake-fast', strong: 'fake-strong' },
    getClient: () => client,
    jsonLines,
  };
}

export { foldAll, fold, emptyOntology };
