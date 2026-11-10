# Using Ontologizer from an agent

This page is for AI agents (and the people who set them up) that want to **use** Ontologizer as a tool. To work on Ontologizer's own code, see [AGENTS.md](../AGENTS.md) and [CONTRIBUTING.md](../CONTRIBUTING.md) instead.

Ontologizer builds a **map of a field**: a tree of categories and nodes (each with a one-line summary), cross-links between categories ("bridges"), insights, thin areas, and sources. The model builds a map once, in a minute or two; after that, reading it is free and instant. An agent reaches it through MCP tools, the HTTP API, or a JS client. All three take the same path through the server, with the same checks.

## When to reach for it

- **Learning a field fast.** You (or your user) know nothing about home espresso, contract law or Kubernetes networking. Build a map once, then read its context pack: the shape of the field, its vocabulary, how its parts connect, and where it is thin.
- **Grounding a brainstorm.** Ideas drawn from a map's categories, bridges and thin areas are broader and less obvious than ideas from memory alone, and each one can name the nodes it builds on.
- **A map in a document.** `export_map` with `"embed"` gives an interactive map (pan, zoom, click a node) that works offline inside a design doc, a wiki page or a report.
- **Where two fields meet.** `fuse` joins two maps and writes the bridges between them.
- **Private, grounded maps.** With configured sources (your operator's MCP servers over internal documents), a map is built from your own material, cites it, and stays private to the people who hold those sources.

Don't use it for a single fact you can look up directly, or for live data: a map is a snapshot of a field, built by a model.

## Setup

### Claude Code

On this machine, over stdio (an in-process server on your own maps in `~/.ontologizer`, loopback only, no token). A home with tokens or a config is refused: it has sign-in, so use a running `serve` with `--url` and `--token-file` instead (below).

```bash
claude mcp add ontologizer -- npx -y ontologizer mcp
claude mcp add ontologizer -- npx -y ontologizer mcp --home ~/team-maps    # another folder of maps
```

A running `ontologizer serve`, over streamable HTTP:

```bash
claude mcp add --transport http ontologizer http://127.0.0.1:8787/v1/mcp      # loopback, no tokens
claude mcp add --transport http ontologizer https://maps.example.com/v1/mcp \
  --header "Authorization: Bearer <YOUR_TOKEN>"                                # a server with tokens
```

Or forward stdio to a remote server, with the token in a file (never on the command line):

```bash
claude mcp add ontologizer -- npx -y ontologizer mcp --url https://maps.example.com --token-file ~/.ontologizer-token
```

The server's operator makes tokens with `ontologizer token create --name <agent> --scopes read` (an agent that only reads) or `--scopes read,build` (one that builds). On the map page, **Connect an agent** (in the Export menu, and in the Server panel) shows these commands ready to copy.

### The Agent SDK

```js
// TypeScript
const options = {
  mcpServers: {
    ontologizer: { type: 'http', url: 'http://127.0.0.1:8787/v1/mcp', headers: { Authorization: `Bearer ${process.env.ONTOLOGIZER_TOKEN}` } },
    // or, on this machine: ontologizer: { command: 'npx', args: ['-y', 'ontologizer', 'mcp'] },
  },
  allowedTools: ['mcp__ontologizer__list_maps', 'mcp__ontologizer__get_context', 'mcp__ontologizer__get_outline',
    'mcp__ontologizer__search_map', 'mcp__ontologizer__get_node'],   // the free reads; add the others deliberately
};
```

```python
# Python
options = ClaudeAgentOptions(
    mcp_servers={"ontologizer": {"type": "http", "url": "http://127.0.0.1:8787/v1/mcp",
                                 "headers": {"Authorization": f"Bearer {os.environ['ONTOLOGIZER_TOKEN']}"}}},
)
```

### Any other MCP client

```json
{ "mcpServers": { "ontologizer": { "command": "npx", "args": ["-y", "ontologizer", "mcp"] } } }
```

### The JS client (apps, scripts)

```js
import { createClient } from 'ontologizer/client';
const c = createClient({ url: 'http://127.0.0.1:8787', token: process.env.ONTOLOGIZER_TOKEN });
const pack = await c.maps.context('home-espresso', { budget: 4000 });
```

Every MCP tool has a client method (`c.maps.check`, `build`, `wait`, `list`, `outline`, `search`, `node`, `context`, `export`, `ask`, `save`, `actions`). The HTTP routes are described at `GET /v1/openapi.json`.

## How the tools fit together

- **Free reads first.** `list_maps`, `get_context`, `get_outline`, `search_map`, `get_node`, `export_map` and `wait_for_map` never call the model. `get_context` is the best first read of a map.
- **Building is two steps.** `check_context` turns a plain description into a brief (it may ask up to three rounds of questions); `build_map` builds from the brief.
- **Jobs run in the background.** `build_map`, `research`, `explain`, `sources`, `fuse` and `rosetta` answer at once. Wait with `wait_for_map` on the map (jobs have no id to wait on); call it again while it says `"busy"`.
- **Ids.** A map id is a saved map's name (`sourdough`) or a draft id (`draft-20261109-153012`). Drafts are kept; `save_map` only names a map, and its old id stops working. A node id is a path (`plastic-modeling/techniques/airbrush-basics`): take it from `get_outline` or `search_map`, never guess it.
- **No tool deletes a map, on purpose.** Deleting, the trash and restoring are for people: the maps home and map page (**Delete**, the **Trash**), the CLI (`ontologizer delete`, `trash`, `restore`) and the HTTP API (`DELETE /v1/t/<tenant>/maps/<id>`, `GET /v1/t/<tenant>/trash`, `POST .../trash/<trashId>/restore`), never MCP. An agent that wants a map gone should ask its user. If a map you were using disappears (404), it may be in the trash.
- **MCP prompts** (`learn-a-field`, `brainstorm-from-map`, `map-for-a-doc`, `connect-two-fields`, `deepen-a-node`, `private-map`) are ready-made starting points for these workflows.

## Workflows

The outputs below have the real shapes (shortened where marked with …); the topics, ids and numbers are examples.

### 1. Learn a field, then brainstorm from it

1. `list_maps` `{}` to see whether a map already covers it.
   ```json
   { "maps": [ { "id": "sourdough", "name": "Sourdough", "root": "sourdough", "nodes": 76, "draft": false } ] }
   ```
2. No map fits, so `check_context` `{ "context": "Home espresso for a complete beginner: machines, grinders, beans, technique" }`.
   ```json
   { "ready": false, "questions": [ { "id": "budget", "text": "What is your budget?", "options": ["Under 300", "300-1000", "Over 1000"] } ] }
   ```
3. Ask your user (or answer from what you know) and call again with the same context and every answer so far: `{ "context": "…", "answers": [ { "id": "budget", "answer": "Under 300" } ] }`.
   ```json
   { "ready": true, "name": "Home espresso", "brief": { "context": "…", "subject": "Home espresso", "scope": "…", "purpose": "…", "level": "beginner" } }
   ```
4. `build_map` `{ "brief": <the brief, unchanged> }`.
   ```json
   { "id": "draft-20261109-161122", "viewUrl": "http://127.0.0.1:8787/v1/t/default/maps/draft-20261109-161122/view", "eventsUrl": "…/events" }
   ```
   Give your user the `viewUrl`: the map draws itself there as it builds.
5. `wait_for_map` `{ "id": "draft-20261109-161122", "timeout": 120000 }` until `{ "state": "idle", "jobs": [] }`. An `error` field says why a build failed.
6. `get_context` `{ "id": "draft-20261109-161122", "budget": 6000 }`.
   ```markdown
   # Home espresso

   ## Brief
   - Subject: Home espresso
   - Size: 74 nodes in 8 categories, 19 cross-links, 0 explained

   ## Outline
   - Home espresso
     - Machines
       - Single boiler machines: …
   …
   ## Bridges
   - Grind size → Extraction (influences): …
   ## Thin areas
   …
   ```
7. Teach and brainstorm from the pack yourself. Use the thin areas and bridges for less obvious ideas, and `get_node` for detail. No more model calls are needed.

### 2. A map in a design doc

1. `list_maps`; if none covers the field, steps 2 to 5 of workflow 1 (`check_context`, `build_map`, `wait_for_map`).
2. `export_map` `{ "id": "electric-bicycles", "format": "embed" }`.
   ```html
   <ontologizer-map style="display:block;height:480px" aria-label="Electric bicycles">
   <script type="application/json" class="ontologizer-data">{"name":"Electric bicycles", …}</script>
   <script>/* the map viewer, with its licence header (about 150 KB) */</script>
   </ontologizer-map>
   ```
3. Paste it into the HTML document as it is. It works offline, loads nothing from the network, and is a snapshot: export again after the map changes. Use `"html"` for a whole page instead, and `get_context` if you also write about the map.

### 3. Look into one node, then research and explain it

1. `search_map` `{ "id": "sourdough", "q": "levain", "limit": 3 }`.
   ```json
   { "results": [ { "id": "sourdough/starter/levain", "label": "Levain", "path": "Sourdough > Starter > Levain", "snippet": "…" } ] }
   ```
2. `get_node` `{ "id": "sourdough", "nodeId": "sourdough/starter/levain" }`: its summary, children, cross-links, sources, and `"article": "Not explained yet: …"` when it has no article.
3. If it is thin: `explain` `{ "id": "sourdough", "nodeId": "sourdough/starter/levain" }` writes its article; `research` `{ "id": "sourdough", "nodeId": "sourdough/starter/levain", "mode": "context" }` adds nodes under it. Each answers `{ "ok": true, "jobId": "job-1" }`.
4. `wait_for_map` `{ "id": "sourdough" }`, then `get_node` again to read the article or the new children.

### 4. Ask the map, with citations

1. `ask_map` `{ "id": "sourdough", "text": "Why does my levain smell like acetone?", "chatId": "agent-bread" }`.
   ```json
   { "answer": "A sharp, nail-polish smell usually means the levain is hungry …",
     "citedNodes": [ { "id": "sourdough/starter/feeding", "label": "Feeding schedule" } ],
     "sources": [ { "title": "…", "url": "https://…" } ], "chatId": "agent-bread" }
   ```
2. Follow up with the same `chatId` (questions with one chatId share history; the default, `"main"`, is the conversation the map page shows). Use `get_node` on a cited node for more.

Ask only when you need prose grounded in the map: you can usually answer from `get_context` and `get_node` yourself, for free.

### 5. Where two fields connect

1. `list_maps` to confirm both maps exist (build a missing one first).
2. `fuse` `{ "id": "sourdough", "with": "fermentation-science" }`.
   ```json
   { "ok": true, "jobId": "fuse-67698-1", "draftId": "draft-20261109-161122-2", "url": "http://127.0.0.1:8787/v1/t/default/maps/draft-20261109-161122-2/view" }
   ```
   The two maps are not changed. `into` names the new map; its id is always the draft id.
3. `wait_for_map` `{ "id": "draft-20261109-161122-2" }`, then `get_context` on it and read its **Bridges**.

## Cost

You pay for model calls with the user's (or the server operator's) API key; the server never shows a price. Roughly:

| Tool | Model calls | Roughly |
|---|---|---|
| `list_maps`, `get_context`, `get_outline`, `search_map`, `get_node`, `export_map`, `wait_for_map`, `save_map` | none | free |
| `check_context` | one fast call per round | a fraction of a cent |
| `build_map` | a handful: one for categories, one per category, one strong call for cross-links and insights (more at a greater `depth`) | a few cents per map at depth 2 |
| `explain`, `sources` | one strong call, with web search | about a cent or two |
| `research` | one or more strong calls | about a cent or two |
| `ask_map` | one strong call (more when it searches the web) | about a cent or two |
| `fuse` | several strong calls | a few cents |
| `rosetta` | strong calls in batches of 25 nodes | grows with the map |

Every tool that calls the model says so in its description ("Calls the model: costs API credits."). A server may cap calls and tokens per day (below).

## Limits and errors

Errors come back as tool results with `isError: true`. The text starts with the server's own message and ends with what to do next.

| Status | Message (start) | What it means | What to do |
|---|---|---|---|
| (before any request) | ``Unknown argument `query`. Did you mean q? search_map takes: id (required), q (required), limit.``, ``Missing argument `id`. …``, ``Argument `limit` must be a whole number from 1 to 50. …`` | A guessed, missing or out-of-range argument: every call is checked against the tool's input schema, and an unknown name is never ignored | Call again with the names it lists |
| 400 | `name must be lowercase letters, digits and hyphens.`, `context must be a non-empty string …` | An argument is wrong | Fix it against the tool's input schema |
| 401 | `Sign in with a token.`, `That token was not accepted.` | No token, or a revoked one | Configure a token (`Authorization` header, or `--token-file`) |
| 403 | `This token needs the build scope.` | Your token's scope does not allow this | Use the free reads, or ask the operator for a broader token |
| 403 | `forbidden origin` | A browser-style request from another site | Call from your MCP client, not a web page |
| 404 | `not found.` | No map with that id that you may read: missing and private maps look the same | `list_maps` for the ids you can use |
| 404 | `No node with id "…". Close node ids: …` | Wrong node id | `search_map` or `get_outline` |
| 409 | `The map is still being built, has jobs running, or a chat answer is being written …` | `save_map` while something runs | `wait_for_map`, then again |
| 409 | `That name is not available.` | `save_map` to a taken name | Pick another name |
| 409 | `A chat answer is already being written for this map …` | Two `ask_map` at once on one map | Wait for the first |
| 429 | `Daily limit reached: 500 model calls today for tenant default (limit 500). It resets at 00:00 UTC …` | The server's daily limit for your tenant | Stop calling model tools until the time given; free reads still work |
| 429 | `10 builds are already waiting …`, `Too many context checks at once …` | The server is busy | Try again after the seconds given |
| 502 | `Your Anthropic API key was rejected …`, or the model's error | A `check_context` model call failed | Try later; tell the operator if it repeats |
| 503 | `the store is not available`, `The embed bundle is missing: run npm run build …` | The server cannot serve this right now | Try again shortly; tell the operator if it repeats |

A job that fails later shows in `wait_for_map`'s `error` (for a build) or as a failed job in its `jobs`: for example `Timed out after 15 minutes` (the server's build timeout), `No Anthropic API key` (the server has no key), or `Interrupted by a restart`.

## Private maps and sources, for an agent

- **Sources** are MCP servers your operator configured (an internal wiki, a docs site). `build_map` lists the ones you hold in its `sources` input, with their visibility. Without a `sources` argument a build uses every source you hold; name them to choose.
- **A map built from a private source is private for good.** Nothing can make it public. `list_maps` shows `"visibility": "private"` on it.
- **Only callers who hold every private source a map used can read it.** To anyone else it does not exist: every tool answers `not found`, exactly as for a map that was never built, and `list_maps` leaves it out. Don't try to tell the two apart.
- **Runs on a private map stay private.** `research`, `explain` and `ask_map` on it use no web search and no public source, only the map and the private sources it already uses. `check_context` never uses sources, so keep private details out of the context you give it.
- **Exports carry the content.** `export_map` on a private map marks it "Private", but whoever gets the file can read it: share it only with people who may read the map.

## Tool catalog

Generated from the tool definitions (`src/ops.js`) by `scripts/mcp-catalog.js`; a test fails if it is out of date.

<!-- tool-catalog:start (generated by scripts/mcp-catalog.js from src/ops.js; do not edit by hand) -->

16 tools. Free (no model call): `list_maps`, `wait_for_map`, `save_map`, `get_outline`, `search_map`, `get_node`, `get_context`, `export_map`. Call the model (cost API credits): `check_context`, `build_map`, `research`, `explain`, `sources`, `fuse`, `rosetta`, `ask_map`.

### `list_maps`: List maps

List the maps on this server that you may read. Use when you start, to find a map by name, or to check that a map you built exists and whether it is private. Don't use when you already have the map id. Returns { maps: [{ id, name, root, nodes, draft, visibility? }] }: drafts are kept like saved maps; visibility "private" means only holders of its sources can read it. Next: get_context or get_outline on an id.

free · read-only · idempotent · token scope: `read` · HTTP: `GET /v1/t/{tenant}/maps`

No inputs.

### `check_context`: Check a topic before building

Turn a plain description of a topic into a brief that build_map can use. Use when you want a new map: it is always the first step of building. Don't use when a map of the topic already exists (list_maps, then read it). Returns { ready: true, brief, name } when the topic is clear, or { ready: false, questions: [{ id, text, options }] }: ask your user (or answer from what you know), then call again with the same context and all answers so far, at most three rounds (if it still asks, add detail to the context and start again). Your context goes to the model as plain text; it never uses configured sources and writes nothing. Next: build_map with the brief. Calls the model: costs API credits.

**calls the model** · read-only · token scope: `build` · HTTP: `POST /v1/t/{tenant}/maps/check`

| Input | Type | Required | Description |
|---|---|---|---|
| `context` | string | yes | What the map is about and for whom, in plain words; at most 4000 characters. E.g. "Home espresso for a complete beginner: machines, grinders, beans, technique" |
| `answers` | object[] | no | Every answer so far to the questions check_context asked, as { id, answer } with the question's id (add question: its text, if you like). E.g. [{ "id": "budget", "answer": "Under 500 dollars" }]. Omit on the first call. |

### `build_map`: Build a map

Start building a new map (a tree of categories and nodes, with cross-links and sources) from the brief check_context returned. Use when check_context said ready. Don't use when you have no brief yet (call check_context first) or a map of the topic exists (list_maps). Returns at once with { id, viewUrl, eventsUrl }: the build goes on in the background (a minute or two at depth 2) and viewUrl shows it growing. The map is kept as a draft under id; building from a private source makes it private for good, before its first node is written. Next: wait_for_map with the id. Calls the model: costs API credits.

**calls the model** · writes to the map · token scope: `build` · HTTP: `POST /v1/t/{tenant}/maps`

| Input | Type | Required | Description |
|---|---|---|---|
| `brief` | object | yes | The brief object exactly as check_context returned it; pass it through unchanged. E.g. { "context": "...", "subject": "Home espresso", "level": "beginner" } |
| `name` | string | no | A display name for the map, at most 120 characters. E.g. "Home espresso". Default: the name check_context suggested |
| `depth` | integer | no | How many levels to build, 1 to 5 (default 2: categories and their nodes). E.g. 3 for more detail; each level costs more |
| `sources` | string[] | no | Configured sources (your operator's MCP servers) to build from, by name. E.g. ["wiki"]. Default: every source you hold. Naming a private source makes the map private for good. Names you may use are listed in this description when the server has any |

### `wait_for_map`: Wait for a map to finish

Wait until nothing runs on a map: its build, its jobs (research, explain, sources, fuse, rosetta) and any answer being written. Use when build_map or a job answered with an id or jobId and you need the result; jobs have no id of their own to wait on, so wait on the map. Don't use when you only want to read a finished map. Returns { state: "idle" | "busy", jobs: [{ id, kind, state }], error? }: "busy" means the timeout passed first, so call again; error says why a build failed. Next: get_context, get_outline or get_node.

free · read-only · idempotent · token scope: `read` · HTTP: `GET /v1/t/{tenant}/maps/{id}/wait`

| Input | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | The map id, from list_maps or build_map: a saved map's name or a draft id. E.g. "sourdough" or "draft-20261109-153012" |
| `timeout` | integer | no | Milliseconds to wait at most, 0 to 300000 (default 30000). E.g. 120000 for a build |

### `research`: Research a node (add nodes under it)

Grow a map under one node: the model adds new child nodes there, in place on this map. Use when a branch is thin or the user wants more depth on one part. Don't use when you only want to know what the map already says (get_node, free) or want one node written up in full (explain). Returns at once with { ok, jobId }; repeating the same request while it runs does not start a second one. On a private map it uses no web search. Next: wait_for_map, then get_node on the same node to see its new children. Calls the model: costs API credits.

**calls the model** · writes to the map · token scope: `build` · HTTP: `POST /v1/t/{tenant}/maps/{id}/actions`

| Input | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | The map id, from list_maps or build_map: a saved map's name or a draft id. E.g. "sourdough" or "draft-20261109-153012" |
| `nodeId` | string | yes | A node id exactly as get_outline, search_map or get_node shows it; ids are paths. E.g. "sourdough/starter/levain" |
| `mode` | "context" \\| "general" | no | "context" keeps to the map's brief (default); "general" covers the node's topic broadly. E.g. "general" when the user wants to go beyond the brief |

### `explain`: Explain a node (write its article)

Write the article for one node: a summary, key facts, why it matters, and sources, stored on the node. Use when get_node says the node is "Not explained yet" and you need more than its one-line summary. Don't use when the node already has an article (get_node shows it, free) or you want new nodes (research). Returns at once with { ok, jobId }. Next: wait_for_map, then get_node to read the article. Calls the model: costs API credits.

**calls the model** · writes to the map · token scope: `build` · HTTP: `POST /v1/t/{tenant}/maps/{id}/actions`

| Input | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | The map id, from list_maps or build_map: a saved map's name or a draft id. E.g. "sourdough" or "draft-20261109-153012" |
| `nodeId` | string | yes | A node id exactly as get_outline, search_map or get_node shows it; ids are paths. E.g. "sourdough/starter/levain" |

### `sources`: Find web sources for a node

Find web pages that back up one node and attach them to it. Use when a node has no sources and you need citations to show the user. Don't use when get_node already lists sources, or on a private map whose content must not go to a web search. Returns at once with { ok, jobId }. Next: wait_for_map, then get_node to see the sources. Calls the model: costs API credits.

**calls the model** · writes to the map · token scope: `build` · HTTP: `POST /v1/t/{tenant}/maps/{id}/actions`

| Input | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | The map id, from list_maps or build_map: a saved map's name or a draft id. E.g. "sourdough" or "draft-20261109-153012" |
| `nodeId` | string | yes | A node id exactly as get_outline, search_map or get_node shows it; ids are paths. E.g. "sourdough/starter/levain" |

### `fuse`: Fuse two maps (find where they connect)

Make a new map that joins two existing maps and adds bridges: cross-links saying where and why the two fields connect. Use when the user asks how two fields relate and both have maps. Don't use when one of the maps does not exist yet (build it first), or a quick comparison of two context packs is enough (get_context on each, free). The two maps are not changed; if either is private, the new map is private. Returns at once with { ok, jobId, draftId, url }: draftId is the new map's id (a draft id) and url its page. Next: wait_for_map on draftId, then get_context on it (its Bridges section). Calls the model: costs API credits.

**calls the model** · writes to the map · token scope: `build` · HTTP: `POST /v1/t/{tenant}/maps/{id}/actions`

| Input | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | The map id, from list_maps or build_map: a saved map's name or a draft id. E.g. "sourdough" or "draft-20261109-153012" |
| `with` | string | yes | The other map, by id or name. E.g. "fermentation-science" |
| `into` | string | no | A name for the new map (its root), lowercase letters, digits and hyphens, at most 40 characters; the map's id is still a draft id. E.g. "bread-science". Default: the model picks a name |

### `rosetta`: Add a lens for a persona

Add a lens to a map: every node gets an analog from a persona's own world ("a chef": a grinder is like a pepper mill). Use when the user learns best through something they already know. Don't use when you just need the map's content (get_context). Returns at once with { ok, jobId, lensId }. Next: wait_for_map, then ask_map with lens set to lensId, or get_node. Calls the model: costs API credits.

**calls the model** · writes to the map · token scope: `build` · HTTP: `POST /v1/t/{tenant}/maps/{id}/actions`

| Input | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | The map id, from list_maps or build_map: a saved map's name or a draft id. E.g. "sourdough" or "draft-20261109-153012" |
| `persona` | string | yes | Who the map is retold for, at most 120 characters. E.g. "a jazz guitarist" |
| `name` | string | no | A short id for the lens: lowercase letters, digits and hyphens, at most 40 characters. E.g. "guitarist". Default: made from the persona |

### `ask_map`: Ask a map a question

Ask one question about a map and get a written answer that cites the map's nodes (and web pages for what the map lacks; none on a private map). The question and answer are saved in the map's chat. Use when the user wants an answer in prose grounded in the map, with citations. Don't use when you can answer from get_context or get_node yourself (free), or to change the map (research, explain). Returns { answer, citedNodes: [{ id, label }], sources: [{ title, url }], chatId }. Next: get_node on a cited node, or ask_map again with the same chatId to follow up. Calls the model: costs API credits.

**calls the model** · writes to the map · token scope: `ask` · HTTP: `POST /v1/t/{tenant}/maps/{id}/chat`

| Input | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | The map id, from list_maps or build_map: a saved map's name or a draft id. E.g. "sourdough" or "draft-20261109-153012" |
| `text` | string | yes | The question, at most 4000 characters. E.g. "Which grinder settings matter most for a beginner?" |
| `chatId` | string | no | A conversation name: questions with the same chatId see the earlier questions and answers. Letters, digits, hyphens. E.g. "espresso-agent". Default "main", the conversation the map page shows |
| `lens` | string | no | Answer through a lens: a lensId from rosetta. E.g. "guitarist". Default: no lens |

### `save_map`: Save or rename a map

Give a map a name, which becomes its id: a draft becomes a saved map, a saved map is renamed. Use when the user wants to keep a map under a memorable name. Don't use when you only want to keep it (drafts are kept too) or while anything runs on it (wait_for_map first). The old id and its viewUrl stop working; visibility does not change (a private map stays private). Returns { ok, id, viewUrl } with the new id. Next: use the new id with every other tool.

free · writes to the map · destructive (the old id stops working) · token scope: `build` · HTTP: `POST /v1/t/{tenant}/maps/{id}/save`

| Input | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | The map id, from list_maps or build_map: a saved map's name or a draft id. E.g. "sourdough" or "draft-20261109-153012" |
| `name` | string | yes | The new name and id: lowercase letters, digits and hyphens, at most 63 characters. E.g. "home-espresso" |

### `get_outline`: Read a map's outline

Read a whole map as an indented outline, one line per node: "- Label (nodeId): summary". Use when you need every node and its id, e.g. to pick a node for get_node, research or explain. Don't use when you want the map's meaning in your context with its cross-links and gaps (get_context is better for that). Returns markdown text. Free: no model call. Next: get_node on a node id.

free · read-only · idempotent · token scope: `read` · HTTP: `GET /v1/t/{tenant}/maps/{id}/outline`

| Input | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | The map id, from list_maps or build_map: a saved map's name or a draft id. E.g. "sourdough" or "draft-20261109-153012" |

### `search_map`: Search a map

Find the nodes of one map that match some words (labels, summaries, articles, source titles). Use when you know what you are looking for but not its node id. Don't use when you need the whole map (get_outline, get_context). Returns { results: [{ id, label, path, snippet }] }, best first; empty when nothing matches. Free: no model call. Next: get_node with a result's id.

free · read-only · idempotent · token scope: `read` · HTTP: `GET /v1/t/{tenant}/maps/{id}/search`

| Input | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | The map id, from list_maps or build_map: a saved map's name or a draft id. E.g. "sourdough" or "draft-20261109-153012" |
| `q` | string | yes | Keywords, at most 500 characters. E.g. "levain starter" |
| `limit` | integer | no | At most this many results, 1 to 50 (default 8). E.g. 3 |

### `get_node`: Read one node

Read everything a map says about one node: its path, summary, article (or "Not explained yet"), sources, children and cross-links to other nodes. Use when you need the detail behind one line of the outline, or to see what research or explain added. Don't use when you do not know the node id (search_map or get_outline first). Returns the node as an object; an unknown id is an error that suggests close ids. Free: no model call. Next: explain or research on the node if it is thin.

free · read-only · idempotent · token scope: `read` · HTTP: `GET /v1/t/{tenant}/maps/{id}/nodes/{nodeId}`

| Input | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | The map id, from list_maps or build_map: a saved map's name or a draft id. E.g. "sourdough" or "draft-20261109-153012" |
| `nodeId` | string | yes | A node id exactly as get_outline, search_map or get_node shows it; ids are paths. E.g. "sourdough/starter/levain" |

### `get_context`: Bring a map into your context

Read a map as a context pack: markdown with its brief, outline, bridges (cross-links between categories), insights, thin areas and sources, trimmed to a token budget. Use when you want to learn, teach, brainstorm or write from a map: this is the best first read. Don't use when you need one node in depth (get_node) or a file for a person (export_map). Returns markdown text; its last line says what was trimmed. Free: no model call. Next: brainstorm or answer from it yourself; get_node for detail.

free · read-only · idempotent · token scope: `read` · HTTP: `GET /v1/t/{tenant}/maps/{id}/context`

| Input | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | The map id, from list_maps or build_map: a saved map's name or a draft id. E.g. "sourdough" or "draft-20261109-153012" |
| `budget` | integer | no | Estimated tokens at most, 300 to 200000 (default 4000). E.g. 8000 for a big map you want in full |

### `export_map`: Export a map for a page or a file

Export a map for people: "embed" is an HTML fragment (an interactive map: pan, zoom, click a node) to paste into a document or web page; "html" is a whole page; both work offline with nothing loaded from the network, keep their styles inside their own element (they do not clash with the page), and are a snapshot that does not update (export again after the map changes). "json" is the full data; "context" is the same pack as get_context. Use when the map must go into a document, a page or a file. Don't use when you want to read the map yourself (get_context, get_outline). A private map's export says "Private": share it only with people who may read it. Returns the exported text (html and embed are large, about 150 KB). Free: no model call. Next: write it into the user's file.

free · read-only · idempotent · token scope: `read` · HTTP: `GET /v1/t/{tenant}/maps/{id}/export`

| Input | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | The map id, from list_maps or build_map: a saved map's name or a draft id. E.g. "sourdough" or "draft-20261109-153012" |
| `format` | "json" \\| "context" \\| "html" \\| "embed" | yes | One of "embed" (a fragment for a document or page), "html" (a whole page), "json", "context". E.g. "embed" |
| `budget` | integer | no | For "context" only: estimated tokens at most, 300 to 200000 (default 4000). E.g. 2000 |
| `threeD` | boolean | no | For "html" and "embed" only: add the 3D view (default false; about five times bigger). E.g. false |

### Prompts

Starting points a client can offer (MCP prompts):

| Prompt | What it does | Arguments |
|---|---|---|
| `learn-a-field` | Map a field you know nothing about, then learn it from the map. | `topic` |
| `brainstorm-from-map` | Ground a brainstorm in a map you already have. | `map`, `goal` (optional) |
| `map-for-a-doc` | An interactive map of a field, ready to paste into a document or web page. | `topic`, `format` (optional) |
| `connect-two-fields` | Fuse two maps and read the bridges between them. | `a`, `b` |
| `deepen-a-node` | See what a map says about one node, then extend it. | `map`, `node` |
| `private-map` | Build a map from a private source and keep it private. | `topic`, `source` |

<!-- tool-catalog:end -->
