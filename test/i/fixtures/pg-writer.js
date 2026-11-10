// @ts-check
// Child process for store-pg-durability.test.js: opens the Postgres store on a pool whose INSERTs are
// slowed by ~30 ms (so a SIGKILL always lands while writes are in flight), creates a draft, appends
// WRITER_N events one by one and prints "ack <i>" for each.
//   WRITER_MODE=sync   prints the ack after `await store.sync()`  (the correct order)
//   WRITER_MODE=early  prints the ack BEFORE sync()               (planted fault: respond before flush)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPostgresStore } from '../../../src/store-postgres/index.js';

const url = process.env.ONTOLOGIZER_PG_URL;
const tenant = process.env.WRITER_TENANT ?? 'writer';
const n = Number(process.env.WRITER_N ?? 8);
const early = process.env.WRITER_MODE === 'early';
const root = process.env.WRITER_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'onto-pg-writer-'));

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const pg = await import('pg');
const real = new pg.default.Pool({ connectionString: url, max: 4 });
/** @param {any} db */
const slow = (db) => async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
  if (/^\s*INSERT/i.test(sql)) await sleep(30);
  return db.query(sql, params);
};
const pool = {
  query: slow(real),
  connect: async () => { const c = await real.connect(); return { query: slow(c), release: () => c.release() }; },
  end: () => real.end(),
};

const store = openPostgresStore({ pool, tenant, root });
await store.ready;
const id = store.createDraft({ topic: 'kill' }, 'Kill');
await store.sync();
process.stdout.write(`draft ${id}\n`);
for (let i = 0; i < n; i++) {
  store.append(id, i === 0
    ? { t: 'ontology.created', at: 0, name: 'Kill', root: 'root', brief: { topic: 'kill' }, categories: [] }
    : { t: 'node.added', at: i, node: { id: `n${i}`, label: `n${i}`, parent: 'root', category: 'c', summary: '', tags: [] } });
  if (!early) await store.sync();
  process.stdout.write(`ack ${i}\n`);
}
await store.sync();
await store.close();
await real.end();
