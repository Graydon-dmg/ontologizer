// @ts-check
// Test doubles for Epic C: a fake Anthropic client and an in-memory store.
import { fold, emptyOntology } from '../../src/core/events.js';

/**
 * @typedef {{
 *   text?: string,                 // what the model "writes"; streamed in small random chunks
 *   stop_reason?: string,          // default 'end_turn'; 'refusal' | 'pause_turn' | 'max_tokens'
 *   stop_details?: any,
 *   content?: any[],               // extra final content blocks, e.g. web_search_tool_result or tool_use
 *   delayMs?: number,              // wait before the first chunk
 *   error?: any,                   // thrown from the stream instead of answering (e.g. { status: 401 })
 * }} FakeAnswer
 */

/** Seeded PRNG, so chunking is random but repeatable. @param {number} a */
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake client with the one method the engine uses: messages.stream(params).
 * @param {{ respond: (params: any, callIndex: number) => FakeAnswer, chunkMs?: number, seed?: number }} opts
 */
export function createFakeClient({ respond, chunkMs = 2, seed = 1 }) {
  const rand = mulberry32(seed);
  /** @type {{ params: any, startedAt: number, finishedAt: number|null }[]} */
  const calls = [];

  function stream(/** @type {any} */ params) {
    const index = calls.length;
    const record = { params: structuredClone(params), startedAt: Date.now(), finishedAt: /** @type {number|null} */ (null) };
    calls.push(record);
    const answer = respond(params, index) ?? {};
    const text = answer.text ?? '';
    /** @type {any} */
    let final = null;
    /** @type {any} */
    let failure = null;

    async function* events() {
      try {
        if (answer.delayMs) await sleep(answer.delayMs);
        if (answer.error) throw answer.error;
        yield { type: 'message_start', message: { role: 'assistant', content: [] } };
        // Extra blocks (tool_use, server_tool_use, search results) announce themselves first.
        for (const b of answer.content ?? []) yield { type: 'content_block_start', index: 0, content_block: b };
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        let i = 0;
        while (i < text.length) {
          const n = 1 + Math.floor(rand() * 12);
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + n) } };
          i += n;
          if (chunkMs) await sleep(chunkMs);
        }
        yield { type: 'content_block_stop', index: 0 };
        const stop_reason = answer.stop_reason ?? 'end_turn';
        yield { type: 'message_delta', delta: { stop_reason } };
        yield { type: 'message_stop' };
        final = {
          role: 'assistant',
          content: [...(answer.content ?? []), { type: 'text', text }],
          stop_reason,
          stop_details: answer.stop_details ?? null,
        };
      } catch (e) {
        failure = e;
        throw e;
      } finally {
        record.finishedAt = Date.now();
      }
    }

    const it = events();
    let consumed = false;
    return {
      [Symbol.asyncIterator]() { consumed = true; return it; },
      async finalMessage() {
        if (!consumed) { consumed = true; for await (const _ of it); }   // drain if nobody iterated
        if (failure) throw failure;
        return final;
      },
    };
  }

  return { messages: { stream }, calls };
}

/** One JSON object per line. @param {object[]} objs */
export const lines = (objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';

/** A web_search_tool_result block holding the given results. @param {{ title: string, url: string }[]} results */
export function searchBlock(results) {
  return {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_fake',
    content: results.map((r) => ({ type: 'web_search_result', title: r.title, url: r.url, encrypted_content: 'x' })),
  };
}

/** An in-memory store with Epic B's append/read shape. Folds every event. */
export function createMemoryStore() {
  /** @type {Record<string, any[]>} */
  const log = {};
  /** @type {Record<string, any>} */
  const state = {};
  return {
    log,
    /** @param {string} id @param {any} event */
    append(id, event) {
      (log[id] ??= []).push({ ...event, _wall: Date.now() });
      state[id] = fold(state[id] ?? emptyOntology(), event);
    },
    /** @param {string} id */
    read(id) { return state[id] ?? emptyOntology(); },
    /** The raw events appended so far, each with _wall (wall-clock ms). @param {string} id */
    list(id) { return log[id] ?? []; },
  };
}
