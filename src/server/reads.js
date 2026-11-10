// @ts-check
// The map as agents and apps read it through the I3 routes (outline, search, nodes) and the MCP
// tools: never the raw folded map, always through the export's own safety: the allow-list snapshot
// (exportSnapshot: no chat, jobs, insights or anything a reader never sees; sources as title, url,
// source and ref) and the context pack's escaping (cleanMap, oneLine: one line per value, no live
// markdown link, heading or quote, sources only with http/https links). The context pack and the
// exports themselves are exportMap's own output.
import { exportSnapshot } from '../core/export/html.js';
import { cleanMap, oneLine, PREAMBLE } from '../core/export/context.js';
import { outline } from '../core/engine/chat.js';

/**
 * The allow-listed, escaped copy of a map. cleanMap covers names, labels, summaries, the brief,
 * category labels, edges and sources; the article's other text and the lenses' analogs are escaped
 * here with the same oneLine.
 * @param {any} o a folded map @returns {any}
 */
export function agentMap(o) {
  const c = /** @type {any} */ (cleanMap(exportSnapshot(o)));
  for (const n of Object.values(c.nodes)) {
    const a = /** @type {any} */ (n).article;
    if (a) {
      a.keyFacts = (Array.isArray(a.keyFacts) ? a.keyFacts : []).map((/** @type {any} */ f) => oneLine(f));
      a.whyItMatters = oneLine(a.whyItMatters);
    }
  }
  for (const l of Object.values(c.lenses ?? {})) {
    const lens = /** @type {any} */ (l);
    lens.persona = oneLine(lens.persona);
    const analogs = /** @type {Record<string, any>} */ ({});
    for (const [id, an] of Object.entries(lens.analogs ?? {})) analogs[id] = an && typeof an === 'object' ? { ...an, label: oneLine(an.label), ...(an.why !== undefined ? { why: oneLine(an.why) } : {}) } : an;
    lens.analogs = analogs;
  }
  return c;
}

/** The outline route's text: the context pack's preamble, the name, one line per node. @param {any} o @param {string} id */
export function outlineText(o, id) {
  const c = agentMap(o);
  return `${PREAMBLE}\n\n# ${c.name || id}\n\n${outline(c)}\n`;
}
