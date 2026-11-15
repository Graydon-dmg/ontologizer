// @ts-check
// `ontologizer hydrate <map> (--all | --nodes a,b)`: write job, examples and not_for on nodes, in
// batches of siblings, with the local engine. Refuses while a server runs on the home.
import { CliError } from '../deps.js';
import { openStore } from '../../core/store.js';
import { runningServer, serverRefusal } from '../served.js';
import { resolveName } from '../resolve-name.js';
import { engineFor, rethrowAuth } from '../serve.js';
import { validateHydrate, selectHydrate, planBatches, estimate, dedupeKey } from '../../server/actions/hydrate.js';

/** How long the CLI waits for every batch; tests shorten it with ONTOLOGIZER_HYDRATE_TIMEOUT_MS. */
const timeoutMs = (/** @type {any} */ env) => Number(env?.ONTOLOGIZER_HYDRATE_TIMEOUT_MS) || 30 * 60 * 1000;

export default {
  command: 'hydrate <map>',
  describe: 'Write agent-facing fields (job, examples, look-alikes) on nodes, in batches of siblings',
  builder: (/** @type {any} */ y) => y
    .positional('map', { type: 'string', describe: 'The map\'s id or name' })
    .option('all', { type: 'boolean', describe: 'Every node except the root' })
    .option('nodes', { type: 'string', describe: 'Node ids, comma-separated: a,b,c' })
    .option('model', { choices: ['sonnet', 'haiku'], default: 'sonnet', describe: 'haiku is cheaper, weaker on look-alikes' })
    .option('redo', { type: 'boolean', default: false, describe: 'Hydrate nodes again even if they already have fields' })
    .option('home', { type: 'string', describe: 'Store home directory' }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const store = argv.home ? openStore(String(argv.home)) : deps.store();
    const server = runningServer(store);
    if (server) throw new CliError(serverRefusal(server, /** @type {any} */ ('hydrate')), 1);
    const id = await resolveName(deps, store, String(argv.map));
    const o = store.read(id);
    const body = {
      ...(argv.nodes !== undefined ? { nodeIds: String(argv.nodes).split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      ...(argv.all ? { all: true } : {}),
      model: argv.model ?? 'sonnet',
    };
    const bad = validateHydrate(o, body);
    if (bad) throw new CliError(bad, 1);
    // No server runs on this home (refused above) and this run's engine has started nothing yet, so a
    // hydrate job the log shows as queued or running is stale: its process stopped. It skips nothing.
    const { selected, skipped } = selectHydrate(o, { nodeIds: body.nodeIds, all: body.all, redo: !!argv.redo, live: new Set() });
    const batches = planBatches(o, selected);
    const out = deps.stdout;
    /** @type {Map<string, string[]>} */ const why = new Map();
    for (const s of skipped) why.set(s.reason, [...(why.get(s.reason) ?? []), s.nodeId]);
    for (const [reason, ids] of why) out.write(`Skipped ${ids.length} (${reason}): ${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ', …' : ''}\n`);
    out.write(`${batches.length} batches, about ${estimate(batches).calls} calls\n`);
    if (!batches.length) { out.write('Hydrated 0 of 0 nodes\n'); return; }

    const engine = await engineFor({ deps, store, id, needKey: deps.env.ONTOLOGIZER_ENGINE !== 'stub' });
    /** @type {Map<string, any>} jobId -> batch */ const byJob = new Map();
    /** @type {Map<string, any>} jobId -> its job.done or job.failed (may arrive before enqueue returns) */ const finals = new Map();
    /** @type {Set<string>} */ const reported = new Set();
    /** @type {Set<string>} nodes this run hydrated */ const hydrated = new Set();
    let wake = () => {};
    const all = new Promise((r) => { wake = () => r(undefined); });
    const check = () => {
      for (const [jobId, b] of byJob) {
        const e = finals.get(jobId);
        if (!e || reported.has(jobId)) continue;
        reported.add(jobId);
        out.write(`batch ${b.batch} (${b.parentId}, ${b.nodeIds.length} node${b.nodeIds.length === 1 ? '' : 's'}): ${e.t === 'job.done' ? 'done' : e.job.error ?? 'failed'}\n`);
      }
      if (byJob.size === batches.length && reported.size === byJob.size) wake();
    };
    const off = store.subscribe(id, (/** @type {any} */ e) => {
      if (e.t === 'node.hydrated' && typeof e.nodeId === 'string') hydrated.add(e.nodeId);
      if ((e.t === 'job.done' || e.t === 'job.failed') && typeof e.job?.id === 'string') { finals.set(e.job.id, e); check(); }
    });
    /**
     * Ctrl-C or the timeout: this process stops, so its unfinished batches would stay "queued" or
     * "running" in the log forever. Mark each one failed ("interrupted") first.
     */
    const abandon = () => {
      for (const [jobId, b] of byJob) {
        if (finals.has(jobId)) continue;
        store.append(id, { t: 'job.failed', at: store.now(id), job: { id: jobId, kind: 'hydrate', nodeId: b.parentId, nodeIds: b.nodeIds, error: 'interrupted' } });
      }
    };
    /** @type {any} */ let timer;
    /** @type {() => void} */ let offSignal = () => {};
    const stopped = new Promise((_, rej) => {
      offSignal = deps.onSignal('SIGINT', () => rej(new CliError('Interrupted: the unfinished batches are marked failed. Run it again to finish them.', 130)));
    });
    stopped.catch(() => {});   // handled by the race below, even when Ctrl-C comes before it starts
    try {
      for (const b of batches) {
        const r = await engine.enqueue({ kind: 'hydrate', nodeId: b.parentId, dedupeKey: dedupeKey(b.parentId, b.nodeIds), nodeIds: b.nodeIds, model: body.model }, { priority: 5 });
        byJob.set(typeof r === 'string' ? r : (r?.jobId ?? r?.id), b);
      }
      check();
      await Promise.race([all, stopped, new Promise((_, rej) => { timer = setTimeout(() => rej(new CliError(`Timed out after ${Math.round(timeoutMs(deps.env) / 60000)} minutes: the unfinished batches are marked failed.`, 1)), timeoutMs(deps.env)); })]);
    } catch (err) {
      abandon();
      if (err instanceof CliError) throw err;
      rethrowAuth(err);
    } finally {
      clearTimeout(timer);
      offSignal();
      off();
    }

    const failed = selected.filter((n) => !hydrated.has(n));
    out.write(`Hydrated ${selected.length - failed.length} of ${selected.length} nodes\n`);
    if (failed.length) throw new CliError(`Failed: ${failed.join(', ')}`, 1);
  },
};

