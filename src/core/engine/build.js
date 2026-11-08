// @ts-check
// The context check and the streaming build (waves 0 to 2). Writes only events, through ectx.emit.
import { isAuthError } from './call.js';
import { checkPrompt, wave0Prompt, wave1Prompt, wave2Prompt } from './prompts.js';
import { slug, childId, norm, findByLabelPath, labelPath } from './ids.js';

const LEVELS = new Set(['beginner', 'intermediate', 'expert']);
const LINK_TYPES = new Set(['influences', 'requires', 'part-of', 'bridge', 'analog']);
const MAX_CATEGORIES = 10;
const MAX_PER_CATEGORY = 25;
const MAX_EDGES = 25;
const MAX_INSIGHTS = 3;

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
  ectx.emit('ontology.created', { name: subject, root, brief, categories: [] });

  /** @param {object} p */
  const node = (p) => ({ summary: '', hook: '', sources: [], article: null, status: 'done', ...p });
  ectx.emit('node.added', {
    node: node({
      id: root, label: subject.charAt(0).toUpperCase() + subject.slice(1), parent: null, category: '', depth: 0,
      summary: str(brief.scope), hook: '', origin: 'seed', createdBy: 'wave0',
    }),
  });

  const taken = new Set([root]);

  // ---- Wave 0: categories, emitted as each line closes.
  /** @type {{ id: string, label: string }[]} */
  const categories = [];
  const seenCat = new Set();
  await ectx.call({ model: ectx.models.fast, effort: 'low', ...wave0Prompt(brief) }, (/** @type {any} */ obj) => {
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
        origin: 'context', createdBy: 'wave0',
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
      await ectx.call({ model: ectx.models.fast, effort: 'low', ...wave1Prompt(brief, cat.label, allLabels, depth) }, (/** @type {any} */ obj) => {
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
            origin: 'context', createdBy: 'wave1',
          }),
        });
      });
    };
    return ectx.queue.add({ kind: 'build', nodeId: cat.id }, work, { priority: 0 }).done;
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
