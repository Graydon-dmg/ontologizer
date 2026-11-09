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
    const ok = outline.some((l) => l === prefix || l.startsWith(prefix + ':') || l.startsWith(prefix + ' ['));
    if (!ok) problems.push(`root child missing from outline: ${node.label}`);
  }

  if (ontology.visibility === 'private' && !(lines[0] ?? '').includes('Private')) {
    problems.push('private map: first line does not carry the Private mark');
  }
  return problems;
}
