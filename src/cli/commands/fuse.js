// @ts-check
import { CliError } from '../deps.js';
import { engineFor, rethrowAuth, serveSession } from '../serve.js';
import { resolveName, waitForExit } from '../resolve-name.js';

export default {
  command: 'fuse <a> <b> [more..]',
  describe: 'Fuse two maps into a new draft',
  builder: (/** @type {any} */ y) => y
    .positional('a', { type: 'string' })
    .positional('b', { type: 'string' })
    .positional('more', { type: 'string', array: true, hidden: true })
    .option('into', { type: 'string', describe: 'Name for the fused map' })
    .option('open', { type: 'boolean', default: true, hidden: true })
    .option('exit-after', { type: 'number', hidden: true }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    // Refuse a third map before any lookup, key prompt or model call.
    if (Array.isArray(argv.more) && argv.more.length > 0) {
      throw new CliError('fuse takes two maps; fuse the result again to add a third', 1);
    }
    const store = deps.store();
    const a = await resolveName(deps, store, String(argv.a));
    const b = await resolveName(deps, store, String(argv.b));
    const engine = await engineFor({ deps, store, id: a, needKey: true });
    let draftId;
    try {
      draftId = await engine.fuse(a, b, { into: argv.into });
    } catch (err) {
      try { rethrowAuth(err); } catch (e) { if (e instanceof CliError) throw e; }
      throw new CliError(/** @type {Error} */ (err).message, 1);
    }
    deps.stdout.write(`Fused into ${draftId}\n`);
    const eng2 = await engineFor({ deps, store, id: draftId, needKey: true });
    const srv = await serveSession({ deps, store, engine: eng2, id: draftId, open: argv.open });
    try {
      await waitForExit(deps, argv.exitAfter);
    } finally {
      await srv.close();
      store.flush(draftId);
    }
  },
};
