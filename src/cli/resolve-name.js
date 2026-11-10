// @ts-check
// Turn what the user typed into a map id or a node id; shared by the load/explain/research/fuse/rosetta commands.
import { CliError } from './deps.js';
import { engineFor, rethrowAuth, untilInterrupt } from './serve.js';

/**
 * @param {import('./deps.js').Deps} deps
 * @param {any} store
 * @param {string} name
 * @returns {Promise<string>}
 */
export async function resolveName(deps, store, name) {
  const r = store.resolve(name);
  if (typeof r === 'string') return r;
  /** @type {{ id: string, name: string, draft: boolean }[]} */
  const all = store.list({ drafts: true });
  const rows = r && typeof r === 'object' && 'ambiguous' in r
    ? all.filter((x) => r.ambiguous.includes(x.id))
    : all;
  const label = (/** @type {any} */ x) => x.name + (x.draft ? ' (draft)' : '');
  if (deps.interactive && rows.length) {
    const { search } = await deps.prompts();
    return await search({
      message: 'Which map?',
      source: async (/** @type {string | undefined} */ term) => {
        const t = (term || '').toLowerCase();
        return rows
          .filter((x) => !t || x.name.toLowerCase().includes(t) || x.id.toLowerCase().includes(t))
          .map((x) => ({ name: label(x), value: x.id }));
      },
    });
  }
  const list = rows.map((x) => `  ${label(x)}`).join('\n');
  if (r && typeof r === 'object' && 'ambiguous' in r) {
    throw new CliError(`"${name}" is ambiguous:\n${list}`, 1);
  }
  throw new CliError(`No map named "${name}".${rows.length ? ` Maps:\n${list}` : ' No maps yet: run ontologizer new.'}`, 1);
}

/**
 * @param {import('../core/schema.js').Ontology} onto
 * @param {string} ref
 * @returns {string}
 */
export function resolveNode(onto, ref) {
  const nodes = Object.values(onto.nodes);
  if (onto.nodes[ref]) return ref;
  const q = String(ref).toLowerCase();
  const byLabel = nodes.filter((n) => n.label.toLowerCase() === q);
  if (byLabel.length === 1) return byLabel[0].id;
  if (byLabel.length > 1) return byLabel.sort((a, b) => a.depth - b.depth)[0].id;
  const bySuffix = nodes.filter((n) => n.id === ref || n.id.endsWith(`/${ref}`));
  if (bySuffix.length === 1) return bySuffix[0].id;
  const byPrefix = nodes.filter((n) => n.label.toLowerCase().startsWith(q));
  if (byPrefix.length === 1) return byPrefix[0].id;
  const close = nodes.filter((n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).slice(0, 10);
  throw new CliError(
    `No node "${ref}" in this map.` + (close.length ? ` Did you mean:\n${close.map((n) => `  ${n.label} (${n.id})`).join('\n')}` : ''),
    1,
  );
}

/**
 * Wait for Ctrl-C, or for a hidden --exit-after <ms> timer.
 * @param {import('./deps.js').Deps} deps
 * @param {number | undefined} exitAfter
 */
export async function waitForExit(deps, exitAfter) {
  if (exitAfter === undefined || exitAfter === null) return untilInterrupt(deps);
  await new Promise((r) => setTimeout(r, Number(exitAfter)));
}

const JOB_TIMEOUT_MS = 10 * 60 * 1000;

/** At most this many nodes in one explain (the server's nodeIds cap too). */
export const NODES_MAX = 8;

/**
 * Shared body of `explain` (several nodes, `--sources` for the sources job) and `research` (one node):
 * send to a live session, or run headless. Every node is resolved before anything starts.
 * @param {any} argv
 * @param {'explain' | 'research' | 'sources'} kind
 */
export async function runNodeJob(argv, kind) {
  const deps = argv.deps;
  const store = deps.store();
  const id = await resolveName(deps, store, String(argv.name));
  const refs = (Array.isArray(argv.nodes) ? argv.nodes : [argv.node]).map(String);
  if (refs.length > NODES_MAX) throw new CliError(`At most ${NODES_MAX} nodes at once (you gave ${refs.length}).`, 1);
  const onto0 = store.read(id);
  const nodeIds = refs.map((r) => resolveNode(onto0, r));
  const twice = nodeIds.find((n, i) => nodeIds.indexOf(n) !== i);
  if (twice) throw new CliError(`${onto0.nodes[twice]?.label ?? twice} (${twice}) is listed twice.`, 1);
  const research = kind === 'research';
  const many = nodeIds.length > 1;
  const nodeId = nodeIds[0];
  const mode = argv.general ? 'general' : 'context';
  const labelOf = (/** @type {string} */ n) => `${store.read(id).nodes[n]?.label ?? n} (${n})`;

  const live = store.sessions.get(id);
  if (live) {
    const body = research ? { type: 'research', nodeId, mode } : many ? { type: kind, nodeIds } : { type: kind, nodeId };
    let res;
    try {
      res = await deps.fetch(`http://127.0.0.1:${live.port}/api/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new CliError(`Could not reach the open session: ${/** @type {Error} */ (err).message}`, 1);
    }
    /** @type {any} */
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw new CliError(String(data?.error ?? `The open session answered ${res.status}.`), 1);
    if (!many) {
      deps.stdout.write(`Sent to the open session (job ${data?.jobId ?? '?'}).\n`);
      return;
    }
    deps.stdout.write('Sent to the open session:\n');
    for (const j of Array.isArray(data?.jobs) ? data.jobs : []) {
      deps.stdout.write(`  ${labelOf(j.nodeId)}: ${j.jobId ? `job ${j.jobId}` : j.skipped ?? j.refused ?? 'sent'}\n`);
    }
    return;
  }

  // Headless. Several nodes: one already explained is skipped, as the server does.
  const todo = many && kind === 'explain' ? nodeIds.filter((n) => !onto0.nodes[n]?.article) : nodeIds;
  for (const n of nodeIds) if (!todo.includes(n)) deps.stdout.write(`${labelOf(n)}: already explained, skipped.\n`);
  if (!todo.length) return;
  const engine = await engineFor({ deps, store, id, needKey: true });
  /** @type {Map<string, any>} jobId -> its job.done or job.failed event */
  const outcomes = new Map();
  /** @type {Map<string, string>} nodeId -> jobId */
  const jobOf = new Map();
  /** @type {string[]} */
  const added = [];
  /** @type {any[]} */
  const finals = [];
  let wake = () => {};
  const finished = new Promise((r) => { wake = () => r(undefined); });
  const check = () => {
    for (const e of finals) if ([...jobOf.values()].includes(e.job.id)) outcomes.set(e.job.id, e);
    if (jobOf.size === todo.length && outcomes.size === new Set(jobOf.values()).size) wake();
  };
  const off = store.subscribe(id, (/** @type {any} */ e) => {
    if (e.t === 'node.added' && e.node?.parent === nodeId) added.push(e.node.id);
    if ((e.t === 'job.done' || e.t === 'job.failed') && e.job) finals.push(e);
    check();
  });
  /** @type {any} */
  let timer;
  try {
    for (const n of todo) {
      const job = research ? { kind: 'research', nodeId: n, mode } : { kind, nodeId: n };
      const r = await engine.enqueue(job, { priority: 10 });
      jobOf.set(n, typeof r === 'string' ? r : (r?.jobId ?? r?.id));
    }
    check();
    await Promise.race([
      finished,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new CliError('Timed out after 10 minutes.', 1)), JOB_TIMEOUT_MS); }),
    ]);
  } catch (err) {
    if (err instanceof CliError) throw err;
    rethrowAuth(err);
  } finally {
    clearTimeout(timer);
    off();
  }

  const onto = store.read(id);
  const out = deps.stdout;
  /** @type {string[]} */
  const failed = [];
  for (const n of todo) {
    const outcome = outcomes.get(/** @type {string} */ (jobOf.get(n)));
    if (outcome?.t === 'job.failed') {
      if (!many) throw new CliError(String(outcome.job.error ?? 'The job failed.'), 1);
      failed.push(`${labelOf(n)}: ${outcome.job.error ?? 'the job failed'}`);
      continue;
    }
    if (many) out.write(`\n== ${labelOf(n)} ==\n`);
    if (research) {
      out.write(`Added ${added.length} node${added.length === 1 ? '' : 's'} under ${onto.nodes[n]?.label ?? n}:\n`);
      for (const a of added) out.write(`  ${onto.nodes[a]?.label ?? a}\n`);
    } else if (kind === 'sources') {
      const list = onto.nodes[n]?.sources ?? [];
      out.write(list.length ? `Sources:\n${list.map((s) => `  - ${s.title} — ${s.url}`).join('\n')}\n` : '(no sources)\n');
    } else {
      const a = onto.nodes[n]?.article;
      if (!a) out.write('(no article)\n');
      else {
        out.write(`${a.summary}\n`);
        if (a.keyFacts?.length) out.write(`\nKey facts:\n${a.keyFacts.map((f) => `  - ${f}`).join('\n')}\n`);
        if (a.whyItMatters) out.write(`\nWhy it matters:\n  ${a.whyItMatters}\n`);
        if (a.seeAlso?.length) out.write(`\nSee also:\n${a.seeAlso.map((f) => `  - ${f}`).join('\n')}\n`);
        if (a.sources?.length) out.write(`\nSources:\n${a.sources.map((s) => `  - ${s.title} — ${s.url}`).join('\n')}\n`);
      }
    }
  }
  store.flush(id);
  if (failed.length) throw new CliError(`${failed.length} of ${todo.length} failed:\n${failed.map((f) => `  ${f}`).join('\n')}`, 1);
}
