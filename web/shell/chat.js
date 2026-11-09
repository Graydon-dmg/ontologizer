// @ts-check
// Chat logic (no DOM): safe light markdown, citations, starters, images, the streamed answer.
import { api } from './base.js';

/** @typedef {{ t: 'text', v: string } | { t: 'b', c: Inline[] } | { t: 'i', c: Inline[] } | { t: 'code', v: string }
 *   | { t: 'link', href: string, c: Inline[] } | { t: 'cite', id: string }} Inline */
/** @typedef {{ t: 'p', c: Inline[] } | { t: 'ul'|'ol', items: Inline[][] } | { t: 'h', c: Inline[] }} Block */

/** Only these link targets are ever made clickable. */
export function safeHref(/** @type {string} */ href) {
  try {
    const u = new URL(href);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch { return null; }
}

/**
 * Inline markdown → a tree of plain strings. Supports **bold**, *italic*, `code`, [text](url)
 * and [[node-id]] citations. Everything else stays literal text (rendered with textContent).
 * @param {string} s @returns {Inline[]}
 */
export function parseInline(s) {
  /** @type {Inline[]} */
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m;
    if ((m = /^\[\[([^\]\n]{1,300})\]\]/.exec(rest))) { flush(); out.push({ t: 'cite', id: m[1].trim() }); i += m[0].length; continue; }
    if ((m = /^`([^`\n]+)`/.exec(rest))) { flush(); out.push({ t: 'code', v: m[1] }); i += m[0].length; continue; }
    if ((m = /^\*\*([^*\n]+?)\*\*/.exec(rest))) { flush(); out.push({ t: 'b', c: parseInline(m[1]) }); i += m[0].length; continue; }
    if ((m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest))) {
      const href = safeHref(m[2]);
      flush();
      if (href) out.push({ t: 'link', href, c: parseInline(m[1]) });
      else out.push({ t: 'text', v: m[1] });
      i += m[0].length; continue;
    }
    if ((m = /^\*([^*\n]+?)\*/.exec(rest)) && !/^\*\s/.test(rest)) { flush(); out.push({ t: 'i', c: parseInline(m[1]) }); i += m[0].length; continue; }
    buf += s[i];
    i++;
  }
  flush();
  return out;
}

/**
 * Block markdown: paragraphs (blank-line separated), "- " / "* " bullets, "1. " numbered lists,
 * and "#" headings shown as bold lines.
 * @param {string} text @returns {Block[]}
 */
export function parseMarkdown(text) {
  /** @type {Block[]} */
  const blocks = [];
  /** @type {string[]} */
  let para = [];
  /** @type {{ t: 'ul'|'ol', items: Inline[][] }|null} */
  let list = null;
  const endPara = () => { if (para.length) { blocks.push({ t: 'p', c: parseInline(para.join(' ')) }); para = []; } };
  const endList = () => { if (list) { blocks.push(list); list = null; } };
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { endPara(); endList(); continue; }
    if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) {
      endPara();
      if (!list || list.t !== 'ul') { endList(); list = { t: 'ul', items: [] }; }
      list.items.push(parseInline(m[1])); continue;
    }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      endPara();
      if (!list || list.t !== 'ol') { endList(); list = { t: 'ol', items: [] }; }
      list.items.push(parseInline(m[1])); continue;
    }
    if ((m = /^#{1,6}\s+(.*)$/.exec(line))) { endPara(); endList(); blocks.push({ t: 'h', c: parseInline(m[1]) }); continue; }
    endList();
    para.push(line.trim());
  }
  endPara(); endList();
  return blocks;
}

/** Unique cited node ids in order of appearance. @param {string} text */
export function citationIds(text) {
  /** @type {string[]} */
  const ids = [];
  for (const m of String(text ?? '').matchAll(/\[\[([^\]\n]{1,300})\]\]/g)) {
    const id = m[1].trim();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * A citation's chip: the node's label, or null when the map has no such node (then the raw id
 * is shown as plain text, not as a broken chip).
 * @param {any} ontology @param {string} id
 */
export function citeChip(ontology, id) {
  const n = ontology && ontology.nodes && ontology.nodes[id];
  return n ? { id, label: n.label } : null;
}

/**
 * Three starter questions from the map's categories.
 * @param {any} ontology @returns {string[]}
 */
export function starterQuestions(ontology) {
  const cats = (ontology && ontology.categories ? ontology.categories : []).slice().sort((a, b) => a.index - b.index);
  const label = (/** @type {any} */ c) => (c && c.label) || '';
  const rootNode = ontology && ontology.nodes && ontology.nodes[ontology.root];
  const subject = String((ontology && ontology.brief && ontology.brief.subject) || (rootNode && rootNode.label) || 'this topic').toLowerCase();
  const q = [`What should a beginner learn first about ${subject}?`];
  if (cats.length >= 2) q.push(`How does ${label(cats[0])} relate to ${label(cats[1])}?`);
  else q.push('Which parts of this map connect the most?');
  if (cats.length >= 3) q.push(`Compare the main options in ${label(cats[2])}.`);
  else if (cats.length) q.push(`Compare the main options in ${label(cats[0])}.`);
  else q.push('What is missing from this map?');
  return q;
}

export const MAX_IMAGES = 4;
export const MAX_EDGE = 1568;
export const MAX_TEXT = 4000;

/** Downscaled size: the long edge at most `max`, aspect kept, never upscaled. */
export function scaleSize(/** @type {number} */ w, /** @type {number} */ h, max = MAX_EDGE) {
  const long = Math.max(w, h);
  if (!(long > max)) return { w: Math.round(w), h: Math.round(h) };
  const k = max / long;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** PNG for screenshots/graphics (PNG, GIF, WebP with alpha), JPEG ~0.85 for photos. */
export function pickEncoding(/** @type {string} */ mime) {
  return mime === 'image/png' || mime === 'image/gif' ? { mime: 'image/png', quality: undefined } : { mime: 'image/jpeg', quality: 0.85 };
}

/**
 * The POST /api/chat body, or null when there is nothing to send. The active Rosetta lens goes
 * along so answers can speak through it.
 * @param {string} text @param {{ mime: string, data: string }[]} images @param {string|null} [lens]
 */
export function chatBody(text, images = [], lens = null) {
  const t = String(text ?? '').trim().slice(0, MAX_TEXT);
  const imgs = images.slice(0, MAX_IMAGES).map((x) => ({ mime: x.mime, data: x.data }));
  if (!t && !imgs.length) return null;
  /** @type {{ text: string, images?: { mime: string, data: string }[], lens?: string }} */
  const body = { text: t };
  if (imgs.length) body.images = imgs;
  if (lens) body.lens = lens;
  return body;
}

/**
 * Server-Sent Events over a fetch stream: feed text chunks, get parsed JSON messages.
 * Accepts `data:` lines (json may carry `type`) and an optional `event:` name.
 */
export function createSSEParser() {
  let buf = '';
  return {
    /** @param {string} chunk @returns {any[]} */
    push(chunk) {
      buf += chunk;
      /** @type {any[]} */
      const out = [];
      let idx;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        let ev = '';
        /** @type {string[]} */
        const data = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (!data.length) continue;
        let msg;
        try { msg = JSON.parse(data.join('\n')); } catch { msg = { text: data.join('\n') }; }
        if (ev && (!msg || typeof msg !== 'object' || !msg.type)) msg = { ...(typeof msg === 'object' ? msg : { value: msg }), type: ev };
        out.push(msg);
      }
      return out;
    },
  };
}

/**
 * The live answer while it streams. Pure: returns a new state for each item.
 * @typedef {{ text: string, citations: string[], sources: { title: string, url: string }[],
 *   suggestions: { nodeId: string, mode: string, label?: string }[], status: string, done: boolean,
 *   error: string, id: string }} LiveAnswer
 * @returns {LiveAnswer}
 */
export function emptyAnswer() {
  return { text: '', citations: [], sources: [], suggestions: [], status: '', done: false, error: '', id: '' };
}
/** @param {LiveAnswer} s @param {any} item @returns {LiveAnswer} */
export function applyChatItem(s, item) {
  if (!item || typeof item !== 'object') return s;
  switch (item.type) {
    case 'delta': return { ...s, text: s.text + String(item.text ?? ''), status: '' };
    case 'citation': return item.nodeId && !s.citations.includes(item.nodeId) ? { ...s, citations: [...s.citations, item.nodeId] } : s;
    case 'source': {
      const url = safeHref(String(item.url ?? ''));
      if (!url || s.sources.some((x) => x.url === url)) return s;
      return { ...s, sources: [...s.sources, { title: String(item.title || url), url }] };
    }
    case 'suggestion':
      if (!item.nodeId || s.suggestions.some((x) => x.nodeId === item.nodeId)) return s;
      return { ...s, suggestions: [...s.suggestions, { nodeId: item.nodeId, mode: item.mode === 'general' ? 'general' : 'context', label: item.label }] };
    case 'status': return { ...s, status: String(item.text ?? item.status ?? '') };
    case 'done': return { ...s, done: true, status: '', id: String(item.msgId ?? item.id ?? s.id) };
    case 'error': return { ...s, done: true, status: '', error: String(item.error ?? item.message ?? 'The answer failed.') };
    default: return s;
  }
}

/** The research action a suggestion button sends (never sent automatically). */
/**
 * Is a research job for this node queued or running? The chat redraws when its saved copy arrives,
 * so the Research suggestion button must read this from the map, not from its own click state.
 * @param {any} ontology @param {string} nodeId @returns {boolean}
 */
export function researchBusy(ontology, nodeId) {
  return Object.values(ontology?.jobs || {}).some((/** @type {any} */ j) =>
    j && j.kind === 'research' && j.nodeId === nodeId && (j.state === 'queued' || j.state === 'running'));
}

export function suggestionAction(/** @type {{ nodeId: string, mode?: string }} */ s) {
  return { type: 'research', nodeId: s.nodeId, mode: s.mode === 'general' ? 'general' : 'context' };
}

/**
 * The thread for display: each user message with its reply (assistant or error), paired by
 * replyTo === msgId (ontology.chat holds one entry per event).
 * @param {any} ontology
 * @returns {{ question: any, reply: any|null }[]}
 */
export function chatThread(ontology) {
  const msgs = (ontology && Array.isArray(ontology.chat) ? ontology.chat : []);
  /** @type {Map<string, any>} */
  const replies = new Map();
  for (const m of msgs) if (m.role !== 'user' && m.replyTo) replies.set(m.replyTo, m);
  return msgs.filter((m) => m.role === 'user').map((q) => ({ question: q, reply: replies.get(q.msgId) || null }));
}

/** The question still waiting for its reply, if any. @param {any} ontology */
export function pendingQuestion(ontology) {
  const t = chatThread(ontology);
  for (let i = t.length - 1; i >= 0; i--) if (!t[i].reply) return t[i].question;
  return null;
}

/** Every node an answer cites: its citations list plus any [[id]] in its text, existing nodes only. */
export function answerCitations(/** @type {any} */ ontology, /** @type {{ text?: string, citations?: { nodeId: string }[] }} */ ans) {
  const ids = [...(ans.citations || []).map((c) => c.nodeId), ...citationIds(ans.text || '')];
  return [...new Set(ids)].filter((id) => ontology && ontology.nodes && ontology.nodes[id]);
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * Which new files to take (paste, drop or the attach button): images only, at most MAX_IMAGES in
 * total. Returns the accepted files and a short message for anything refused.
 * @template {{ type: string, name?: string }} F
 * @param {number} have @param {F[]} files
 * @returns {{ accepted: F[], error: string }}
 */
export function acceptImages(have, files) {
  /** @type {F[]} */
  const accepted = [];
  let notImage = 0, overLimit = 0;
  for (const f of files) {
    if (!f || !IMAGE_TYPES.includes(f.type)) { notImage++; continue; }
    if (have + accepted.length >= MAX_IMAGES) { overLimit++; continue; }
    accepted.push(f);
  }
  const errs = [];
  if (notImage) errs.push('Only images can be added (PNG, JPEG, GIF or WebP).');
  if (overLimit) errs.push(`Up to ${MAX_IMAGES} images per question.`);
  return { accepted, error: errs.join(' ') };
}

/** A clear message for a refused chat request. @param {number} status @param {string} [error] */
export function chatErrorText(status, error) {
  if (status === 409) return error || 'Another answer is still being written. Wait for it, then ask again.';
  if (status === 413) return error || 'Those images are too large together. Remove one and try again.';
  if (status === 400) return error || 'That question could not be sent.';
  if (status === 403) return error || 'This page is not allowed to talk to ontologizer. Open the map from the link ontologizer printed.';
  if (status === 415) return error || 'The question was not sent as JSON.';
  if (status === 401) return error || 'Your Anthropic API key was rejected: run ontologizer key set';
  if (status === 0) return 'Cannot reach the server. Is ontologizer still running?';
  return error || `The server answered HTTP ${status}.`;
}

/**
 * Send a question: POST /api/chat with { text, images? } and stream the answer items to onItem.
 * Resolves when the stream ends. Errors before the stream (400/409/413/…) resolve { ok: false }.
 * @param {typeof fetch} fetchFn
 * @param {{ text: string, images?: { mime: string, data: string }[] }} body
 * @param {(item: any) => void} onItem
 * @param {{ signal?: AbortSignal, base?: string }} [o]
 * @returns {Promise<{ ok: boolean, status: number, error?: string }>}
 */
export async function postChat(fetchFn, body, onItem, o = {}) {
  let res;
  try {
    res = await fetchFn(o.base ? `${o.base}/api/chat` : api('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: o.signal,
    });
  } catch (err) {
    return { ok: false, status: 0, error: chatErrorText(0) };
  }
  if (!res.ok) {
    let msg = '';
    try { const j = await res.json(); msg = j && j.error ? String(j.error) : ''; } catch { /* not JSON */ }
    return { ok: false, status: res.status, error: chatErrorText(res.status, msg) };
  }
  const parser = createSSEParser();
  let sawEnd = false;
  const emit = (/** @type {any[]} */ items) => { for (const it of items) { if (it.type === 'done' || it.type === 'error') sawEnd = true; onItem(it); } };
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch { break; }
      if (chunk.done) break;
      emit(parser.push(dec.decode(chunk.value, { stream: true })));
    }
    emit(parser.push('\n\n'));
  } else {
    emit(parser.push(await res.text() + '\n\n'));
  }
  if (!sawEnd) onItem({ type: 'error', error: 'The answer stopped before it finished. Is ontologizer still running?' });
  return { ok: true, status: res.status };
}
