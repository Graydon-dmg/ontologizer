// @ts-check
// ontologizer usage: model calls and tokens per tenant per UTC day, read from <home>/usage.json.
import { resolveHome } from './status.js';
import { readUsageFile } from '../../server/usage.js';
import { CliError } from '../deps.js';

export default {
  command: 'usage',
  describe: 'Show model calls and tokens per tenant per day (counts, not money)',
  builder: (/** @type {any} */ y) => y
    .option('home', { type: 'string', describe: 'Store home directory' })
    .option('days', { type: 'number', default: 7, describe: 'How many recent days to show' })
    .option('json', { type: 'boolean', default: false, describe: 'Print one JSON object' }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const home = resolveHome(argv, deps);
    const days = Number(argv.days ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 31) throw new CliError('--days must be a whole number from 1 to 31.', 1);
    const file = readUsageFile(home);
    /** @type {Record<string, Record<string, { calls: number, inputTokens: number, outputTokens: number }>>} */
    const tenants = {};
    for (const [t, byDay] of Object.entries(file.tenants).sort(([a], [b]) => a.localeCompare(b))) {
      const recent = Object.keys(byDay).sort().reverse().slice(0, days);
      if (recent.length) tenants[t] = Object.fromEntries(recent.map((d) => [d, byDay[d]]));
    }
    if (argv.json) { deps.stdout.write(`${JSON.stringify({ home, tenants })}\n`); return; }
    const names = Object.keys(tenants);
    if (!names.length) { deps.stdout.write(`No model usage recorded in ${home} yet.\n`); return; }
    const out = [];
    for (const t of names) {
      out.push(`Tenant ${t}`);
      for (const [d, c] of Object.entries(tenants[t])) out.push(`  ${d}  ${c.calls} calls  ${c.inputTokens} in  ${c.outputTokens} out tokens`);
    }
    out.push('These are model calls and tokens, not money.');
    deps.stdout.write(`${out.join('\n')}\n`);
  },
};
