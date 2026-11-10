// @ts-check
import { CliError } from '../deps.js';
import { resolveHome } from './status.js';
import { findConfig, loadConfig, ConfigError } from '../../server/config.js';
import { createSources } from '../../server/sources.js';

const NONE = 'No sources configured. Add a sources list to ontologizer.config.js (see docs/GUIDE.md, "Ports and private sources").';

export default {
  command: 'sources [action] [target]',
  describe: 'List and test the MCP sources in ontologizer.config.js (read-only)',
  builder: (/** @type {any} */ y) => y
    .positional('action', { type: 'string', describe: 'list | test' })
    .positional('target', { type: 'string', describe: 'Source name (test)' })
    .option('config', { type: 'string', describe: 'Config file (default: ONTOLOGIZER_CONFIG, then <home>/ontologizer.config.js)' })
    .option('home', { type: 'string', describe: 'Store home directory' })
    .option('json', { type: 'boolean', default: false, describe: 'Print JSON' }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const action = argv.action;
    if (action !== 'list' && action !== 'test') throw new CliError('Usage: ontologizer sources list | test <name>', 1);
    if (action === 'test' && !argv.target) throw new CliError('sources test needs a source name.', 1);
    /** @type {any} */
    let config = null;
    try {
      const file = findConfig({ flag: argv.config, env: deps.env ?? process.env, home: resolveHome(argv, deps) });
      if (file) config = await loadConfig(file);
    } catch (/** @type {any} */ err) {
      if (err instanceof ConfigError) throw new CliError(err.message, 1);
      throw err;
    }
    const entries = config?.sources ?? [];
    if (!entries.length) {
      if (action === 'test') throw new CliError(`No source named "${argv.target}". Configured: none.`, 1);
      deps.stdout.write(argv.json ? '[]\n' : `${NONE}\n`);
      return;
    }
    const sources = createSources(entries);
    try {
      if (action === 'list') {
        const rows = await sources.status({});
        if (argv.json) {
          deps.stdout.write(`${JSON.stringify(rows)}\n`);
        } else {
          for (const r of rows) {
            deps.stdout.write(`${r.name}  ${r.visibility}  tools ${r.allowTools.join(',')}  ${r.reachable ? 'reachable' : `unreachable: ${r.error}`}\n`);
          }
        }
        return;
      }
      const name = String(argv.target);
      if (!sources.get(name)) throw new CliError(`No source named "${name}". Configured: ${sources.names().join(', ')}.`, 1);
      const [row] = await sources.status({ names: [name] });
      if (!row.reachable) throw new CliError(`${name}: unreachable: ${row.error}`, 1);
      if (argv.json) {
        deps.stdout.write(`${JSON.stringify(row)}\n`);
      } else {
        deps.stdout.write(`${name} (${row.visibility}): reachable\n`);
        for (const t of row.tools ?? []) deps.stdout.write(`  ${t.name}  ${t.offered ? 'offered' : `not offered: ${t.why}`}\n`);
      }
    } finally {
      await sources.close();
    }
  },
};
