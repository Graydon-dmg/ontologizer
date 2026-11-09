// @ts-check
import os from 'node:os';
import path from 'node:path';
import { CliError } from '../deps.js';
import { shellQuote } from '../../server/service.js';
import { resolveHome } from './status.js';
import { SCOPES, tokensPath, readTokens, createToken, revokeToken, publicRows } from '../../server/tokens.js';

/** @template T @param {() => T} fn @returns {T} */
function asCliError(fn) {
  try {
    return fn();
  } catch (/** @type {any} */ err) {
    if (err instanceof CliError) throw err;
    throw new CliError(err.message, 1);
  }
}

/**
 * The line after `token create`: how to start a server that requires it. --home is left out when it
 * is the default home (~/.ontologizer).
 * @param {string} home
 */
export function nextStep(home) {
  const abs = path.resolve(home);
  const isDefault = abs === path.join(os.homedir(), '.ontologizer');
  return `Start the server with: ontologizer serve${isDefault ? '' : ` --home ${shellQuote(abs)}`} --host 0.0.0.0`;
}

export default {
  command: 'token [action] [target]',
  describe: 'Manage service-mode access tokens (create, list, revoke)',
  builder: (/** @type {any} */ y) => y
    .positional('action', { type: 'string', describe: 'create | list | revoke' })
    .positional('target', { type: 'string', describe: 'Token name (revoke)' })
    .option('name', { type: 'string', describe: 'Token name (create)' })
    .option('tenant', { type: 'string', default: 'default', describe: 'Tenant the token opens (create)' })
    .option('scopes', { type: 'string', default: 'read,build', describe: `Comma list of ${SCOPES.join(', ')}; each implies the ones before it (create)` })
    .option('home', { type: 'string', describe: 'Store home directory' })
    .option('json', { type: 'boolean', default: false, describe: 'Print JSON (list)' }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const file = tokensPath(resolveHome(argv, deps));
    const action = argv.action;
    if (action === 'create') {
      if (!argv.name) throw new CliError('token create needs --name <name>.', 1);
      const scopes = String(argv.scopes).split(',').map((s) => s.trim()).filter(Boolean);
      const bad = scopes.filter((s) => !SCOPES.includes(s));
      if (bad.length || !scopes.length) {
        throw new CliError(`Invalid scopes "${argv.scopes}": allowed scopes are ${SCOPES.join(', ')}.`, 1);
      }
      const { token } = asCliError(() => createToken(file, { name: argv.name, tenant: argv.tenant, scopes }));
      deps.stdout.write(`${token}\n`);
      deps.stdout.write('This token is shown once; only its hash is stored.\n');
      deps.stdout.write(`${nextStep(resolveHome(argv, deps))}\n`);
    } else if (action === 'list') {
      const rows = publicRows(asCliError(() => readTokens(file)));
      if (argv.json) {
        deps.stdout.write(`${JSON.stringify(rows)}\n`);
      } else if (!rows.length) {
        deps.stdout.write('No tokens.\n');
      } else {
        for (const r of rows) deps.stdout.write(`${r.name}  tenant ${r.tenant}  scopes ${r.scopes.join(',')}  ${r.created}\n`);
      }
    } else if (action === 'revoke') {
      const name = argv.target ?? argv.name;
      if (!name) throw new CliError('token revoke needs a token name.', 1);
      if (!asCliError(() => revokeToken(file, String(name)))) throw new CliError(`No token named "${name}".`, 1);
      deps.stdout.write(`Revoked ${name}.\n`);
    } else {
      throw new CliError('Usage: ontologizer token create --name <name> | list | revoke <name>', 1);
    }
  },
};
