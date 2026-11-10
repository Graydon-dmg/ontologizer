// @ts-check
export default {
  command: 'list',
  describe: 'List saved maps',
  builder: (/** @type {any} */ y) => y.option('drafts', { type: 'boolean', default: false, describe: 'Include drafts' }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const store = deps.store();
    const rows = store.list({ drafts: Boolean(argv.drafts) });
    if (!rows.length) {
      deps.stdout.write('No saved maps yet. Run ontologizer new.\n');
      return;
    }
    // Visibility comes from the index row (no event log is read), goes last so the existing columns
    // keep their places, and is shown only when some map is private (so an all-public list is unchanged).
    const anyPrivate = rows.some((r) => r.visibility === 'private');
    for (const r of rows) {
      const when = new Date(r.updatedAt).toISOString();
      const title = r.name && r.name !== r.id ? `  ${r.name}` : '';
      const visibility = anyPrivate ? `  ${r.visibility ?? 'public'}` : '';
      deps.stdout.write(`${r.id}${r.draft ? '  (draft)' : ''}${title}  ${r.nodes} nodes  ${when}${visibility}\n`);
    }
  },
};
