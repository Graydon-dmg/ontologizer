// @ts-check
// exportMap: one map out in one of four formats. Pure (no Node, no DOM): the `export` command and
// the page's Export menu both call it.
import { htmlPage, embedFragment } from './html.js';
import { contextPack, estimateTokens, minContextBudget } from './context.js';

export { contextPack, estimateTokens, minContextBudget, CONTEXT_HEADINGS } from './context.js';
export { htmlPage, embedFragment, exportSnapshot } from './html.js';

/** @typedef {import('../schema.js').Ontology} Ontology */
/** @typedef {'html'|'embed'|'json'|'context'} ExportFormat */

export const FORMATS = /** @type {const} */ (['html', 'embed', 'json', 'context']);

/**
 * @param {Ontology} ontology
 * @param {{ format: ExportFormat, bundle?: string, budget?: number, liveUrl?: string|null, includeChat?: boolean }} opts
 *   bundle: the text of the embed bundle (html, embed only). budget: context only, in estimated
 *   tokens (chars / 4); a budget too small for the map is refused, naming the smallest that fits.
 *   liveUrl: html, embed only; shows "Open live" when set. includeChat: json only; the chat is left
 *   out unless this is true (questions people asked are not part of a shared map).
 * @returns {string}
 */
export function exportMap(ontology, { format, bundle, budget = 4000, liveUrl = null, includeChat = false }) {
  if (!ontology || typeof ontology !== 'object' || !ontology.nodes) throw new Error('exportMap needs a map snapshot.');
  switch (format) {
    case 'html':
      return htmlPage(ontology, { bundle, liveUrl });
    case 'embed':
      return embedFragment(ontology, { bundle, liveUrl });
    case 'json':
      // What /api/snapshot returns (a private map keeps its top-level "visibility"), with the chat
      // emptied unless asked for: same shape, so the file still loads as a map.
      return JSON.stringify(includeChat ? ontology : { ...ontology, chat: [] });
    case 'context': {
      const b = Number(budget);
      if (!Number.isFinite(b) || b <= 0) throw new Error('The context budget must be a positive number of tokens.');
      const text = contextPack(ontology, { budget: Math.floor(b) });
      if (estimateTokens(text) > Math.floor(b)) {
        throw new Error(`A budget of ${Math.floor(b)} tokens is too small for this map: the smallest context pack it fits in is ${minContextBudget(ontology)} tokens.`);
      }
      return text;
    }
    default:
      throw new Error(`Unknown export format "${format}": use ${FORMATS.join(', ')}.`);
  }
}
