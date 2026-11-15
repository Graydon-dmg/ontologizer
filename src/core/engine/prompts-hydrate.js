// @ts-check
// The hydrate prompt: one batch of siblings gets job, examples and not_for, written for an agent
// that classifies requests against the map. No web search, no source tools.
import { labelPath } from './ids.js';

export const MAX_CHILDREN = 20;
export const MAX_SIBLINGS = 200;

/** One line of text, at most n characters. @param {any} s @param {number} n */
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The children of a node, in label order. @param {Record<string, any>} nodes @param {string|null} id */
export function childrenOf(nodes, id) {
  return Object.values(nodes).filter((n) => n.parent === id)
    .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * @param {any} o  the folded map
 * @param {string} parentId  the batch's parent
 * @param {string[]} nodeIds  the batch: children of parentId
 */
export function hydratePrompt(o, parentId, nodeIds) {
  const nodes = o.nodes;
  const parent = nodes[parentId];
  const subject = o.brief?.subject || nodes[o.root]?.label || o.name || '';
  const siblings = childrenOf(nodes, parentId);
  const uncles = parent && parent.parent !== null ? childrenOf(nodes, parent.parent).filter((n) => n.id !== parentId) : [];

  const system = `You write agent-facing fields for nodes of a map. An agent will read them to decide which node a request belongs to, so they must separate each node from its nearest neighbours.
For each node you are given, write:
- job: what the node is for, in one plain line (at most 200 characters).
- examples: exactly 3 different, typical requests that belong to this node and not to its neighbours (each at most 200 characters), written as a user would ask them.
- not_for: its nearest look-alikes among the listed siblings (or the parent's siblings) and what separates them, in one or two sentences (at most 400 characters).
- not_for_ids: the ids of those look-alikes, 1 to 3 of them, copied exactly from the sibling list or the parent's siblings. Never the node itself, never an id that is not listed. Only when a node has no siblings at all: not_for "" and not_for_ids [].
Write one line for every node to hydrate, and no line for any other id.
Output one JSON object per line, nothing else: no prose, no headings, no code fences, no arrays of lines.
Each line: {"id":"<the node's id, exactly>","job":"…","examples":["…","…","…"],"not_for":"…","not_for_ids":["…"]}
Example line: {"id":"defi/lending","job":"Borrowing and lending crypto assets against collateral.","examples":["What rate does Aave pay on USDC?","How do I avoid liquidation on a loan?","Is Compound safer than Morpho?"],"not_for":"Not DEXes (swapping one token for another, no loan) and not Stablecoins (the assets themselves, not lending them).","not_for_ids":["defi/dexes","stablecoins"]}`;

  const batch = nodeIds.map((id) => {
    const n = nodes[id];
    const kids = childrenOf(nodes, id).slice(0, MAX_CHILDREN).map((c) => c.label);
    return [
      `- id: ${id}`,
      `  label: ${n.label}`,
      `  path: ${labelPath(nodes, id).join(' > ')}`,
      ...(n.summary ? [`  summary: ${clip(n.summary, 300)}`] : []),
      ...(kids.length ? [`  children: ${kids.join(', ')}`] : []),
    ].join('\n');
  });
  const list = (/** @type {any[]} */ ns) => ns.slice(0, MAX_SIBLINGS).map((n) => `- ${n.id}: ${n.label}`).join('\n') || '(none)';

  const prompt = `The map's subject: ${subject}
The parent of these nodes: ${parent ? labelPath(nodes, parentId).join(' > ') : parentId}

Every sibling (children of the parent), id: label:
${list(siblings)}

The parent's siblings, id: label:
${list(uncles)}

The nodes to hydrate (${nodeIds.length}):
${batch.join('\n')}`;
  return { system, prompt };
}
