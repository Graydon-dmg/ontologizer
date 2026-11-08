// @ts-check
import { CliError } from '../deps.js';
import { showBanner, packageVersion } from '../banner.js';
import { engineFor, rethrowAuth, serveSession, untilInterrupt } from '../serve.js';

/** Save under `name`, or name-2, name-3 when taken. @param {any} store @param {string} id @param {string} name */
function saveUnique(store, id, name) {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    try {
      return store.save(id, candidate);
    } catch (err) {
      if (!/already exists/.test(/** @type {Error} */ (err).message) || n > 99) throw err;
    }
  }
}

/** @param {any} argv */
export async function handler(argv) {
  /** @type {import('../deps.js').Deps} */
  const deps = argv.deps;
  if (!argv.bannerShown) await showBanner(deps, { version: await packageVersion() }); // TTY only; nothing when piped
  const store = deps.store();
  const yes = Boolean(argv.yes);
  const interactive = deps.interactive && !yes;
  const prompts = interactive || !argv.context ? await deps.prompts() : /** @type {any} */ (null);

  let context = argv.context;
  if (!context) {
    if (!deps.interactive) throw new CliError('Pass --context "what you want to explore" (no terminal to ask in).');
    context = await prompts.input({ message: 'Context: what do you want to explore, and why?' });
  }

  // Key first: fails before any draft exists.
  let engine = await engineFor({ deps, store, id: 'draft-pending', needKey: true });

  /** @type {any} */
  let brief = { context, subject: context, scope: '', purpose: '', level: 'beginner' };
  let name = 'untitled';
  try {
    /** @type {any[]} */
    let answers = [];
    for (let round = 0; round < 3; round++) {
      const r = await engine.check(context, answers);
      if (r.ready) {
        brief = r.brief;
        name = r.name || 'untitled';
        break;
      }
      if (!interactive || round === 2) break;
      for (const q of r.questions ?? []) {
        let answer = await prompts.select({ message: q.text, choices: [...q.options, 'Other…'] });
        if (answer === 'Other…') answer = await prompts.input({ message: q.text });
        answers.push({ id: q.id, answer });
      }
    }
  } catch (err) {
    rethrowAuth(err);
  }

  deps.stdout.write(`Subject: ${brief.subject}\nScope: ${brief.scope}\nPurpose: ${brief.purpose}\nLevel: ${brief.level}\nSuggested name: ${name}\n`);
  if (interactive) {
    const go = await prompts.confirm({ message: 'Build it?', default: true });
    if (!go) return;
  }

  const id = store.createDraft(brief, name);
  engine = await engineFor({ deps, store, id, needKey: true });
  const srv = await serveSession({ deps, store, engine, id, open: argv.open });
  const off = store.subscribe(id, (/** @type {any} */ ev) => {
    if (ev.t === 'category.added') deps.stdout.write(`  + ${ev.category.label}\n`);
  });
  // Listen for Ctrl-C from the start, so stopping mid-build still offers to save.
  const interrupted = argv.exitAfterBuild ? null : untilInterrupt(deps).then(() => 'interrupted');
  /** @type {any} */
  let first;
  try {
    const built = engine.build(brief).then(() => 'built');
    first = interrupted ? await Promise.race([built, interrupted]) : await built;
    if (first === 'interrupted') built.catch(() => {}); // the build may still fail after we stop
  } catch (err) {
    off();
    await srv.close();
    store.flush(id);
    rethrowAuth(err);
  }
  off();
  if (first === 'built') {
    deps.stdout.write(`Built ${Object.keys(store.read(id).nodes).length} nodes. Ctrl-C to stop.\n`);
  } else {
    deps.stdout.write('\nStopped during the build.\n');
  }

  if (argv.exitAfterBuild) {
    await srv.close();
    store.flush(id);
    return;
  }
  if (first === 'built') await interrupted;

  const row = store.list({ drafts: true }).find((/** @type {any} */ r) => r.id === id);
  if (row?.draft === true) {
    let saved = false;
    if (deps.interactive) {
      const p = await deps.prompts();
      if (await p.confirm({ message: `Save as "${name}"?`, default: true })) {
        deps.stdout.write(`Saved as ${saveUnique(store, id, name)}\n`);
        saved = true;
      }
    }
    if (!saved) deps.stdout.write(`Draft kept: ${id}\n`);
  }
  await srv.close();
  store.flush(store.current() ?? id);
}

export default {
  command: 'new',
  describe: 'Build a new topic map',
  builder: (/** @type {any} */ y) => y
    .option('context', { type: 'string', describe: 'What you want to explore, and why' })
    .option('yes', { type: 'boolean', alias: 'y', describe: 'Skip all questions' })
    .option('open', { type: 'boolean', default: true, hidden: true })
    .option('exit-after-build', { type: 'boolean', default: false, hidden: true }),
  handler,
};
