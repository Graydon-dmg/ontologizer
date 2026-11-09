// @ts-check
// ontologizer serve: service mode. Every map in the home, many at once, on one server.
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../deps.js';
import { engineFor } from '../serve.js';
import { packageVersion } from '../banner.js';
import { resolveHome } from './status.js';
import { startService, isLoopback } from '../../server/service.js';
import { tokensPath } from '../../server/tokens.js';
import { openStore, TENANT_RE } from '../../core/store.js';

/** Maps in every tenant of the home (saved and drafts). @param {string} home */
function countMaps(home) {
  let n = openStore(home).list({ drafts: true }).length;
  try {
    for (const e of fs.readdirSync(path.join(home, 'tenants'), { withFileTypes: true })) {
      if (e.isDirectory() && TENANT_RE.test(e.name) && e.name !== 'default') n += openStore(home, { tenant: e.name }).list({ drafts: true }).length;
    }
  } catch { /* no tenants */ }
  return n;
}

/** @param {string} file @param {any} data */
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/** @param {any} argv */
export async function handler(argv) {
  /** @type {import('../deps.js').Deps} */
  const deps = argv.deps;
  const home = path.resolve(resolveHome(argv, deps));
  const host = String(argv.host);
  const port = Number(argv.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError('--port must be a whole number from 0 to 65535.', 1);
  const maxBuilds = Number(argv.maxBuilds);
  if (!Number.isInteger(maxBuilds) || maxBuilds < 1 || maxBuilds > 64) throw new CliError('--max-builds must be a whole number from 1 to 64.', 1);
  const maxQueued = Number(argv.maxQueued);
  if (!Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 1000) throw new CliError('--max-queued must be a whole number from 0 to 1000.', 1);
  const maxChecks = Number(argv.maxChecks);
  if (!Number.isInteger(maxChecks) || maxChecks < 1 || maxChecks > 64) throw new CliError('--max-checks must be a whole number from 1 to 64.', 1);
  /** @type {string|null} */
  let tokensFile = null;
  if (argv.tokens !== undefined) {
    tokensFile = path.resolve(String(argv.tokens));
    if (!fs.existsSync(tokensFile)) throw new CliError(`No tokens file at ${tokensFile}.`, 1);
  } else if (fs.existsSync(tokensPath(home))) {
    tokensFile = tokensPath(home);
  }
  // --allow-host (repeatable) and ONTOLOGIZER_ALLOW_HOST (comma-separated, for containers).
  const allowHosts = [
    ...(Array.isArray(argv.allowHost) ? argv.allowHost : argv.allowHost ? [argv.allowHost] : []),
    ...String(deps.env.ONTOLOGIZER_ALLOW_HOST ?? '').split(','),
  ].map((h) => String(h).trim()).filter(Boolean);
  fs.mkdirSync(home, { recursive: true });

  let srv;
  try {
    srv = await startService({
      home, host, port, tokensFile, allowHosts, maxBuilds, maxQueued, maxChecks,
      watchTokensFile: tokensPath(home),
      version: await packageVersion(),
      // A missing API key fails the model call (shown on the map), never the server.
      makeEngine: ({ store, id }) => engineFor({ deps, store, id, needKey: false }),
      log: (line) => deps.stderr.write(`${line}\n`),
    });
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.code === 'NO_TOKENS') throw new CliError(e.message, 1);
    if (e?.code === 'EADDRINUSE') throw new CliError(`Port ${port} is already in use: pick another with --port.`, 1);
    if (e?.code === 'EADDRNOTAVAIL' || e?.code === 'ENOTFOUND') throw new CliError(`Cannot listen on ${host}.`, 1);
    throw new CliError(e?.message ?? String(err), 1);
  }

  // One stray rejection (a model call finishing after its map was renamed, say) is logged, never fatal.
  const onRejection = (/** @type {any} */ reason) => {
    deps.stderr.write(`ontologizer: an operation failed in the background: ${String(reason?.message ?? reason).split('\n')[0]}\n`);
  };
  process.on('unhandledRejection', onRejection);

  const serveFile = path.join(home, 'serve.json');
  writeAtomic(serveFile, { pid: process.pid, url: srv.url, startedAt: new Date().toISOString(), auth: srv.tokensLoaded ? 'tokens' : 'open' });
  const removeServeFile = () => {
    try {
      const j = JSON.parse(fs.readFileSync(serveFile, 'utf8'));
      if (j && j.pid === process.pid) fs.rmSync(serveFile, { force: true });
    } catch { /* already gone */ }
  };
  process.once('exit', removeServeFile);

  const n = countMaps(home);
  deps.stdout.write(`Serving ${n} ${n === 1 ? 'map' : 'maps'} at ${srv.url}  (Ctrl-C to stop)\n`);
  if (!isLoopback(host)) deps.stdout.write(`Listening on ${host}: every /v1/t/ route needs a token.\n`);
  else if (!srv.tokensLoaded) deps.stdout.write('No tokens loaded: loopback only, open to this machine.\n');
  if (argv.open) await deps.openBrowser(srv.url);

  try {
    if (argv.exitAfter !== undefined) await new Promise((r) => setTimeout(r, Number(argv.exitAfter)));
    else {
      await new Promise((resolve) => {
        /** @type {Array<() => void>} */
        const offs = [];
        const stop = () => { for (const off of offs) off(); resolve(undefined); };
        // SIGTERM (a container stopping) shuts down the same way as Ctrl-C.
        offs.push(deps.onSignal('SIGINT', stop), deps.onSignal(/** @type {any} */ ('SIGTERM'), stop));
      });
    }
  } finally {
    deps.stdout.write('Stopping…\n');
    await srv.close();
    removeServeFile();
    process.off('exit', removeServeFile);
    process.off('unhandledRejection', onRejection);
  }
}

export default {
  command: 'serve',
  describe: 'Serve every map in the home (service mode: many maps, tokens, an HTTP API)',
  builder: (/** @type {any} */ y) => y
    .option('host', { type: 'string', default: '127.0.0.1', describe: 'Address to listen on (not loopback: needs tokens)' })
    .option('port', { type: 'number', default: 8787, describe: 'Port to listen on' })
    .option('home', { type: 'string', describe: 'Store home directory' })
    .option('tokens', { type: 'string', describe: 'Tokens file (default: <home>/tokens.json if it exists)' })
    .option('max-builds', { type: 'number', default: 2, describe: 'Builds that run at once; more wait in a queue' })
    .option('max-queued', { type: 'number', default: 10, describe: 'Builds that may wait per tenant; more get 429' })
    .option('max-checks', { type: 'number', default: 4, describe: 'Context checks at once; more get 429' })
    .option('allow-host', { type: 'string', array: true, describe: 'Extra Host name to accept behind a reverse proxy (needs tokens); repeatable. Also ONTOLOGIZER_ALLOW_HOST=a,b' })
    .option('open', { type: 'boolean', default: false, describe: 'Open the maps home in a browser' })
    .option('exit-after', { type: 'number', hidden: true }),
  handler,
};
