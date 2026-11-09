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
- Static files are served only from `web/shell`, `web/shared`, `web/views`, `web/dev`, `fixtures/`, `src/core/` and the vendored packages. A path that escapes those folders gets 404.

## Network mode

`ontologizer serve` (service mode) is off unless you run it. It listens on `127.0.0.1` by default and is then open to your own machine only, like the one-map server. It never listens on another address without tokens:

- **Loopback unless tokens are loaded.** A `--host` that is not `127.0.0.1`, `::1` or `localhost`, with no tokens, exits 1 before it opens a port. Revoking every token while it runs closes it to everyone; it never opens it.
- **Tokens.** `ontologizer token create` prints a token once. `<home>/tokens.json` stores only its SHA-256 hash, is written atomically with mode 0600, and is compared in constant time. No response, log line or page contains a token: the Server panel and `ontologizer status` show names, tenants and scopes only. `token revoke` takes effect on the next request, and ends that token's browser sessions.
- **Every `/v1/t/` route needs a token** (`Authorization: Bearer <token>`, or the session cookie): none or a wrong one gets 401, another tenant's map gets 404 (its existence is not revealed), a missing scope gets 403. Health checks and the page's static files need none.
- **Browser sessions.** Signing in on the maps home sets `ontologizer_session` (`HttpOnly`, `SameSite=Strict`, `Path=/`), a random id that is not the token and lives only in the server's memory (12 hours, or until the server stops). A `POST` or `DELETE` that uses the cookie must carry an `Origin` matching the server's own, or it gets 403. Bearer requests need no `Origin`.
- **Host check.** The `Host` header must name the bound address and port (when bound to loopback or every interface, also `127.0.0.1`, `localhost` or `[::1]` on that port; when bound to every interface, also this machine's own IP addresses on that port), or a name given with `--allow-host`. Anything else gets 403, which blocks DNS rebinding: a rebinding page can only send a host name, and only `--allow-host` names are accepted.
- **Plain HTTP.** Service mode serves HTTP. On a network you do not trust, put it behind a reverse proxy that terminates TLS, and pass `--allow-host` with the proxy's name.
- **The API key** stays in the server's environment or keychain. Service mode never prompts for it and never sends it to a browser.

## Data at rest

Images you attach in the chat are saved in the map's folder as `attachments/<sha256>.<ext>`. The chat transcript in `events.jsonl` records only each image's hash, type and size, never its bytes. Delete `attachments/` (or single files in it) to remove the images; the chat still loads without them.


Maps are plain JSONL files (one event per line) in `~/.ontologizer`, or in the folder named by `ONTOLOGIZER_HOME`. They are readable by your user account and are not encrypted. They contain no API key. They do contain the context you typed and everything the model wrote, so treat them like any other personal notes.
