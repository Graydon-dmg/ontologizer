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
- **Chat:** your question, the earlier messages in that chat, any images you paste or drop in, and the parts of the map the model looks up to answer (labels, summaries, articles and links of the nodes it searches). It may also use web search. ⟦verify against engine.ask⟧

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
- `POST /api/chat` (the chat) has the same `Host` and `Origin` checks. It takes JSON only (415 otherwise), refuses a body over 28 MB before or while reading it (413), and allows at most 4 images of 5 MB each. An image's type is read from its own bytes, not from what the request claims: only PNG, JPEG, WebP and GIF are accepted, so SVG and anything else is refused. Only one chat answer is written per map at a time (409), and closing the page stops it.
- Chat images are served back only at `/api/attachments/<hash>` for an exact 64-character hex hash, with `X-Content-Type-Options: nosniff`; no part of the request path reaches the file system.
- Static files are served only from `web/shell`, `web/shared`, `web/views`, `web/dev`, `fixtures/`, `src/core/` and the vendored packages. A path that escapes those folders gets 404.

## Data at rest

Images you attach in the chat are saved in the map's folder as `attachments/<sha256>.<ext>`. The chat transcript in `events.jsonl` records only each image's hash, type and size, never its bytes. Delete `attachments/` (or single files in it) to remove the images; the chat still loads without them.


Maps are plain JSONL files (one event per line) in `~/.ontologizer`, or in the folder named by `ONTOLOGIZER_HOME`. They are readable by your user account and are not encrypted. They contain no API key. They do contain the context you typed and everything the model wrote, so treat them like any other personal notes.
