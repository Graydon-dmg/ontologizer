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
| Server status | `ontologizer status` | Read-only **Server** panel (`#server-panel`) | I1 (filled in by I2, I3) |
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
- Security is the default: loopback only unless told otherwise; secrets never in a response, a log or the page.

---

# Part I1 · Service mode

## You own

- `src/cli/commands/serve.js`, `src/cli/commands/status.js`, `src/cli/commands/token.js`
- `src/server/service.js` (the multi-map router) and any new `src/server/*.js` it needs
- `src/server/tokens.js` (token file, hashing, checking)
- `web/home/` (the maps home page: `index.html`, `main.js`, `home.css`)
- `web/shell/ui/server.js` (the Server panel, shared by the home page and the map page)
- `src/features.js`, `test/i/`
- `Dockerfile`, `.dockerignore`

**May touch:**
- `src/server/index.js`: refactor so the one-map server and the router share handlers. Its routes, responses and behaviour stay exactly as they are (`test/b` passes unchanged).
- `src/core/store.js`: add the optional `tenant` to `openStore`. Tenant `default` is today's layout, byte for byte.
- `src/cli/main.js` (register the new commands), `src/cli/complete.js` (complete them).
- `web/shell/*.js`: replace hard-coded `/api/...` URLs with one helper that prefixes the page's base path (see Interface). Nothing else.
- `web/index.html`: one `<meta name="ontologizer-base">` placeholder and the Server panel's mount point.
- `SECURITY.md` (network mode section), `README.md` and `docs/GUIDE.md` (a short "Service mode" section), `package.json` (scripts only: `check:i`).

**Must not touch:** `src/core/engine/`, `src/core/events.js`, `src/core/schema.js`, `web/views/`, any existing test.

## Interface

### Commands

```text
ontologizer serve [--host 127.0.0.1] [--port 8787] [--home <dir>] [--tokens <file>] [--max-builds 2] [--open]
    Serves every map in the home. Never opens a browser unless --open.
    Tokens: --tokens <file>, else <home>/tokens.json if it exists.
    A --host that is not loopback (127.0.0.1, ::1, localhost) with no tokens loaded:
      exit 1, "Refusing to listen on <host> without tokens: create one with `ontologizer token create`, or pass --tokens."
    Writes <home>/serve.json { pid, url, startedAt } while running; removes it on exit.
    Prints: "Serving <n> maps at <url>  (Ctrl-C to stop)".

ontologizer status [--home <dir>] [--json]
    Home, tenants and map counts, the tokens file (names, tenants, scopes; never secrets),
    and the running server's URL if <home>/serve.json names a live pid.

ontologizer token create --name <name> [--tenant default] [--scopes read,build] [--home <dir>]
    Prints the new token once ("ont_" + 43 base64url chars). Stores only its SHA-256 in <home>/tokens.json.
ontologizer token list [--home <dir>] [--json]       names, tenants, scopes, created dates
ontologizer token revoke <name> [--home <dir>]
```

Scopes: `read` (list, snapshot, events, view, wait, status, ask), `build` (check, build, actions, save), `admin` (everything, and every tenant's status). `ask` costs money but changes nothing, so it rides on `read`, as on the page today.

### Tokens file

```json
[{ "name": "ci", "tenant": "default", "scopes": ["read", "build"], "hash": "sha256:<hex>", "created": "2026-11-09T18:00:00Z" }]
```

Written atomically, mode 0600. Compare hashes in constant time.

### Store

```js
openStore(home, { tenant = 'default' } = {})
// 'default' -> <home>/ exactly as today.  Others -> <home>/tenants/<tenant>/ with the same layout inside.
// Tenant names: /^[a-z0-9][a-z0-9-]{0,62}$/, anything else throws.
```

### HTTP (service mode)

All JSON responses are `application/json`; errors are `{ ok: false, error }` with the right status.

```text
GET  /                                   maps home page (web/home/index.html)
POST /v1/session      { token }          sets cookie "ontologizer_session" (HttpOnly, SameSite=Strict, Path=/) -> { ok, tenant, scopes }
DELETE /v1/session                       clears it
GET  /v1/health/live                     200 always
GET  /v1/health/ready                    200 when the home is readable, else 503
GET  /v1/t/:tenant/status                { tenant, home, store: "files", maps, tokens: [{ name, tenant, scopes }], server: { version, startedAt } }
GET  /v1/t/:tenant/maps                  [{ id, name, root, nodes, updatedAt, draft }]
POST /v1/t/:tenant/maps/check            { context, answers? } -> { ready, brief?, name?, questions? }   (engine.check)
POST /v1/t/:tenant/maps                  { brief, name?, depth? } -> 202 { id, viewUrl, eventsUrl }   (build starts in the background)
GET  /v1/t/:tenant/maps/:id/snapshot     the folded map (today's /api/snapshot)
GET  /v1/t/:tenant/maps/:id/events?from=n  SSE (today's /api/events)
GET  /v1/t/:tenant/maps/:id/wait?timeout=ms  { state: "idle" | "busy", jobs } ; default timeout 30000, max 300000
POST /v1/t/:tenant/maps/:id/actions      today's /api/action body and response
POST /v1/t/:tenant/maps/:id/chat         today's /api/chat body and response
POST /v1/t/:tenant/maps/:id/save         { name } -> { ok, id }
GET  /v1/t/:tenant/maps/:id/view         the map page, with its base path set to /v1/t/:tenant/maps/:id
     /v1/t/:tenant/maps/:id/api/*        today's /api/* routes for that map, so the page works unchanged under its base
GET  /shell/*, /shared/*, /views/*, /vendor/*, /src/core/*, /fixtures/*, /home/*   static, as today
```

Auth (when tokens are loaded): `Authorization: Bearer <token>` or the session cookie. Missing or wrong: 401. Wrong tenant: 404 (do not reveal the map exists). Missing scope: 403. Health routes and static files need no auth. POST and DELETE with a cookie must carry an `Origin` that matches the server's own; Bearer requests need not. Without tokens (loopback only), everything is open, as the one-map server is today.

`viewUrl` is `/v1/t/<tenant>/maps/<id>/view`; `eventsUrl` is `/v1/t/<tenant>/maps/<id>/events`.

**Host check:** the one-map server's Host check stays. The router checks Host against the bound host and port, plus any `--allow-host <name>` given (repeatable), so it works behind a reverse proxy.

### The base path in the page

```html
<meta name="ontologizer-base" content="">   <!-- the server fills it: "" for the one-map server, "/v1/t/default/maps/<id>" in service mode -->
```

```js
// web/shell/base.js
export const BASE = document.querySelector('meta[name="ontologizer-base"]')?.content ?? '';
export const api = (path) => `${BASE}${path}`;   // api('/api/events?from=0')
```

### Engines and fuse

- One engine per map, created on first use by the same `engineFor` the CLI uses (`needKey: false`: a missing key fails the model call, not the server), kept in a registry keyed by `tenant/id`.
- `--max-builds` caps builds running at once; a build over the cap waits in a queue (the 202 still returns at once).
- Fuse in service mode makes the fused draft a new map in the same process; its `url` is that map's `viewUrl`. No child servers, no new ports.

## Bodies of work

- **W1 · Store tenant + tokens.** `openStore` tenant option; `src/server/tokens.js`; `token` and `status` commands.
- **W2 · Router.** `src/server/service.js` with auth, the routes above, the engine registry, async build, `wait`, in-process fuse, the shared handlers refactor of `src/server/index.js`.
- **W3 · `serve` command.** Flags, the network-bind refusal, `serve.json`, graceful shutdown (stop accepting, flush stores, close streams), `Dockerfile` (`node:22-slim`, non-root user, `ONTOLOGIZER_HOME=/data`, `serve --host 0.0.0.0`, which refuses without tokens by design).
- **W4 · Maps home and New map.** `web/home/`: the map list (name, root, nodes, updated), a **New map** button opening a dialog: context textarea → `check` → its questions as option buttons plus "Other" text → `check` again (up to three rounds, as the CLI) → `build` → go to `viewUrl`. A token form when the server answers 401. Uses `web/shared/tokens.js` for every color and the shell's CSS.
- **W5 · Server panel.** `web/shell/ui/server.js`: a read-only panel from `/v1/t/:tenant/status` (tenant, store, map count, tokens by name and scopes). Mounted on the home page and, in service mode, on the map page (a top-bar button `#server-panel`). Hidden on the one-map server.
- **W6 · Base path.** `web/shell/base.js` and every `/api/` call in `web/shell/` through `api()`.
- **W7 · Docs and features.** `src/features.js` rows for I1, `test/i/features.test.js`, README and GUIDE sections, SECURITY.md "Network mode".

## Checks (each with its planted fault)

| Check | Planted fault it must catch |
|---|---|
| `serve --host 0.0.0.0` with no tokens exits 1 and the message names `ontologizer token create`. | A `serve` that only warns. |
| With tokens loaded, every `/v1/t/` route returns 401 without a token and with a wrong one. | A route registered outside the auth wrapper. |
| A `read`-only token gets 403 on `POST /maps`, `/actions`, `/save`. | A scope check that only checks the tenant. |
| A token for tenant `a` gets 404 on tenant `b`'s map. | A store lookup that ignores the tenant. |
| A cookie POST with a foreign `Origin` gets 403. | An Origin check that skips cookie requests. |
| No response, log line or page contains a token secret; `tokens.json` holds only hashes. | A status handler that returns the token. |
| `POST /maps` returns 202 within 1 s with the stub engine; `wait` then reports `idle` and the snapshot has nodes. | A handler that awaits the build. |
| Fuse in service mode creates a new map id in the same process and opens no new port. | The child-server path. |
| `openStore(home)` and `openStore(home, { tenant: 'default' })` read and write the same files as before. | A default tenant that writes under `tenants/default/`. |
| The map page served under `/v1/t/default/maps/<id>/view` loads its events from `<base>/api/events`. | A shell call left on a bare `/api/`. |
| Every feature in `src/features.js` has a registered command and its button's id in its page. | A feature row with a missing button. |
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
- `web/embed/` (the `<ontologizer-map>` custom element and its entry)
- `web/shell/ui/export.js` (the Export menu)
- `scripts/build-embed.js`, `test/i/` files named `export*.test.js`, `context*.test.js`, `embed*.test.js`, `build*.test.js`

**May touch:**
- `package.json`: the `esbuild` devDependency (exact version), `scripts` (`build`, `prepack`, and `check`, `check:i`, `dev` run `build` first), `files` (add `dist`), `exports` (add `"./export": "./src/core/export/index.js"`).
- `.gitignore` (add `dist/`).
- `src/server/index.js`: serve `/dist/*` as static files (one route), nothing else.
- `web/index.html`: the Export menu's mount point. `web/shell/main.js`: mount it.
- `web/views/graph/`: a read-only flag in the view's context, if the view needs one. The live view's behaviour must not change.
- `src/features.js`: rows for I4 (I1 creates the file; if I1 has not landed, create it with only your rows and the shared shape).
- `src/cli/main.js` (register `export`), `src/cli/complete.js`.
- `README.md`, `docs/GUIDE.md`: a short "Export" section.

**Must not touch:** `src/core/engine/`, `src/core/events.js`, `src/core/schema.js`, `src/server/` beyond the one static route, any existing test.

## Interface

```text
ontologizer export <map> --format html|embed|json|context [--3d] [--budget 4000] [--out <file>] [--live-url <url>]
    html, embed: written to --out, else <map>.html / <map>.embed.html in the current folder.
    json, context: to --out, else stdout.
    --3d: html and embed only; adds the 3D view (bigger file; the command prints the size).
    <map> resolves as `load` does: a saved map or draft, else a bundled fixture by name (`demo`).
```

```js
import { exportMap } from 'ontologizer/export';
exportMap(ontology, {
  format,              // 'html' | 'embed' | 'json' | 'context'
  bundle,              // the text of dist/embed.js or dist/embed-3d.js (html, embed only)
  budget = 4000,       // context only, in estimated tokens (chars / 4)
  liveUrl = null,      // html, embed: shows "Open live" when set
}) // -> string
```

- **`html`:** one self-contained page: the bundle inlined in a classic `<script>`, the map in `<script type="application/json" id="ontologizer-data">`, one `<ontologizer-map>` filling the window. No external URL anywhere.
- **`embed`:** a fragment: one `<ontologizer-map style="display:block;height:480px">` with its data tag and the inlined bundle, nothing else. Drops into any page. Several embeds on one page share the bundle if it is already defined (`customElements.get` guard).
- **`json`:** `JSON.stringify(ontology)` as `/api/snapshot` returns it.
- **`context`:** markdown with fixed headings, in this order:

```md
# <map name>
## Brief          context, subject, scope, purpose, level
## Outline        one line per node, indented by depth: "- Label: one-line summary"
## Bridges        cross-links between categories: "- A → B (influences): why"
## Insights       the map's insight events
## Thin areas     nodes with no explanation, no sources, or many leaves and no summary
## Sources        the web sources the map cites, deduplicated
```
  Trimmed to `budget`: drop the deepest outline level first, then summaries from the deepest up; the root's children always stay; then shorten Bridges and Sources. A last line says what was trimmed.
- **Private maps:** once I2 lands, `ontology.visibility === 'private'` puts a "Private" mark in every format (a banner in html and embed, a first line in context, a top-level `"visibility"` in json). Build the hook now: read `ontology.visibility` if present.

### The embed bundle

- `scripts/build-embed.js` runs esbuild (exact pinned version) on `web/embed/index.js`: `bundle: true, format: 'iife', minify: true, target: 'es2022'`, writing `dist/embed.js` (2D) and `dist/embed-3d.js` (2D and 3D).
- The element: shadow DOM; reads its data from the JSON tag inside it (or the page's `#ontologizer-data` for `html`); mounts the existing 2D graph view read-only with the shared layout and `web/shared/tokens.js`; pan, zoom, click a node for its details (label, summary, explanation, sources), collapse, search; light and dark from `prefers-color-scheme`; "Open live" when `liveUrl` is set.
- **No network:** no fetch, XMLHttpRequest, EventSource, WebSocket, `import()` or external URL in the bundle or the export.
- The live page keeps running from source files with its import map. Only exports use the bundle.

### The Export menu (`#export` in the top bar)

Items: **Download page** (`html`), **Copy embed** (`embed`, to the clipboard), **Download JSON**, **Copy for an agent** (`#export-context`, `context` at 4000 tokens). The page fetches `/dist/embed.js` and calls the same `exportMap` from `/src/core/export/index.js` on its current snapshot. `liveUrl` is the page's own URL.

## Bodies of work

- **W1 · Context pack.** `src/core/export/context.js` and its tests (pure, no bundle needed).
- **W2 · Bundle.** `web/embed/`, `scripts/build-embed.js`, package.json scripts, `.gitignore`.
- **W3 · Formats.** `src/core/export/index.js`, `html.js`, and the `export` command.
- **W4 · Export menu.** `web/shell/ui/export.js`, the `/dist/` route, the mount point, the features rows.

## Checks (each with its planted fault)

| Check | Planted fault it must catch |
|---|---|
| An `html` or `embed` export of the demo fixture has no `http:`, `https:` or `//` URL in any `src`, `href`, `import` or `url(`. (`liveUrl` is the one allowed link, in an `<a href>`.) | An export that loads d3 from a CDN. |
| `dist/embed.js` contains none of `fetch(`, `XMLHttpRequest`, `EventSource`, `WebSocket`, `import(`. | A bundle that pings for updates. |
| The 2D `html` export of the demo fixture is under 400 KB. | A 2D export that bundles three.js. |
| A context pack's estimate is at or under its budget, keeps every child of the root, and its headings are exactly the six above, in order. | A trim that cuts the top level first. |
| With `ontology.visibility = 'private'`, every format carries the mark. | A `json` path that skips it. |
| The embed's data reader (a pure function in `web/embed/`) parses the demo export's data tag back to the same snapshot, and reports a clear error for a malformed tag. Rendering itself is checked by hand in Try it: the repo's tests run in Node with no DOM. | A malformed data tag that is read as an empty map. |
| `npm pack --dry-run` lists `dist/embed.js`; `git check-ignore dist/embed.js` succeeds. | A pack without the `prepack` build. |
| `npm run check` builds the bundle first, so a clean clone passes with `npm ci --ignore-scripts && npm run check` (as CI runs). | A test that assumes `dist/` exists. |
| Every I4 feature has its command and its button (the shared features test). | An Export menu without Copy for an agent. |

## Try it

```bash
npm run build
node src/cli/index.js export demo --format html --out /tmp/demo.html && open /tmp/demo.html   # pan, zoom, click, offline
node src/cli/index.js export demo --format context --budget 1500
node src/cli/index.js load demo                       # Export menu: Download page, Copy embed, Copy for an agent
```
