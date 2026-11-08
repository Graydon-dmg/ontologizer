# Epic B · CLI, store and server

| Session | Branch | Worktree | Lead | Workers | Window |
|---|---|---|---|---|---|
| `epic-b-cli-store-server` | `epic/b-cli` | `../onto-b` | Opus 5.5 | Sonnet 5.5 | 0:15 to 1:40 (plan from 0:00; build after Epic A's first drop) |

Read `LEAD.md` first, then Epic A's files on `main` (`src/core/schema.js`, `src/core/events.js`).

## Goal

`npm i -g ontologizer` gives a working `ontologizer` command with every verb below. Maps live on disk as an event log plus a snapshot. Drafts save themselves. Names tab-complete. Each session serves its map on a free localhost port, with a live event stream for the web page.

## You own

- `src/cli/` (entry point `src/cli/index.js`, starting with `#!/usr/bin/env node`; the API key module is `src/cli/apikey.js`)
- `src/core/store.js` (Epic A leaves a placeholder; replace it)
- `src/server/`
- `test/b/`

**May touch:** `package.json` (dependency lines only, per `LEAD.md`). `src/core/index.js` already re-exports `openStore`: do not edit it.
**Must not touch:** `src/core/schema.js`, `src/core/events.js`, `src/core/engine/`, `web/`.

## Interface

### Commands

Use `yargs`. The rule for every command: existing things are positional (so Tab completes them), and names for new things are flags.

```text
ontologizer                                   interactive start menu: New, Load (recent five), Fuse, Quit
ontologizer new [--context "…"] [--yes]       context check -> build -> serve -> open the browser
ontologizer load <name> [--replay] [--speed <n>]
ontologizer save [name]                       promote the current draft to a named ontology
ontologizer list [--drafts]
ontologizer fuse <a> <b> [--into <name>]      (Epic G calls engine.fuse)
ontologizer rosetta <name> --as "<persona>" [--name <lens>]   (Epic G calls engine.rosetta)
ontologizer explain <name> <node>
ontologizer research <name> <node> [--general]
ontologizer update                            runs: npm i -g ontologizer@latest (stdio inherited)
ontologizer key [set|clear]                   no argument: say where the key comes from (env / keychain / none);
                                              set: prompt for a new key and store it; clear: delete it from the keychain
ontologizer doctor                            prints one row per check: ok / warn / fail, with the fix
ontologizer completion [zsh|bash|fish]        prints the completion script
ontologizer __complete <words…>               hidden; prints one candidate per line
```

What each command does:

- **`new`:**
  1. Ask "Context: what do you want to explore, and why?" (`@inquirer/prompts` input).
  2. Call `engine.check(context)`. While it returns questions, ask them with `select` plus an "Other…" free-text option. At most two rounds.
  3. Show the Brief and the suggested name, then ask "Build it? (Y/n)".
  4. Create the draft, start the server, open the browser (`open`), and call `engine.build(brief)`.
  5. Stay in the foreground, printing one line per category as it lands.
  6. On Ctrl-C with an unsaved draft, ask `Save as "<suggested>"? (Y/n)`. Answering no keeps the draft on disk.

  With `--context` and `--yes`, nothing is asked.
- **`load`:** read the snapshot, serve it, open the browser. With `--replay`, the server streams the saved events with their original timing divided by `--speed` (default 1). This is the offline demo.
  - If the store has no map by that name but the package has `fixtures/<name>.events.jsonl`, import it into the store as a saved map first. This is how `ontologizer load demo --replay` works on a fresh install.
- **`save`:** the "current draft" is the most recently active draft, recorded in `~/.ontologizer/index.json`. It writes an `ontology.renamed` event, renames the folder, and updates the index.
- **`explain` and `research`:** if a session is serving that ontology (see `sessions.json` below), POST the action to it. Otherwise run the engine headless against the store, append its events, and print the result.
- **Name lookup:** any `<name>` argument resolves by exact name, then by unique prefix. If the prefix is ambiguous or matches nothing, open a searchable picker; with no TTY, print the candidates and exit 1.
- **Update notice:** at most once a day, check `https://registry.npmjs.org/ontologizer/latest` with a 1.5 s timeout and print "ontologizer x.y.z is available: run ontologizer update" when it is newer. Never block startup on the network.

### `doctor` checks

| Check | ok when | fix printed |
|---|---|---|
| Node | version 20 or newer | install Node 20+ |
| API key | `ANTHROPIC_API_KEY` is set, or the keychain holds a key | `ontologizer key set` |
| Network | `api.anthropic.com` reachable within 3 s | check the connection |
| Store | `~/.ontologizer/` writable | permissions on the folder |
| Completion | the shell's rc file mentions `ontologizer completion` | the exact `eval` line for this shell |
| Version | no newer version on npm | `ontologizer update` |

`doctor` exits 1 if any row fails.

### API key: `src/cli/apikey.js`

The user never has to set an environment variable. The first command that needs the model asks for the key once, stores it in the operating system's keychain, and every later run reads it from there.

```js
// @ts-check
// Keychain entry: service "ontologizer", account "anthropic-api-key", via @napi-rs/keyring (Entry).
// On macOS that is a generic password, readable by hand with:
//   security find-generic-password -s ontologizer -a anthropic-api-key -w
export function defaultKeyring() {} // -> { get(): string|null, set(key): void, delete(): void }
//   ONTOLOGIZER_KEYRING=none selects an always-empty keyring whose set() is a no-op (for tests only).
export async function getApiKey({ keyring = defaultKeyring(), env = process.env,
                                  interactive = Boolean(process.stdin.isTTY), ask = null } = {}) {}
// -> { key, source: 'env'|'keychain'|'prompt' }
// Order:
//   1. env.ANTHROPIC_API_KEY, when set and non-empty (wins; keeps CI and scripts working).
//   2. keyring.get().
//   3. interactive: ask with @inquirer/prompts `password({ message: 'Anthropic API key:', mask: '*' })`
//      (ask overrides it in tests). Reject anything not starting with "sk-ant-" and ask again (3 tries).
//      Then keyring.set(key) and print "Saved to your system keychain." If set() throws (e.g. Linux with
//      no Secret Service), warn "Could not save the key to the keychain: set ANTHROPIC_API_KEY to skip
//      this prompt" and still return the key for this run.
//   4. not interactive: throw an error whose message is
//      "No Anthropic API key. Run `ontologizer key set` in a terminal, or set ANTHROPIC_API_KEY."
//      The CLI prints it and exits 1. Never hang waiting for input.
// The key is never printed, logged, written to any file (index.json, sessions.json, brief.json, events),
// or put into process.env (child processes such as `open` and `npm i -g` would inherit it).
```

Which commands get the key:
- **`new`, `explain`, `research`, `fuse`, `rosetta`:** call `getApiKey()` before any engine work, then `createEngine({ store, id, client: new Anthropic({ apiKey: key }) })`.
- **`load`:** never prompts (so `load demo --replay` works offline on a fresh install). It uses a key if env or the keychain already has one; without one, a clicked Research or Explain ends as `job.failed` with "No Anthropic API key: run ontologizer key set".
- **An API 401** (`AuthenticationError` from the SDK) on any call: print "Your Anthropic API key was rejected: run ontologizer key set" and exit 1 (in `new`), or fail the job with that message (in a served session).
- **The engine stub** accepts and ignores `client`.

### Store: `src/core/store.js`

```js
// @ts-check
// Layout: ~/.ontologizer/ (override with ONTOLOGIZER_HOME)
//   index.json        [{ id, name, root, nodes, updatedAt, draft: boolean }], plus { current: id }
//   sessions.json     { [id]: { port, pid, startedAt } }  (stale pids are ignored and cleaned up)
//   <id>/events.jsonl one event per line, append-only
//   <id>/snapshot.json foldAll(events), rewritten at most every 500 ms and on exit
//   <id>/brief.json
// A draft's id is "draft-<yyyymmdd-hhmmss>"; a saved ontology's id is its name.
export function openStore(home) {}
//   .createDraft(brief, suggestedName) -> id   (writes brief.json and an empty events.jsonl;
//                                     it does NOT write ontology.created: engine.build does)
//   .append(id, event)                -> void   (append the line, fold in memory, notify subscribers)
//   .read(id)                         -> Ontology
//   .events(id, { from = 0 })         -> AsyncIterable<event>
//   .subscribe(id, fn)                -> unsubscribe
//   .save(id, name)                   -> name   (refuses an existing name unless overwrite: true)
//   .list({ drafts })                 -> index rows
//   .resolve(nameOrPrefix)            -> id | null | { ambiguous: string[] }
//   .current()                        -> id | null
```

### Server: `src/server/`

```js
export function startServer({ store, engine, id, port = 0, replay = null }) {} // -> { url, close }
// GET  /                       web/index.html with web/shared/importmap.json inlined at <!--importmap-->
// GET  /shell/*, /shared/*, /views/*, /dev/*   static files from web/
// GET  /vendor/<pkg>/<path>    from node_modules, folder found with packageDir() from src/core/vendor.js
//                              (Epic A); never resolve '<pkg>/package.json' (d3 does not export it)
// GET  /fixtures/<name>        static
// GET  /src/core/*             static, so the browser can import fold()
// GET  /api/snapshot           the Ontology as JSON, for tools and debugging. The shell does NOT use it
//                              to start: it folds /api/events from 0, so the snapshot and stream can
//                              never double-count, and a replay grows from empty.
// GET  /api/events?from=<n>    Server-Sent Events: every stored event from index n, then live ones.
//                              With replay set, events are paced by their `at` / speed instead.
//                              Each SSE message: `data: <event json>\n\n`; a comment ping every 15 s.
// POST /api/action             JSON body, answered 202 { ok: true, jobId? }:
//   { type: 'expand'|'collapse', nodeId }        -> view.changed (collapsed set)
//   { type: 'focus', nodeId }                    -> view.changed (focus)
//   { type: 'layout', value }                    -> view.changed (layout)
//   { type: 'lens', value }                      -> view.changed (lens)
//   { type: 'filter', value: { categories?, maxDepth? } } -> view.changed (filter)
//   { type: 'research', nodeId, mode: 'context'|'general' } -> engine.enqueue
//   { type: 'explain', nodeId }                  -> engine.enqueue
//   { type: 'sources', nodeId }                  -> engine.enqueue
//   unknown type -> 400 { ok: false, error }
// It records itself in sessions.json on start and removes itself on close.
```

Until Epic C lands, code against this engine stub and replace it at integration:

```js
// src/cli/engine-stub.js: same shape as Epic C's createEngine, replays the plastic-modeling fixture
export function createEngine({ store, id }) {} // .check() returns ready with the fixture's brief;
                                                // .build() appends fixture events with their timing;
                                                // .enqueue() appends job.queued then job.done
```

## Work

- **W1: the store and its tests.**
- **W2: the server (static files, vendor, import map, snapshot, SSE with replay, action routing) and its tests.**
- **W3: the CLI skeleton.** Every command wired with `yargs`; `new` and `load` working end to end against the engine stub; `save` and `list`; Ctrl-C save prompt.
- **W4: completion, `__complete`, the picker, `doctor`, `update`, the update notice.**
- **W5: `src/cli/apikey.js`, the `key` command, and the key wiring in `new`, `load`, `explain`, `research`, `fuse`, `rosetta`.** Lead-reviewed line by line: it handles a secret. **The one exception to landing on your own:** when W5 passes the full check, tell `lead` the commit and wait for its ok (a security review, about 5 minutes) before pushing it to `main`.

Run W1 first (W2 and W3 need it), then W2, W3, W4 and W5 in parallel (W5 owns `apikey.js` and the `key` command file; W3 calls `getApiKey()` where listed above).

## Checks: `npm run check:b`

Use `ONTOLOGIZER_HOME` pointed at a temporary folder for every test. **No test touches the real keychain:** in-process tests pass a fake keyring object; CLI subprocess tests set `ONTOLOGIZER_KEYRING=none` and unset `ANTHROPIC_API_KEY`.

| Check | Planted fault it must catch |
|---|---|
| A map built from the fixture, collapsed and focused through `/api/action`, saved, then read back, folds to the same snapshot (collapsed set and focus included). | A save that drops `view.changed` events. |
| `/api/events?from=0` sends every stored event in order, then a newly appended one. | An SSE handler that sends only new events. |
| Replay at speed 10 delivers the fixture in order and takes about a tenth of its span (within 50%). | A replay that sends everything at once. |
| `__complete load pla` prints `plastic-modeling` in under 100 ms with 50 ontologies in the index. | A completion that reads every snapshot from disk. |
| `resolve('m')` with `manga` and `modeling` saved returns `{ ambiguous }`, not the first match. | A resolver that returns the first prefix match. |
| An unknown `/api/action` type returns 400. | A router that answers 202 to anything. |
| `doctor` with `ANTHROPIC_API_KEY` unset and `ONTOLOGIZER_KEYRING=none` reports a failing row and exits 1. | A doctor that only warns. |
| `getApiKey` with no env key, an empty fake keyring and a fake `ask`: asks once and stores the key; a second call returns it from the keyring with `source: 'keychain'` and does not ask. | A `getApiKey` that never calls `keyring.set`. |
| `getApiKey` with `ANTHROPIC_API_KEY` set returns it without reading the keyring or asking. | A keyring read placed before the env check. |
| `getApiKey` with no key anywhere and `interactive: false` rejects with the "No Anthropic API key" message and never calls `ask`. | An implementation that prompts without a TTY. |
| After a full `new --context … --yes` run with a fake key supplied by the fake `ask` (stub engine), no file under `ONTOLOGIZER_HOME` and none of the captured stdout/stderr contains the key text. | A key written into `index.json`. |
| `getApiKey` rejects `"hello"` from `ask` and asks again. | A prompt with no `sk-ant-` check. |

## Try it

```bash
npm link                                   # puts `ontologizer` on your PATH from this worktree
export ONTOLOGIZER_HOME=/tmp/onto          # every command below uses the same throwaway store
ontologizer new --context "plastic modeling for a beginner" --yes   # with no ANTHROPIC_API_KEY: asks for the key once
ontologizer key                            # says: keychain
ontologizer new --context "plastic modeling for a beginner" --yes   # does not ask again
```
The browser opens. With the engine stub, the fixture streams in. Ctrl-C asks to save. Then `ontologizer list`, `ontologizer load plas<Tab>` and `ontologizer load plastic-modeling --replay --speed 4` all work.

## Not in this epic

- No prompts and no model calls (Epic C).
- No page UI (Epic D).
- No accounts, no sync, no cloud.
- No hand editing of nodes.

## Hand-offs

- **Epic C:** at integration, replace the stub with `createEngine({ store, id, client })` from `src/core/engine/index.js`, where `client` is `new Anthropic({ apiKey })` built from `getApiKey()`. The real engine still defaults its models (and its client, for headless tests), so the call is the same as the stub's.
- **Epic D:** depends on `/api/snapshot`, `/api/events` and `/api/action` exactly as written above. Land the server early (by about 1:00) so the shell can switch from the dev harness to the real server.
- **Epic G:** wire `fuse` and `rosetta` to `engine.fuse(a, b, { into })` and `engine.rosetta(id, persona, { name })` now, fully (open the browser on the result as `new` does). Until G lands, the engine throws "fuse: not built yet": print that message and exit 1. G then needs no change in `src/cli/`.
