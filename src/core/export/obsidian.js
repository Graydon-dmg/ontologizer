// @ts-check
// Obsidian export: the map as a folder of linked notes (one per node, plus an index note named after
// the map) and `.obsidian/graph.json`, whose colour groups give Obsidian's graph view the map's
// category colours. Pure (no Node, no DOM, no import outside src/core): the `export` command writes the
// files, the page zips them. Both pass in tokens.js categoryColor, so the graph matches the page.
//
// Map text came from a model that read the web, so every value is untrusted. Note names are made
// here and only here (wikilinks point at generated names, never at raw text); body text is one line
// with every markdown, HTML and Obsidian marker backslash-escaped; frontmatter values are quoted
// YAML strings.
import { webUrl } from './context.js';

/** @typedef {import('../schema.js').Ontology} Ontology */
/** @typedef {import('../schema.js').OntoNode} OntoNode */
/** @typedef {{ path: string, text: string }} VaultFile */

/** The longest note or folder name, in characters (before ".md"). */
export const NAME_MAX = 120;
const FIELD_MAX = 2000;

// Characters a file name or wikilink target may not hold: path separators and Windows-reserved
// characters, and Obsidian's link syntax (# heading, ^ block, [ ] link, | alias).
const BAD_NAME = /[/\\:*?"<>|#^[\]%$`]/g; // also % $ ` (comments, math, code in link text)
// Control, zero-width, bidi-override and line/paragraph separator characters.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** The first `max` characters (whole code points), trimmed. @param {string} s @param {number} max */
// At most `max` characters and at most 240 UTF-8 bytes (Linux file systems cap a name at 255 bytes;
// the rest is left for " (Category)", a number and ".md").
const NAME_BYTES = 200;
const enc = new TextEncoder();
const cap = (s, max) => {
  let cps = [...s];
  if (cps.length > max) cps = cps.slice(0, max);
  while (cps.length && enc.encode(cps.join('')).length > NAME_BYTES) cps.pop();
  return cps.join('');
};

/**
 * A safe note (or folder) name for this text: no separators or reserved characters, one line,
 * no leading or trailing dots or spaces, at most `max` characters, never empty, never a Windows
 * device name.
 * @param {unknown} text @param {number} [max]
 */
export function safeName(text, max = NAME_MAX) {
  let t = String(text ?? '').normalize('NFC').replace(INVISIBLE, ' ').replace(/[/\\]/g, '-').replace(BAD_NAME, ' ').replace(/\s+/g, ' ');
  const tidy = (/** @type {string} */ s) => s.replace(/^[\s.]+|[\s.]+$/g, '');
  t = tidy(cap(tidy(t), max));
  if (!t) t = 'Untitled';
  // Windows refuses a device name before any extension too ("CON.md", "lpt1.txt.md").
  const dot = t.indexOf('.');
  const stem = dot < 0 ? t : t.slice(0, dot);
  if (RESERVED.test(stem.trim())) t = `${stem.trim()} (note)${dot < 0 ? '' : t.slice(dot)}`;
  return t;
}

/** The key two names collide on: file systems and Obsidian links ignore case. @param {string} s */
// Case-insensitive file systems (macOS, Windows) fold more than toLowerCase does (ς/σ, ı/i, ß): fold
// the same way so two notes can never land on one file.
const nameKey = (s) => s.normalize('NFKC').toUpperCase().toLowerCase().replace(/ς/g, 'σ').replace(/ı/g, 'i');

/** The text as one line. @param {unknown} s @param {number} [max] */
function line(s, max = FIELD_MAX) {
  let t = String(s ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  if ([...t].length > max) t = `${cap(t, max - 1).trimEnd()}…`;
  return t;
}

/**
 * Untrusted text as one line of inert markdown: every character that could start HTML, a link, a
 * wikilink or embed, a tag, a block id, a comment (%%), a highlight, math, emphasis, a table or a
 * code span is backslash-escaped (CommonMark renders "\x" as a literal x), and a leading list,
 * quote or heading marker is escaped too. So "[[x]]" shows as text, "<b>" is never HTML, "#tag"
 * is never a tag, and no value can end the frontmatter or start a block.
 * @param {unknown} s @param {number} [max]
 */
export function mdText(s, max = FIELD_MAX) {
  const t = line(s, max).replace(/[\\`*_[\]<>#^|~=$%]/g, '\\$&').replace(/::/g, ':\\:'); // no Dataview inline fields
  return t.replace(/^[-+>]/, '\\$&').replace(/^(\d+)([.)])/, '$1\\$2');
}

/** A YAML double-quoted string: JSON's escapes are YAML's, plus the separators YAML 1.1 breaks on. @param {unknown} s */
export function yamlString(s) {
  // Obsidian reads "[[x]]" in a property as a link: split the brackets so a value never links.
  return JSON.stringify(line(s).replace(/\[(?=\[)/g, '[ ').replace(/\](?=\])/g, '] ')).replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** A tag: lowercase letters, digits and dashes, never only digits. @param {unknown} s */
function tagSlug(s) {
  const t = String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return /[a-z]/.test(t) ? t : t ? `c-${t}` : '';
}

/** A CSS `hsl(h s% l%)` as Obsidian's colour integer (0xRRGGBB). @param {string} css */
export function hslToRgbInt(css) {
  const m = /hsl\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(css);
  if (!m) return 0x888888;
  const h = Number(m[1]) % 360; const s = Number(m[2]) / 100; const l = Number(m[3]) / 100;
  const k = (/** @type {number} */ n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (/** @type {number} */ n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/**
 * The map as an Obsidian vault folder.
 * @param {Ontology} ontology
 * @param {{ colorOf?: (index: number, family: number) => string }} [opts] a category's CSS colour
 *   (`hsl(h s% l%)`), normally tokens.js categoryColor; without it every group is grey.
 * @returns {{ folder: string, index: string, notes: VaultFile[], config: VaultFile[] }}
 *   folder: the folder's name (the map's name, made safe). index: the index note's file name.
 *   notes: the .md files, paths relative to the folder. config: `.obsidian/graph.json`, to write
 *   only into a fresh folder.
 */
export function obsidianVault(ontology, { colorOf = () => 'hsl(0 0% 53%)' } = {}) {
  if (!ontology || typeof ontology !== 'object' || !ontology.nodes) throw new Error('The Obsidian export needs a map snapshot.');
  const o = ontology;
  const nodes = o.nodes;
  const mapName = line(o.name) || 'Map';
  const folder = safeName(mapName);
  const priv = o.visibility === 'private';
  const privateSources = (o.privateSources || []).map((s) => line(s, 100));

  // Categories: label, tag, colour.
  /** @type {Map<string, { label: string, tag: string, rgb: number }>} */
  const cats = new Map();
  const tagsTaken = new Set(['ontologizer']);
  for (const c of o.categories || []) {
    if (!c || cats.has(c.id)) continue;
    let tag = tagSlug(c.label) || `category-${cats.size + 1}`;
    for (let i = 2; tagsTaken.has(tag); i++) tag = `${tagSlug(c.label) || 'category'}-${i}`;
    tagsTaken.add(tag);
    cats.set(c.id, { label: line(c.label, 200), tag, rgb: hslToRgbInt(colorOf(Number(c.index) || 0, Number(c.family) || 0)) });
  }

  // Node order: by depth, then the map's own order, so names are handed out the same way every time.
  const order = Object.keys(nodes);
  const pos = new Map(order.map((id, i) => [id, i]));
  const ids = [...order].sort((a, b) => (Number(nodes[a].depth) || 0) - (Number(nodes[b].depth) || 0) || /** @type {number} */ (pos.get(a)) - /** @type {number} */ (pos.get(b)));
  const rootId = nodes[o.root] ? o.root : null;

  // Note names: the root's note is the index, named after the map; the rest take their label, then
  // "Label (Category)", then "Label 2", "Label 3", ... Names are unique ignoring case.
  /** @type {Map<string, string>} */
  const nameOf = new Map();
  const taken = new Set();
  const claim = (/** @type {string} */ id, /** @type {string} */ name) => { nameOf.set(id, name); taken.add(nameKey(name)); };
  const free = (/** @type {string} */ name) => !taken.has(nameKey(name));
  taken.add(nameKey(folder));
  if (rootId) nameOf.set(rootId, folder);
  for (const id of ids) {
    if (id === rootId) continue;
    const n = nodes[id];
    const base = safeName(n.label);
    if (free(base)) { claim(id, base); continue; }
    const cat = cats.get(n.category);
    if (cat) {
      const c = safeName(cat.label, 40);
      const withCat = `${safeName(n.label, NAME_MAX - c.length - 3)} (${c})`;
      if (free(withCat)) { claim(id, withCat); continue; }
    }
    for (let i = 2; ; i++) {
      const suffix = ` ${i}`;
      const name = `${safeName(n.label, NAME_MAX - suffix.length)}${suffix}`;
      if (free(name)) { claim(id, name); break; }
    }
  }
  const link = (/** @type {string} */ id) => `[[${nameOf.get(id)}]]`;

  // Children and cross-links, in the map's order.
  /** @type {Map<string, string[]>} */
  const kids = new Map();
  for (const id of order) {
    const p = nodes[id].parent;
    if (id !== rootId && p && nodes[p] && p !== id) kids.set(p, [...(kids.get(p) ?? []), id]);
  }
  /** @type {Map<string, string[]>} */
  const links = new Map();
  const addLink = (/** @type {string} */ id, /** @type {string} */ text) => links.set(id, [...(links.get(id) ?? []), text]);
  for (const e of o.edges || []) {
    if (!e || !nodes[e.from] || !nodes[e.to]) continue;
    const kind = mdText(e.type, 40) || 'related';
    const why = e.why ? `: ${mdText(e.why)}` : '';
    addLink(e.from, `- ${kind} → ${link(e.to)}${why}`);
    if (e.to !== e.from) addLink(e.to, `- ${kind} ← ${link(e.from)} (incoming)${why}`);
  }

  // Lens analogies: persona → this node's analog.
  /** @type {Map<string, string[]>} */
  const analogies = new Map();
  for (const lens of Object.values(o.lenses || {})) {
    for (const [nid, a] of Object.entries(lens?.analogs || {})) {
      if (!nodes[nid] || !a?.label) continue;
      const breaks = a.breaks ? ` (where it breaks: ${mdText(a.breaks)})` : '';
      analogies.set(nid, [...(analogies.get(nid) ?? []), `- As ${mdText(lens.persona, 200)}: ${mdText(a.label, 300)}${breaks}`]);
    }
  }

  const privateLine = priv
    ? `> [!warning] Private map\n> Made with private sources${privateSources.length ? ` (${privateSources.map((s) => mdText(s, 100)).join(', ')})` : ''}. Share it only with people who may read them.`
    : null;

  /** @param {string} id @param {string[]} extraTags @returns {string} */
  function frontmatter(id, extraTags) {
    const n = nodes[id];
    const cat = cats.get(n.category);
    const out = ['---'];
    if (cat) out.push(`category: ${yamlString(cat.label)}`);
    out.push(`depth: ${Number.isInteger(n.depth) ? n.depth : 0}`);
    out.push('tags:', '  - ontologizer', ...extraTags.map((t) => `  - ${t}`), ...(cat ? [`  - ${cat.tag}`] : []));
    const label = line(n.label, 500);
    if (label && label !== nameOf.get(id)) out.push('aliases:', `  - ${yamlString(label)}`);
    out.push(`source: ${yamlString(mapName)}`);
    if (priv) out.push('visibility: "private"');
    out.push('---', '');
    return out.join('\n');
  }

  /** @param {any[]} list */
  const sourceLines = (list) => {
    const seen = new Set();
    /** @type {string[]} */
    const out = [];
    for (const x of Array.isArray(list) ? list : []) {
      const title = typeof x?.source === 'string' ? `${x.source} · ${x?.title || x?.ref || ''}` : (x?.title || '');
      const url = webUrl(x?.url);
      const key = url || `text:${line(title)}`;
      if (seen.has(key) || (!url && !line(title))) continue;
      seen.add(key);
      const shown = mdText(title, 300) || mdText(url, 300);
      out.push(url ? `- [${shown}](${url})` : `- ${shown}`);
    }
    return out;
  };

  /** The sections every note shares. @param {string} id @returns {string[]} */
  function body(id) {
    const n = nodes[id];
    const out = [];
    const summary = mdText(n.summary);
    if (summary) out.push(summary, '');
    const a = /** @type {any} */ (n.article);
    if (a) {
      out.push('## Article', '');
      if (a.summary) out.push(mdText(a.summary), '');
      const facts = (Array.isArray(a.keyFacts) ? a.keyFacts : []).map((f) => mdText(f)).filter(Boolean);
      if (facts.length) out.push('### Key facts', '', ...facts.map((f) => `- ${f}`), '');
      if (a.whyItMatters) out.push('### Why it matters', '', mdText(a.whyItMatters), '');
    }
    const p = n.parent;
    if (id !== rootId && p && nodes[p]) out.push(`Part of: ${link(p)}`, '');
    const k = kids.get(id) ?? [];
    if (k.length) out.push(`Branches: ${k.map(link).join(', ')}`, '');
    const l = links.get(id) ?? [];
    if (l.length) out.push('## Links', '', ...l, '');
    const an = analogies.get(id) ?? [];
    if (an.length) out.push('## Analogies', '', ...an, '');
    const s = sourceLines([...(n.sources || []), ...(a?.sources || [])]);
    if (s.length) out.push('## Sources', '', ...s, '');
    return out;
  }

  /** @type {VaultFile[]} */
  const notes = [];
  for (const id of ids) {
    if (id === rootId) continue;
    const text = [frontmatter(id, []), ...(privateLine ? [privateLine, ''] : []), ...body(id)].join('\n').replace(/\n+$/, '\n');
    notes.push({ path: `${nameOf.get(id)}.md`, text });
  }

  // The index note: the brief, the categories with their top nodes, the insights, then the root's own sections.
  const b = /** @type {any} */ (o.brief || {});
  const idx = [];
  if (rootId) idx.push(frontmatter(rootId, ['ontologizer-index']));
  else idx.push(['---', 'tags:', '  - ontologizer', '  - ontologizer-index', `source: ${yamlString(mapName)}`, ...(priv ? ['visibility: "private"'] : []), '---', ''].join('\n'));
  if (privateLine) idx.push(privateLine, '');
  idx.push(`A map made with Ontologizer: ${Object.keys(nodes).length} notes, ${(o.edges || []).length} cross-links.`, '');
  if (b.subject) idx.push(`**Subject:** ${mdText(b.subject)}`, '');
  if (b.scope) idx.push(`**Scope:** ${mdText(b.scope)}`, '');
  for (const [cid, cat] of cats) {
    const inCat = ids.filter((id) => id !== rootId && nodes[id].category === cid);
    if (!inCat.length) continue;
    const head = nodes[cid] && cid !== rootId ? cid : null;
    const top = head ? [head, ...(kids.get(head) ?? [])] : inCat.filter((id) => nodes[id].depth === nodes[inCat[0]].depth);
    idx.push(`## ${mdText(cat.label, 200)}`, '', ...top.map((id) => `- ${link(id)}`), '');
  }
  const insights = (o.insights || []).map((i) => mdText(i?.text)).filter(Boolean);
  if (insights.length) idx.push('## Insights', '', ...insights.map((t) => `- ${t}`), '');
  if (rootId) {
    const own = body(rootId);
    if (own.length) idx.push('## About', '', ...own);
  }
  notes.unshift({ path: `${folder}.md`, text: idx.join('\n').replace(/\n+$/, '\n') });

  const graph = {
    'collapse-color-groups': false,
    colorGroups: [...cats.values()].map((c) => ({ query: `tag:#${c.tag}`, color: { a: 1, rgb: c.rgb } })),
  };
  return { folder, index: `${folder}.md`, notes, config: [{ path: '.obsidian/graph.json', text: `${JSON.stringify(graph, null, 2)}\n` }] };
}
