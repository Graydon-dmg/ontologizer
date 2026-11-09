// @ts-check
// ontologizer mcp: the map tools over stdio, for agents. Nothing but the protocol goes to stdout.
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../deps.js';
import { engineFor } from '../serve.js';
import { packageVersion } from '../banner.js';
import { resolveHome } from './status.js';
import { startService } from '../../server/service.js';
import { createMcpServer, loopbackCaller, remoteCaller } from '../../server/mcp.js';

/** @param {any} argv */
export async function handler(argv) {
  /** @type {import('../deps.js').Deps & { stdin?: any }} */
  const deps = argv.deps;
  const version = await packageVersion();
  let token = String(deps.env.ONTOLOGIZER_TOKEN ?? '').trim();
  if (argv.tokenFile !== undefined) {
    try { token = fs.readFileSync(path.resolve(String(argv.tokenFile)), 'utf8').trim(); } catch {
      throw new CliError(`Cannot read the token file ${argv.tokenFile}.`, 1);
    }
  }
  /** @type {any} */
  let srv = null;
  /** @type {import('../../server/mcp.js').Call} */
  let call;
  let baseUrl;
  let where;
  if (argv.url !== undefined) {
    let u;
    try { u = new URL(String(argv.url)); } catch { throw new CliError('--url must be the server\'s address, like http://127.0.0.1:8787', 1); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new CliError('--url must start with http:// or https://', 1);
    baseUrl = u.origin;
    call = remoteCaller({ url: String(argv.url), token: token || null, fetch: deps.fetch });
    where = baseUrl;
  } else {
    const home = path.resolve(resolveHome(argv, deps));
    fs.mkdirSync(home, { recursive: true });
    try {
      srv = await startService({
        home, host: '127.0.0.1', port: 0, tokensFile: null, version,
        makeEngine: (/** @type {any} */ { store, id, clientFor, meter }) => engineFor({
          deps, store, id, needKey: false, ...(clientFor ? { clientFor } : {}), ...(meter ? { meter } : {}),
        }),
        log: (/** @type {string} */ l) => deps.stderr.write(`${l}\n`),
      });
    } catch (/** @type {any} */ e) {
      throw new CliError(e?.message ?? String(e), 1);
    }
    baseUrl = `http://127.0.0.1:${srv.port}`;
    call = loopbackCaller({ host: '127.0.0.1', port: srv.port, headers: { host: `127.0.0.1:${srv.port}` } });
    where = `the in-process server on ${home}`;
  }
  deps.stderr.write(`ontologizer mcp: tools for ${where}\n`);

  const [{ StdioServerTransport }] = await Promise.all([import('@modelcontextprotocol/sdk/server/stdio.js')]);
  const server = createMcpServer({ call, version, baseUrl });
  const stdin = deps.stdin ?? process.stdin;
  const stdout = /** @type {any} */ (deps.stdout ?? process.stdout);
  const transport = new StdioServerTransport(stdin, stdout);
  try {
    await server.connect(transport);
    await new Promise((resolve) => {
      /** @type {Array<() => void>} */
      const offs = [];
      const stop = () => { for (const off of offs) off(); stdin.off?.('end', stop); stdin.off?.('close', stop); resolve(undefined); };
      offs.push(deps.onSignal('SIGINT', stop), deps.onSignal(/** @type {any} */ ('SIGTERM'), stop));
      stdin.on('end', stop);
      stdin.on('close', stop);
    });
  } finally {
    await server.close().catch(() => {});
    if (srv) await srv.close();
  }
}

export default {
  command: 'mcp',
  describe: 'MCP over stdio for agents (Claude Code, the Agent SDK): the map tools, through the HTTP API',
  builder: (/** @type {any} */ y) => y
    .option('url', { type: 'string', describe: 'A running `ontologizer serve` (default: an in-process server on the home)' })
    .option('token-file', { type: 'string', describe: 'A file holding the token (or set ONTOLOGIZER_TOKEN)' })
    .option('home', { type: 'string', describe: 'Store home directory' }),
  handler,
};
