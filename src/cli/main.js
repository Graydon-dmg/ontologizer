// @ts-check
// The CLI as a function: main(argv, deps) -> exit code. Commands never call process.exit, so
// tests run them in-process with fake deps.
import { CliError, makeDeps } from './deps.js';

// One file per command under ./commands/, each `export default { command, describe, builder, handler }`.
export const COMMANDS = [
  'start', 'new', 'load', 'save', 'list', 'fuse', 'rosetta', 'explain', 'research',
  'update', 'key', 'doctor', 'completion', 'complete',
  'serve', 'status', 'token', 'sources', 'export', 'mcp', 'usage',
  'delete', 'trash', 'restore',
];

async function loadCommands() {
  const mods = [];
  for (const name of COMMANDS) {
    const url = new URL(`./commands/${name}.js`, import.meta.url);
    try {
      mods.push((await import(url.href)).default);
    } catch (err) {
      // A command file that does not exist yet is skipped; any other error is real.
      if (/** @type {any} */ (err).code === 'ERR_MODULE_NOT_FOUND' && String(err).includes(url.pathname)) continue;
      throw err;
    }
  }
  return mods;
}

/**
 * @param {string[]} argv  arguments after the program name
 * @param {Partial<import('./deps.js').Deps>} [over]
 * @returns {Promise<number>}
 */
export async function main(argv, over = {}) {
  const deps = makeDeps(over);
  // `--version` on a TTY shows the mark; piped, yargs prints the bare version as before.
  if (argv.length === 1 && argv[0] === '--version' && /** @type {any} */ (deps.stdout).isTTY === true) {
    const { showBanner, packageVersion } = await import('./banner.js');
    await showBanner(/** @type {any} */ (deps), { version: await packageVersion() });
    return 0;
  }
  const { default: yargs } = await import('yargs');
  // Our own package.json, never one yargs guesses from where it is installed (a host project's).
  const { packageVersion } = await import('./banner.js');
  const version = await packageVersion();
  let code = 0;
  let failed = false;
  const cli = yargs(argv)
    .scriptName('ontologizer')
    .usage('$0 [command]\n\nA live, color-coded map of any topic, built by an LLM.')
    .middleware((args) => {
      // Non-enumerable, so no debug or JSON dump of argv can ever print env.
      Object.defineProperty(args, 'deps', { value: deps, enumerable: false, configurable: true });
    })
    .strict()
    .help()
    .alias('h', 'help')
    .version(version)
    .exitProcess(false)
    .showHelpOnFail(false)
    .fail((msg, err) => {
      failed = true;
      if (err) throw err;
      // Throwing stops yargs here, so a command with a bad flag never runs (no half-started server).
      code = 1;
      throw new CliError(`${msg}\nRun ontologizer --help for usage.`, 1);
    })
    .wrap(Math.min(100, process.stdout.columns || 100));
  for (const mod of await loadCommands()) cli.command(mod);
  // Once-a-day update notice; returns at once and never blocks on the network.
  try {
    const { checkForUpdate } = await import('./notice.js');
    const { readFileSync } = await import('node:fs');
    const current = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
    if (argv[0] !== 'update') checkForUpdate({ deps, current });
  } catch { /* never let the notice break a command */ }
  try {
    await cli.parseAsync();
    if (failed) return code || 1;
    return typeof deps.exitCode === 'number' ? deps.exitCode : 0;
  } catch (err) {
    if (err instanceof CliError) {
      if (err.message) deps.stderr.write(`${err.message}\n`);
      return err.code;
    }
    if (/** @type {any} */ (err)?.name === 'ExitPromptError') return 130; // Ctrl-C inside a prompt
    deps.stderr.write(`ontologizer: ${/** @type {any} */ (err)?.message ?? err}\n`);
    if (deps.env.ONTOLOGIZER_DEBUG === '1') deps.stderr.write(`${/** @type {any} */ (err)?.stack}\n`);
    return 1;
  }
}
