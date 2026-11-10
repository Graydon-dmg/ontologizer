// @ts-check
// Whether a service-mode server (`serve`, or `ontologizer mcp`'s in-process one) runs on this home:
// it registers itself in the home's sessions.json while it runs. Its open pages and engines hold its
// own view of the maps, so `delete` and `restore` go through it, never around it.

/**
 * The first server another process runs on this home, or null (an entry from a dead process is dropped).
 * @param {any} store the home's store (files)
 * @returns {{ pid: number, url: string } | null}
 */
export function runningServer(store) {
  const list = typeof store?.sessions?.servers === 'function' ? store.sessions.servers() : [];
  return list.find((/** @type {any} */ s) => s && s.pid !== process.pid) ?? null;
}

/** @param {{ pid: number, url: string }} s @param {'delete'|'restore'} verb */
export const serverRefusal = (s, verb) => `A server is running on this home (pid ${s.pid}, ${s.url}): ${verb} from its page, or stop it first.`;
