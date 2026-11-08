// @ts-check
import fs from 'node:fs';
import { CliError } from '../deps.js';
import { engineFor, serveSession, checkPort } from '../serve.js';
import { resolveName, waitForExit } from '../resolve-name.js';

export default {
  command: 'load <name>',
  describe: 'Open a saved map (add --replay to watch it build again)',
  builder: (/** @type {any} */ y) => y
    .positional('name', { type: 'string', describe: 'Map name (a prefix works)' })
    .option('replay', { type: 'boolean', default: false, describe: 'Replay the build as it happened' })
    .option('speed', { type: 'number', default: 1, describe: 'Replay speed multiplier' })
    .option('port', { type: 'number', default: 0, describe: 'Port to serve on (default: a free one)' })
    .option('open', { type: 'boolean', default: true, hidden: true })
    .option('exit-after', { type: 'number', hidden: true }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const store = deps.store();
    const name = String(argv.name);
    const speed = argv.speed;
    if (!(speed > 0)) throw new CliError('--speed must be greater than 0.', 1);
    if (store.resolve(name) === null && /^[a-z0-9][a-z0-9-]*$/.test(name)) {
      const file = new URL(`../../../fixtures/${name}.events.jsonl`, import.meta.url);
      if (fs.existsSync(file)) {
        const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        store.importEvents(name, events);
        deps.stdout.write(`Imported the bundled "${name}" map.\n`);
      }
    }
    const id = await resolveName(deps, store, name);
    const engine = await engineFor({ deps, store, id, needKey: false });
    const srv = await serveSession({ deps, store, engine, id, replay: argv.replay ? { speed } : null, open: argv.open, port: checkPort(argv.port) });
    deps.stdout.write(`${Object.keys(store.read(id).nodes).length} nodes.\n`);
    try {
      await waitForExit(deps, argv.exitAfter);
    } finally {
      await srv.close();
      store.flush(id);
    }
  },
};
