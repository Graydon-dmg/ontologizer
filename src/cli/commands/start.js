// @ts-check
import { handler as newHandler } from './new.js';
import { showBanner, packageVersion } from '../banner.js';

export default {
  command: '$0',
  describe: 'Interactive start menu',
  builder: (/** @type {any} */ y) => y,
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    if (!deps.interactive) {
      deps.stdout.write('Run ontologizer --help\n');
      return;
    }
    await showBanner(deps, { version: await packageVersion() });
    const p = await deps.prompts();
    const recent = deps.store().list().slice(0, 5);
    const choice = await p.select({
      message: 'What would you like to do?',
      choices: [
        { name: 'New map', value: { a: 'new' } },
        ...recent.map((/** @type {any} */ r) => ({ name: `Load ${r.name}`, value: { a: 'load', name: r.id } })),
        { name: 'Fuse two maps', value: { a: 'fuse' } },
        { name: 'Quit', value: { a: 'quit' } },
      ],
    });
    if (choice.a === 'new') {
      // deps is non-enumerable on argv, so a spread would drop it: re-attach it explicitly.
      const args = { ...argv, open: true, yes: false, exitAfterBuild: false, context: undefined, bannerShown: true };
      Object.defineProperty(args, 'deps', { value: deps, enumerable: false });
      await newHandler(args);
    } else if (choice.a === 'load') {
      const { main } = await import('../main.js');
      deps.exitCode = await main(['load', choice.name], deps);
    } else if (choice.a === 'fuse') {
      deps.stdout.write('Run: ontologizer fuse <a> <b> --into <name>\n');
    }
  },
};
