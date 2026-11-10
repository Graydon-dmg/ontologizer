// @ts-check
// The one place the CLI picks its engine. Tests force the stub with ONTOLOGIZER_ENGINE=stub, so
// they stay offline after integration; ONTOLOGIZER_ENGINE=real forces Epic C's engine.

/** Flip to true at integration (Epic C's check/build/jobs on main). */
const REAL_BY_DEFAULT = true;

/**
 * @param {{ store: any, id: string, client?: any, env?: NodeJS.ProcessEnv, clientFor?: any }} opts
 *   clientFor: the model port (service mode with a config); the real engine calls it per model call.
 * @returns {Promise<any>} an engine: check, build, enqueue, fuse, rosetta
 */
export async function loadEngine({ store, id, client = null, env = process.env, clientFor = null }) {
  const choice = env.ONTOLOGIZER_ENGINE;
  const real = choice === 'real' || (choice !== 'stub' && REAL_BY_DEFAULT);
  // The CLI always passes a client built from getApiKey(); never fall back to a bare new Anthropic().
  if (real && !client) throw new Error('internal: the real engine needs a client');
  const { createEngine } = real
    ? await import('../core/engine/index.js')
    : await import('./engine-stub.js');
  return createEngine({ store, id, client, ...(clientFor ? { clientFor } : {}) });
}
