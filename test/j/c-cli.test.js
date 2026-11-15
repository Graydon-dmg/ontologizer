// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// C · `ontologizer add-node <map> --parent <id> --label <label>` on a temp home (the handler is called
// directly: it is not in main()'s COMMANDS yet). It writes one node through addNode(), prints
// `Added <id> under <parent>`, refuses while a server runs on the home, and every refusal writes
// nothing. Each check has a planted fault (a broken copy of src/cli/commands/add-node.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../../src/core/store.js';
import { makeDeps } from '../../src/cli/deps.js';
import { fixtureEvents } from '../i/helpers-service.js';
import { faultyModule } from '../i/helpers-fault.js';

const COMMAND = 'src/cli/commands/add-node.js';
const FAULTS = {
  /** Ignores a server running on the home. */
  noServeCheck: [['    if (server) throw new CliError(', '    if (false) throw new CliError(']],
  /** Writes the node as another actor. */
  wrongActor: [['actor: LOCAL_ACTOR', "actor: { id: 'x', kind: 'agent' }"]],
  /** Swallows a refusal from addNode() and says it added the node. */
  ignoresRefusal: [["if (r.status !== 201) throw new CliError(`ontologizer: ${r.error}`);", "if (r.status !== 201) { deps.stdout.write(`Added ${argv.parent}/${argv.label} under ${argv.parent}\\n`); return; }"]],
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-add-node-cli-'));
function cap() { return { out: '', write(/** @type {string} */ s) { this.out += s; return true; } }; }
/** @param {string} map @param {string} fixture */
function seeded(map = 'demo', fixture = 'demo') {
  const home = tmp();
  openStore(home).importEvents(map, fixtureEvents(fixture));
  return home;
}
/** The events written to a map, read with a fresh store. @param {string} home @param {string} id */
async function events(home, id) {
  /** @type {any[]} */ const out = [];
  for await (const e of openStore(home).events(id)) out.push(e);
  return out;
}

/**
 * Run the command's handler (the real one, or a broken copy), as main() would.
 * @param {string} home @param {{ map?: string, parent: string, label: string, summary?: string }} a
 * @param {Array<[string, string]>} [fault]
 */
async function run(home, { map = 'demo', parent, label, summary }, fault) {
  const mod = fault ? await faultyModule(COMMAND, fault) : await import('../../src/cli/commands/add-node.js');
  const stdout = cap(); const stderr = cap();
  const deps = makeDeps({ home, stdout, stderr, interactive: false, env: { ...process.env, ONTOLOGIZER_HOME: home } });
  try {
    await mod.default.handler({ deps, map, parent, label, summary });
    return { code: 0, stdout: stdout.out, message: '' };
  } catch (/** @type {any} */ e) { return { code: e.code ?? 1, stdout: stdout.out, message: String(e.message) }; }
}

/** A refusal: exit 1, the message, and not one event written. @param {{ code: number, message: string }} r @param {RegExp} msg @param {number} before @param {number} after */
function refusalProblems(r, msg, before, after) {
  /** @type {string[]} */ const p = [];
  if (r.code !== 1) p.push(`exit ${r.code}`);
  if (!msg.test(r.message)) p.push(`message: ${r.message}`);
  if (after !== before) p.push(`${after - before} event(s) written`);
  return p;
}

const ROOT = 'scale-plastic-modeling';

test('writes one node and prints "Added <id> under <parent>"; the event is a local human add_node', async () => {
  const home = seeded();
  const parent = `${ROOT}/kits-and-brands`;
  const r = await run(home, { parent, label: 'Resin Kits', summary: ' Short run. ' });
  const id = `${parent}/resin-kits`;
  const evs = await events(home, 'demo');
  const added = evs.filter((e) => e.t === 'node.added' && e.node.id === id);
  /** @type {string[]} */ const p = [];
  if (r.code !== 0) p.push(`exit ${r.code}: ${r.message}`);
  if (r.stdout !== `Added ${id} under ${parent}\n`) p.push(`stdout: ${JSON.stringify(r.stdout)}`);
  if (added.length !== 1) p.push(`${added.length} node.added events`);
  else {
    if (JSON.stringify(added[0].actor) !== JSON.stringify({ id: 'local', kind: 'human' })) p.push(`actor: ${JSON.stringify(added[0].actor)}`);
    if (added[0].node.createdBy !== 'add_node') p.push(`createdBy: ${added[0].node.createdBy}`);
    if (added[0].node.summary !== 'Short run.') p.push(`summary: ${added[0].node.summary}`);
  }
  const n = openStore(home).read('demo').nodes[id];
  if (!n || n.parent !== parent || n.label !== 'Resin Kits') p.push('the folded map lacks the node');
  assert.deepEqual(p, []);
  // Planted fault: a command that stamps another actor must trip the same check.
  const bh = seeded();
  await run(bh, { parent, label: 'Resin Kits' }, FAULTS.wrongActor);
  const bad = (await events(bh, 'demo')).find((e) => e.t === 'node.added' && e.node.id === id);
  assert.notDeepEqual(bad?.actor, { id: 'local', kind: 'human' });
});

test('works on another map and under the root (a new category)', async () => {
  const home = seeded('plastic-modeling', 'plastic-modeling');
  const r = await run(home, { map: 'plastic-modeling', parent: 'plastic-modeling', label: 'Safety' });
  assert.equal(r.message, '');
  assert.equal(r.stdout, 'Added plastic-modeling/safety under plastic-modeling\n');
  const o = openStore(home).read('plastic-modeling');
  assert.equal(o.nodes['plastic-modeling/safety'].category, 'plastic-modeling/safety');
  assert.ok(o.categories.some((c) => c.id === 'plastic-modeling/safety'));
});

/** @param {string} home @param {Array<[string, string]>} [fault] */
async function serverRefusal(home, fault) {
  const s = openStore(home);
  s.sessions.addServer({ pid: process.ppid, port: 1, url: 'http://x', startedAt: Date.now() });
  const before = (await events(home, 'demo')).length;
  const r = await run(home, { parent: ROOT, label: 'Fresh' }, fault);
  return { r, before, after: (await events(home, 'demo')).length };
}

test('refuses (exit 1, nothing written) while a server runs on the home', async () => {
  const real = await serverRefusal(seeded());
  assert.deepEqual(refusalProblems(real.r, /^ontologizer: a server is running on this home \(pid \d+, http:\/\/x\)/, real.before, real.after), []);
  // Planted fault: a command that ignores the server writes the node.
  const bad = await serverRefusal(seeded(), FAULTS.noServeCheck);
  assert.notDeepEqual(refusalProblems(bad.r, /^ontologizer: a server is running/, bad.before, bad.after), []);
});

/** @param {string} home @param {{ parent: string, label: string }} a @param {Array<[string, string]>} [fault] */
async function badInput(home, a, fault) {
  const before = (await events(home, 'demo')).length;
  const r = await run(home, a, fault);
  return { r, before, after: (await events(home, 'demo')).length };
}

test('unknown parent, a duplicate label (any case) and an 81-character label are refused, nothing written', async () => {
  const cases = /** @type {Array<[{ parent: string, label: string }, RegExp]>} */ ([
    [{ parent: 'nope', label: 'X' }, /^ontologizer: no node "nope"$/],
    [{ parent: ROOT, label: '  KITS AND BRANDS ' }, /^ontologizer: .*already exists under/],
    [{ parent: ROOT, label: 'a'.repeat(81) }, /^ontologizer: label must be 1 to 80 characters$/],
  ]);
  for (const [a, msg] of cases) {
    const x = await badInput(seeded(), a);
    assert.deepEqual(refusalProblems(x.r, msg, x.before, x.after), [], a.label);
    assert.equal(x.r.stdout, '', 'nothing is printed to stdout');
  }
  // Planted fault: a command that swallows addNode()'s refusal must trip the same check.
  const bad = await badInput(seeded(), cases[0][0], FAULTS.ignoresRefusal);
  assert.notDeepEqual(refusalProblems(bad.r, cases[0][1], bad.before, bad.after), []);
});

test('a second add of the same label is refused with the first one kept', async () => {
  const home = seeded();
  const a = { parent: `${ROOT}/kits-and-brands`, label: 'Resin Kits' };
  assert.equal((await run(home, a)).code, 0);
  const n = (await events(home, 'demo')).length;
  const again = await run(home, { ...a, label: 'resin kits' });
  assert.equal(again.code, 1);
  assert.match(again.message, /already exists under .*\/resin-kits$/);
  assert.equal((await events(home, 'demo')).length, n);
});
