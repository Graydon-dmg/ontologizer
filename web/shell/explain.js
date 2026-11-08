// @ts-check
/** @typedef {import('../../src/core/schema.js').Ontology} Ontology */

/**
 * @param {Ontology} ontology @param {string} nodeId
 * @returns {{ node: any, article: any, researching: boolean,
 *   analog: { lensId: string, persona: string, label: string, breaks?: string }|null,
 *   seeAlso: { id: string, label: string }[], sources: { title: string, url: string }[] }|null}
 */
export function explainModel(ontology, nodeId) {
  const node = ontology.nodes[nodeId];
  if (!node) return null;
  const article = node.article || null;
  const researching = Object.values(ontology.jobs).some(
    (j) => j.kind === 'explain' && j.nodeId === nodeId && (j.state === 'queued' || j.state === 'running'),
  );
  let analog = null;
  const lensId = ontology.view.lens;
  const lens = lensId ? ontology.lenses[lensId] : null;
  const a = lens && lens.analogs ? lens.analogs[nodeId] : null;
  if (lens && a) analog = { lensId: lens.id, persona: lens.persona, label: a.label, breaks: a.breaks };
  /** @type {{ id: string, label: string }[]} */
  const seeAlso = [];
  const all = Object.values(ontology.nodes);
  for (const ref of (article && article.seeAlso) || []) {
    const hit = ontology.nodes[ref] || all.find((n) => n.label.toLowerCase() === String(ref).toLowerCase());
    if (hit && !seeAlso.some((s) => s.id === hit.id)) seeAlso.push({ id: hit.id, label: hit.label });
  }
  const sources = (article && article.sources && article.sources.length ? article.sources : node.sources) || [];
  return { node, article, researching, analog, seeAlso, sources };
}

/** How long a sent request may wait for its job to show up before we call it lost (ms). */
export const EXPLAIN_ANSWER_MS = 8000;

/**
 * The newest explain job for a node, if any.
 * @param {Ontology} ontology @param {string} nodeId
 */
export function latestExplainJob(ontology, nodeId) {
  const jobs = Object.values(ontology.jobs).filter((j) => j.kind === 'explain' && j.nodeId === nodeId);
  return jobs.length ? jobs[jobs.length - 1] : null;
}

/**
 * What the explain panel should show for a node.
 * @param {Ontology} ontology @param {string} nodeId
 * @param {{ state: 'sending'|'sent'|'error', jobId?: string, error?: string }|undefined} req  this page's own request
 * @returns {{ kind: 'article'|'writing'|'failed'|'idle', error?: string }}
 */
export function explainStatus(ontology, nodeId, req) {
  const node = ontology.nodes[nodeId];
  if (node && node.article) return { kind: 'article' };
  const job = latestExplainJob(ontology, nodeId);
  if (job && (job.state === 'queued' || job.state === 'running')) return { kind: 'writing' };
  if (req && req.state === 'sending') return { kind: 'writing' };
  if (req && req.state === 'sent' && !(req.jobId && ontology.jobs[req.jobId])) return { kind: 'writing' };
  if (req && req.state === 'error') return { kind: 'failed', error: req.error };
  if (job && job.state === 'failed') return { kind: 'failed', error: job.error || 'The explanation failed.' };
  return { kind: 'idle' };
}

/**
 * This page's explain requests: one per node at a time, never a duplicate of a running job.
 * @param {{ act: (a: any) => Promise<any>, snapshot: () => Ontology, now?: () => number,
 *           onChange?: () => void, answerMs?: number }} o
 */
export function createExplainRequests({ act, snapshot, now = () => Date.now(), onChange = () => {}, answerMs = EXPLAIN_ANSWER_MS }) {
  /** @type {Map<string, { state: 'sending'|'sent'|'error', jobId?: string, error?: string, at: number }>} */
  const reqs = new Map();
  return {
    /** @param {string} nodeId */
    get: (nodeId) => reqs.get(nodeId),
    /**
     * Ask for an explanation unless one exists or is already being written.
     * @param {string} nodeId
     * @returns {Promise<{ sent: boolean, ok?: boolean, error?: string, reason?: string }>}
     */
    async request(nodeId) {
      const o = snapshot();
      const st = explainStatus(o, nodeId, reqs.get(nodeId));
      if (st.kind === 'article') return { sent: false, reason: 'article' };
      if (st.kind === 'writing') return { sent: false, reason: 'writing' };
      reqs.set(nodeId, { state: 'sending', at: now() });
      onChange();
      let r;
      try { r = await act({ type: 'explain', nodeId }); } catch (err) { r = { ok: false, error: String(err && /** @type {any} */ (err).message || err) }; }
      if (r && r.ok !== false) reqs.set(nodeId, { state: 'sent', jobId: r.jobId, at: now() });
      else reqs.set(nodeId, { state: 'error', error: `Could not ask for an explanation: ${(r && r.error) || 'the server refused'}`, at: now() });
      onChange();
      return { sent: true, ok: !!(r && r.ok !== false), error: r && r.error };
    },
    /** Turn sent requests whose job never appeared into errors. Returns true if anything changed. */
    expire() {
      const o = snapshot();
      let changed = false;
      for (const [id, q] of reqs) {
        if (q.state === 'sent' && !(q.jobId && o.jobs[q.jobId]) && now() - q.at > answerMs) {
          reqs.set(id, { state: 'error', error: 'No answer from the server. Is ontologizer still running?', at: now() });
          changed = true;
        }
      }
      if (changed) onChange();
      return changed;
    },
  };
}
