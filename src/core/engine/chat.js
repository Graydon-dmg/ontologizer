// @ts-check
// The chat side panel's brain: engine.ask() answers questions about the whole map.
// Map first (search_map / get_node over the store, read-only), the web for what the map lacks,
// every map claim cited as [[node-id]] and every web fact linked. Writes only chat.* events.
import { WEB_SEARCH_TOOL, RefusalError, jobErrorMessage, searchFailure, searchFailureText } from './call.js';
import { labelPath, findByLabelPath } from './ids.js';
import { chatSystem, outlineBlock } from './prompts-chat.js';
import { UNTRUSTED } from './run.js';
import { oneLine } from '../export/context.js';

const MAX_TURNS = 6;           // model calls per question, tool turns included
const HISTORY_EXCHANGES = 10;  // earlier question/answer pairs sent with each question
const MAX_SUGGESTIONS = 3;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const STOPPED = 'Stopped.';

const SOURCES_NOTE = `

The reader's own sources can also be searched, with the tools named <source>__<tool>. Use them for what the map does not cover. When you use a document from a source that has a url, link it the way you link web pages.
${UNTRUSTED}`;

/**
 * @typedef {{ type: 'delta', text: string } | { type: 'citation', nodeId: string, label: string }
 *   | { type: 'source', title: string, url: string }
 *   | { type: 'suggestion', kind: 'research', nodeId: string, mode: 'context'|'general', label: string }
 *   | { type: 'status', text: string } | { type: 'done', msgId: string } | { type: 'error', error: string }
 *   | { type: 'websearch', used: boolean, failed?: string, note?: string }} ChatItem
 * websearch comes once, just before done: whether the answer searched the web, the error_code of a
 * search that failed or ran out, and a plain note naming the next step (the page ignores it).
 * @typedef {{ mime: string, data: string, hash?: string, w?: number, h?: number }} ChatImage
 */

export const TOOLS = [
  {
    name: 'search_map',
    description: 'Search the reader\'s map. Returns up to 8 nodes ranked by relevance to the query, each with its id, label path and a snippet. Use short keyword queries; search again with other words if the first try misses.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Keywords to look for' } }, required: ['query'] },
  },
  {
    name: 'get_node',
    description: 'Read one node of the map in full: its article (summary, key facts, why it matters), sources, parent, children, cross-linked neighbours and, for a node with children, the cross-links of the nodes under it (branchLinks).',
    input_schema: { type: 'object', properties: { id: { type: 'string', description: 'The node id, exactly as shown in the outline or a search result' } }, required: ['id'] },
  },
];

// ---------------------------------------------------------------------------------------------
// The engine entry point

/**
 * @param {{ store: any, id: string, models: { strong: string }, getClient: () => any,
 *           emit: (t: string, fields: object) => void, run?: any }} cctx
 *   run: the run's source tools (service mode with configured sources); offered beside the map
 *   tools and web search. They only read, like the map tools.
 * @param {{ chatId?: string, text?: string, images?: ChatImage[], lens?: string|null }} input
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {AsyncIterable<ChatItem>}
 */
export function ask(cctx, input, { signal } = {}) {
  const out = channel();
  const chatId = String(input?.chatId ?? 'main');
  const text = String(input?.text ?? '').trim();
  const images = (Array.isArray(input?.images) ? input.images : [])
    .filter((im) => im && IMAGE_TYPES.has(im.mime) && typeof im.data === 'string' && im.data.length > 0);
  const lens = typeof input?.lens === 'string' && input.lens ? input.lens : null;

  if (!text && !images.length) {
    out.push({ type: 'error', error: 'Ask a question first.' });
    out.end();
    return out.iterable;
  }

  const stamp = `${chatId}-${Date.now().toString(36)}-${++counter}`;
  const msgId = `${stamp}-q`;                               // the question; the answer is `${stamp}-a`
  // Image references only: the picture itself never goes into the event log.
  const refs = images.map((im) => ({ hash: String(im.hash ?? ''), mime: im.mime, w: Number(im.w) || 0, h: Number(im.h) || 0 }));
  cctx.emit('chat.asked', { chatId, msgId, text, images: refs });

  run(cctx, { chatId, msgId, answerId: `${stamp}-a`, text, images, lens, signal }, out).finally(() => out.end());
  return out.iterable;
}
let counter = 0;

/**
 * Runs the whole answer, eagerly: it finishes and is saved even if nobody reads the items.
 * @param {any} cctx @param {any} q @param {ReturnType<typeof channel>} out
 */
async function run(cctx, q, out) {
  const { store, id, models, getClient, emit } = cctx;
  /** Source tools for this ask (offered only when the run has any). */
  const srcTools = cctx.run?.hasTools ? cctx.run.tools : null;
  const srcNames = new Set((srcTools?.defs ?? []).map((/** @type {any} */ d) => d.name));
  const { chatId, msgId, answerId, text, images, lens, signal } = q;
  const answer = { text: '', usedWeb: false, /** @type {string|null} */ searchFailed: null };
  /** @type {Map<string, { nodeId: string, label: string }>} */ const citations = new Map();
  /** @type {Map<string, { title: string, url: string }>} */ const sources = new Map();
  /** @type {Map<string, { kind: 'research', nodeId: string, mode: 'context'|'general', label: string }>} */
  const suggestions = new Map();
  /** @type {Map<string, string>} */ const searchTitles = new Map();   // url -> title, from search results
  /** Every url a tool result gave this run (a source ref, a web result). @type {Set<string>} */
  const toolUrls = new Set();
  let priv = false;                                       // visibility only rises: cache the yes
  const isPrivate = () => priv || (priv = store.read(id)?.visibility === 'private');
  // On a private map a link may only point where a tool result pointed: a hidden instruction in a
  // private document cannot have the answer link (and leak) private text to a url of its choosing.
  const links = createLinkFilter((url) => toolUrls.has(url));

  /** @param {ChatItem} item */
  const send = (item) => out.push(item);
  const nodes = () => store.read(id).nodes ?? {};

  const filter = createTokenFilter((inner) => {
    const s = inner.trim();
    const sug = /^suggest:(.*)$/i.exec(s);
    if (sug) {
      const [nodeId = '', mode = '', ...rest] = sug[1].split('|').map((x) => x.trim());
      const label = rest.join(' ').trim();
      if (nodes()[nodeId] && (mode === 'context' || mode === 'general') && label
          && suggestions.size < MAX_SUGGESTIONS && !suggestions.has(`${nodeId}|${mode}`)) {
        const item = { kind: /** @type {const} */ ('research'), nodeId, mode, label: label.slice(0, 80) };
        suggestions.set(`${nodeId}|${mode}`, item);
        send({ type: 'suggestion', ...item });
      }
      return '';
    }
    const node = nodes()[s];
    if (!node) return '';                                  // an id that is not in the map: drop it
    if (!citations.has(s)) {
      citations.set(s, { nodeId: s, label: node.label });
      send({ type: 'citation', nodeId: s, label: node.label });
    }
    return `[[${s}]]`;
  });

  /** @param {string} t @param {boolean} [filtered] */
  const emitText = (t, filtered = false) => {
    // Visibility only rises: once private, every later piece of text goes through the link filter.
    if (!filtered && isPrivate()) t = links.push(t, answer.text);
    if (!t) return;
    answer.text += t;
    send({ type: 'delta', text: t });
    for (const link of linksIn(answer.text)) addSource(link.url, link.title);
  };
  /** @param {string} url @param {string} [title] */
  const addSource = (url, title) => {
    if (!/^https?:\/\//i.test(url) || sources.has(url)) return;
    if (isPrivate() && !toolUrls.has(url)) return;       // a private map's sources come from tools only
    const s = { title: String(searchTitles.get(url) ?? title ?? url).slice(0, 200), url };
    sources.set(url, s);
    send({ type: 'source', title: s.title, url });
  };

  try {
    const o = store.read(id);
    const index = buildIndex(o, lens);
    const system = [
      { type: 'text', text: chatSystem(o.brief, lensInfo(o, lens)) + (srcTools ? SOURCES_NOTE : '') },
      { type: 'text', text: outlineBlock(outline(o, lens)), cache_control: { type: 'ephemeral' } },
    ];
    /** @type {any[]} */
    const messages = [...historyMessages(o, chatId, msgId), {
      role: 'user',
      content: [
        ...images.map((/** @type {ChatImage} */ im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })),
        { type: 'text', text: text || 'What is in this image, and how does it relate to my map?' },
      ],
    }];

    const client = getClient();
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (signal?.aborted) throw abortError();
      const last = turn === MAX_TURNS - 1;
      /** @type {any} */
      const params = {
        model: models.strong, max_tokens: 8000, system, messages,
        output_config: { effort: 'medium' },
        // A private map's answer never reaches the web or a public source: only the map's own tools
        // and the private sources this ask may use (checked each turn: a source can raise it mid-answer).
        tools: [...TOOLS, ...(store.read(id).visibility === 'private' ? [] : [WEB_SEARCH_TOOL]), ...(srcTools ? srcTools.defs : [])],
      };
      if (last) params.tool_choice = { type: 'none' };      // out of turns: answer with what it has
      const stream = client.messages.stream(params, signal ? { signal } : undefined);

      let turnText = false;
      /** @type {Set<string>} */ const said = new Set();
      for await (const e of stream) {
        if (signal?.aborted) throw abortError();
        if (e.type === 'content_block_start') {
          const b = e.content_block ?? {};
          if (b.type === 'tool_use' && srcNames.has(b.name)) {
            if (!said.has('src')) { said.add('src'); send({ type: 'status', text: 'Searching your sources…' }); }
          } else if (b.type === 'tool_use' && !said.has('map')) { said.add('map'); send({ type: 'status', text: 'Searching your map…' }); }
          if (b.type === 'server_tool_use' && b.name === 'web_search') {
            answer.usedWeb = true;
            if (!said.has('web')) { said.add('web'); send({ type: 'status', text: 'Searching the web…' }); }
          }
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          // A new turn after tool calls starts a new paragraph.
          if (!turnText && turn > 0 && answer.text && !/\s$/.test(answer.text)) emitText(filter.push('\n\n'));
          turnText = true;
          emitText(filter.push(e.delta.text));
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') throw new RefusalError(final.stop_details?.category ?? undefined);
      for (const b of final.content ?? []) {
        if (b?.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (typeof r?.url === 'string') toolUrls.add(r.url);
      }
      readSearchBlocks(final.content, searchTitles, addSource);
      answer.searchFailed = searchFailure(final.content) ?? answer.searchFailed;

      if (final.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: final.content });
        continue;
      }
      const uses = (final.content ?? []).filter((/** @type {any} */ b) => b.type === 'tool_use');
      if (final.stop_reason !== 'tool_use' || !uses.length || last) break;
      messages.push({ role: 'assistant', content: final.content });
      /** @type {any[]} */
      const results = [];
      for (const u of uses) {
        if (srcNames.has(u.name) && params.tools.some((/** @type {any} */ d) => d.name === u.name)) {
          // A source tool (read-only). A private source's first answer raises the map first.
          const r = await /** @type {any} */ (srcTools).call(u.name, u.input);
          for (const ref of r.refs ?? []) {
            if (typeof ref?.url === 'string' && ref.url) toolUrls.add(ref.url);
            if (ref.url && ref.title) searchTitles.set(ref.url, String(ref.title));
          }
          results.push({ type: 'tool_result', tool_use_id: u.id, content: r.text || '(no result)', ...(r.isError ? { is_error: true } : {}) });
          continue;
        }
        const r = runTool(u.name, u.input, store.read(id), index, lens);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(r.result), ...(r.error ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
    emitText(filter.flush());
    if (isPrivate()) emitText(links.flush(), true);

    const finalText = answer.text.trim();
    emit('chat.answered', {
      chatId, msgId: answerId, replyTo: msgId, text: finalText,
      citations: [...citations.values()], sources: [...sources.values()],
      suggestions: [...suggestions.values()], usedWeb: answer.usedWeb,
    });
    send(webSearchItem(answer, [...citations.keys()], index, text, store.read(id).nodes ?? {}));
    send({ type: 'done', msgId: answerId });
  } catch (err) {
    const error = signal?.aborted ? STOPPED : jobErrorMessage(err);
    emit('chat.failed', { chatId, replyTo: msgId, error });
    send({ type: 'error', error });
  }
}

/**
 * The websearch item: on a failed search, which failure in plain words and the next step for the
 * node the question is about (the first node the answer cites, else the best match for the question).
 * @param {{ usedWeb: boolean, searchFailed: string|null }} answer @param {string[]} cited
 * @param {ReturnType<typeof buildIndex>} index @param {string} question @param {Record<string, any>} nodes
 * @returns {ChatItem}
 */
export function webSearchItem(answer, cited, index, question, nodes) {
  const used = answer.usedWeb || answer.searchFailed !== null;
  if (!answer.searchFailed) return { type: 'websearch', used };
  const nodeId = cited.find((c) => nodes[c]) ?? (question ? index.search(question, 1)[0]?.id : undefined);
  const what = searchFailureText(answer.searchFailed);
  const next = nodeId
    // The label is map text (from the model and the web) going into ask_map's answer: one clean line.
    ? `To find and keep web sources for "${oneLine(nodes[nodeId]?.label ?? nodeId, 200)}", run sources on ${nodeId} (or explain); both call the model.`
    : 'To find and keep web sources, run sources (or explain) on the node your question is about; both call the model.';
  return { type: 'websearch', used, failed: answer.searchFailed, note: `The ${what}, so this answer may lack web sources. ${next}` };
}

function abortError() {
  const e = new Error(STOPPED);
  e.name = 'AbortError';
  return e;
}

// ---------------------------------------------------------------------------------------------
// [[...]] tokens in the streamed text

/**
 * A streaming filter for [[...]] tokens. Text outside tokens passes through as soon as it is safe;
 * a token is held back until it closes, then replaced by resolve(inner) ('' drops it). An
 * unclosed token longer than 300 characters, or broken by a newline, passes through as written.
 * @param {(inner: string) => string} resolve
 */
export function createTokenFilter(resolve) {
  let buf = '';
  /** @param {boolean} final */
  function drain(final) {
    let out = '';
    for (;;) {
      const i = buf.indexOf('[');
      if (i < 0) { out += buf; buf = ''; break; }
      out += buf.slice(0, i);
      buf = buf.slice(i);
      if (buf.length < 2) { if (final) { out += buf; buf = ''; } break; }
      if (buf[1] !== '[') { out += '['; buf = buf.slice(1); continue; }
      const close = buf.indexOf(']]', 2);
      const nl = buf.indexOf('\n');
      if (close >= 0 && (nl < 0 || nl > close)) {
        out += resolve(buf.slice(2, close));
        buf = buf.slice(close + 2);
        continue;
      }
      if (final || (nl >= 0) || buf.length > 300) { out += '['; buf = buf.slice(1); continue; }
      break;                                               // wait for more text
    }
    return out;
  }
  return {
    /** @param {string} chunk */
    push(chunk) { buf += chunk; return drain(false); },
    flush() { return drain(true); },
  };
}

// ---------------------------------------------------------------------------------------------
// Links and web sources

/**
 * A streaming filter that unlinks markdown links whose target is not kept: `[x](url)` becomes `[x]`
 * (plain text in the chat renderer). It looks only at the `](target)` part, which never spans a
 * line, so a link text that starts on an earlier line is caught too. After a removal the scan goes on
 * from the `]`, so `[x](a)(b)` cannot reassemble into a link to b. Bare urls are left as text (the
 * renderer never makes them clickable). The tail that might still become `](target)` is held back.
 * @param {(url: string) => boolean} keep
 */
export function createLinkFilter(keep) {
  let buf = '';
  let cut = false;   // the last text out was the "]" of an unlinked link: a "(" next must not glue on
  let started = false;
  /** @param {boolean} final */
  function drain(final) {
    let out = '';
    for (;;) {
      if (cut && buf) { if (buf[0] === '(') out += ' '; cut = false; }
      const i = buf.indexOf(']');
      if (i < 0) { out += buf; buf = ''; break; }
      out += buf.slice(0, i);
      buf = buf.slice(i);
      if (buf.length < 2 && !final) break;                 // "]" alone: a "(" may follow
      if (buf[1] !== '(') { out += ']'; buf = buf.slice(1); continue; }
      const m = /** @type {RegExpExecArray} */ (/^\]\(([^)\s]*)(\))?/.exec(buf));
      if (!m[2]) {
        if (m[0].length === buf.length && !final) break;   // the target may still grow: wait
        out += ']'; buf = buf.slice(1); continue;          // ended by a space or newline: not a link
      }
      out += ']';
      buf = buf.slice(m[0].length);
      if (keep(m[1])) out += m[0].slice(1); else cut = true;
    }
    return out;
  }
  return {
    /**
     * @param {string} chunk
     * @param {string} [before] the text already out before the filter's first chunk (a "]" there counts)
     */
    push(chunk, before = '') {
      if (!started) { started = true; if (before.endsWith(']')) cut = true; }
      buf += chunk;
      return drain(false);
    },
    flush() { return drain(true); },
  };
}

/** Markdown links and bare URLs in text. @param {string} text */
export function linksIn(text) {
  /** @type {{ title?: string, url: string }[]} */ const out = [];
  for (const m of text.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g)) out.push({ title: m[1], url: m[2] });
  for (const m of text.matchAll(/(?<!\]\()(?<![\w/])(https?:\/\/[^\s)<>\]]+[^\s)<>\].,;:!?'"])/g)) out.push({ url: m[1] });
  return out;
}

/**
 * Titles from web_search results (for nicer source items), and URLs the model cited through the
 * API's own citation fields.
 * @param {any[]} content @param {Map<string, string>} titles @param {(url: string, title?: string) => void} addSource
 */
function readSearchBlocks(content, titles, addSource) {
  for (const b of content ?? []) {
    if (b?.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r?.url && r.title) titles.set(r.url, String(r.title));
    }
    if (b?.type === 'text' && Array.isArray(b.citations)) {
      for (const c of b.citations) if (typeof c?.url === 'string') addSource(c.url, c.title);
    }
  }
}

/**
 * The answer's format rules, checked after the fact (tests use it as the oracle):
 * - under a "From the web" heading, every line that states a number carries a link;
 * - anywhere, a line with a percentage carries a link or a [[node-id]] citation (no bare statistics);
 * - no [[...]] token names a node that is not in the map.
 * Lines of plain commentary (no numbers) need no link.
 * @param {string} text @param {{ nodes?: Record<string, any> }} [opts]
 * @returns {string[]} problems, empty when the answer is well formed
 */
export function checkAnswer(text, { nodes } = {}) {
  /** @type {string[]} */ const problems = [];
  const LINK = /\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\//;
  let section = '';
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^(#{1,6}\s+|\*\*)(.*?)(\*\*)?:?$/.exec(line);
    if (heading && /from (your|the) (map|web)/i.test(heading[2])) {
      section = /web/i.test(heading[2]) ? 'web' : 'map';
      continue;
    }
    const linked = LINK.test(line);
    const plain = line.replace(/\[\[[^\]]*\]\]/g, '').replace(/\]\(https?:[^)]*\)/g, ']');
    if (section === 'web' && !linked && /\d/.test(plain)) problems.push(`web fact without a link: ${line.slice(0, 120)}`);
    else if (!linked && !/\[\[[^\]]+\]\]/.test(line) && /\d\s*%/.test(plain)) problems.push(`statistic without a source: ${line.slice(0, 120)}`);
  }
  if (nodes) {
    for (const m of String(text).matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      if (!/^suggest:/i.test(m[1]) && !nodes[m[1].trim()]) problems.push(`cites a node that is not in the map: ${m[1]}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// History

/**
 * Earlier answered exchanges in this chat (ontology.chat, folded from chat.* events), oldest
 * first, as alternating user / assistant messages. Failed and unanswered questions are left out.
 * @param {any} o @param {string} chatId @param {string} currentMsgId
 */
export function historyMessages(o, chatId, currentMsgId) {
  const chat = (Array.isArray(o?.chat) ? o.chat : []).filter((m) => m && (m.chatId ?? 'main') === chatId);
  const answers = new Map(chat.filter((m) => m.role === 'assistant' && m.replyTo).map((m) => [m.replyTo, m]));
  const pairs = chat
    .filter((m) => m.role === 'user' && m.msgId !== currentMsgId && answers.has(m.msgId))
    .map((m) => ({ q: String(m.text ?? ''), a: String(answers.get(m.msgId).text ?? ''), images: m.images?.length ?? 0 }));
  return pairs.slice(-HISTORY_EXCHANGES).flatMap((p) => [
    { role: 'user', content: p.images ? `${p.q}\n\n[${p.images} image(s) were attached to this message.]` : (p.q || '(an image)') },
    { role: 'assistant', content: p.a || '(no answer)' },
  ]);
}

// ---------------------------------------------------------------------------------------------
// The outline, the lens, and the two map tools

/** @param {any} o @param {string|null} lens */
function lensInfo(o, lens) {
  const l = lens ? o.lenses?.[lens] : null;
  return l ? { persona: String(l.persona ?? lens) } : null;
}

/** Children of each node in insertion order. @param {Record<string, any>} nodes */
function childrenOf(nodes) {
  /** @type {Map<string, any[]>} */ const kids = new Map();
  for (const n of Object.values(nodes)) {
    if (!n.parent) continue;
    kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  }
  return kids;
}

/**
 * The compact outline: one line per node, indented by depth: "- Label (id): summary  ≈ analog [explained]"
 * ("[explained]" when the node has an article). Big maps drop summaries below depth 2 to keep the prompt small.
 * @param {any} o @param {string|null} lens
 */
export function outline(o, lens = null) {
  const nodes = o.nodes ?? {};
  const kids = childrenOf(nodes);
  const analogs = (lens && o.lenses?.[lens]?.analogs) || {};
  const big = Object.keys(nodes).length > 400;
  /** @type {string[]} */ const lines = [];
  const seen = new Set();
  /** @param {any} n @param {number} d */
  const walk = (n, d) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    const summary = n.summary && !(big && d > 2) ? `: ${clip(n.summary, 110)}` : '';
    const analog = analogs[n.id]?.label ? `  ≈ ${clip(analogs[n.id].label, 60)}` : '';
    lines.push(`${'  '.repeat(d)}- ${flat(n.label)} (${safeId(n.id)})${summary}${analog}${n.article ? ' [explained]' : ''}`);
    for (const c of kids.get(n.id) ?? []) walk(c, d + 1);
  };
  if (nodes[o.root]) walk(nodes[o.root], 0);
  for (const n of Object.values(nodes)) if (!seen.has(n.id)) walk(n, Math.max(0, n.depth ?? 0));   // orphans
  return lines.join('\n');
}

/** One line: a value from an imported map can never start a line of its own (a heading, a quote). @param {unknown} s */
const flat = (s) => String(s ?? '').replace(/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
/** A node id as the outline shows it: as is when it is a plain slug path, else on one line. @param {unknown} id */
const safeId = (id) => (/^[A-Za-z0-9][\w.:/-]{0,299}$/.test(String(id)) ? String(id) : flat(id));

const STOP = new Set('a an and are as at be by for from has have how in is it its of on or that the this to was what when where which who why with your you my me i'.split(' '));

/** @param {string} s */
function tokens(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/** @param {string} s @param {number} n */
function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Sentences a snippet can come from. @param {any} n @param {any} analog */
function passages(n, analog) {
  const a = n.article ?? {};
  return [n.summary, n.hook, ...(String(a.summary ?? '').split(/(?<=[.!?])\s+/)), ...(a.keyFacts ?? []), a.whyItMatters,
    analog?.label ? `Analog: ${analog.label}` : '']
    .filter((x) => typeof x === 'string' && x.trim());
}

/**
 * BM25 over each node's label (x3), label path, summary, hook, article and source titles.
 * @param {any} o @param {string|null} lens
 */
export function buildIndex(o, lens = null) {
  const nodes = o.nodes ?? {};
  const analogs = (lens && o.lenses?.[lens]?.analogs) || {};
  const docs = Object.values(nodes).map((n) => {
    const path = labelPath(nodes, n.id);
    const a = n.article ?? {};
    const text = [n.label, n.label, n.label, path.join(' '), n.summary, n.hook, a.summary,
      ...(a.keyFacts ?? []), a.whyItMatters, ...(a.seeAlso ?? []),
      ...[...(n.sources ?? []), ...(a.sources ?? [])].map((s) => s?.title), analogs[n.id]?.label].join(' ');
    /** @type {Map<string, number>} */ const tf = new Map();
    const toks = tokens(text);
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { n, path, tf, len: toks.length };
  });
  /** @type {Map<string, number>} */ const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
  return {
    /** @param {string} query @param {number} [k] */
    search(query, k = 8) {
      const q = [...new Set(tokens(query))];
      if (!q.length) return [];
      const N = docs.length;
      return docs.map((d) => {
        let score = 0;
        for (const t of q) {
          const f = d.tf.get(t);
          if (!f) continue;
          const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
          score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / avg));
        }
        return { d, score };
      }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k).map(({ d }) => {
        const best = passages(d.n, analogs[d.n.id])
          .map((p) => ({ p, hits: tokens(p).filter((t) => q.includes(t)).length }))
          .sort((a, b) => b.hits - a.hits)[0];
        return { id: d.n.id, label: d.n.label, path: d.path.join(' > '), snippet: clip(best?.p ?? d.n.summary ?? '', 220) };
      });
    },
  };
}

const BRANCH_LINKS_MAX = 20;

/** Every node under id (not id itself), following parent links; safe on a parent cycle. @param {Record<string, any>} nodes @param {string} id */
function descendantsOf(nodes, id) {
  const kids = childrenOf(nodes);
  /** @type {Set<string>} */ const out = new Set();
  const todo = [...(kids.get(id) ?? [])];
  while (todo.length) {
    const c = /** @type {any} */ (todo.pop());
    if (c.id === id || out.has(c.id)) continue;
    out.add(c.id);
    todo.push(...(kids.get(c.id) ?? []));
  }
  return out;
}

/**
 * Run one map tool. Read-only: takes a snapshot, returns plain data.
 * @param {string} name @param {any} input @param {any} o @param {ReturnType<typeof buildIndex>} index @param {string|null} lens
 * @returns {{ result: any, error?: boolean }}
 */
export function runTool(name, input, o, index, lens) {
  const nodes = o.nodes ?? {};
  if (name === 'search_map') {
    const results = index.search(String(input?.query ?? ''));
    return { result: results.length ? { results } : { results, note: 'No node matches. Try other words, or use web_search.' } };
  }
  if (name === 'get_node') {
    const want = String(input?.id ?? '').trim();
    const nid = nodes[want] ? want : findByLabelPath(nodes, want);
    const n = nid ? nodes[nid] : null;
    if (!n) {
      const near = index.search(want.replace(/[/-]+/g, ' '), 3).map((r) => r.id);
      return { result: { error: `No node with id "${want}".`, didYouMean: near }, error: true };
    }
    const kids = Object.values(nodes).filter((c) => c.parent === n.id);
    const label = (/** @type {string} */ x) => nodes[x]?.label ?? x;
    const a = n.article;
    const analog = lens ? o.lenses?.[lens]?.analogs?.[n.id] : null;
    // explain merges the article's sources into the node's own, so the two lists overlap: one entry per url.
    const seenUrl = new Set();
    const sources = [...(n.sources ?? []), ...(a?.sources ?? [])].filter((s) => {
      const k = String(s?.url ?? '').trim().replace(/#.*$/, '').replace(/\/+$/, '');
      if (!k) return true;
      if (seenUrl.has(k)) return false;
      seenUrl.add(k);
      return true;
    });
    // Cross-links sit on leaves, so a category's own neighbours are usually empty: the links that
    // leave its branch (one end under it, the other outside) say how it connects.
    const under = descendantsOf(nodes, n.id);
    const branchLinks = (o.edges ?? []).filter((e) => under.has(e.from) !== under.has(e.to) && e.from !== n.id && e.to !== n.id
      && (under.has(e.from) ? nodes[e.to] : nodes[e.from]))
      .slice(0, BRANCH_LINKS_MAX)
      .map((e) => ({ from: { id: e.from, label: label(e.from) }, to: { id: e.to, label: label(e.to) }, type: e.type, why: e.why }));
    return {
      result: {
        id: n.id, label: n.label, path: labelPath(nodes, n.id).join(' > '),
        parent: n.parent ? { id: n.parent, label: label(n.parent) } : null,
        summary: n.summary ?? '', hook: n.hook ?? '',
        article: a ? { summary: a.summary, keyFacts: a.keyFacts, whyItMatters: a.whyItMatters, seeAlso: a.seeAlso }
          : 'Not explained yet: the reader can click Explain on this node.',
        sources: sources.slice(0, 10),
        children: kids.map((c) => ({ id: c.id, label: c.label, summary: c.summary ?? '' })),
        neighbours: (o.edges ?? []).filter((e) => e.from === n.id || e.to === n.id).map((e) => {
          const other = e.from === n.id ? e.to : e.from;
          return { id: other, label: label(other), type: e.type, why: e.why, direction: e.from === n.id ? 'out' : 'in' };
        }),
        ...(kids.length ? { branchLinks } : {}),
        ...(analog ? { analog } : {}),
      },
    };
  }
  return { result: { error: `Unknown tool ${name}` }, error: true };
}

// ---------------------------------------------------------------------------------------------

/** A push-based async iterable: the producer pushes, one consumer reads. */
function channel() {
  /** @type {ChatItem[]} */ const items = [];
  /** @type {(() => void) | null} */ let wake = null;
  let ended = false;
  return {
    /** @param {ChatItem} item */
    push(item) { if (!ended) { items.push(item); wake?.(); } },
    end() { ended = true; wake?.(); },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (items.length) { yield /** @type {ChatItem} */ (items.shift()); continue; }
          if (ended) return;
          await new Promise((r) => { wake = () => { wake = null; r(undefined); }; });
        }
      },
    },
  };
}
