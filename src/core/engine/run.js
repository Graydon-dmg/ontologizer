// @ts-check
// One run (a build with all its waves, one job, or one ask) with configured sources: it calls their
// tools, remembers every ref a tool returned, keeps only those when a model line cites them, and
// raises the map's visibility the first time a private source answers.
// Without tools a run cites nothing and raises nothing: the CLI writes exactly what it always did.

/** @typedef {{ source: string, ref: string, title?: string, url?: string }} SourceRef */
/** @typedef {{ text: string, isError: boolean, source: string, visibility: 'public'|'private', refs: SourceRef[] }} ToolResult */
/** @typedef {{ defs: { name: string, description: string, input_schema: any }[], names?: string[],
 *              call: (name: string, input: any) => Promise<ToolResult> }} ToolSet */

const MAX_REFS = 8;

/**
 * @param {{ tools?: ToolSet|null, emit: (t: string, fields: object) => void, read: () => any }} o
 *   emit: the run's emit (it stamps the actor); read: the map as it is now.
 */
export function createRun({ tools = null, emit, read }) {
  /** Every ref a tool returned in this run, by source and ref. @type {Map<string, SourceRef>} */
  const returned = new Map();
  /** Private sources this run already raised the map for. @type {Set<string>} */
  const raised = new Set();
  const key = (/** @type {string} */ source, /** @type {string} */ ref) => `${source}\u0000${ref}`;

  /** @param {string} name */
  function raise(name) {
    if (raised.has(name)) return;
    const o = read();
    if (Array.isArray(o?.privateSources) && o.privateSources.includes(name)) { raised.add(name); return; }
    raised.add(name);
    emit('visibility.raised', { to: 'private', reason: 'source', sources: [name] });
  }

  const has = Boolean(tools && Array.isArray(tools.defs) && tools.defs.length);
  return {
    /** Whether this run has source tools to offer. */
    hasTools: has,
    /** What runCall offers the model: the defs, and how to call one. Null without tools. */
    tools: has ? {
      defs: /** @type {ToolSet} */ (tools).defs,
      /**
       * Call one tool. A private source's first answer raises the map before the result goes back
       * to the model, so nothing the model writes from it can land on a map that is still public.
       * @param {string} name @param {any} input @returns {Promise<ToolResult>}
       */
      async call(name, input) {
        const r = await /** @type {ToolSet} */ (tools).call(name, input);
        if (!r.isError) {
          if (r.visibility === 'private' && r.source) raise(r.source);
          for (const ref of r.refs ?? []) if (ref && ref.source && ref.ref) returned.set(key(ref.source, ref.ref), ref);
        }
        return r;
      },
    } : null,
    /**
     * The verified refs of a model line's `sources`: only refs a tool in this run returned, with the
     * title and url the tool gave (never the model's), deduplicated, at most 8. Anything else is dropped.
     * @param {any} list @returns {SourceRef[]}
     */
    cite(list) {
      if (!has || !Array.isArray(list)) return [];
      /** @type {SourceRef[]} */
      const out = [];
      const seen = new Set();
      for (const c of list) {
        if (!c || typeof c.source !== 'string' || typeof c.ref !== 'string') continue;
        const k = key(c.source, c.ref.trim());
        const hit = returned.get(k);
        if (!hit || seen.has(k)) continue;
        seen.add(k);
        out.push({ ...hit });
        if (out.length >= MAX_REFS) break;
      }
      return out;
    },
  };
}

/**
 * Appended to a system prompt when the run has source tools.
 * @param {{ defs: { name: string }[] }} tools
 */
export function sourcesNote(tools) {
  const names = [...new Set(tools.defs.map((d) => d.name.split('__')[0]))].join(', ');
  return `

You can look things up in the reader's own sources (${names}) with the tools named <source>__<tool>. Use them where they help.
When a line draws on a document a tool returned, add to that line "sources":[{"source":"<source name>","ref":"<the ref exactly as the tool gave it>"}].
Cite only refs a tool returned in this conversation; never invent one. The output format above still applies.`;
}
