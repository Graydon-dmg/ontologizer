# Security

## Reporting a vulnerability

Email the maintainer at graydon.garden@outlook.com. Please do not open a public issue for a security report. Include:

- steps to reproduce,
- the version (`ontologizer --version`).

Supported versions: the latest release.

## Verifying a release

Releases are published to npm from GitHub Actions using npm trusted publishing (OIDC), with provenance: each published version is signed and linked to the exact source commit and workflow run that built it. To check what you installed, run `npm audit signatures` in a project that depends on ontologizer; the npm page for each version also shows its provenance.

## How your API key is handled

Ontologizer looks for your Anthropic API key in this order:

1. the `ANTHROPIC_API_KEY` environment variable;
2. your operating system's keychain (through `@napi-rs/keyring`), under service `ontologizer`, account `anthropic-api-key`;
3. a masked prompt in a terminal. It accepts only a key starting with `sk-ant-` (three tries) and saves it to the keychain. With no terminal and no key, it stops with an error instead of waiting.

The key is never printed, logged, written to a file, or put into `process.env` (so programs Ontologizer starts, such as the browser opener and `npm`, do not inherit it). Those child programs also get an environment with `ANTHROPIC_API_KEY` removed. The key goes only into the Anthropic client object.

- `ontologizer key` prints only where the key comes from: the environment, the keychain, or none.
- `ontologizer key set` prompts for a key and stores it in the keychain.
- `ontologizer key clear` deletes it from the keychain.

## What is sent to Anthropic

Ontologizer sends requests to the Anthropic API (api.anthropic.com) through the official SDK. They carry:

- **Building a map:** the context you type (and your answers to its clarifying questions), then the map's brief (context, subject, scope, purpose, reader level) plus category and node labels as the map grows.
- **Research:** the brief and the node's label path and the labels already under it. "General" research sends only the node's label, with no brief.
- **Explain and Sources:** the brief and the node's label path.
- **Fuse:** the two maps' node ids and labels.
- **Rosetta:** node ids, label paths and summaries.
- **Chat:** your question; any images attached to it; the last 10 answered exchanges of the chat; the brief (subject, scope, purpose, level); an outline of the map (every node's label, id and summary, plus its lens analog when a lens is active); and whatever the model looks up with its read-only map tools: matching nodes' labels, paths and snippets, and a node's article, sources, parent, children and links. It may also run up to 3 web searches per question.

Explain, Sources and Chat use Anthropic's web search tool, so Anthropic runs searches on your behalf for those requests. See Anthropic's own terms for how it handles API data.

## Other network contact

Nothing else is sent anywhere, with two exceptions, neither of which carries your maps or key:

- **Version check.** Once a day, in an interactive terminal, Ontologizer fetches `https://registry.npmjs.org/ontologizer/latest` to see if a newer version exists. Set `ONTOLOGIZER_NO_UPDATE_CHECK=1` to turn it off. `ontologizer doctor` makes the same request.
- **`ontologizer doctor`** also sends a HEAD request to `https://api.anthropic.com` (no key, no data) to check you can reach it.
- **`ontologizer update`** runs `npm i -g ontologizer@latest`.

## The local server

When you open a map, Ontologizer starts a web server on `127.0.0.1` (your own machine only) on a random free port. It checks every request:

- The `Host` header must be exactly `127.0.0.1:<port>` or `localhost:<port>`. Anything else gets 403. This blocks DNS-rebinding attacks from other websites.
- `POST /api/action` is the only write endpoint. If the request has an `Origin` header, it must be `http://127.0.0.1:<port>` or `http://localhost:<port>`, otherwise 403. Bodies over 64 KB are rejected, and the action type and its fields are validated.
- `POST /api/chat` (the chat) has the same `Host` and `Origin` checks. It takes JSON only (415 otherwise), refuses a body over about 27 MB (enough for four 5 MB images plus the longest message) before or while reading it (413), and allows at most 4 images of 5 MB each. An image's type is read from its own bytes, not from what the request claims: only PNG, JPEG, WebP and GIF are accepted, so SVG and anything else is refused. Only one chat answer is written per map at a time (409). Closing the page stops the answer, and so does a model that sends nothing for 2 minutes or runs longer than 5 minutes in total.
- Chat images are served back only at `/api/attachments/<hash>` for an exact 64-character hex hash, with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`; no part of the request path reaches the file system.
- Every HTML page is sent with `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` and `X-Content-Type-Options: nosniff`, so another website cannot show it in a hidden frame and trick your clicks into a build or a chat.
- Static files are served only from `web/shell`, `web/shared`, `web/views`, `web/dev`, `fixtures/`, `src/core/` and the vendored packages. A path that escapes those folders gets 404.

## Network mode

`ontologizer serve` (service mode) is off unless you run it. It listens on `127.0.0.1` by default and is then open to your own machine only, like the one-map server. It never listens on another address without tokens:

- **Loopback unless tokens are loaded.** A `--host` that is not `127.0.0.1`, `::1` or `localhost`, with no tokens, exits 1 before it opens a port. Revoking every token while it runs closes it to everyone; it never opens it. Tokens created while an open server runs are not required until it is restarted: `ontologizer status` and the Server panel say so.
- **Open mode is for this machine only.** With no tokens, the server trusts that nothing but this machine can reach its port. The proxy-header check below is a safety net, not a boundary: a tunnel or port forward sends no such headers. Never expose an open server through a reverse proxy, a tunnel (`ssh -R`, ngrok) or a port forward. Create a token first.
- **A proxy needs tokens.** With no tokens, `--allow-host` (or `ONTOLOGIZER_ALLOW_HOST`) exits 1, and any request carrying `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host` or `X-Real-IP` gets 403, so a reverse proxy in front of an open server cannot expose it, even one that rewrites `Host` to `127.0.0.1`.
- **Tokens.** `ontologizer token create` prints a token once. `<home>/tokens.json` stores only its SHA-256 hash, is written atomically with mode 0600, and is compared in constant time. No response, log line or page contains a token: the Server panel and `ontologizer status` show names, tenants and scopes only. `token revoke` takes effect on the next request: it ends that token's browser sessions and closes its open event streams within one keep-alive ping (15 s). An answer the model is already writing finishes.
- **Scopes are a ladder:** `read` < `ask` < `build` < `admin`, each including the ones before it. `read` only reads. Asking the map (`ask`) calls the model at your cost and writes the conversation and any images into the map, so it needs `ask`. `build` builds, changes and saves maps. `admin` also sees every tenant's status and the server's own paths.
- **Every `/v1/t/` route needs a token** (`Authorization: Bearer <token>`, or the session cookie): none or a wrong one gets 401, another tenant's map gets 404 (its existence is not revealed), a missing scope gets 403. Health checks and the page's static files need none.
- **Browser sessions.** Signing in on the maps home sets `ontologizer_session` (`HttpOnly`, `SameSite=Strict`, `Path=/`), a random id that is not the token and lives only in the server's memory (12 hours, or until the server stops; at most 20 per token, its oldest going first). Behind an `--allow-host` proxy that sends `X-Forwarded-Proto: https`, the cookie is also `Secure`. A `POST` or `DELETE` that uses the cookie must carry an `Origin` matching the server's own (the `Host` it was reached by, or an `--allow-host` name), or it gets 403. Bearer requests need no `Origin`.
- **Host check.** The `Host` header must be `127.0.0.1`, `localhost` or `[::1]` (any port, so a container's `-p 9000:8787` works), the bound address and port, this machine's own IP addresses on that port when bound to every interface, or a name given with `--allow-host`. Anything else gets 403, which blocks DNS rebinding: a rebinding page can only send its own host name, and only `--allow-host` names are accepted.
- **Limits.** At most `--max-builds` builds run at once and `--max-queued` wait per tenant (more get 429); waiting builds start in turn across tenants. At most `--max-checks` context checks run at once (429). A token holds at most 50 open event streams and waits (429). A map with no open streams and nothing running gives back its engine after 10 minutes. These caps limit new-map builds only. A `build` token can still start research, explain, fuse and rosetta jobs, and an `ask` token can chat; all of them spend your Anthropic credits. Give `build` or `ask` only to people you trust with your API spend.
- **Plain HTTP.** Service mode serves HTTP, so tokens and session cookies cross the network unencrypted. For anything beyond this machine, put it behind a reverse proxy that serves HTTPS, create a token, and pass `--allow-host` with the proxy's name. `serve` on a non-loopback `--host` prints a warning saying so. In a container, publish the port on loopback only (`-p 127.0.0.1:8787:8787`) for the proxy to reach.
- **No framing.** Every page carries `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`, so another website cannot frame it.
- **The API key** stays in the server's environment or keychain. Service mode never prompts for it and never sends it to a browser.

## Ports, sources and private maps

Service mode can load an optional `ontologizer.config.js` (see the guide, "Ports and private sources").

- **The config runs as code.** Loading it imports a JavaScript module with the server's own rights: it can read files and the environment and open connections. `serve` finds it only through `--config`, `ONTOLOGIZER_CONFIG` or `<home>/ontologizer.config.js`, never from the current folder, so running `serve` in a folder someone else controls cannot load their code. Keep the file writable only by you. A config that fails to load or validate stops the server (exit 1); unknown keys are refused rather than ignored.
- **Sources only read.** A source's tool is offered to the model only if the operator listed it in `allowTools` and the source server marks it `readOnlyHint`. Both must hold; a call to any other tool is refused before it reaches the server. `readOnlyHint` is the source server's own claim, which is why the operator's list is also required: remove a source that lies about its tools. `sources list` and `sources test` never call a tool.
- **Citations are checked.** A node cites a source document only if a tool returned that document in the same build or job; the title and link come from the tool's result, and only `http`/`https` links are made clickable.
- **Private maps.** A map is marked private before its first node when a private source is picked for it, and otherwise the first time a private source answers during a run (a result or any error), before that answer reaches the model; a fused map with a private input is private too. Nothing can mark it public again. A private map is readable only by an admin or a principal holding every private source it used (a private map naming no source: admin only); anyone else gets 404 on every route of it, and it is left out of their maps list, fuse picker and map count. A click or a question on an existing map never brings in a new private source: only **New map** does.
- **Open connections are re-checked.** An event stream re-checks the caller (token, session, the token's current sources) and the read rule on every keep-alive ping and before every event; a map that becomes private ends the stream of anyone who cannot read it before the raise is sent. A chat answer is stopped the same way, before its next chunk. With a custom identity port, the caller is re-checked too: the port's optional `stillValid(principal)` is asked, or else its `authenticate` runs again on the request that opened the stream (it must return the same actor and tenant); a custom policy is asked again as well. Each is asked again once its last answer is 5 seconds old, so a user your identity or policy removes loses an open stream or chat at the first check after that (within one keep-alive ping, 15 s, when nothing else is sent).
- **A map's private sources share one trust zone.** Every private source a map uses is offered to the model on that map's runs together. Text in one source's document can instruct the model to query another of the map's sources with what it read, so content from one can end up in a search sent to another, and in the map. Use private sources on the same map only when everyone who can reach one may see the others; keep sources that must stay apart on separate maps.
- **Private runs stay private.** Once a map is private, its runs are offered no web search and no public source, only the map and the private sources they may use. A private source's error text never reaches the model. Every source's results come with the instruction that they are data, never instructions (prompt injection from a source can still steer the model's own answer, but it cannot reach a tool that is not offered).
- **Names.** Fuse never names a map the caller cannot read, and a fuse with a private side records only "a private map" in the other map's log. Save under a taken name answers 409 "That name is not available." without naming the map, but it does reveal that the name is taken: map ids are names, so a caller can probe whether a name exists in its tenant.
- **Changing a source's visibility.** Making a source public in the config opens every map that was private for it to principals who hold public sources by default (tokens without a `sources` list). Nothing rewrites existing maps.
- **The Postgres store** stores every write the server acknowledges before answering, stops at the first failed write (503 from then on, no gaps, and nothing more is served from memory), and refuses a second process on the same tenant (an advisory lock). If the lock's connection is lost, the store stops the same way, so it never writes beside another process; the server keeps running and `/v1/health/ready` answers 503.
- **Tenants and connections.** A status for another tenant (an admin's) never opens that tenant's store. At most `--max-stores` (default 16) tenants have a store open at once, files or Postgres, and a store that fails to open is not kept, so made-up tenant names cannot use up the database's connections. A store with nothing open on it (no request, stream, chat, build or engine) for the idle time (10 minutes) is closed, freeing its slot; when every slot is busy, a new tenant gets 503 with `Retry-After`. A store that failed after opening (a lost Postgres connection, a failed write) is not closed this way: that tenant answers 503, and `/v1/health/ready` reports not ready, until the server is restarted.
- **Logs.** A private source's errors are logged as the source's name and an error code or class only, never their text.
- **Async policies** are awaited for every event an open stream sends, in order; only a `true` lets an event out. A custom policy's answer is reused for at most 5 seconds; the default policy's until the caller's scopes or sources, or the map's visibility, change.
- **Status** remembers whether each source is reachable for 30 seconds, and never opens a store for a tenant that does not exist, or for another tenant. It lists each token's name, tenant and scopes; a token's `sources` (which may name private sources) are shown only to an admin, or to that token itself.
- **Identity port.** A custom identity replaces tokens. It is trusted to say who a request comes from, so whatever it reads (for example a header set by a sign-in proxy) must be something only that proxy can set: keep the server unreachable except through it. A principal without a valid actor, tenant and scopes, or an identity that throws, is refused. A cross-origin `POST` is refused as with cookie sessions.
- **Policy port.** A custom policy that throws or returns anything but `true` denies. No policy can reach another tenant's maps.
- **Who did what.** Every event a service-mode request appends carries the caller's actor (`token:<name>`, `local`, or the identity port's actor), never a token or a session id.
- **Model port.** The model client and any headers it adds are the operator's code; the server passes it the principal and the call's purpose, nothing else.

- **Chat links on a private map.** A chat answer on a private map can only link to addresses a source returned during that answer. Any other link shows as plain text and is not listed as a source, so a hidden instruction in a private document cannot turn private text into a link to somewhere else.
- **Admin-only maps stay admin only.** A private map that names no source (for example a fuse with such a map) is readable only by admins, and a later source never widens it.
- **The config file runs code.** Every command refuses a config file that is not yours (or root's), that group or others can write to, or that sits in a folder anyone can write to without the sticky bit. The error names the file and the fix, such as `chmod go-w`. Windows skips this check.

## Agents and apps

- **MCP takes the same path as everything else.** No MCP tool calls the engine or the store. `/v1/mcp` first checks the caller as every `/v1/t/` route does (401 without a valid token or session; 403 for a cookie request without a matching `Origin`, or any foreign `Origin`), then sends each tool call to the same server on loopback with the caller's own headers. The tenant rule, the scopes, the read rule for private maps, the policy port and the limits apply to it unchanged: a reader asking for a private map's outline gets the same "not found" over MCP as over HTTP.
- **`ontologizer mcp` (stdio)** with `--url` sends the token from `--token-file` or `ONTOLOGIZER_TOKEN`; there is no flag for a token, so it never appears in the process list or shell history. It refuses (exit 1) an `http://` URL to anything but this machine, where the token would cross the network unencrypted, unless `--allow-http` is given; use `https://`. It warns on stderr when the token file can be read by group or others (`chmod 600` it; not checked on Windows). Without `--url` it runs a server on `127.0.0.1` (a random port) for as long as it runs, signed in with a random admin token it makes at start and holds only in memory: never written, printed or logged. Another program on this machine that finds the port gets 401. It still refuses (exit 1) a home that has tokens or a config: such a home is reached only through a running `serve`, with `--url` and a token file.
- **Two writers on one home.** While an agent uses the in-process `ontologizer mcp`, `ontologizer load` (or `serve`) on the same home is a second process writing the same maps. Each sees only its own changes live: a page open in one does not show what the other writes until it is reloaded.
- **The map resource is a read like the tools.** `ontologizer://<tenant>/maps/<id>/snapshot` is the read tools' own copy of the map (the export's allow-list, escaped: no chat, no jobs, no private source names), through the same read rule.
- **Tools that cost money say so.** Every tool that calls the model ends its description with "Calls the model: costs API credits." An agent with a `build` or `ask` token can spend your credits; give agents a `read` token unless they need more.
- **Connect an agent** shows a `<YOUR_TOKEN>` placeholder, never a token. `/v1/openapi.json` needs no token and holds no secret.
- **Limits are not a spend cap.** `--limit-calls` and `--limit-tokens` count model calls and tokens per tenant per UTC day, from what each response reports; no prices are kept, so they do not bound what you spend in money. Set a spend limit with your API provider too. The counts are kept in `<home>/usage.json` (mode 0600, no prompts or answers in it). Two processes on one home (`serve` and `ontologizer mcp`, or an overlapping restart) add their counts up: every write merges with the file under a lock. Tokens are counted as an answer streams, so an answer that is stopped half way still counts what it used, and a stream that reports nothing is counted by estimate (its size in, its `max_tokens` out), never as free.

## Data at rest

Images you attach in the chat are saved in the map's folder as `attachments/<sha256>.<ext>`. The chat transcript in `events.jsonl` records only each image's hash, type and size, never its bytes. Delete `attachments/` (or single files in it) to remove the images; the chat still loads without them.


Maps are plain JSONL files (one event per line) in `~/.ontologizer`, or in the folder named by `ONTOLOGIZER_HOME`. They are readable by your user account and are not encrypted. They contain no API key. They do contain the context you typed and everything the model wrote, so treat them like any other personal notes.
