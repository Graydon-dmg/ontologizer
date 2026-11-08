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

/**
 * Shared body of `explain` and `research`: send to a live session, or run headless.
 * @param {any} argv
 * @param {'explain' | 'research'} kind
 */
export async function runNodeJob(argv, kind) {
  const deps = argv.deps;
  const store = deps.store();
  const id = await resolveName(deps, store, String(argv.name));
  const nodeId = resolveNode(store.read(id), String(argv.node));
  const research = kind === 'research';
  const mode = argv.general ? 'general' : 'context';

  const live = store.sessions.get(id);
  if (live) {
    const body = research ? { type: 'research', nodeId, mode } : { type: 'explain', nodeId };
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
    deps.stdout.write(`Sent to the open session (job ${data?.jobId ?? '?'}).\n`);
    return;
  }

  const engine = await engineFor({ deps, store, id, needKey: true });
  /** @type {any} */
  let outcome = null;
  /** @type {string[]} */
  const added = [];
  /** @type {string | null} */
  let jobId = null;
  /** @type {any[]} */
  const finals = [];
  let wake = () => {};
  const finished = new Promise((r) => { wake = () => r(undefined); });
  const check = () => {
    if (jobId === null || outcome) return;
    const hit = finals.find((e) => e.job.id === jobId);
    if (hit) { outcome = hit; wake(); }
  };
  const off = store.subscribe(id, (/** @type {any} */ e) => {
    if (e.t === 'node.added' && e.node?.parent === nodeId) added.push(e.node.id);
    if ((e.t === 'job.done' || e.t === 'job.failed') && e.job) finals.push(e);
    check();
  });
  /** @type {any} */
  let timer;
  try {
    const job = research ? { kind: 'research', nodeId, mode } : { kind: 'explain', nodeId };
    const r = await engine.enqueue(job, { priority: 10 });
    jobId = typeof r === 'string' ? r : (r?.jobId ?? r?.id);
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
  if (outcome.t === 'job.failed') throw new CliError(String(outcome.job.error ?? 'The job failed.'), 1);

  const onto = store.read(id);
  const out = deps.stdout;
  if (research) {
    out.write(`Added ${added.length} node${added.length === 1 ? '' : 's'} under ${onto.nodes[nodeId]?.label ?? nodeId}:\n`);
    for (const a of added) out.write(`  ${onto.nodes[a]?.label ?? a}\n`);
  } else {
    const a = onto.nodes[nodeId]?.article;
    if (!a) out.write('(no article)\n');
    else {
      out.write(`${a.summary}\n`);
      if (a.keyFacts?.length) out.write(`\nKey facts:\n${a.keyFacts.map((f) => `  - ${f}`).join('\n')}\n`);
      if (a.whyItMatters) out.write(`\nWhy it matters:\n  ${a.whyItMatters}\n`);
      if (a.seeAlso?.length) out.write(`\nSee also:\n${a.seeAlso.map((f) => `  - ${f}`).join('\n')}\n`);
      if (a.sources?.length) out.write(`\nSources:\n${a.sources.map((s) => `  - ${s.title} — ${s.url}`).join('\n')}\n`);
    }
  }
  store.flush(id);
}
