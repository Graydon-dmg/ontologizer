// @ts-check
/** @typedef {{ context: string, subject: string, scope: string, purpose: string,
 *              level: 'beginner'|'intermediate'|'expert' }} Brief */
/** @typedef {{ title: string, url: string }} Source   a web source */
/** @typedef {{ source: string, ref: string, title?: string, url?: string }} SourceRef
 *   A document a configured source (an MCP server) returned in the same run that wrote the node. */
/** @typedef {{ id: string, kind: 'human'|'agent'|'service', via?: string }} Actor
 *   Who caused an event, in service mode (a top-level `actor` field on the event). */
/** @typedef {{ summary: string, keyFacts: string[], whyItMatters: string,
 *              seeAlso: string[], sources: Source[] }} Article */
/** @typedef {{ id: string, label: string, parent: string|null, category: string, depth: number,
 *              summary?: string, hook?: string,
 *              origin: 'seed'|'context'|'general'|'fuse'|'rosetta',
 *              sources: (Source|SourceRef)[], article: Article|null, status: 'pending'|'done',
 *              createdBy: string }} OntoNode
 *   id is the path slug of labels from the root: "plastic-modeling/tools/adhesives".
 *   parent is null only for the root. depth: root 0, categories 1, and so on.
 *   category is the id of the node's top-level category: normally its depth-1 ancestor (a category's own
 *   category is itself; the root's is ""). In a fused map, copied nodes keep their source map's category
 *   so colors and sectors survive fusion; the two source roots have category "".
 *   createdBy names the pass that made it: "wave0", "wave1", "research", "fuse", ... */
/** @typedef {{ id: string, from: string, to: string,
 *              type: 'influences'|'requires'|'part-of'|'bridge'|'analog', why: string }} OntoEdge
 *   Edges are cross-links only. Parent links are implied by node.parent, never stored as edges. */
/** @typedef {{ id: string, persona: string,
 *              analogs: Record<string, { label: string, breaks?: string }> }} Lens */
/** @typedef {{ collapsed: string[], focus: string, layout: string, lens: string|null,
 *              filter: { categories: string[]|null, maxDepth: number|null } }} ViewState */
/** @typedef {{ id: string, label: string, index: number, family: number }} Category
 *   index: 0-based order of appearance; family: 0 normally, 1 for the second map in a fusion,
 *   2 for the Hybrids category of a fused map. */
/** @typedef {{ name: string, root: string, version: 1, brief: Brief, categories: Category[],
 *              nodes: Record<string, OntoNode>, edges: OntoEdge[],
 *              lenses: Record<string, Lens>, view: ViewState,
 *              jobs: Record<string, { id: string, kind: string, nodeId?: string,
 *                                     state: 'queued'|'running'|'done'|'failed', error?: string }>,
 *              insights: { at: number, text: string, nodeId?: string }[],
 *              chat: ChatMessage[], visibility: 'public'|'private', privateSources: string[] }} Ontology
 *   chat: the side chatbot's conversation, in order. Defaults to [] (maps saved before 1.2.0 fold fine).
 *   visibility: 'private' once any visibility.raised event exists, else 'public'; privateSources: the
 *   sorted names of the private sources it used. Folded from events, never written directly. */
/** @typedef {{ hash: string, mime: string, w: number, h: number }} ChatImage
 *   An image attached to a question, stored by content hash; the bytes live outside the event log. */
/** @typedef {{ kind: 'research', nodeId: string, mode: 'context'|'general', label: string }} ChatSuggestion */
/** @typedef {{ role: 'user'|'assistant'|'error', chatId: string, msgId: string, replyTo?: string,
 *              text: string, images?: ChatImage[], citations?: { nodeId: string, label: string }[],
 *              sources?: Source[], suggestions?: ChatSuggestion[], usedWeb?: boolean, at: number }} ChatMessage
 *   v1 has one chat per map, chatId 'main'. role 'error' carries the error text in `text`. */
export {};
