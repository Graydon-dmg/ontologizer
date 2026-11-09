// @ts-check
// Context pack: a compact markdown brief of a map, written for an AI agent that is about to
// brainstorm or work on the topic. Pure: no I/O, no platform globals; runs in Node and the browser.

/** @typedef {import('../schema.js').Ontology} Ontology */
/** @typedef {import('../schema.js').OntoNode} OntoNode */

export const CONTEXT_HEADINGS = ['Brief', 'Outline', 'Bridges', 'Insights', 'Thin areas', 'Sources'];

const SUMMARY_MAX = 140;
const WHY_MAX = 160;
const THIN_NODE_MAX = 12;
const BRIEF_CUT = 80;
const NONE = 'None yet.';

/** @param {string} text */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/** @param {unknown} s @param {number} [max] */
function oneLine(s, max) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (max === undefined || t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

/** @param {OntoNode} n */
function summaryOf(n) {
  return oneLine(n.summary || n.article?.summary || '', SUMMARY_MAX);
}

/** @param {OntoNode} n */
function hasSources(n) {
  return (n.sources?.length ?? 0) > 0 || (n.article?.sources?.length ?? 0) > 0;
}

/** @param {string} url */
function urlKey(url) {
  return url.trim().replace(/#.*$/, '').replace(/\/+$/, '');
}

/**
 * @typedef {{ id: string, depth: number, indent: number, label: string, summary: string, explained: boolean }} OutlineRow
 */

/** @param {Ontology} o */
function buildModel(o) {
  const ids = Object.keys(o.nodes);
  /** @type {Map<string, string[]>} */
  const kids = new Map();
  /** @type {string[]} */
  const orphans = [];
  for (const id of ids) {
    const n = o.nodes[id];
    if (id === o.root) continue;
    if (n.parent && o.nodes[n.parent]) {
      const l = kids.get(n.parent) ?? [];
      l.push(id);
      kids.set(n.parent, l);
    } else orphans.push(id);
  }
  const rootNode = o.nodes[o.root];
  /** @type {OutlineRow[]} */
  const rows = [];
  const seen = new Set();
  /** @param {string} id @param {number} indent */
  const walk = (id, indent) => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = o.nodes[id];
    // The root's summary is usually the brief's scope or context again: say it once, in the Brief.
    const repeats = id === o.root && [o.brief?.scope, o.brief?.context].some((b) => b && oneLine(b, SUMMARY_MAX) === summaryOf(n));
    rows.push({ id, depth: n.depth ?? indent, indent, label: n.label, summary: repeats ? '' : summaryOf(n), explained: !!n.article });
    for (const c of kids.get(id) ?? []) walk(c, indent + 1);
  };
  if (rootNode) walk(o.root, 0);
  for (const id of orphans) walk(id, 1);
  // Anything unreachable (a parent cycle) still gets listed at depth 1.
  for (const id of ids) if (!seen.has(id)) walk(id, 1);

  /** @type {Map<string, number>} */
  const leafCount = new Map();
  /** @type {Map<string, number>} */
  const descCount = new Map();
  /** @param {string} id @param {Set<string>} path @returns {[number, number]} */
  const count = (id, path) => {
    const cs = (kids.get(id) ?? []).filter((c) => !path.has(c));
    if (!cs.length) {
      leafCount.set(id, 1);
      descCount.set(id, 0);
      return [1, 0];
    }
    path.add(id);
    let l = 0;
    let d = 0;
    for (const c of cs) {
      const [cl, cd] = count(c, path);
      l += cl;
      d += cd + 1;
    }
    path.delete(id);
    leafCount.set(id, l);
    descCount.set(id, d);
    return [l, d];
  };
  for (const id of ids) if (!leafCount.has(id) && (id === o.root || orphans.includes(id))) count(id, new Set());
  for (const id of ids) if (!leafCount.has(id)) count(id, new Set());

  const catLabel = (/** @type {string} */ c) => o.categories.find((x) => x.id === c)?.label ?? c;
  return { ids, rows, leafCount, descCount, kids, catLabel };
}

/** @param {Ontology} o @param {ReturnType<typeof buildModel>} m */
function sectionLines(o, m) {
  const nodes = o.nodes;
  const root = nodes[o.root];
  const name = o.name || root?.label || 'Untitled map';
  const b = o.brief || /** @type {any} */ ({});

  const explained = m.ids.filter((id) => nodes[id].article).length;
  const briefFields = /** @type {[string, string][]} */ ([
    ['Context', b.context], ['Subject', b.subject], ['Scope', b.scope], ['Purpose', b.purpose], ['Level', b.level],
  ]).map(([k, v]) => /** @type {[string, string]} */ ([k, oneLine(v)])).filter(([, v]) => v);
  const sizeLine = `- Size: ${m.ids.length} nodes in ${o.categories.length} categories, ${o.edges.length} cross-links, ${explained} explained`;

  // A label shared by several nodes is named with its category, so "Panel Lining → Panel Lining"
  // does not read as a loop. When the category is shared too, the parent is added.
  /** @type {Map<string, string[]>} */
  const byLabel = new Map();
  for (const id of m.ids) {
    const key = String(nodes[id].label ?? '').trim().toLowerCase();
    byLabel.set(key, [...(byLabel.get(key) ?? []), id]);
  }
  /** Where a node sits: its category, or its parent for a category node. @param {string} id */
  const placeOf = (id) => {
    const n = nodes[id];
    if (n.category && n.category !== id) return m.catLabel(n.category);
    return n.parent ? nodes[n.parent]?.label ?? '' : '';
  };
  /** The node's label, qualified only when another node has the same label. @param {string} id */
  const nameOf = (id) => {
    const n = nodes[id];
    const twins = byLabel.get(String(n.label ?? '').trim().toLowerCase()) ?? [];
    if (twins.length < 2) return n.label;
    const place = placeOf(id);
    const samePlace = twins.some((t) => t !== id && placeOf(t) === place);
    const parent = n.parent ? nodes[n.parent]?.label : '';
    const where = samePlace && parent && parent !== place ? `${place}, under ${parent}` : place;
    return where ? `${n.label} (${where})` : n.label;
  };

  /** @type {string[]} */
  const bridges = [];
  for (const e of o.edges) {
    const a = nodes[e.from];
    const c = nodes[e.to];
    if (!a || !c || !a.category || !c.category || a.category === c.category) continue;
    const why = oneLine(e.why, WHY_MAX);
    bridges.push(`- ${nameOf(e.from)} → ${nameOf(e.to)} (${e.type})${why ? ': ' + why : ''}`);
  }

  const insights = (o.insights ?? []).map((i) => {
    const n = i.nodeId ? nodes[i.nodeId] : undefined;
    return `- ${oneLine(i.text)}${n && i.nodeId ? ` (${nameOf(i.nodeId)})` : ''}`;
  });

  // Thin areas
  /** @type {{ id: string, line: string, e: number, n: number, s: number }[]} */
  const cats = o.categories.map((c) => {
    const inCat = m.ids.filter((id) => nodes[id].category === c.id);
    const e = inCat.filter((id) => nodes[id].article).length;
    const s = inCat.filter((id) => hasSources(nodes[id])).length;
    return { id: c.id, line: `- ${c.label}: ${e} of ${inCat.length} explained, ${s} with sources`, e, n: inCat.length, s };
  });
  const share = (/** @type {number} */ a, /** @type {number} */ n) => (n ? a / n : 0);
  cats.sort((a, b2) => share(a.e, a.n) - share(b2.e, b2.n) || share(a.s, a.n) - share(b2.s, b2.n) || b2.n - a.n);
  const catLines = cats.map((c) => c.line);

  const noSummary = m.ids.filter((id) => (m.leafCount.get(id) ?? 0) >= 4 && (m.kids.get(id)?.length ?? 0) > 0 && !summaryOf(nodes[id]))
    .sort((a, b2) => (m.leafCount.get(b2) ?? 0) - (m.leafCount.get(a) ?? 0));
  // A category with nothing explained or sourced is already one line above; listing its nodes one by
  // one would only repeat it. Single nodes are worth naming where their neighbours are covered.
  const coveredCats = new Set(cats.filter((c) => c.e > 0 || c.s > 0).map((c) => c.id));
  const bare = m.ids.filter((id) => (nodes[id].depth ?? 0) >= 1 && nodes[id].category !== id && coveredCats.has(nodes[id].category)
    && !nodes[id].article && !hasSources(nodes[id]) && !noSummary.includes(id))
    .sort((a, b2) => (nodes[a].depth - nodes[b2].depth) || ((m.descCount.get(b2) ?? 0) - (m.descCount.get(a) ?? 0)));
  /** @type {string[]} */
  const thinNodes = [];
  for (const id of noSummary) thinNodes.push(`- ${nameOf(id)}: ${m.leafCount.get(id)} leaves, no summary`);
  for (const id of bare) {
    const shown = nameOf(id); // already carries its category when the label is shared
    thinNodes.push(`- ${shown !== nodes[id].label ? shown : `${nodes[id].label} (${m.catLabel(nodes[id].category)})`}: no explanation, no sources`);
  }
  thinNodes.length = Math.min(thinNodes.length, THIN_NODE_MAX);

  // Sources
  /** @type {Map<string, { title: string, url: string, cited: Set<string> }>} */
  const src = new Map();
  for (const id of m.ids) {
    const n = nodes[id];
    for (const s of [...(n.sources ?? []), ...(n.article?.sources ?? [])]) {
      const url = String(s?.url ?? '').trim();
      if (!url) continue;
      const k = urlKey(url);
      const cur = src.get(k) ?? { title: oneLine(s.title) || url, url, cited: new Set() };
      cur.cited.add(id);
      src.set(k, cur);
    }
  }
  const sources = [...src.values()]
    .sort((a, b2) => b2.cited.size - a.cited.size || a.title.localeCompare(b2.title))
    .map((s) => `- ${s.title}: ${s.url}`);

  // On a fresh map nothing is explained or sourced: one line says so instead of a line per category.
  const covered = m.ids.some((id) => nodes[id].article || hasSources(nodes[id]));
  const coverageLines = covered ? catLines : ['- Nothing explained or sourced yet: every branch is thin.'];
  return { name, briefFields, sizeLine, bridges, insights, coverageLines, thinNodes, sources };
}

/**
 * Render the context pack as markdown, trimmed to `budget` estimated tokens when it is larger.
 * @param {Ontology} ontology
 * @param {{ budget?: number }} [opts]
 * @returns {string}
 */
export function contextPack(ontology, { budget = 4000 } = {}) {
  const m = buildModel(ontology);
  const s = sectionLines(ontology, m);
  const maxDepth = m.rows.reduce((a, r) => Math.max(a, r.depth), 0);
  const depthCounts = new Map();
  for (const r of m.rows) depthCounts.set(r.depth, (depthCounts.get(r.depth) ?? 0) + 1);

  // Summaries go first, deepest level up; the root's own summary before its children's, which
  // stay longest. Labels stay until the very end of the outline trim: they are cheap and they are
  // what a brainstorm needs most.
  const present = new Set(m.rows.map((r) => r.depth));
  const withSum = new Set(m.rows.filter((r) => r.summary).map((r) => r.depth));
  const SUM_ORDER = [...[...present].filter((d) => d >= 2).sort((a, b) => b - a), 0, 1].filter((d) => withSum.has(d));
  /** Each summary's place among the summaries of its level, in outline order. @type {Map<string, number>} */
  const rank = new Map();
  /** @type {Map<number, number>} summaries per level */
  const perLevel = new Map();
  for (const r of m.rows) {
    if (!r.summary) continue;
    const k = perLevel.get(r.depth) ?? 0;
    rank.set(r.id, k);
    perLevel.set(r.depth, k + 1);
  }

  const st = {
    depthMax: maxDepth, // outline rows deeper than this are dropped
    sumOff: 0, // how many levels of SUM_ORDER have lost their summaries
    part: Infinity, // at level SUM_ORDER[sumOff], how many summaries (in outline order) are kept
    bridges: s.bridges.length,
    sources: s.sources.length,
    thin: s.thinNodes.length,
    insights: s.insights.length,
    briefCut: false,
  };

  /** @param {string[]} all @param {number} keep */
  const section = (all, keep) => {
    if (!all.length) return [NONE];
    const out = all.slice(0, keep);
    if (keep < all.length) out.push(`- …and ${all.length - keep} more`);
    return out;
  };

  const render = () => {
    /** @type {string[]} */
    const out = [];
    if (/** @type {any} */ (ontology).visibility === 'private') {
      out.push('> Private map: it cites private sources. Keep it inside its audience.', '');
    }
    out.push(`# ${s.name}`, '');
    out.push('## Brief');
    for (const [k, v] of s.briefFields) {
      out.push(`- ${k}: ${st.briefCut && k !== 'Subject' && k !== 'Level' ? oneLine(v, BRIEF_CUT) : v}`);
    }
    out.push(s.sizeLine, '');
    out.push('## Outline');
    for (const r of m.rows) {
      if (r.depth > st.depthMax) continue;
      const lvl = SUM_ORDER.indexOf(r.depth);
      const sum = lvl > st.sumOff || (lvl === st.sumOff && (rank.get(r.id) ?? 0) < st.part) ? r.summary : '';
      out.push(`${'  '.repeat(r.indent)}- ${r.label}${sum ? ': ' + sum : ''}${r.explained ? ' [explained]' : ''}`);
    }
    out.push('', '## Bridges', ...section(s.bridges, st.bridges), '');
    out.push('## Insights', ...section(s.insights, st.insights), '');
    out.push('## Thin areas');
    const thin = [...s.coverageLines, ...section(s.thinNodes, st.thin).filter((l) => l !== NONE)];
    out.push(...(thin.length ? thin : [NONE]), '');
    out.push('## Sources', ...section(s.sources, st.sources));
    const what = trimmedWhat();
    if (what.length) out.push('', `_Trimmed to fit ${budget} tokens: ${what.join(', ')}._`);
    return out.join('\n') + '\n';
  };

  const trimmedWhat = () => {
    /** @type {string[]} */
    const w = [];
    if (st.depthMax < maxDepth) {
      const ds = [];
      let nodes = 0;
      for (let d = maxDepth; d > st.depthMax; d--) {
        ds.push(d);
        nodes += depthCounts.get(d) ?? 0;
      }
      const lbl = ds.length === 1 ? `${ds[0]}` : `${ds.slice(0, -1).join(', ')} and ${ds[ds.length - 1]}`;
      w.push(`outline depth${ds.length === 1 ? '' : 's'} ${lbl} (${nodes} node${nodes === 1 ? '' : 's'})`);
    }
    const lost = SUM_ORDER.slice(0, st.sumOff).filter((d) => d <= st.depthMax);
    const cutLevel = SUM_ORDER[st.sumOff];
    const cut = cutLevel !== undefined && Number.isFinite(st.part) ? (perLevel.get(cutLevel) ?? 0) - st.part : 0;
    if (lost.length || cut) {
      if (!cut && lost.length === SUM_ORDER.filter((d) => d <= st.depthMax).length) w.push('all outline summaries');
      else {
        const parts = lost.map((d) => (d === 0 ? "the root's" : `depth ${d}`));
        if (cut) parts.push(`${cut} of ${perLevel.get(cutLevel)} at ${cutLevel === 0 ? 'the root' : `depth ${cutLevel}`}`);
        w.push(`summaries at ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`}`);
      }
    }
    if (st.bridges < s.bridges.length) w.push(`${s.bridges.length - st.bridges} of ${s.bridges.length} bridges`);
    if (st.sources < s.sources.length) w.push(`${s.sources.length - st.sources} of ${s.sources.length} sources`);
    if (st.thin < s.thinNodes.length) w.push(`${s.thinNodes.length - st.thin} of ${s.thinNodes.length} thin-area nodes`);
    if (st.insights < s.insights.length) w.push(`${s.insights.length - st.insights} of ${s.insights.length} insights`);
    if (st.briefCut) w.push('brief fields shortened');
    return w;
  };

  const fits = () => estimateTokens(render()) <= budget;
  if (fits()) return render();

  /** Shorten these sections from the end, in order; the largest keep that fits, by binary search. @param {('bridges'|'sources'|'thin'|'insights')[]} keys */
  const shrink = (keys) => {
    for (const key of keys) {
      const total = { bridges: s.bridges.length, sources: s.sources.length, thin: s.thinNodes.length, insights: s.insights.length }[key];
      if (!total) continue;
      st[key] = 0;
      if (!fits()) continue; // all of it goes, and the next section is cut too
      let lo = 0;
      let hi = total;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        st[key] = mid;
        if (fits()) lo = mid;
        else hi = mid - 1;
      }
      st[key] = lo;
      return true;
    }
    return fits();
  };

  // 1. drop summaries, deepest level first; the root's children keep theirs longest (labels stay).
  //    Within the level being cut, summaries go from the end of the outline, only as many as needed.
  while (st.sumOff < SUM_ORDER.length) {
    const total = perLevel.get(SUM_ORDER[st.sumOff]) ?? 0;
    st.part = 0;
    if (fits()) {
      let lo = 0;
      let hi = total;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        st.part = mid;
        if (fits()) lo = mid;
        else hi = mid - 1;
      }
      st.part = lo;
      return render();
    }
    st.sumOff += 1;
    st.part = Infinity;
    if (fits()) return render();
  }
  // 2. shorten Bridges, then Sources
  if (shrink(['bridges', 'sources'])) return render();
  // 3. only then drop the deepest labels (never depth 1 or the root), keeping as many bridges and
  //    sources as now fit again
  while (st.depthMax > 1) {
    st.depthMax -= 1;
    st.bridges = s.bridges.length;
    st.sources = s.sources.length;
    if (fits() || shrink(['bridges', 'sources'])) return render();
  }
  // 4. thin-area node lines, then insights
  if (shrink(['thin', 'insights'])) return render();
  // 5. shorten brief values
  st.briefCut = true;
  return render();
}
