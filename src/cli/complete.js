// @ts-check
// Tab completion, as a sync function with only node builtins so the whole process answers fast.
// Reads <home>/index.json only: never a snapshot or an events file. Never throws.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const COMMANDS = ['new', 'load', 'save', 'list', 'fuse', 'rosetta', 'explain', 'research', 'update', 'key', 'doctor', 'completion'];
const FLAGS = {
  new: ['--context', '--yes'],
  load: ['--replay', '--speed'],
  list: ['--drafts'],
  fuse: ['--into'],
  rosetta: ['--as', '--name'],
  research: ['--general'],
  serve: ['--host', '--port', '--home', '--tokens', '--max-builds', '--max-queued', '--max-checks', '--allow-host', '--open', '--config', '--limit-calls', '--limit-tokens', '--build-timeout'],
  status: ['--home', '--json', '--config'],
  token: ['--name', '--tenant', '--scopes', '--sources', '--home', '--json'],
  sources: ['--config', '--home', '--json'],
  export: ['--format', '--3d', '--budget', '--out', '--live-url', '--include-chat'],
  mcp: ['--url', '--token-file', '--allow-http', '--home', '--build-timeout'],
  usage: ['--home', '--days', '--json'],
  delete: ['--yes'],
  trash: ['--json'],
  restore: ['--as'],
};
const NAME_COMMANDS = new Set(['load', 'explain', 'research', 'rosetta', 'fuse', 'export', 'delete']);
// `export` completes its map name, its flags and the --format values, but is left out of COMMANDS:
// the top-level list is pinned by test/b/complete.test.js. So are `delete` (map names, --yes),
// `trash` (--json) and `restore` (--as), for the same reason.
const EXPORT_FORMATS = ['html', 'embed', 'json', 'context'];

/** @returns {string[]} saved names and draft ids, sorted */
function savedNames() {
  try {
    const home = process.env.ONTOLOGIZER_HOME ?? path.join(os.homedir(), '.ontologizer');
    const idx = JSON.parse(fs.readFileSync(path.join(home, 'index.json'), 'utf8'));
    const out = new Set();
    // Complete ids: a saved map's id is the kebab-case name the user types; the row's `name` is
    // the display name ("Plastic modeling") and never matches what is typed.
    for (const o of Array.isArray(idx?.ontologies) ? idx.ontologies : []) {
      if (o && typeof o.id === 'string') out.add(o.id);
    }
    return [...out].sort();
  } catch {
    return [];
  }
}

/** @param {string[]} words @returns {string[]} */
export function complete(words) {
  try {
    if (!Array.isArray(words) || words.length === 0) return [];
    const partial = String(words[words.length - 1] ?? '');
    if (words.length === 1) return COMMANDS.filter((c) => c.startsWith(partial));
    const cmd = words[0];
    if (partial.startsWith('-')) {
      return (/** @type {Record<string,string[]>} */ (FLAGS)[cmd] ?? []).filter((f) => f.startsWith(partial));
    }
    if (cmd === 'key' && words.length === 2) return ['set', 'clear'].filter((c) => c.startsWith(partial));
    if (cmd === 'token' && words.length === 2) return ['create', 'list', 'revoke'].filter((c) => c.startsWith(partial));
    if (cmd === 'sources' && words.length === 2) return ['list', 'test'].filter((c) => c.startsWith(partial));
    if (cmd === 'completion' && words.length === 2) return ['zsh', 'bash', 'fish'].filter((c) => c.startsWith(partial));
    if (cmd === 'export' && words[words.length - 2] === '--format') return EXPORT_FORMATS.filter((c) => c.startsWith(partial));
    if (NAME_COMMANDS.has(cmd)) {
      if (cmd === 'fuse' ? words.length > 3 : words.length > 2) return [];
      return savedNames().filter((n) => n.startsWith(partial));
    }
    return [];
  } catch {
    return [];
  }
}
