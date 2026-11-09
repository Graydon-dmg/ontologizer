// @ts-check
// One streamed model call: text deltas -> jsonLines -> onObject(obj) as each line closes.
// Handles stop reasons (refusal, pause_turn, max_tokens) and collects web search sources.
// With source tools (a run's `tools`), a tool_use stop runs the tools and the call goes on: lines
// keep streaming to onObject across the turns.
import { jsonLines } from './jsonl.js';

export const KEY_REJECTED = 'Your Anthropic API key was rejected: run ontologizer key set';

/** Thrown when the model refuses. job.failed carries its short message. */
export class RefusalError extends Error {
  /** @param {string} [category] */
  constructor(category) {
    super(category ? `The model declined this request (${category}).` : 'The model declined this request.');
    this.name = 'RefusalError';
  }
}

/** An SDK AuthenticationError (401), or anything shaped like one (the fake client throws { status: 401 }). */
/** @param {any} e */
export function isAuthError(e) {
  return !!e && (e.status === 401 || e.name === 'AuthenticationError' || e.constructor?.name === 'AuthenticationError');
}

/** The message a failed job carries. @param {any} e */
export function jobErrorMessage(e) {
  if (isAuthError(e)) return KEY_REJECTED;
  return String(e?.message ?? e ?? 'unknown error').slice(0, 300);
}

export const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 3 };

/** Tool turns one call may take before it must answer. */
export const MAX_TOOL_TURNS = 6;

/**
 * @typedef {{ defs: { name: string, description: string, input_schema: any }[],
 *             call: (name: string, input: any) => Promise<{ text: string, isError: boolean }> }} CallTools
 * @typedef {{ model: string, effort: 'low'|'medium'|'high', system: string, prompt: string,
 *             webSearch?: boolean, maxTokens?: number, tools?: CallTools|null }} CallParams
 * @typedef {{ stopReason: string|null, sources: { title: string, url: string }[], objects: number }} CallResult
 */

/**
 * @param {() => any} getClient
 * @param {CallParams} p
 * @param {(obj: Record<string, any>) => void} onObject  called the moment each line closes
 * @returns {Promise<CallResult>}
 */
export async function runCall(getClient, p, onObject) {
  const client = getClient();
  /** @type {any[]} */
  const messages = [{ role: 'user', content: p.prompt }];
  /** @type {any} */
  const params = {
    model: p.model,
    max_tokens: p.maxTokens ?? 16000,
    system: p.system,
    output_config: { effort: p.effort },
  };
  // Haiku-class models accept disabled thinking at low effort: it gets the first line out fastest.
  if (/haiku/i.test(p.model)) params.thinking = { type: 'disabled' };
  const tools = p.tools && p.tools.defs.length ? p.tools : null;
  if (p.webSearch) params.tools = [WEB_SEARCH_TOOL];
  if (tools) params.tools = [...(params.tools ?? []), ...tools.defs];

  /** @type {Map<string, { title: string, url: string }>} */
  const sources = new Map();
  let objects = 0;
  let stopReason = null;

  let pauses = 0;                                 // at most two pause_turn resumes
  let toolTurns = 0;                              // at most MAX_TOOL_TURNS rounds of source tools
  for (;;) {
    // Out of tool turns: the model must answer with what it has.
    const stream = client.messages.stream({ ...params, ...(tools && toolTurns >= MAX_TOOL_TURNS ? { tool_choice: { type: 'none' } } : {}), messages });
    async function* text() {
      for await (const e of stream) {
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') yield e.delta.text;
        // Each new text block (e.g. after a web search) starts on its own line.
        else if (e.type === 'content_block_start' && e.content_block?.type === 'text') yield '\n';
      }
    }
    for await (const obj of jsonLines(text())) {
      objects++;
      onObject(obj);
    }
    const final = await stream.finalMessage();
    stopReason = final.stop_reason ?? null;
    collectSources(final.content, sources);

    if (stopReason === 'refusal') throw new RefusalError(final.stop_details?.category ?? undefined);
    if (stopReason === 'pause_turn' && pauses < 2) {
      pauses++;
      messages.push({ role: 'assistant', content: final.content });
      continue;
    }
    const uses = tools && stopReason === 'tool_use' ? (final.content ?? []).filter((/** @type {any} */ b) => b?.type === 'tool_use') : [];
    if (uses.length && toolTurns < MAX_TOOL_TURNS) {
      toolTurns++;
      messages.push({ role: 'assistant', content: final.content });
      /** @type {any[]} */
      const results = [];
      for (const u of uses) {
        const r = await /** @type {CallTools} */ (tools).call(u.name, u.input);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: r.text || '(no result)', ...(r.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    break;                                        // end_turn, max_tokens (keep what streamed), or out of resumes
  }
  return { stopReason, sources: [...sources.values()], objects };
}

/**
 * Read web_search_tool_result blocks. A success holds a list of results; an error holds one object
 * with error_code, which is skipped.
 * @param {any[]} content
 * @param {Map<string, { title: string, url: string }>} into
 */
export function collectSources(content, into) {
  for (const block of content ?? []) {
    if (block?.type !== 'web_search_tool_result') continue;
    if (!Array.isArray(block.content)) continue;  // { type: 'web_search_tool_result_error', error_code }
    for (const r of block.content) {
      if (r?.type === 'web_search_result' && typeof r.url === 'string' && !into.has(r.url)) {
        into.set(r.url, { title: String(r.title ?? r.url), url: r.url });
      }
    }
  }
}
