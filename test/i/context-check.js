// @ts-check
import { CONTEXT_HEADINGS, estimateTokens } from '../../src/core/export/context.js';

/**
 * Check a rendered context pack. Returns a list of problems (empty when the pack is sound).
 * @param {string} text
 * @param {any} ontology
 * @param {number} budget
 * @returns {string[]}
 */
export function checkContextPack(text, ontology, budget) {
  /** @type {string[]} */
  const problems = [];
  const lines = text.split('\n');
  const tokens = estimateTokens(text);
  if (tokens > budget) problems.push(`over budget: ${tokens} > ${budget}`);

  const headings = lines.filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
  if (headings.join('|') !== CONTEXT_HEADINGS.join('|')) {
    problems.push(`headings are [${headings.join(', ')}], expected [${CONTEXT_HEADINGS.join(', ')}]`);
  }

  const start = lines.indexOf('## Outline');
  const end = lines.indexOf('## Bridges');
  const outline = start >= 0 ? lines.slice(start + 1, end >= 0 ? end : undefined) : [];
  for (const n of Object.values(ontology.nodes)) {
    const node = /** @type {any} */ (n);
    if (node.parent !== ontology.root) continue;
    const prefix = `  - ${node.label}`;
    const ok = outline.some((l) => l === prefix || l.startsWith(prefix + ':') || l.startsWith(prefix + ' [') || l.startsWith(prefix + ' ('));
    if (!ok) problems.push(`root child missing from outline: ${node.label}`);
  }

  if (ontology.visibility === 'private' && !(lines[0] ?? '').includes('Private')) {
    problems.push('private map: first line does not carry the Private mark');
  }
  return problems;
}

/**
 * Node labels missing from a pack's Outline (the brainstorm needs every label it can afford).
 * @param {string} text @param {any} ontology @returns {string[]}
 */
export function missingLabels(text, ontology) {
  const lines = text.split('\n');
  const outline = lines.slice(lines.indexOf('## Outline') + 1, lines.indexOf('## Bridges'));
  // "- Label (id): summary [explained]": the id (after the last " (" before the summary) is not part of the label.
  const labels = new Set(outline.map((l) => l.trim().replace(/^- /, '').replace(/ \[explained\]$/, '').split(': ')[0].replace(/ \((?:…\/)?[\w.:/-]+\)$/, '')));
  return Object.values(ontology.nodes).map((n) => /** @type {any} */ (n).label).filter((l) => !labels.has(l));
}

/**
 * Bridge lines whose two ends read the same ("A → A"): two nodes that share a label must be told
 * apart, or the bridge reads as a loop.
 * @param {string} text @returns {string[]}
 */
export function sameNameBridges(text) {
  const lines = text.split('\n');
  const from = lines.indexOf('## Bridges');
  const to = lines.indexOf('## Insights');
  return lines.slice(from + 1, to).filter((l) => {
    const m = l.match(/^- (.+?) → (.+?) \((?:influences|requires|part-of|bridge|analog)\)/);
    return m !== null && m[1] === m[2];
  });
}
