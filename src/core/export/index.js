// @ts-check
// exportMap: one map out in one of four formats. Pure (no Node, no DOM): the `export` command and
// the page's Export menu both call it.
import { htmlPage, embedFragment } from './html.js';
import { contextPack } from './context.js';

export { contextPack, estimateTokens, CONTEXT_HEADINGS } from './context.js';
export { htmlPage, embedFragment, exportSnapshot } from './html.js';

/** @typedef {import('../schema.js').Ontology} Ontology */
/** @typedef {'html'|'embed'|'json'|'context'} ExportFormat */

export const FORMATS = /** @type {const} */ (['html', 'embed', 'json', 'context']);

/**
 * @param {Ontology} ontology
 * @param {{ format: ExportFormat, bundle?: string, budget?: number, liveUrl?: string|null }} opts
 *   bundle: the text of the embed bundle (html, embed only). budget: context only, in estimated
 *   tokens (chars / 4). liveUrl: html, embed only; shows "Open live" when set.
 * @returns {string}
 */
export function exportMap(ontology, { format, bundle, budget = 4000, liveUrl = null }) {
  if (!ontology || typeof ontology !== 'object' || !ontology.nodes) throw new Error('exportMap needs a map snapshot.');
  switch (format) {
    case 'html':
      return htmlPage(ontology, { bundle, liveUrl });
    case 'embed':
      return embedFragment(ontology, { bundle, liveUrl });
    case 'json':
      // Exactly what /api/snapshot returns, so a private map keeps its top-level "visibility".
      return JSON.stringify(ontology);
    case 'context': {
      const b = Number(budget);
      if (!Number.isFinite(b) || b <= 0) throw new Error('The context budget must be a positive number of tokens.');
      return contextPack(ontology, { budget: Math.floor(b) });
    }
    default:
      throw new Error(`Unknown export format "${format}": use ${FORMATS.join(', ')}.`);
  }
}
