// @ts-check
// ontologizer mcp: the map tools over stdio, for agents. Nothing but the protocol goes to stdout.
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../deps.js';
import { engineFor } from '../serve.js';
import { packageVersion } from '../banner.js';
import { resolveHome } from './status.js';
import { startService, isLoopback } from '../../server/service.js';
import { createMcpServer, loopbackCaller, remoteCaller } from '../../server/mcp.js';
import { tokensPath, readTokens, newToken, hashToken } from '../../server/tokens.js';
import { findConfig } from '../../server/config.js';

/**
 * Why a home must not be served by the in-process server (which has only its own token): it has tokens, or a
 * config (whose identity, policy, store or private sources an open server would bypass). Null when
 * it is a plain single-user home. An unreadable tokens file or a config named but missing counts too.
 * @param {string} home @param {NodeJS.ProcessEnv} env @returns {string|null}
 */
export function needsSignIn(home, env) {
  const file = tokensPath(home);
  if (fs.existsSync(file)) {
    try { if (readTokens(file).length) return `tokens (${file})`; } catch { return `a tokens file it cannot read (${file})`; }
  }
  try {
    const config = findConfig({ flag: undefined, env, home });
    if (config) return `a config (${config})`;
  } catch (/** @type {any} */ err) { return `a config it cannot use (${String(err?.message ?? err)})`; }
  return null;
}

/**
 * The in-process server on a plain home, signed in with a token made now: a random admin token held
 * only in this process's memory (never written, printed or logged), loaded as the server's one token,
 * so any other program on this machine that finds the port gets 401. The returned `call` carries it.
 * @param {{ home: string, deps: any, version: string, buildTimeoutMs?: number }} o
 */
export async function startInProcess({ home, deps, version, buildTimeoutMs }) {
  const token = newToken();
  const row = { name: 'mcp', tenant: 'default', scopes: ['admin'], hash: hashToken(token), created: new Date().toISOString() };
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, tokensFile: null, tokens: [row], version,
    ...(buildTimeoutMs !== undefined ? { buildTimeoutMs } : {}),
    makeEngine: (/** @type {any} */ { store, id, clientFor, meter }) => engineFor({
      deps, store, id, needKey: false, ...(clientFor ? { clientFor } : {}), ...(meter ? { meter } : {}),
    }),
    log: (/** @type {string} */ l) => deps.stderr.write(`${l}\n`),
  });
  const call = loopbackCaller({ host: '127.0.0.1', port: srv.port, headers: { host: `127.0.0.1:${srv.port}`, authorization: `Bearer ${token}` } });
  return { srv, call, baseUrl: `http://127.0.0.1:${srv.port}` };
}

/**
 * Why a --url must not be used, or null. A bearer token over plain http crosses the network in clear,
 * so http:// is for this machine only unless --allow-http says otherwise.
 * @param {URL} u @param {boolean} allowHttp
 */
export function urlProblem(u, allowHttp) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '--url must start with http:// or https://';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (u.protocol === 'http:' && !allowHttp && !isLoopback(host)) {
    return `Refusing http://${u.host}: the token would cross the network unencrypted. Use https://, or pass --allow-http if this network is trusted.`;
  }
  return null;
}

/**
 * A warning when the token file can be read by others (group or world), or null. Skipped on Windows.
 * @param {string} file @param {string} [platform]
 */
export function tokenFileWarning(file, platform = process.platform) {
  if (platform === 'win32') return null;
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode & 0o077) return `ontologizer mcp: warning: ${file} can be read by other users (mode ${mode.toString(8).padStart(3, '0')}): run chmod 600 ${file}`;
  } catch { /* read above; nothing to say */ }
  return null;
}

/** @param {any} argv */
export async function handler(argv) {
  /** @type {import('../deps.js').Deps & { stdin?: any }} */
  const deps = argv.deps;
  const version = await packageVersion();
  let token = String(deps.env.ONTOLOGIZER_TOKEN ?? '').trim();
  if (argv.tokenFile !== undefined) {
    const file = path.resolve(String(argv.tokenFile));
    try { token = fs.readFileSync(file, 'utf8').trim(); } catch {
      throw new CliError(`Cannot read the token file ${argv.tokenFile}.`, 1);
    }
    const warn = tokenFileWarning(file);
    if (warn) deps.stderr.write(`${warn}\n`);
  }
  let buildTimeoutMs;
  if (argv.buildTimeout !== undefined) {
    const min = Number(argv.buildTimeout);
    if (!Number.isInteger(min) || min < 1 || min > 1440) throw new CliError('--build-timeout must be a whole number of minutes from 1 to 1440.', 1);
    if (argv.url !== undefined) throw new CliError('--build-timeout is for the in-process server: set it on `ontologizer serve` instead.', 1);
    buildTimeoutMs = min * 60000;
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
    const bad = urlProblem(u, argv.allowHttp === true);
    if (bad) throw new CliError(bad, 1);
    baseUrl = u.origin;
    call = remoteCaller({ url: String(argv.url), token: token || null, fetch: deps.fetch });
    where = baseUrl;
  } else {
    const home = path.resolve(resolveHome(argv, deps));
    // The in-process server signs in with its own in-memory token, but it has no tokens or config of
    // the home's: only for a plain single-user home.
    const why = needsSignIn(home, deps.env);
    if (why) {
      const homeFlag = argv.home !== undefined ? ` --home ${home}` : '';
      throw new CliError(`Refusing to serve ${home} without sign-in: it has ${why}. `
        + `Run \`ontologizer serve${homeFlag}\`, then point this at it: `
        + `\`ontologizer mcp --url http://127.0.0.1:8787 --token-file <file>\` (a file holding a token from \`ontologizer token create${homeFlag}\`).`, 1);
    }
    fs.mkdirSync(home, { recursive: true });
    try {
      ({ srv, call, baseUrl } = await startInProcess({ home, deps, version, ...(buildTimeoutMs !== undefined ? { buildTimeoutMs } : {}) }));
    } catch (/** @type {any} */ e) {
      throw new CliError(e?.message ?? String(e), 1);
    }
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
    .option('allow-http', { type: 'boolean', describe: 'Allow an http:// --url that is not this machine (the token crosses the network in clear)' })
    .option('build-timeout', { type: 'number', describe: 'In-process server only: minutes a build may run before it is stopped (1 to 1440; default 15)' })
    .option('home', { type: 'string', describe: 'Store home directory' }),
  handler,
};
