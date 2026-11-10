# Changelog

## 1.6.0 (2026-11-10)

- **Manage maps.** Rename a map, or delete it to a 30-day trash and restore it, from the map page, the maps home or the command line (`ontologizer delete`, `trash`, `restore`). An **All maps** link goes back to your list. Thanks to Alex Garden ([#9](https://github.com/Graydon-dmg/ontologizer/pull/9)).
- **Agents get more from one read.** The context pack and `get_node` carry node ids, articles and branch links; `explain` and `sources` take several nodes in one call; a web search that fails is recorded and `ask_map` says so. Thanks to Alex Garden ([#8](https://github.com/Graydon-dmg/ontologizer/pull/8)).

## 1.5.0 (2026-11-10)

- **Agents can use your maps (MCP).** `ontologizer mcp` connects Claude Code, Claude Desktop or any MCP client to your maps: list, outline, search, read a node, get a context pack, and (with permission) build, research, explain, ask, fuse and save. **Connect an agent** in the Export menu shows the setup. The tools that spend API credits say so. See [docs/MCP.md](docs/MCP.md) and [FOR-AGENTS.md](FOR-AGENTS.md). Thanks to Alex Garden ([#6](https://github.com/Graydon-dmg/ontologizer/pull/6), [#7](https://github.com/Graydon-dmg/ontologizer/pull/7)).
- **HTTP API and JS client.** `serve` describes every route at `/v1/openapi.json`, adds cheap reads (outline, search, node, context, export), and `ontologizer/client` wraps them for Node and browsers.
- **Usage and limits.** `ontologizer usage` shows model calls and tokens per day. `serve --limit-calls / --limit-tokens` caps them per tenant (not a money cap), and `--build-timeout` stops runaway builds.
- **Private sources and ports.** An `ontologizer.config.js` can plug in your own sign-in, permission rules, storage (files or Postgres via `ontologizer/store-postgres`) and model client, and add private MCP sources that builds can search. A map that uses a private source becomes private: it is hidden from anyone who can't read that source, never mixed with web search, and marked Private everywhere, exports included. Thanks to Alex Garden ([#4](https://github.com/Graydon-dmg/ontologizer/pull/4), [#5](https://github.com/Graydon-dmg/ontologizer/pull/5)).
- **Hardened after review.** Revoked users lose open streams and chats; idle tenants free their slot; a chat on a private map can't link out to addresses its sources never returned; admin-only maps stay admin only; a config file other users can change is refused; drafts are written crash-safe; the local agent server needs a secret only it knows; builds stopped by a session ending say so; the usage counter never blocks the server or resets on a damaged file.
- **Laptop use is unchanged.** With no config, `new`, `load`, the page, research, explain, fuse, Rosetta and Ask the map send exactly what they did in 1.4.0. `ontologizer list` only adds a visibility column when a map is private.

## 1.4.0 (2026-11-09)

Tagged but never published to npm: everything below ships in 1.5.0.

- **Export.** `ontologizer export <map> --format html | embed | json | context`, and an **Export** menu on the page. `html` is one page that shows the map offline (pan, zoom, click, collapse, search; `--3d` adds the 3D view). `embed` is a fragment to paste into any page; several can share a page, 2D and 3D mixed. `json` is the map itself. Thanks to Alex Garden ([#3](https://github.com/Graydon-dmg/ontologizer/pull/3)).
- **Copy for an agent.** `--format context` (or **Copy for an agent** in the menu) gives a short markdown brief of the map to hand to an AI agent, kept within `--budget` tokens. Map text is cleaned so it can't pose as instructions.
- **Exports share only what they show.** Pages and embeds leave out the chat, your original prompt and job errors. JSON leaves out the chat unless you add `--include-chat`. **Open live** links back only from a map served at an address others can reach.
- **Search finds hidden matches.** A search opens the collapsed branches that hold a match, once you pause typing or press Enter.
- **Safer releases.** The export bundle is built in its own step, checked by hash, and published byte for byte.
- **Fixed:** `ontologizer --version` printed the wrong number when ontologizer was installed inside another project.

## 1.3.0 (2026-11-09)

- **Service mode.** `ontologizer serve` runs one server for every map in a folder: on your laptop, a Linux host or in Docker. A maps home page lists your maps and has a **New map** button (it asks the same questions as `ontologizer new`, then opens the live map). Thanks to Alex Garden ([#2](https://github.com/Graydon-dmg/ontologizer/pull/2)).
- **Access tokens.** `ontologizer token create / list / revoke` lets other people use your server. Each token has a level (read < ask < build < admin) and can be limited to its own space of maps (a tenant). Only a hash of each token is stored. Browsers sign in once and get a cookie, never the token.
- **Server panel and status.** `ontologizer status` and a read-only **Server** panel show what is running and which tokens exist (names and levels only).
- **Safe by default.** `serve` listens on this machine only. It refuses to listen on the network without tokens, warns that its traffic is plain HTTP (put an HTTPS proxy in front), and every page refuses to be framed by another site.
- **Laptop use is unchanged.** `new`, `load` and the one-map page work as before.
- **Layout polish.** The top bar fits on one row from 1280 px wide, "Ask the map" never shrinks to an icon, long map names truncate with a tooltip, labels stay on screen and off the panels, popovers stay inside the window, and clicking a link clears a citation highlight.

## 1.2.0 (2026-11-08)

- **Ask the map.** A new **Ask the map** button opens a Chat pane. Ask in words or with images (paste, drop or add up to 4), and the answer cites the map's nodes (click one to see it) and lists web sources for anything the map lacks. It can suggest research, but never starts a job on its own.
- **Cited nodes light up** in both the 2D and the 3D view.
- **Safer API key setup.** The key is checked with Anthropic before it's saved, and the API address is pinned to api.anthropic.com unless ANTHROPIC_BASE_URL is a secure address.
- **Hardened chat endpoint.** `/api/chat` caps the request size, checks image types from the file bytes, writes one answer per map at a time, stops stalled answers, and serves images back sandboxed.

## 1.1.0 (2026-11-08)

- **Fuse from the browser.** A "Fuse" button in the top bar lists your other maps, then fuses the open map with the one you pick into a new map that opens in its own tab. Both originals stay untouched.
- **MIT licence.** Ontologizer is now MIT-licensed. Version 1.0.0 remains Apache-2.0.
- **Calmer Rosetta and 3D labels.** Each lens analogy sits as a short second line under its node's label, with a dot where the analogy breaks (full text on hover). Labels no longer pile on top of each other in 2D or 3D.
- **Persona kept after a reload.** The jobs tray still names the Rosetta persona ("Building lens: a home chef") after you reload the page.
- **Fixed tip strip.** The insight ticker has its own strip at the bottom, so it never covers the map or the panels.
- **Safe to pipe.** `ontologizer doctor | head` and other piped commands exit quietly instead of printing an error. Unknown flags are now rejected before anything runs.

## 1.0.0 (2026-11-08)

First release.

- **Live topic maps.** `ontologizer new` asks a few questions to pin down what you mean, then builds a color-coded map of the whole topic in waves and streams it into your browser as it goes.
- **2D graph and 3D view.** A force-directed 2D graph with a minimap, plus a 3D view, one click apart. Search, category and depth filters, and Light and Dark themes. Filters and theme are remembered.
- **Grow any node.** From a node's menu: Research it (in the context of your topic, or in general), Explain it (an article with key facts, "why it matters" and links to related nodes), or find Sources.
- **Fuse two maps.** `ontologizer fuse a b --into c` joins two maps into a third, adding bridges and hybrid ideas at the seam. Both originals stay untouched.
- **Rosetta lenses.** Re-explain a map through a field you already know ("a home chef"), with notes on where each analogy breaks.
- **Saved, loaded and replayed.** Every map is an event log in `~/.ontologizer/`. `ontologizer load <name> --replay` re-watches a build, and `ontologizer load demo --replay` runs the bundled demo with no network and no key.
- **Easy setup.** Your Anthropic API key is asked for once and kept in your system keychain (`ontologizer key set|clear`; `ANTHROPIC_API_KEY` overrides it). `ontologizer doctor` checks everything and tells you how to fix what it finds. Shell completion for zsh, bash and fish.

Requires Node 22 or newer.
