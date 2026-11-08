// @ts-check
import { spawn } from 'node:child_process';
import { childEnv } from '../deps.js';

export default {
  command: 'update',
  describe: 'Update ontologizer to the latest version',
  builder: (/** @type {any} */ y) => y,
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const code = await new Promise((resolve) => {
      const child = spawn('npm', ['i', '-g', 'ontologizer@latest'], { stdio: 'inherit', env: childEnv(deps.env) });
      child.on('error', (e) => {
        deps.stderr.write(`Could not run npm: ${e.message}\n`);
        resolve(1);
      });
      child.on('close', (c) => resolve(c ?? 1));
    });
    deps.exitCode = code;
  },
};
