// @ts-check
export default {
  command: 'list',
  describe: 'List saved maps',
  builder: (/** @type {any} */ y) => y.option('drafts', { type: 'boolean', default: false, describe: 'Include drafts' }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const rows = deps.store().list({ drafts: Boolean(argv.drafts) });
    if (!rows.length) {
      deps.stdout.write('No saved maps yet. Run ontologizer new.\n');
      return;
    }
    for (const r of rows) {
      const when = new Date(r.updatedAt).toISOString();
      const title = r.name && r.name !== r.id ? `  ${r.name}` : '';
      deps.stdout.write(`${r.id}${r.draft ? '  (draft)' : ''}${title}  ${r.nodes} nodes  ${when}\n`);
    }
  },
};
