// @ts-check
// Epic G's prompts: fuse (the seam call) and rosetta (the analogy lens).
// Each prompt asks for one JSON object per line, nothing else.

/**
 * @typedef {{ id: string, label: string, depth: number }} PromptNode
 */

/** @param {PromptNode[]} nodes */
function nodeList(nodes) {
  return nodes.map((n) => `${'  '.repeat(Math.max(0, n.depth))}${n.id} | ${n.label}`).join('\n');
}

export const FUSE_SYSTEM = `You fuse two concept maps into a third. You find the seam between two fields: the real things that live where they overlap, and the specific connections that cross from one to the other.

You read two maps. Each line of a map is "<node id> | <label>", indented by depth. You answer with JSON lines that add the seam.

Output: one JSON object per line, nothing else. No prose, no headings, no code fences, no arrays. Three kinds of line:

1. Only if the user asks for a name, the very first line names the fused map, in kebab-case, 1 to 3 words:
{"name":"gunpla"}

2. A hybrid: a real thing that exists only because both fields meet. 3 to 8 of them.
{"hybrid":"Gunpla","summary":"Bandai's snap-fit Gundam model kits, where mecha anime meets plastic modeling.","hook":"Gunpla outsells every other plastic kit line in the world."}

3. A bridge: one specific connection across the seam. 8 to 20 of them in total.
{"from":"<node id>","to":"<node id or hybrid label>","why":"One sentence naming the specific connection."}

Rules:
- Hybrids are real, named crossovers a practitioner of both fields would recognise: products, practices, scenes, techniques, communities (for manga and plastic modeling: Gunpla, garage kits, figure painting). Never a generic word such as "Creativity", "Craftsmanship", "Storytelling" or "Fandom".
- Write each hybrid line, then straight away the bridges that tie it in: at least one bridge from a node of the first map and one from a node of the second map, with the hybrid's label as "to".
- After the hybrids, add direct bridges: "from" a node of the first map, "to" a node of the second map.
- Copy node ids exactly as written in the maps. Never invent an id. Use a hybrid's exact label to refer to it.
- "why" names the concrete link (who, what, how), never "both involve creativity".
- summary: one plain sentence. hook: one surprising, specific fact.`;

/**
 * @param {{ a: { root: string, name: string, nodes: PromptNode[] },
 *           b: { root: string, name: string, nodes: PromptNode[] },
 *           askName: boolean }} input
 */
export function fusePrompt({ a, b, askName }) {
  return [
    `First map: ${a.name} (root id "${a.root}")`,
    nodeList(a.nodes),
    '',
    `Second map: ${b.name} (root id "${b.root}")`,
    nodeList(b.nodes),
    '',
    askName
      ? 'Name the fused map on the first line, then write the hybrids and bridges.'
      : 'Do not write a name line. Write the hybrids and bridges.',
    'One JSON object per line, nothing else.',
  ].join('\n');
}

/** @param {string} persona */
export function rosettaSystem(persona) {
  return `You explain a field to ${persona}, through the domain they already know.

For every node you are given, name the one closest analog in their domain, and say where the analogy breaks: where intuition carried over from their domain will mislead them about this field. The breaks are the most valuable part: they show what is genuinely new.

Output: one JSON object per line, nothing else. No prose, no headings, no code fences, no arrays. One line per node, in the order given:
{"id":"<node id copied exactly>","analog":"<the analog>","breaks":"<where it misleads>"}

Example, for a home chef learning plastic modeling:
{"id":"plastic-modeling/painting/priming","analog":"seasoning a cast-iron pan","breaks":"Seasoning builds up over many uses; a primer coat must go on thin, once, or it buries the detail."}

Rules:
- Every node gets a line. Copy its id exactly.
- The analog is a specific, named thing from the reader's domain: a technique, tool, ingredient, dish, role or ritual, 2 to 6 words ("mise en place", "deglazing the pan", "a mandoline slicer"). Never a generic word such as "preparation", "a tool", "the process", "practice" or "a recipe".
- Do not reuse the same analog for two nodes in one answer.
- breaks: one sentence naming the concrete point where the analogy fails. Give it for nearly every node; leave the key out only when the analogy truly holds all the way.`;
}

/**
 * @param {{ subject: string, nodes: { id: string, path: string, summary?: string }[] }} input
 */
export function rosettaPrompt({ subject, nodes }) {
  const lines = nodes.map((n) => `${n.id} | ${n.path}${n.summary ? ` | ${n.summary}` : ''}`);
  return [
    `Field: ${subject}`,
    'Nodes, one per line as "<id> | <label path> | <summary>":',
    ...lines,
    '',
    `Write exactly ${nodes.length} lines, one per node. One JSON object per line, nothing else.`,
  ].join('\n');
}
