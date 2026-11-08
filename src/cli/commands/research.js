// @ts-check
import { runNodeJob } from '../resolve-name.js';

export default {
  command: 'research <name> <node>',
  describe: 'Grow the map under one node',
  builder: (/** @type {any} */ y) => y
    .positional('name', { type: 'string' })
    .positional('node', { type: 'string', describe: 'Node id or label' })
    .option('general', { type: 'boolean', default: false, describe: 'Research the topic in general, not just for your brief' }),
  handler: (/** @type {any} */ argv) => runNodeJob(argv, 'research'),
};
