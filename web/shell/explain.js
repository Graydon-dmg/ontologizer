// @ts-check
/** @typedef {import('../../src/core/schema.js').Ontology} Ontology */

/** A source ref has a string `source` field (a web source has title and url only). @param {any} s */
export const isRef = (s) => !!s && typeof s.source === 'string';

/** The url when it is http or https, else null. @param {any} u @returns {string|null} */
export function safeHttpUrl(u) {
  if (typeof u !== 'string') return null;
  try { const p = new URL(u).protocol; return p === 'http:' || p === 'https:' ? u : null; } catch { return null; }
}

/** One list item for a source ref: "<source> · <title or ref>", a link only for an http(s) url.
 * @param {any} r @returns {{ text: string, href: string|null }} */
export const refItem = (r) => ({ text: `${r.source} · ${r.title || r.ref || ''}`, href: safeHttpUrl(r.url) });

/**
 * The Private badge: private once the snapshot says so or a visibility.raised event arrives, and
 * never back (nothing lowers visibility, so anything else in an event is ignored).
 * @param {any} snapshot @param {any[]} [events] @param {{ show: boolean, title: string }} [prev]
 * @returns {{ show: boolean, title: string }}
 */
export function privateBadge(snapshot, events = [], prev) {
  const names = new Set(prev && prev.show ? prev.title.replace(/^Private: built from /, '').split(', ').filter((n) => n && n !== 'Private') : []);
  let show = !!(prev && prev.show);
  if (snapshot && snapshot.visibility === 'private') show = true;
  for (const n of (snapshot && snapshot.privateSources) || []) names.add(n);
  for (const e of events) {
    if (e && e.t === 'visibility.raised' && e.to === 'private') { show = true; for (const n of e.sources || []) names.add(n); }
  }
  if (!show) return { show: false, title: '' };
  const list = [...names].sort();
  return { show: true, title: list.length ? `Private: built from ${list.join(', ')}` : 'Private' };
}

/**
 * @param {Ontology} ontology @param {string} nodeId
 * @returns {{ node: any, article: any, researching: boolean,
 *   analog: { lensId: string, persona: string, label: string, breaks?: string }|null,
 *   seeAlso: { id: string, label: string }[], sources: { title: string, url: string }[], refs: { text: string, href: string|null }[] }|null}
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
  const webOnly = (/** @type {any[]|undefined} */ l) => (l || []).filter((s) => !isRef(s));
  const artWeb = webOnly(article && article.sources);
  const sources = artWeb.length ? artWeb : webOnly(node.sources);
  const refs = (node.sources || []).filter(isRef).map(refItem);
  return { node, article, researching, analog, seeAlso, sources, refs };
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

/**
 * A "See also" link: open the panel ON that node (so a node without an article shows
 * "Write an explanation", and explanations chain), and focus it on the map. The focus runs after
 * the panel is drawn, so the view centres it inside the updated insets.
 * @param {{ openExplain: (id: string) => void, act: (a: any) => any, activeView: () => any }} shell
 * @param {string} nodeId
 * @param {(fn: () => void) => void} [later]
 */
export function followSeeAlso(shell, nodeId, later = (fn) => fn()) {
  shell.openExplain(nodeId);
  later(() => {
    shell.act({ type: 'focus', nodeId });
    const v = shell.activeView();
    if (v && typeof v.setFocus === 'function') v.setFocus(nodeId);
  });
}
