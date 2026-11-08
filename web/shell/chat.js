// @ts-check
// Chat logic (no DOM): safe light markdown, citations, starters, images, the streamed answer.

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
  const subject = (ontology && (ontology.brief && ontology.brief.subject)) || (ontology && ontology.nodes && ontology.nodes[ontology.root] && ontology.nodes[ontology.root].label) || 'this topic';
  const q = [`What should a beginner learn first about ${subject.toLowerCase() === subject ? subject : subject}?`];
  if (cats.length >= 2) q.push(`How does ${label(cats[0])} relate to ${label(cats[1])}?`);
  else q.push('Which parts of this map connect the most?');
  if (cats.length >= 3) q.push(`Compare the main options in ${label(cats[2])}.`);
  else if (cats.length) q.push(`Compare the main options in ${label(cats[0])}.`);
  else q.push('What is missing from this map?');
  return q;
}

export const MAX_IMAGES = 4;
export const MAX_EDGE = 1568;

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
 * The POST /api/chat body, or null when there is nothing to send.
 * @param {string} text @param {{ mime: string, data: string }[]} images
 */
export function chatBody(text, images = []) {
  const t = String(text ?? '').trim();
  const imgs = images.slice(0, MAX_IMAGES).map((x) => ({ mime: x.mime, data: x.data }));
  if (!t && !imgs.length) return null;
  return imgs.length ? { text: t, images: imgs } : { text: t };
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
    case 'done': return { ...s, done: true, status: '', id: String(item.id ?? s.id) };
    case 'error': return { ...s, done: true, status: '', error: String(item.error ?? item.message ?? 'The answer failed.') };
    default: return s;
  }
}

/** The research action a suggestion button sends (never sent automatically). */
export function suggestionAction(/** @type {{ nodeId: string, mode?: string }} */ s) {
  return { type: 'research', nodeId: s.nodeId, mode: s.mode === 'general' ? 'general' : 'context' };
}
