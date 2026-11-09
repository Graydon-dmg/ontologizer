// @ts-check
// Rosetta: re-explain an ontology through the domain a persona already knows.
// One lens, one analog (plus where it breaks) per node, streamed in batches.
import PQueue from 'p-queue';
import { makeEvent } from '../events.js';
import { rosettaSystem, rosettaPrompt } from './prompts-g.js';

const BATCH_SIZE = 25;
const CONCURRENCY = 3;
const LEADING = /^(?:(?:someone|somebody|a person|a man|a woman|people)\s+(?:who|that)\s+(?:is|are|was)?\s*|(?:a|an|the|my|our|your|his|her|their|this|that|some|any)\s+)+/i;

/**
 * Slug of the persona's main noun: "a home chef" -> "chef".
 * @param {string} persona
 * @returns {string}
 */
export function lensSlug(persona) {
  const stripped = `${String(persona).trim()} `.replace(LEADING, '');
  const words = stripped.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const last = words.length ? words[words.length - 1] : '';
  return last.toLowerCase() || 'lens';
}

/** @param {string} s */
function slugName(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/**
 * @param {import('../schema.js').Ontology} ontology
 * @returns {{ id: string, path: string, summary: string }[]}
 */
function nodeInputs(ontology) {
  const nodes = ontology.nodes;
  return Object.values(nodes).map((n) => {
    const labels = [];
    const seen = new Set();
    /** @type {any} */
    let cur = n;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      labels.unshift(cur.label ?? cur.id);
      cur = cur.parent ? nodes[cur.parent] : null;
    }
    return { id: n.id, path: labels.join(' › '), summary: n.summary ?? '' };
  });
}

/**
 * @param {{ store: any, models: { fast: string, strong: string }, getClient: () => any,
 *           jsonLines: (src: AsyncIterable<string>) => AsyncIterable<any> }} ctx
 * @param {string} ontologyId
 * @param {string} persona
 * @param {{ name?: string, actor?: any }} [opts]  actor: stamped on the lens events (service mode)
 * @returns {Promise<string>} lensId
 */
export async function rosetta(ctx, ontologyId, persona, { name, actor = null } = {}) {
  /** @param {Record<string, any>} f */
  const as = (f) => (actor ? { ...f, actor } : f);
  if (typeof persona !== 'string' || !persona.trim()) {
    throw new Error('rosetta: persona is empty (who should the lens explain this to?)');
  }
  persona = persona.trim();
  if (persona.length > 200) throw new Error('rosetta: persona is too long (200 characters at most)');
  const ontology = ctx.store.read(ontologyId);
  const all = nodeInputs(ontology);
  if (!all.length) throw new Error('rosetta: the ontology has no nodes to explain');

  const startedAt = Date.now();
  // name may come from the browser: keep it to a kebab-case slug.
  const base = (name && slugName(String(name))) || lensSlug(persona);
  let lensId = base;
  for (let n = 2; ontology.lenses[lensId]; n++) lensId = `${base}-${n}`;

  ctx.store.append(ontologyId, makeEvent('lens.added', as({ lens: { id: lensId, persona, analogs: {} } }), startedAt));

  const subject = ontology.brief?.subject || ontology.name;
  /** @type {typeof all[]} */
  const batches = [];
  for (let i = 0; i < all.length; i += BATCH_SIZE) batches.push(all.slice(i, i + BATCH_SIZE));

  const queue = new PQueue({ concurrency: CONCURRENCY });
  /** @type {any} */
  let fatal = null;
  /** @type {any[]} */
  const failures = [];

  /** @param {typeof all} batch */
  async function runBatch(batch) {
    const ids = new Set(batch.map((n) => n.id));
    const answered = new Set();
    const client = ctx.getClient();
    const stream = client.messages.stream({
      model: ctx.models.strong,
      max_tokens: 16000,
      system: rosettaSystem(persona),
      messages: [{ role: 'user', content: rosettaPrompt({ subject, nodes: batch }) }],
      output_config: { effort: 'medium' },
    });
    async function* text() {
      for await (const e of stream) {
        if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') yield e.delta.text;
      }
    }
    for await (const obj of ctx.jsonLines(text())) {
      if (!obj || typeof obj.id !== 'string' || !ids.has(obj.id) || answered.has(obj.id)) continue;
      const label = typeof obj.analog === 'string' ? obj.analog.trim() : '';
      if (!label) continue;
      answered.add(obj.id);
      /** @type {Record<string, any>} */
      const fields = { lensId, nodeId: obj.id, label };
      if (typeof obj.breaks === 'string' && obj.breaks.trim()) fields.breaks = obj.breaks.trim();
      ctx.store.append(ontologyId, makeEvent('lens.analog', as(fields), startedAt));
    }
    // 'refusal' / 'max_tokens': keep whatever streamed, do not throw.
    await stream.finalMessage();
  }

  for (const batch of batches) {
    queue.add(async () => {
      if (fatal) return;
      try {
        await runBatch(batch);
      } catch (err) {
        if (/** @type {any} */ (err)?.status === 401) {
          fatal = err;
          queue.clear();
        } else {
          failures.push(err);
        }
      }
    });
  }
  await queue.onIdle();

  if (fatal) throw fatal;
  if (failures.length === batches.length) throw failures[0];
  return lensId;
}
