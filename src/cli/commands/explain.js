// @ts-check
import { runNodeJob, NODES_MAX } from '../resolve-name.js';

export default {
  command: 'explain <name> <nodes..>',
  describe: `Write an article for each node (at most ${NODES_MAX}); --sources finds web sources instead`,
  builder: (/** @type {any} */ y) => y
    .positional('name', { type: 'string' })
    .positional('nodes', { type: 'string', array: true, describe: 'Node ids or labels: each one is its own job (a model call)' })
    .option('sources', { type: 'boolean', default: false, describe: 'Find web sources for each node (the Sources button) instead of writing its article' }),
  handler: (/** @type {any} */ argv) => runNodeJob(argv, argv.sources ? 'sources' : 'explain'),
};
