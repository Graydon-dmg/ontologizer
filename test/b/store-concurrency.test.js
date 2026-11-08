// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../src/core/store.js';
import { tempHome, fixtureEvents } from './helpers.js';

const STORE = fileURLToPath(new URL('../../src/core/store.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../fixtures/manga.events.jsonl', import.meta.url));
const N = 8;

// Each child waits for a shared "go" file, so all N hit index.json at the same moment.
// (With node -e, the first extra argument is process.argv[1].) It gives up after 10 s.
const BARRIER = `const fs=require('fs');const t0=Date.now();while(!fs.existsSync(process.argv[1]+'/go')){if(Date.now()-t0>10000)process.exit(9)}`;
// The real thing: openStore(home).importEvents(name, events).
const REAL = `${BARRIER};import(${JSON.stringify(STORE)}).then(({openStore})=>{
  const ev=fs.readFileSync(${JSON.stringify(FIXTURE)},'utf8').split('\\n').filter(Boolean).map(JSON.parse);
  openStore(process.argv[1]).importEvents(process.argv[2], ev);
})`;
// Planted fault: the old unlocked read-modify-write (with a short gap between read and write).
const UNLOCKED = `${BARRIER};const f=process.argv[1]+'/index.json';
  let idx={current:null,ontologies:[]};try{idx=JSON.parse(fs.readFileSync(f,'utf8'))}catch{}
  const t=Date.now();while(Date.now()-t<50){}
  idx.ontologies.push({id:process.argv[2],name:process.argv[2],root:'',nodes:0,updatedAt:1,draft:false});
  fs.writeFileSync(f+'.'+process.pid,JSON.stringify(idx));fs.renameSync(f+'.'+process.pid,f);`;

/** Run N children at once with `script`; resolve with their exit codes. @param {string} home @param {string} script */
async function race(home, script) {
  const kids = Array.from({ length: N }, (_, i) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, ['-e', script, home, `map-${i}`], { stdio: ['ignore', 'ignore', 'inherit'] });
      c.on('exit', (code) => resolve(code));
    }));
  await new Promise((r) => setTimeout(r, 300)); // let every child reach the barrier
  fs.writeFileSync(path.join(home, 'go'), '');
  return Promise.all(kids);
}

test('N concurrent imports in separate processes all end up listed', async () => {
  const home = tempHome();
  openStore(home); // creates the folder
  const codes = await race(home, REAL);
  assert.deepEqual(codes, Array(N).fill(0));
  const ids = openStore(home).list().map((r) => r.id).sort();
  assert.deepEqual(ids, Array.from({ length: N }, (_, i) => `map-${i}`).sort());
  assert.equal(fs.existsSync(path.join(home, 'index.json.lock')), false, 'lock left behind');
});

test('planted fault: the unlocked read-modify-write loses rows under the same race', async () => {
  const home = tempHome();
  await race(home, UNLOCKED);
  const rows = JSON.parse(fs.readFileSync(path.join(home, 'index.json'), 'utf8')).ontologies;
  assert.ok(rows.length < N, `expected lost rows, got all ${rows.length}`);
});

test('self-heal: a map folder with no index row is re-registered instead of refused', () => {
  const home = tempHome();
  const store = openStore(home);
  store.importEvents('manga', fixtureEvents('manga'));
  // Lose the row, as the race used to.
  const file = path.join(home, 'index.json');
  const idx = JSON.parse(fs.readFileSync(file, 'utf8'));
  idx.ontologies = [];
  fs.writeFileSync(file, JSON.stringify(idx));
  assert.equal(store.resolve('manga'), null);
  assert.equal(store.importEvents('manga', fixtureEvents('manga')), 'manga'); // used to throw "already exists"
  const row = store.list().find((r) => r.id === 'manga');
  assert.ok(row && row.nodes > 0);
  // With the row present it still refuses a duplicate.
  assert.throws(() => store.importEvents('manga', fixtureEvents('manga')), /already exists/);
});
