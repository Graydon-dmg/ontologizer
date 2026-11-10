// @ts-check
// The context check and the streaming build (waves 0 to 2). Writes only events, through ectx.emit.
import { isAuthError } from './call.js';
import { checkPrompt, wave0Prompt, wave1Prompt, wave2Prompt } from './prompts.js';
import { slug, childId, norm, findByLabelPath, labelPath } from './ids.js';
import { sourcesNote } from './run.js';

/**
 * A wave's call with the run's source tools (when it has any): the tools are offered and the system
 * prompt says how to cite them. Without tools the call is exactly as before.
 * @param {any} ectx @param {{ system: string, prompt: string }} p
 */
function grounded(ectx, p) {
  return ectx.run?.hasTools ? { ...p, system: p.system + sourcesNote(ectx.run.tools) + pickedNote(ectx.chosen), useTools: true } : p;
}

/**
 * When the reader picked sources in New map: they are the reader's chosen references, and each
 * category is searched in them before its nodes are written. Nothing is added when none were picked.
 * @param {string[]|undefined} chosen
 */
export function pickedNote(chosen) {
  if (!Array.isArray(chosen) || !chosen.length) return '';
  return `
The reader chose these sources as the references for this map: ${chosen.join(', ')}. Before you write the lines for a category, search these sources for it with their tools, and base the lines on what they return, citing each document you use. Use general knowledge only where they have nothing.`;
}

/** The verified refs of a line (only refs a tool returned in this run); [] without tools. @param {any} ectx @param {any} obj */
const citeOf = (ectx, obj) => (ectx.cite ? ectx.cite(obj?.sources) : []);

const LEVELS = new Set(['beginner', 'intermediate', 'expert']);
const LINK_TYPES = new Set(['influences', 'requires', 'part-of', 'bridge', 'analog']);
const MAX_CATEGORIES = 10;
const MAX_PER_CATEGORY = 25;
const MAX_EDGES = 25;
const MAX_INSIGHTS = 3;

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);

/**
 * A short root label: the subject without qualifiers ("(...)", ": ...", ", ...", " - ..."), at most
 * 4 words, Title Case. Words that already carry capitals ("3D", "DNA", "iPhone") are kept as written.
 * @param {string} subject
 */
export function rootLabel(subject) {
  const head = String(subject ?? '').replace(/\s*[([{].*$/, '').split(/\s*[:;,\u2013\u2014]\s*|\s+-\s+/)[0].trim();
  const words = (head || String(subject ?? '').trim()).split(/\s+/).filter(Boolean).slice(0, 4);
  while (words.length > 1 && SMALL.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.map((w, i) => {
    if (/[A-Z]/.test(w.slice(1)) || /\d/.test(w)) return w;
    const lower = w.toLowerCase();
    return i > 0 && SMALL.has(lower) ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ') || 'Map';
}

/** @param {any} v */
const str = (v) => (typeof v === 'string' ? v : '');

/** A usable label: a non-empty string of at most 80 chars once trimmed, else null. @param {any} v */
function validLabel(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= 80 ? s : null;
}

/**
 * Answers may be strings or objects; make them [{ id, question, answer }].
 * @param {any[]} answers
 */
function normaliseAnswers(answers) {
  /** @type {{ id: string, question?: string, answer: string }[]} */
  const out = [];
  (Array.isArray(answers) ? answers : []).forEach((a, i) => {
    if (typeof a === 'string') { if (a.trim()) out.push({ id: `q${i + 1}`, answer: a }); return; }
    if (!a || typeof a !== 'object' || a.answer == null) return;
    const entry = /** @type {{ id: string, question?: string, answer: string }} */ ({ id: str(a.id) || `q${i + 1}`, answer: String(a.answer) });
    const q = str(a.question) || str(a.text);
    if (q) entry.question = q;
    out.push(entry);
  });
  return out;
}

/**
 * @param {any} ectx @param {string} context @param {any[]} [answers]
 * @returns {Promise<{ ready: true, brief: any, name: string } | { ready: false, questions: { id: string, text: string, options: string[] }[] }>}
 */
export async function check(ectx, context, answers = []) {
  const { system, prompt } = checkPrompt(context, normaliseAnswers(answers));
  /** @type {any} */
  let first = null;
  await ectx.call({ model: ectx.models.fast, effort: 'low', system, prompt }, (/** @type {any} */ obj) => {
    if (first === null) first = obj;
  });
  if (first === null) throw new Error('check: the model returned no answer');

  if (first.ready === true) {
    const b = first.brief && typeof first.brief === 'object' ? first.brief : {};
    const level = str(b.level).trim().toLowerCase();
    const brief = {
      context: String(context),
      subject: str(b.subject).trim(),
      scope: str(b.scope),
      purpose: str(b.purpose),
      level: LEVELS.has(level) ? level : 'beginner',
    };
    if (brief.subject) return { ready: true, brief, name: slug(str(first.name) || brief.subject) };
  }

  const questions = (Array.isArray(first.questions) ? first.questions : [])
    .filter((/** @type {any} */ q) => q && typeof q === 'object' && typeof q.id === 'string' && q.id && typeof q.text === 'string' && q.text)
    .slice(0, 3)
    .map((/** @type {any} */ q) => ({
      id: q.id,
      text: q.text,
      options: (Array.isArray(q.options) ? q.options : []).filter((/** @type {any} */ o) => typeof o === 'string').slice(0, 5),
    }));
  if (!questions.length) questions.push({ id: 'subject', text: 'What exactly do you want to explore?', options: [] });
  return { ready: false, questions };
}

/**
 * @param {any} ectx @param {any} brief @param {{ depth?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function build(ectx, brief, { depth = 2 } = {}) {
  ectx.resetClock();
  const subject = String(brief.subject);
  const root = slug(subject);
  // Service mode writes ontology.created (and a picked private source's raise) with the draft, before
  // the build is even queued: then the build starts from there instead of writing them again.
  const already = Boolean(ectx.store.read(ectx.id).root);
  if (!already) ectx.emit('ontology.created', { name: subject, root, brief, categories: [] });
  // Private sources picked in New map make the map private before anything else is written (not even
  // the root node is ever public), durably, whether or not the build ends up using them.
  if (ectx.picked?.length && !already) {
    ectx.emit('visibility.raised', { to: 'private', reason: 'sources-picked', sources: [...new Set(/** @type {string[]} */ (ectx.picked))].sort() });
    await ectx.durable?.();
  }

  /** @param {object} p */
  const node = (p) => ({ summary: '', hook: '', sources: [], article: null, status: 'done', ...p });
  ectx.emit('node.added', {
    node: node({
      id: root, label: rootLabel(subject), parent: null, category: '', depth: 0,
      summary: str(brief.scope), hook: '', origin: 'seed', createdBy: 'wave0',
    }),
  });

  const taken = new Set([root]);

  // ---- Wave 0: categories, emitted as each line closes.
  /** @type {{ id: string, label: string }[]} */
  const categories = [];
  const seenCat = new Set();
  await ectx.call({ model: ectx.models.fast, effort: 'low', ...grounded(ectx, wave0Prompt(brief)) }, (/** @type {any} */ obj) => {
    const label = validLabel(obj?.label);
    if (!label || seenCat.has(norm(label)) || categories.length >= MAX_CATEGORIES) return;
    seenCat.add(norm(label));
    const id = childId(root, label, taken);
    taken.add(id);
    const index = categories.length;
    categories.push({ id, label });
    ectx.emit('category.added', { category: { id, label, index, family: 0 } });
    ectx.emit('node.added', {
      node: node({
        id, label, parent: root, category: id, depth: 1, summary: str(obj.summary), hook: str(obj.hook),
        origin: 'context', createdBy: 'wave0', sources: citeOf(ectx, obj),
      }),
    });
  });
  if (!categories.length) throw new Error('build: the model returned no categories');

  // ---- Wave 1: one queued job per category.
  const allLabels = categories.map((c) => c.label);
  const jobs = categories.map((cat) => {
    const work = async () => {
      /** @type {Map<string, { id: string, depth: number }>} */
      const local = new Map();          // norm(label) -> node this call added
      const seen = new Set();           // parentId|norm(label)
      let count = 0;
      await ectx.call({ model: ectx.models.fast, effort: 'low', ...grounded(ectx, wave1Prompt(brief, cat.label, allLabels, depth)) }, (/** @type {any} */ obj) => {
        const label = validLabel(obj?.label);
        if (!label || count >= MAX_PER_CATEGORY) return;
        let parentId = cat.id;
        let parentDepth = 1;
        const hit = typeof obj.parent === 'string' ? local.get(norm(obj.parent)) : undefined;
        if (hit && hit.depth + 1 <= depth) { parentId = hit.id; parentDepth = hit.depth; }
        const key = `${parentId}|${norm(label)}`;
        if (seen.has(key)) return;
        seen.add(key);
        count++;
        const id = childId(parentId, label, taken);
        taken.add(id);
        if (!local.has(norm(label))) local.set(norm(label), { id, depth: parentDepth + 1 });
        ectx.emit('node.added', {
          node: node({
            id, label, parent: parentId, category: cat.id, depth: parentDepth + 1, summary: str(obj.summary), hook: str(obj.hook),
            origin: 'context', createdBy: 'wave1', sources: citeOf(ectx, obj),
          }),
        });
      });
    };
    return ectx.queue.add({ kind: 'build', nodeId: cat.id }, work, { priority: 0, actor: ectx.actor ?? null }).done;
  });
  const outcomes = await Promise.all(jobs);
  for (const o of outcomes) if (!o.ok && isAuthError(o.error)) throw o.error;

  // ---- Wave 2: cross-links and insights (strong model). Failures here keep the finished map.
  try {
    const nodes = ectx.store.read(ectx.id).nodes;
    const paths = Object.values(nodes)
      .filter((/** @type {any} */ n) => n.id !== root)
      .map((/** @type {any} */ n) => labelPath(nodes, n.id).slice(1).join(' > '));
    const linked = new Set();
    let edges = 0;
    let insights = 0;
    await ectx.call({ model: ectx.models.strong, effort: 'medium', ...wave2Prompt(brief, paths) }, (/** @type {any} */ obj) => {
      if (obj && typeof obj.from === 'string' && typeof obj.to === 'string') {
        if (edges >= MAX_EDGES) return;
        const from = findByLabelPath(nodes, obj.from);
        const to = findByLabelPath(nodes, obj.to);
        if (!from || !to || from === to || nodes[from].parent === to || nodes[to].parent === from) return;
        const pair = [from, to].sort().join('\u0000');
        if (linked.has(pair)) return;
        linked.add(pair);
        edges++;
        const type = LINK_TYPES.has(obj.type) ? obj.type : 'influences';
        ectx.emit('edge.added', { edge: { id: `e${edges}`, from, to, type, why: str(obj.why) } });
      } else if (obj && typeof obj.insight === 'string' && obj.insight.trim()) {
        if (insights >= MAX_INSIGHTS) return;
        insights++;
        /** @type {{ text: string, nodeId?: string }} */
        const fields = { text: obj.insight };
        const about = typeof obj.about === 'string' ? findByLabelPath(nodes, obj.about) : null;
        if (about) fields.nodeId = about;
        ectx.emit('insight', fields);
      }
    });
  } catch (e) {
    if (isAuthError(e)) throw e;
  }
}
