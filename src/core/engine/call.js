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

/** What each web search error_code means, in plain words ("web search …"). */
const SEARCH_FAILURES = /** @type {Record<string, string>} */ ({
  max_uses_exceeded: `ran out: one call may search ${WEB_SEARCH_TOOL.max_uses} times`,
  too_many_requests: 'was rate-limited (too many requests)',
  unavailable: 'was unavailable',
  query_too_long: 'failed: a query was too long',
  invalid_input: 'failed: a query was not valid',
});

/** "web search ran out: …" for an error_code. @param {string} code */
export function searchFailureText(code) {
  return `web search ${SEARCH_FAILURES[code] ?? `failed (${code})`}`;
}

/**
 * The error_code of the last failed web search in a response's content, or null. A failed search
 * is a web_search_tool_result whose content is { type: 'web_search_tool_result_error', error_code }
 * (max_uses_exceeded, too_many_requests, unavailable, query_too_long, invalid_input).
 * @param {any[]} content @returns {string|null}
 */
export function searchFailure(content) {
  let code = null;
  for (const b of content ?? []) {
    const c = b?.type === 'web_search_tool_result' ? b.content : null;
    if (c && !Array.isArray(c) && c.type === 'web_search_tool_result_error') code = typeof c.error_code === 'string' && c.error_code ? c.error_code : 'unavailable';
  }
  return code;
}

/** Tool turns one call may take before it must answer. */
export const MAX_TOOL_TURNS = 6;

/**
 * @typedef {{ defs: { name: string, description: string, input_schema: any }[],
 *             call: (name: string, input: any) => Promise<{ text: string, isError: boolean }> }} CallTools
 * @typedef {{ model: string, effort: 'low'|'medium'|'high', system: string, prompt: string,
 *             webSearch?: boolean, maxTokens?: number, tools?: CallTools|null, restricted?: () => boolean }} CallParams
 *   restricted: whether the map is private now. Checked before every turn: a private map's run gets
 *   no web search (and its tools' defs are already only private sources), so private text cannot
 *   leave through another tool. Absent or false: exactly as before.
 * @typedef {{ stopReason: string|null, sources: { title: string, url: string }[], objects: number, searchFailed: string|null }} CallResult
 *   searchFailed: the error_code of the last web search that failed in this call, or null
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
  const tools = p.tools ?? null;
  /** The tools for the next turn: recomputed each turn, since a private source can make the map private mid-run. */
  const toolsNow = () => {
    const priv = p.restricted ? p.restricted() : false;
    const list = [...(p.webSearch && !priv ? [WEB_SEARCH_TOOL] : []), ...(tools ? tools.defs : [])];
    return list.length ? list : null;
  };

  /** @type {Map<string, { title: string, url: string }>} */
  const sources = new Map();
  let objects = 0;
  let stopReason = null;
  /** @type {string|null} */ let searchFailed = null;

  let pauses = 0;                                 // at most two pause_turn resumes
  let toolTurns = 0;                              // at most MAX_TOOL_TURNS rounds of source tools
  for (;;) {
    // Out of tool turns: the model must answer with what it has.
    const list = toolsNow();
    const offered = new Set((list ?? []).map((/** @type {any} */ d) => d.name));
    const stream = client.messages.stream({
      ...params, ...(list ? { tools: list } : {}),
      ...(list && tools && toolsHave(tools, offered) && toolTurns >= MAX_TOOL_TURNS ? { tool_choice: { type: 'none' } } : {}),
      messages,
    });
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
    searchFailed = searchFailure(final.content) ?? searchFailed;

    if (stopReason === 'refusal') throw new RefusalError(final.stop_details?.category ?? undefined);
    if (stopReason === 'pause_turn' && pauses < 2) {
      pauses++;
      messages.push({ role: 'assistant', content: final.content });
      continue;
    }
    const uses = tools && stopReason === 'tool_use' ? (final.content ?? []).filter((/** @type {any} */ b) => b?.type === 'tool_use') : [];
    // A name that was not offered on this turn (a public source after the map went private) is refused here too.
    if (uses.length && toolTurns < MAX_TOOL_TURNS) {
      toolTurns++;
      messages.push({ role: 'assistant', content: final.content });
      /** @type {any[]} */
      const results = [];
      for (const u of uses) {
        const r = offered.has(u.name) ? await /** @type {CallTools} */ (tools).call(u.name, u.input)
          : { text: 'That tool is not offered.', isError: true };
        results.push({ type: 'tool_result', tool_use_id: u.id, content: r.text || '(no result)', ...(r.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    break;                                        // end_turn, max_tokens (keep what streamed), or out of resumes
  }
  return { stopReason, sources: [...sources.values()], objects, searchFailed };
}

/** Whether any of the run's source tools is on offer this turn. @param {CallTools} tools @param {Set<string>} offered */
function toolsHave(tools, offered) {
  return tools.defs.some((d) => offered.has(d.name));
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
