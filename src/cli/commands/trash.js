// @ts-check
// `ontologizer trash`: the deleted maps in this home, newest first. Each is purged for good 30 days
// after it was deleted (when a store opens, and once a day in `serve`).
import { TRASH_DAYS } from '../../core/store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export default {
  command: 'trash',
  describe: `List deleted maps (each is purged ${TRASH_DAYS} days after it was deleted)`,
  builder: (/** @type {any} */ y) => y.option('json', { type: 'boolean', default: false, describe: 'Print JSON' }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const items = deps.store().listTrash();
    if (argv.json) {
      deps.stdout.write(`${JSON.stringify(items.map((/** @type {any} */ t) => ({ ...t, purgeAt: t.deletedAt + TRASH_DAYS * DAY_MS })), null, 2)}\n`);
      return;
    }
    if (!items.length) { deps.stdout.write('The trash is empty.\n'); return; }
    for (const t of items) {
      const day = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, 10);
      const title = t.name && t.name !== t.id ? `  ${t.name}` : '';
      const by = t.deletedBy?.id ? ` by ${t.deletedBy.id}` : '';
      deps.stdout.write(`${t.trashId}${t.draft ? '  (draft)' : ''}${title}  ${t.nodes} nodes  ${t.visibility === 'private' ? 'private' : 'public'}  deleted ${day(t.deletedAt)}${by}  purged after ${day(t.deletedAt + TRASH_DAYS * DAY_MS)}\n`);
    }
    deps.stdout.write('Bring one back with: ontologizer restore <trash-id> [--as <name>]\n');
  },
};
