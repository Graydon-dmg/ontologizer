# Epic I · Service mode

Proposed and approved in issue #1. Four parts, one pull request each, merged in this order: **I1 service mode → I2 ports and provenance → I3 surfaces → I4 export and context**. I4 needs only saved maps, so it is built alongside I1.

| Part | Branch | Lead | Workers | Rough size |
|---|---|---|---|---|
| I1 · Service mode | `epic/i1-service-mode` | Opus 5.5 | Sonnet 5.5 | ~1,100 lines with tests |
| I2 · Ports and provenance | `epic/i2-ports` | Opus 5.5 | Sonnet 5.5 | ~1,250 lines with tests |
| I3 · Surfaces | `epic/i3-surfaces` | Opus 5.5 | Sonnet 5.5 | ~950 lines with tests |
| I4 · Export and context | `epic/i4-export` | Opus 5.5 | Sonnet 5.5 | ~950 lines with tests |

Read `LEAD.md` for how a lead works, with two differences: **each part lands as a pull request** (not a push to `main`), and CI must be green on it.

## Goal

Ontologizer gets an opt-in **service mode**: `ontologizer serve` runs headless on a laptop, in a terminal or on a Linux host, serves many maps, and lets agents and apps use it through MCP, an HTTP API and an embeddable export. Five ports (identity, policy, store, model, sources) let a team plug in its own pieces without forking.

**Nothing changes for a person on a laptop.** `ontologizer new`, `load` and every other existing command, the one-map page on 127.0.0.1, and the `~/.ontologizer` layout all stay exactly as they are. The existing tests pass unchanged.

## The rule: every feature gets a button and a command

From issue #1: "make sure any new features have a button on the localhost and a command-line function."

- Every feature someone **does** gets a button (or menu item) on the localhost page **and** a CLI command.
- Setup (tokens, ports, the store) gets a command and a **read-only** view on the page. Never a settings editor.
- `src/features.js` lists every Epic I feature. `test/i/features.test.js` fails if a feature's command is not registered or its button's element id is not in the page.

```js
// src/features.js
export const FEATURES = [
  { id: 'serve',   epic: 'I1', cli: 'serve',   ui: { page: 'web/home/index.html', id: 'new-map' } },
  // one row per feature; `cli` is the yargs command name, `ui.id` an element id in `ui.page`
];
```

| Feature | Command | Button on the localhost page | Part |
|---|---|---|---|
| Service mode, new maps from the browser | `ontologizer serve` | Maps home with a **New map** button (`#new-map`) | I1 |
| Server status | `ontologizer status` | Read-only **Server** panel (`#server-panel`), with the auth mode | I1 (filled in by I2, I3) |
| Tokens | `ontologizer token create / list / revoke` | Listed in the Server panel, names and scopes only (`#server-tokens`) | I1 |
| Private sources and visibility | `ontologizer sources list / test`; `list` shows visibility | Sources picker in New map, **Private** badge, source refs in node details | I2 |
| MCP for agents | `ontologizer mcp` | **Connect an agent** (`#connect-agent`) | I3 |
| HTTP API and usage | `ontologizer usage` | Usage and an **API** link in the Server panel | I3 |
| Export and embed | `ontologizer export --format html / embed / json` | **Export** menu (`#export`) | I4 |
| Context pack | `ontologizer export --format context` | **Copy for an agent** (`#export-context`) | I4 |

## Shared rules for every part

- Plain JavaScript with `// @ts-check`, Node 22+, ES modules, no TypeScript build.
- Tests go in `test/i/` and run offline under `npm run check` with the stub engine (`src/cli/engine-stub.js`) and the fixtures. No API key, no network. `npm run check:i` runs only them.
- Every check below comes with a **planted fault**, built into the test: the test feeds the fault and asserts the check reports failure (`LEAD.md`).
- No new runtime dependency except the ones named here. No company, product or vendor names in code, docs or commits.
- Security is the default: loopback only unless tokens are loaded; a server behind a proxy needs tokens; secrets never in a response, a log or the page.
- Scopes are a ladder, each implying the ones before it: `read` < `ask` < `build` < `admin`. `read` never writes; anything that calls the model needs at least `ask`.

---

# Part I1 · Service mode

This section describes Part I1 as built (branch `epic/i1-service-mode`), including the changes accepted during review.

## You own

- `src/cli/commands/serve.js`, `src/cli/commands/status.js`, `src/cli/commands/token.js`
- `src/server/service.js` (the multi-map router), `src/server/map.js` (one map's `/api/*` handlers, shared with the one-map server), `src/server/http.js` (shared HTTP helpers)
- `src/server/tokens.js` (token file, hashing, checking, the scope ladder)
- `web/home/` (the maps home page: `index.html`, `main.js`, `flow.js`, `home.css`)
- `web/shell/ui/server.js` and `web/shell/server-panel.js` (the Server panel, shared by the home page and the map page), `web/shell/base.js` (the page's base path)
- `src/features.js`, `test/i/`
- `Dockerfile`, `.dockerignore`

**May touch:**
- `src/server/index.js`: refactored so the one-map server and the router share handlers (`map.js`, `http.js`). Its routes, responses and behaviour stay exactly as they are (`test/b` passes unchanged).
- `src/core/store.js`: the optional `tenant` for `openStore`, and the reserved map name `tenants`. Tenant `default` is today's layout, byte for byte.
- `src/cli/main.js` (register the new commands; `COMMANDS` is exported for the features test), `src/cli/complete.js` (their flags and `token` subcommands).
- `web/shell/*.js`: replace hard-coded `/api/...` URLs with one helper that prefixes the page's base path (see Interface), and mount the Server panel in service mode. Nothing else.
- `web/index.html`: one `<meta name="ontologizer-base">` placeholder and the Server panel's mount point.
- `SECURITY.md` (network mode section), `README.md` and `docs/GUIDE.md` (a short "Service mode" section), `package.json` (scripts only: `check:i`).

**Must not touch:** `src/core/engine/`, `src/core/events.js`, `src/core/schema.js`, `web/views/`, any existing test.

## Interface

### Commands

```text
ontologizer serve [--host 127.0.0.1] [--port 8787] [--home <dir>] [--tokens <file>] [--max-builds 2]
                  [--max-queued 10] [--max-checks 4] [--allow-host <name>]... [--open]
    Serves every map in the home. Never opens a browser unless --open.
    Tokens: --tokens <file>, else <home>/tokens.json if it exists. A file with no rows is no tokens.
    A --host that is not loopback (127.0.0.1, ::1, localhost) with no tokens loaded:
      exit 1, "Refusing to listen on <host>: no tokens in <home>/tokens.json. Create one with
               `ontologizer token create --name <name> --home <home>`, then run serve again with the same --home."
    --tokens <value> that starts with ont_ or is not an existing file: exit 1, "--tokens takes the path of a tokens
      file, not a token. Tokens live in <home>/tokens.json (made by `ontologizer token create`); serve finds them
      there on its own." The value given is never echoed.
    --allow-host (or ONTOLOGIZER_ALLOW_HOST=a,b) with no tokens loaded:
      exit 1, "Refusing --allow-host: no tokens in <home>/tokens.json, and a server behind a proxy must require tokens. ..."
    Writes <home>/serve.json { pid, url, startedAt, auth: "open"|"tokens" } while running; removes it on exit.
    Prints: "Serving <n> maps at <url>  (Ctrl-C to stop)". Ctrl-C and SIGTERM stop it gracefully.
    An unhandled rejection is logged as one line ("an operation failed in the background: ...") and never stops the server.

ontologizer status [--home <dir>] [--json]
    Home, tenants and map counts, the tokens file (names, tenants, scopes; never secrets),
    and the running server's URL and auth mode if <home>/serve.json names a live pid. A server that
    started open while tokens now exist adds the note "tokens found: restart serve to require them".

ontologizer token create --name <name> [--tenant default] [--scopes read,build] [--home <dir>]
    Prints the new token once ("ont_" + 43 base64url chars). Stores only its SHA-256 in <home>/tokens.json.
    Ends with "Start the server with: ontologizer serve --home <home> --host 0.0.0.0" (no --home for the default home).
ontologizer token list [--home <dir>] [--json]       names, tenants, scopes, created dates
ontologizer token revoke <name> [--home <dir>]
    (One yargs command, `token [action] [target]`; `token` alone prints usage and exits 1.)
```

Scopes are a **ladder**, each implying the ones before it: `read` < `ask` < `build` < `admin`.
- `read`: list, snapshot, events, view, wait, status, attachments. Strictly read-only.
- `ask`: chat (ask the map). It calls the model (costs money) and writes the chat and any images into the map.
- `build`: check, build, actions, save.
- `admin`: everything in its own tenant, plus every tenant's status and the server's paths in it. An admin token still gets 404 on another tenant's maps.

`token create` defaults to `read,build` (build implies ask and read).

### Tokens file

```json
[{ "name": "ci", "tenant": "default", "scopes": ["read", "build"], "hash": "sha256:<hex>", "created": "2026-11-09T18:00:00Z" }]
```

Written atomically, mode 0600. Compare hashes in constant time. Re-read when it changes (mtime, size, inode): a revoke takes effect on the next request, ends that token's sessions, and closes its open event streams within one ping. If it becomes unreadable while running, every token is refused. Whether the server requires tokens is fixed at start: revoking every token refuses everyone, it never reopens the server.

### Store

```js
openStore(home, { tenant = 'default' } = {})
// 'default' -> <home>/ exactly as today.  Others -> <home>/tenants/<tenant>/ with the same layout inside.
// Tenant names: /^[a-z0-9][a-z0-9-]{0,62}$/, anything else throws.
// The map name `tenants` is reserved in every tenant (save and import refuse it with a clear message).
```

### HTTP (service mode)

All JSON responses are `application/json`; errors are `{ ok: false, error }` with the right status.

```text
GET  /                                   maps home page (web/home/index.html); ?next=<map view path> returns there after sign-in
GET  /v1/session                         { ok, tenant, scopes, open } ; 401 when tokens are loaded and none is sent
POST /v1/session      { token }          sets cookie "ontologizer_session" (HttpOnly, SameSite=Strict, Path=/; Secure via an https --allow-host proxy) -> { ok, tenant, scopes }
                                         400 when the server has no tokens
DELETE /v1/session                       clears it
GET  /v1/health/live                     200 always
GET  /v1/health/ready                    200 when the home is readable, else 503
GET  /v1/t/:tenant/status                { tenant, home (admin only), store: "files", auth: "open"|"tokens", note?, maps, tokens: [{ name, tenant, scopes }], server: { version, startedAt } }
GET  /v1/t/:tenant/maps                  [{ id, name, root, nodes, updatedAt, draft }]
POST /v1/t/:tenant/maps/check            { context, answers? } -> { ready, brief?, name?, questions? }   (engine.check; 502 with the model's error; 429 when --max-checks are busy)
POST /v1/t/:tenant/maps                  { brief, name?, depth? } -> 202 { id, viewUrl, eventsUrl }   (build starts in the background; 429 when --max-queued builds already wait for this tenant)
GET  /v1/t/:tenant/maps/:id/snapshot     the folded map (today's /api/snapshot)
GET  /v1/t/:tenant/maps/:id/events?from=n  SSE (today's /api/events)
GET  /v1/t/:tenant/maps/:id/wait?timeout=ms  { state: "idle" | "busy", jobs: [{ id, kind, state }], error? } ; default 30000, max 300000
                                         jobs: the build (queued or running), the map's unfinished jobs, and a chat being written
POST /v1/t/:tenant/maps/:id/actions      today's /api/action body and response
POST /v1/t/:tenant/maps/:id/chat         today's /api/chat body and response
POST /v1/t/:tenant/maps/:id/save         { name } -> { ok, id, viewUrl } ; 409 while anything in `jobs` runs or the name is taken
GET  /v1/t/:tenant/maps/:id/view         the map page, with its base path set to /v1/t/:tenant/maps/:id
     /v1/t/:tenant/maps/:id/api/*        today's /api/* routes for that map, so the page works unchanged under its base
GET  /shell/*, /shared/*, /views/*, /vendor/*, /src/core/*, /fixtures/*, /home/*, /dist/*   static, as today
```

A failed build appends `job.failed` (kind `build`, with the error) to the map, so the page's jobs tray shows it; `wait` reports the error. A successful build leaves the log exactly as a CLI build does.

**Auth** (when tokens are loaded): `Authorization: Bearer <token>` or the session cookie. Checked in this order on every `/v1/t/` route: missing or wrong credentials 401, then a cookie POST/DELETE without a matching `Origin` 403, then a wrong tenant 404 (do not reveal the map exists), then a missing scope 403, then a missing map 404. A browser `GET .../view` (Accept includes `text/html`) with no or an expired session gets `302 /?next=<path>` instead of 401. Health routes and static files need no auth. Bearer requests need no `Origin`. Sessions are random ids in memory (12 hours; at most 20 per token, evicting that token's oldest; at most 1000 in all), never the token. Without tokens (loopback only), everything is open, as the one-map server is; a POST with a foreign `Origin` still gets 403.

**Proxies need tokens:** without tokens, `--allow-host` is refused at start, and any request carrying `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host` or `X-Real-IP` gets 403 ("This server has no tokens; proxied requests need tokens.").

**Host check:** the one-map server's Host check stays. The router accepts `Host` = `127.0.0.1`, `localhost` or `[::1]` on any port; the bound host and port; this machine's own IP addresses on the bound port when bound to `0.0.0.0` or `::`; and any `--allow-host` name (with any port). A cookie POST's `Origin` matches when it is the request's own `Host` or an `--allow-host` name.

**Limits:** `--max-builds` builds run at once; waiting builds queue per tenant (at most `--max-queued`) and start round-robin across tenants. `--max-checks` context checks at once. At most 50 open event streams plus pending waits per token (429). A map's engine and handler with no open streams and nothing running are dropped after 10 minutes and made again on the next request.

`viewUrl` is `/v1/t/<tenant>/maps/<id>/view`; `eventsUrl` is `/v1/t/<tenant>/maps/<id>/events`.

### The base path in the page

```html
<meta name="ontologizer-base" content="">   <!-- the server fills it: "" for the one-map server, "/v1/t/default/maps/<id>" in service mode -->
```

```js
// web/shell/base.js
export const BASE = /* the meta's content, or "" (also in Node, with no document) */;
export const api = (path) => `${BASE}${path}`;   // api('/api/events?from=0')
export const TENANT = /* the tenant in a service-mode BASE, else null */;
```

### Engines and fuse

- One engine per map, created on first use by the same `engineFor` the CLI uses (`needKey: false`: a missing key fails the model call, not the server), kept in a registry keyed by `tenant/id`. Context checks use one engine per tenant with id `draft-pending` (check writes nothing), as `ontologizer new` does.
- `--max-builds` caps builds running at once; a build over the cap waits in a queue (the 202 still returns at once).
- Fuse in service mode makes the fused draft a new map in the same process; its `url` is that map's `viewUrl`. No child servers, no new ports.

## Bodies of work

- **W1 · Store tenant + tokens.** `openStore` tenant option, the reserved name; `src/server/tokens.js` with the scope ladder; `token` and `status` commands.
- **W2 · Router.** `src/server/service.js` with auth, the routes above, the engine registry with idle eviction, async build with per-tenant queues, `wait`, save, in-process fuse, the limits, the proxy rule; the shared handlers refactor of `src/server/index.js` into `map.js` and `http.js`, with event streams that end when their token or session does.
- **W3 · `serve` command.** Flags, the network-bind and `--allow-host` refusals, `serve.json`, graceful shutdown (stop accepting, end streams and chats, flush stores), the unhandled-rejection guard, `Dockerfile` (`node:22-slim`, non-root user, `ONTOLOGIZER_HOME=/data`, `serve --host 0.0.0.0`, which refuses without tokens by design).
- **W4 · Maps home and New map.** `web/home/`: the map list (name, root, nodes, updated), a **New map** button opening a dialog: context textarea → `check` → its questions as option buttons plus "Other" text → `check` again with the answers so far (up to three rounds, as the CLI) → `build` → go to `viewUrl`. A token form when the server answers 401; after sign-in, back to `?next=` if it is a map page. Uses `web/shared/tokens.js` for every color and the shell's CSS. Request and round logic in `web/home/flow.js` (no DOM).
- **Every I1 panel stays inside the window.** The Server popover is fixed beside its button and placed by `fitPanel` (`web/shell/fit.js`): an 8 px margin, width and height capped (scrolling inside) when the window is smaller, re-placed on resize. The New map and sign-in dialogs cap their height and scroll.
- **W5 · Server panel.** `web/shell/ui/server.js`: a read-only panel from `/v1/t/:tenant/status` (tenant, store, auth mode and its note, map count, version, tokens by name and scopes). Mounted on the home page and, in service mode, on the map page (a top-bar button `#server-panel`). Hidden on the one-map server.
- **W6 · Base path.** `web/shell/base.js` and every `/api/` call in `web/shell/` through `api()`.
- **W7 · Docs and features.** `src/features.js` rows for I1, `test/i/features.test.js`, README and GUIDE sections, SECURITY.md "Network mode".

## Checks (each with its planted fault)

| Check | Planted fault it must catch |
|---|---|
| `serve --host 0.0.0.0` with no tokens exits 1 and the message names `ontologizer token create`. | A `serve` that only warns. |
| With tokens loaded, every `/v1/t/` route returns 401 without a token and with a wrong one. | A route registered outside the auth wrapper. |
| A `read`-only token gets 403 on `POST /maps`, `/actions`, `/save`, and on chat. Scopes form the ladder read < ask < build < admin. | A scope check that only checks the tenant; a flat scope check. |
| A token for tenant `a` gets 404 on tenant `b`'s map. | A store lookup that ignores the tenant. |
| A cookie POST with a foreign `Origin` gets 403; an `--allow-host` origin passes. | An Origin check that skips cookie requests. |
| No response, log line or page contains a token secret; `tokens.json` holds only hashes. | A status handler that returns the token. |
| `POST /maps` returns 202 within 1 s with the stub engine; `wait` then reports `idle` and the snapshot has nodes. | A handler that awaits the build. |
| Fuse in service mode creates a new map id in the same process and opens no new port. | The child-server path. |
| `openStore(home)` and `openStore(home, { tenant: 'default' })` read and write the same files as before. | A default tenant that writes under `tenants/default/`. |
| The map page served under `/v1/t/default/maps/<id>/view` loads its events from `<base>/api/events`. | A shell call left on a bare `/api/`. |
| Every feature in `src/features.js` has a registered command and its button's id in its page (in the HTML, or rendered by a module the page loads). | A feature row with a missing button. |
| Save while a chat answer is being written gets 409; `serve` survives an unhandled rejection. | A work list without chats; no rejection handler. |
| Without tokens, `--allow-host` is refused and proxied requests get 403. | A server that ignores proxy headers. |
| A revoked token's (or signed-out session's) open event stream ends within one ping. | A stream that is never re-checked. |
| The map name `tenants` is refused in every tenant. | A store that allows it. |
| Build queue cap per tenant (429), round-robin start order, check slots (429), idle eviction, streams per token (429), sessions per token. | No cap; a FIFO queue; no eviction. |
| A browser `GET .../view` without a session gets 302 to `/?next=`; API requests keep 401. | A server that redirects every unauthenticated request. |
| `fitPanel` keeps a floating panel inside the window (8 px margin) at every size and anchor. | A placement that ignores the left edge. |
| The refusal names the home and the exact `token create --home` command; `--tokens` given a token says what it takes; `token create` ends with the serve command. | A message that echoes the token. |
| `test/a` to `test/h` pass unchanged. | (Their own planted faults.) |

## Try it

```bash
H=$(mktemp -d)
ONTOLOGIZER_HOME=$H node src/cli/index.js load demo --replay --no-open & sleep 1; kill %1   # the old path still works
node src/cli/index.js serve --home $H                    # open http://127.0.0.1:8787/, New map, watch it build
node src/cli/index.js serve --home $H --host 0.0.0.0     # refuses
node src/cli/index.js token create --name me --home $H   # then serve --host 0.0.0.0 starts; the page asks for the token
docker build -t ontologizer . && docker run -p 8787:8787 -e ANTHROPIC_API_KEY -v $H:/data ontologizer   # refuses without tokens
```

## Open for the maintainer

1. **Top-level tab completion.** `serve`, `status` and `token` are not in the top-level completion list, because `test/b/complete.test.js` pins `complete([''])` to the exact old list and existing tests must not change. Their flags and `token create|list|revoke` do complete. Updating that test (and adding the I1 and I4 commands) is the maintainer's call.
2. **The keychain in the container.** The `Dockerfile` sets `ONTOLOGIZER_KEYRING=none`, because a container has no OS keychain and the key comes from `ANTHROPIC_API_KEY`. `src/cli/apikey.js` describes that value as "for tests only". Either bless it as the container setting or add a dedicated one.

---

# Part I2 · Ports and provenance

Built after I1 merges. Interfaces, so I1 and I4 leave room for them:

```js
// ontologizer.config.js (found via --config, ONTOLOGIZER_CONFIG, or <home>/ontologizer.config.js); every key optional
export default {
  identity: { authenticate(req) /* -> { actor: { id, kind: 'human'|'agent'|'service', via? }, tenant, scopes } | null */ },
  policy:   { can(principal, action, { tenant, mapId, map }) /* -> boolean */ },  // action: read|build|ask|job|save|export|admin
  store:    (tenant) => /* a store with openStore()'s methods */,
  model:    ({ principal, purpose }) => /* an Anthropic-compatible client */,
  sources:  [{ name, url /* or command */, visibility: 'public'|'private', allowTools: ['search','get'], headers: (principal) => ({}) }],
};
```

- Defaults reproduce I1 exactly. `event.actor` on every event from an authenticated call; `node.sources: [{ source, ref, title?, url? }]`; `Ontology.visibility` folded from events (private once any event cites a private source; fuse takes the stricter side), never written directly.
- Source tools: only tools in `allowTools` **and** marked `readOnlyHint` are offered to the model, beside `web_search`, in build, research, explain and ask.
- Default read rule: a caller reads a private map only if its scopes cover every private source the map used.
- `ontologizer/store-postgres` export; `pg` as an optional peer dependency; store contract tests run only when `ONTOLOGIZER_PG_URL` is set.
- Buttons and commands: `ontologizer sources list / test`; `list` gains a visibility column; New map gets a sources picker; a Private badge; source refs in node details.

# Part I3 · Surfaces

Built after I2 merges.

```js
// src/ops.js: each operation once; HTTP routes, /v1/openapi.json and the MCP tools are generated from it
{ name, http: { method, path }, mcp: { name, description }, input /* JSON Schema */, output, scope, callsModel, cli, ui }
```

- `ontologizer mcp` (stdio) and `POST /v1/mcp` (streamable HTTP, same tokens), with `@modelcontextprotocol/sdk`.
- MCP tools: `check_context, build_map, wait_for_map, list_maps, get_outline, search_map, get_node, research, explain, sources, ask_map, fuse, rosetta, save_map, get_context, export_map`. Every tool with `callsModel: true` ends its description with "Calls the model: costs API credits."
- `import { createClient } from 'ontologizer/client'`; per-tenant daily limits on model calls and tokens (`--limit-calls`, `--limit-tokens`), 429 with a reset time.
- Buttons and commands: **Connect an agent** (`#connect-agent`) shows the MCP config; `ontologizer usage`; usage and an API link in the Server panel. `test/i` checks every op names a registered `cli` and a `ui` element.

---

# Part I4 · Export and context

## You own

- `src/core/export/` (`index.js`, `html.js`, `context.js`): pure functions, no Node or DOM imports, so the page can run them too (the server already serves `/src/core/`).
- `src/cli/commands/export.js`
- `web/embed/` (the `<ontologizer-map>` custom element, its entries for 2D and 3D, and a pure data reader)
- `web/shell/ui/export.js` (the Export menu)
- `scripts/build-embed.js`, `test/i/` files named `export*`, `context*`, `embed*`, `build*`

**May touch:**
- `package.json`: the `esbuild` devDependency (exact version: `0.28.2`), `scripts` (`build`, `prepack`, and `check`, `check:i`, `dev` run the build first), `exports` (add `"./export": "./src/core/export/index.js"`). `files` is unchanged: the bundle lives under `web/`, which already ships.
- `.gitignore` (add `dist/`, which also covers `web/dist/`).
- `src/server/index.js`: add `'dist'` to the existing static list, nothing else. (Service mode's list gets the same word in Part I1.)
- `web/index.html`: the Export menu's mount point. `web/shell/main.js`: mount it.
- `web/views/graph/`: a read-only flag in the view's context, if the view needs one. The live view's behaviour must not change.
- `src/features.js`: rows for I4.
- `src/cli/main.js` (register `export`), `src/cli/complete.js`.
- `scripts/third-party-notices.js` and the `THIRD_PARTY_NOTICES.md` it generates (see Licences).
- `.github/workflows/release.yml` and `docs/RELEASING.md` (see Releases).
- `README.md`, `docs/GUIDE.md`: a short "Export" section.

**Must not touch:** `src/core/engine/`, `src/core/events.js`, `src/core/schema.js`, `src/server/` beyond the one word, any existing test.

## Interface

```text
ontologizer export <map> --format html|embed|json|context [--3d] [--budget 4000] [--out <file>] [--live-url <url>]
    html, embed: written to --out, else <map>.html / <map>.embed.html in the current folder.
    json, context: to --out, else stdout.
    --3d: html and embed only; adds the 3D view (bigger file; the command prints the size).
    <map> resolves as `load` does: a saved map or draft, else a bundled fixture by name (`demo`).
    A missing bundle fails with "run `npm run build`", never a stack trace.
```

```js
import { exportMap } from 'ontologizer/export';
exportMap(ontology, {
  format,              // 'html' | 'embed' | 'json' | 'context'
  bundle,              // the text of web/dist/embed.js or web/dist/embed-3d.js (html, embed only)
  budget = 4000,       // context only, in estimated tokens (chars / 4)
  liveUrl = null,      // html, embed: shows "Open live" when set (http and https only)
}) // -> string
```

- **`html`:** one self-contained page: the bundle inlined in a classic `<script>`, the map in `<script type="application/json" id="ontologizer-data">`, one `<ontologizer-map>` filling the window. No external URL anywhere.
- **`embed`:** a fragment: one `<ontologizer-map style="display:block;height:480px">` with its data tag and the inlined bundle, nothing else. Drops into any page. Several embeds on one page share the bundle (a define-once guard).
- **html and embed carry no chat and no unfinished jobs:** questions people asked are not part of a published map, and a static page cannot finish a job.
- **`json`:** `JSON.stringify(ontology)` as `/api/snapshot` returns it.
- **`context`:** markdown with fixed headings, in this order:

```md
# <map name>
## Brief          context, subject, scope, purpose, level, size
## Outline        one line per node, indented by depth: "- Label: one-line summary"
## Bridges        cross-links between categories: "- A → B (influences): why"
## Insights       the map's insight events
## Thin areas     uncovered branches; one line when nothing is explained or sourced yet
## Sources        the web sources the map cites, deduplicated
```
  Trimmed to `budget`, in this order: (1) summaries, from the deepest level up, and within a level one at a time from the end of the outline, only as many as needed (the root's children keep theirs longest); (2) Bridges and Sources shortened; (3) only then the deepest labels, never depth 1, refilling Bridges and Sources after each level; (4) Thin-area node lines and Insights; the Brief last. A last line says exactly what was trimmed. Labels are cheap and are what an agent needs most, so they outlive summaries.
- **Same-name nodes:** where the pack names a node whose label another node also uses (Bridges, Thin areas, insight references), it adds the node's category in parentheses, or "Category, under Parent" when both are in one category. Unique labels are unchanged.
- **Private maps:** once I2 lands, `ontology.visibility === 'private'` puts a "Private" mark in every format (a banner in html and embed, a first line in context, a top-level `"visibility"` in json). The hook reads `ontology.visibility` if present.

### Escaping

- The data tag's JSON escapes `<`, U+2028 and U+2029; the map name is HTML-escaped; `liveUrl` must parse as http or https and is escaped.
- A `</script` in the bundle is split. A bundle containing `<!--` or `<script` (any case) is refused: the build fails without writing it, and `exportMap` throws as a second guard, because inside a classic `<script>` that pair can stop the real `</script>` from closing it.

### The embed bundle

- `scripts/build-embed.js` runs esbuild `0.28.2` on `web/embed/`: `bundle: true, format: 'iife', minify: true, target: 'es2022'`, writing `web/dist/embed.js` (2D) and `web/dist/embed-3d.js` (2D and 3D). Writes are atomic and skipped when unchanged; it logs to stderr, because `npm pack --json` runs it as `prepack`.
- `web/dist/` is built, never committed. The page serves it at `/dist/`.
- The element: shadow DOM; reads its data from the JSON tag inside it (or the page's `#ontologizer-data` for `html`); mounts the existing 2D graph view read-only with the shared layout and `web/shared/tokens.js`; pan, zoom, click a node for its details (label, summary, explanation, sources), collapse, search; light and dark from `prefers-color-scheme`; "Open live" when `liveUrl` is set.
- **No network:** no fetch, XMLHttpRequest, EventSource, WebSocket, `import()` or external URL in the bundle or the export.
- The live page keeps running from source files with its import map. Only exports use the bundle.
- Measured on the demo: `embed.js` 119 KB, `embed-3d.js` 700 KB, the 2D `html` export 174 KB.

### Licences

- Each bundle opens with the full licence text and copyright line of every package esbuild put in it, taken from esbuild's metafile (never a hand list). The header survives into html and embed exports.
- `scripts/third-party-notices.js` lists shipped packages and, in their own section, build tools ("installed for development only, never shipped or bundled"), with separate counts. Platform binaries are credited to the package that lists them as optional dependencies. The "not bundled" bullet becomes: `web/dist/embed.js` copies d3 code, `embed-3d.js` also copies three, and each carries their licence texts.

### Releases

- The `publish` job holds the npm publish credential and must never install or run a project dependency. So `verify` (no credential) builds the bundle in `npm run check` and uploads `web/dist/` as a one-day artifact; `publish` downloads it, checks both files are non-empty, and publishes with `--ignore-scripts` as before. Both actions are pinned to commit SHAs.

### The Export menu (`#export` in the top bar)

Items: **Download page** (`html`), **Copy embed** (`embed`, to the clipboard), **Download JSON**, **Copy for an agent** (`#export-context`, `context` at 4000 tokens). The page fetches `/dist/embed.js` and calls the same `exportMap` from `/src/core/export/index.js` on its current snapshot. `liveUrl` is the page's own URL. Between 1280 and 1366 px it is an icon, so the top bar wraps at no width where it did not before.

## Bodies of work

- **W1 · Context pack.** `src/core/export/context.js` and its tests (pure, no bundle needed).
- **W2 · Bundle.** `web/embed/`, `scripts/build-embed.js`, package.json scripts, `.gitignore`, the licence header, the notices generator.
- **W3 · Formats.** `src/core/export/index.js`, `html.js`, and the `export` command.
- **Search fix (shell and embed).** Search opens the collapsed branches that hold a match, so the highlight is visible.
- **W4 · Export menu.** `web/shell/ui/export.js`, the static `dist` word, the mount point, the features rows, the release workflow.

## Checks (each with its planted fault)

| Check | Planted fault it must catch |
|---|---|
| An `html` or `embed` export of the demo has no `http:`, `https:` or `//` URL in any `src`, `href`, `import` or `url(`. (`liveUrl` is the one allowed link, in an `<a href>`.) | An export that loads d3 from a CDN. |
| `web/dist/embed.js` contains none of `fetch(`, `XMLHttpRequest`, `EventSource`, `WebSocket`, `import(`. | A bundle that pings for updates. |
| The 2D `html` export of the demo is under 400 KB. | A 2D export that bundles three.js. |
| A context pack's estimate is at or under its budget, its headings are exactly the six above, in order, and at a budget that fits labels but not summaries every node label is present. | The old depth-first trim, which fits the budget but drops every leaf label. |
| A bridge between two same-label nodes names each with its category. | A pack that qualifies labels only when both ends share a category. |
| Swept from 4,000 down to 300 tokens, nothing comes back as the budget shrinks, deeper summaries go before shallower ones, and labels go only after every summary. | A trim that drops labels while summaries remain. |
| With `ontology.visibility = 'private'`, every format carries the mark. | A `json` path that skips it. |
| A label that tries to close the data tag, and a bundle containing `<!--<script>`, are both handled: the first escaped, the second refused by the build and by `exportMap`. | An unescaped data tag; a guard that only checks `</script`. |
| Every package in esbuild's metafile is named in its bundle's licence header with its full text, and the header survives into exports. | A header missing `d3-zoom`. |
| The embed's data reader parses the demo export's data tag back to the same snapshot, and reports a clear error for a malformed tag. Rendering is checked in a browser (Try it): the repo's tests run in Node with no DOM. | A malformed tag read as an empty map. |
| `npm pack --dry-run` lists `web/dist/embed.js`; `git check-ignore web/dist/embed.js` succeeds; the existing pack audit passes unchanged. | A pack without the `prepack` build. |
| `npm run check` builds first, so a clean clone passes with `npm ci --ignore-scripts && npm run check` (as CI runs). | A test that assumes `web/dist/` exists. |
| In `release.yml`, `publish` runs no `npm ci`, install, `run`, `exec` or `npx` (except upgrading npm itself at an exact version), keeps `--ignore-scripts`, and downloads and checks the bundle before `npm publish`; `verify` uploads it after `npm run check`. | A copy of the workflow with `npm run build` in `publish`. |
| Every I4 feature has its command and its button (the shared features test). | An Export menu without Copy for an agent. |

## Try it

```bash
npm run build
node src/cli/index.js export demo --format html --out /tmp/demo.html && open /tmp/demo.html   # pan, zoom, click, offline
node src/cli/index.js export demo --format context --budget 1500
node src/cli/index.js load demo                       # Export menu: Download page, Copy embed, Copy for an agent
```

## Open for the maintainer

1. `export` is not in the top-level tab-completion list, because `test/b` pins `complete([''])` exactly (as in Part I1). Its flags, map names and `--format` values complete.
2. html and embed exports leave out the chat. Say if a published map should carry its questions and answers.
