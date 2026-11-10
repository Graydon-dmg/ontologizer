<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Graydon-dmg/ontologizer/main/web/shared/brand/lockup-dark.svg">
  <img alt="ontologizer" src="https://raw.githubusercontent.com/Graydon-dmg/ontologizer/main/web/shared/brand/lockup-light.svg" width="408">
</picture>

Ontologizer is an open-source command-line tool: give it a topic and Claude builds a live, color-coded map of everything inside it, streaming into a local web page as it goes.

**For AI agents:** start at [FOR-AGENTS.md](https://github.com/Graydon-dmg/ontologizer/blob/main/FOR-AGENTS.md). To use Ontologizer as a tool (MCP for Claude Code and the Agent SDK, the HTTP API, the JS client), see [docs/MCP.md](https://github.com/Graydon-dmg/ontologizer/blob/main/docs/MCP.md).

```text
        manga chess jazz
       *--o     o     o--*
           \    |    /
        *   \   |   /   *
         \   \  |  /   /
 espresso O--( you )--O rust
         /   /  |  \   \
        *   /   |   \   *
           /    |    \
       *--o     o     o--*
   sourdough gunpla orbits

      every topic is a map.
      ontologizer draws it.
```

![Ontologizer's 2D graph mid-build](https://raw.githubusercontent.com/Graydon-dmg/ontologizer/main/docs/screenshot.png)

- **A live map of any topic**, drawn in your browser as Claude builds it, in 2D or 3D.
- **Ask the map**: ask questions in words or with an image, and get answers that cite the map's nodes, with web sources when the map runs out.
- **Grow, fuse and re-explain**: research or explain any node, fuse two maps, or see a map through a field you already know (Rosetta).

## Install

**Easiest:** point your coding agent (Claude Code, Codex, Cursor...) at [docs/AGENT-INSTALL.md](https://github.com/Graydon-dmg/ontologizer/blob/main/docs/AGENT-INSTALL.md) and ask it to install Ontologizer.

**Manual:**

1. Install it:

   ```bash
   npm i -g ontologizer
   ```

2. Start it and pick **New**. The first time it needs Claude, it asks for your Anthropic API key once and stores it in your system keychain:

   ```bash
   ontologizer
   ```

3. Check that everything is in place:

   ```bash
   ontologizer doctor
   ```

## Your first map in 30 seconds

```bash
ontologizer new
```

You will see a few context check questions, then the map streams in live in your browser. When you like it, save it with `ontologizer save [name]`.

Then ask it something:

1. Click **Ask the map** (top bar, right of Search).
2. Type a question, or paste or drop an image, and press Enter.
3. Click a cited node to see it on the map.

Claude reads an outline of the whole map, searches it with a map-search tool, cites the nodes it used (click one to see it on the map), and searches the web for facts the map lacks, with links. No embeddings and no extra key: it uses the same Anthropic key.

No key or network yet? Run `ontologizer load demo --replay` to watch the bundled demo build itself offline.

## Commands

| Command | What it does |
| --- | --- |
| `ontologizer` | Interactive start menu |
| `ontologizer new` | Build a new topic map |
| `ontologizer load <name>` | Open a saved map (add `--replay` to watch it build again) |
| `ontologizer save [name]` | Save the current draft |
| `ontologizer list` | List saved maps |
| `ontologizer fuse <a> <b>` | Fuse two maps into a new draft |
| `ontologizer rosetta <map>` | Add a lens that re-explains the map for a persona |
| `ontologizer explain <name> <node>` | Write an article for one node |
| `ontologizer research <name> <node>` | Grow the map under one node |
| `ontologizer export <map> --format <f>` | Export a map: an offline page, an embed, JSON, or a context pack for an agent |
| `ontologizer update` | Update ontologizer to the latest version |
| `ontologizer key [action]` | Show, set or clear the Anthropic API key |
| `ontologizer doctor` | Check that everything ontologizer needs is in place |
| `ontologizer completion [shell]` | Print a shell completion script (zsh, bash or fish) |
| `ontologizer serve` | Service mode: serve every map, build new ones from the browser |
| `ontologizer status` | Show the home, tenants, tokens and the running server |
| `ontologizer token create / list / revoke` | Manage access tokens for service mode |
| `ontologizer sources list / test` | List the configured sources, or test one: which of its tools are offered, and why the others are not |
| `ontologizer mcp` | MCP over stdio: the map tools for an agent |
| `ontologizer usage` | Model calls and tokens per tenant per day (service mode) |

Every command takes `--help`. Full detail is in the [guide](https://github.com/Graydon-dmg/ontologizer/blob/main/docs/GUIDE.md).

## Service mode

`ontologizer serve` runs one server for every map in your home, without opening a browser. Open `http://127.0.0.1:8787/` for the maps home: your maps, a **New map** button, and a read-only **Server** panel. Agents and scripts use the same server over HTTP (`/v1/...`).

It listens on `127.0.0.1` only, unless you create a token and pass `--host`:

```bash
ontologizer token create --name me          # prints the token once; only its hash is stored
ontologizer serve --host 0.0.0.0            # every /v1/t/ route now needs the token
```

The server speaks plain HTTP: beyond this machine, put it behind an HTTPS reverse proxy. `new`, `load` and the one-map page work exactly as before. Details are in the [guide](https://github.com/Graydon-dmg/ontologizer/blob/main/docs/GUIDE.md#10-service-mode) and in [SECURITY.md](SECURITY.md#network-mode).

**Ports and private sources.** An optional `ontologizer.config.js` plugs in your own identity, policy, store (files or Postgres), model client and **sources**: your own MCP servers, whose read-only tools the model uses to build maps that cite your documents. A map built from a private source is private for life and visible only to those who hold that source. `ontologizer sources list` and `sources test` check them. See the [guide](https://github.com/Graydon-dmg/ontologizer/blob/main/docs/GUIDE.md#11-ports-and-private-sources).

## Export

`ontologizer export <map> --format html` writes one page that shows the map offline: pan, zoom, click a node for its details, collapse, search. Nothing in it loads from the network. `--format embed` gives a fragment to paste into any page, `--format json` the map itself, and `--format context` a short markdown brief of the map (outline, cross-links, insights, thin areas, sources) to hand to an AI agent, trimmed to `--budget` tokens (4000 by default). On the page, the same four are in the **Export** menu; **Copy for an agent** copies the context pack. Several embeds can share one page, 2D and 3D mixed; each keeps the views it was exported with. A page or embed exported from the menu links back to the live map (**Open live**) only when the map is served from an address other people can reach, never `localhost`, and without the address's query or `#` part.

```bash
ontologizer export demo --format html --out demo.html
ontologizer export demo --format context --budget 1500
```

## Agents and apps

Agents use your maps through MCP: `ontologizer mcp` (stdio) or `/v1/mcp` on `ontologizer serve`. The tools build a map, wait for it, read its outline, search it, open a node, run research or explain, ask it a question, and export it or its context pack. **Connect an agent** (in the Export menu, and in the Server panel) shows the setup to copy:

```bash
claude mcp add ontologizer -- npx -y ontologizer mcp                    # this machine, your own maps
claude mcp add --transport http ontologizer http://127.0.0.1:8787/v1/mcp  # a running ontologizer serve
```

Apps use the HTTP API (described at `/v1/openapi.json`) or the JS client, `import { createClient } from 'ontologizer/client'`. Tools that call the model say so and spend your API credits; `serve --limit-calls` and `--limit-tokens` cap each tenant's model calls and tokens per day (`ontologizer usage` shows them). The agent guide, [docs/MCP.md](https://github.com/Graydon-dmg/ontologizer/blob/main/docs/MCP.md), has the setup, the workflows, costs and errors; the [user guide](https://github.com/Graydon-dmg/ontologizer/blob/main/docs/GUIDE.md#12-agents-and-apps) has the server side.

## Requirements

- Node 22+
- An Anthropic API key from the [Claude Console](https://console.anthropic.com/). Claude.ai subscription logins (Pro, Max) can't be used: Anthropic's terms keep them for its own apps.

## Cost and privacy

- Model calls go to Anthropic's API using your own key. A map costs a few cents of API usage; Explain, Research and Sources (in the node menu or as commands), `fuse` and `rosetta` each make extra calls.
- Maps are stored locally in `~/.ontologizer`.
- The page is served only on 127.0.0.1 (your own machine). Service mode listens on the network only when you create a token.
- Exports carry the map's nodes, summaries, articles and sources, never your API key. The page and embed leave out the chat, your original prompt and job errors; JSON leaves out the chat unless you add `--include-chat`.

See [SECURITY.md](https://github.com/Graydon-dmg/ontologizer/blob/main/SECURITY.md).

## Licence

MIT: see [LICENSE](https://github.com/Graydon-dmg/ontologizer/blob/main/LICENSE). The Ontologizer name and logo are trademarks: see [TRADEMARKS.md](https://github.com/Graydon-dmg/ontologizer/blob/main/TRADEMARKS.md). Third-party licences are listed in [THIRD_PARTY_NOTICES.md](https://github.com/Graydon-dmg/ontologizer/blob/main/THIRD_PARTY_NOTICES.md). Contributions welcome: see [CONTRIBUTING.md](https://github.com/Graydon-dmg/ontologizer/blob/main/CONTRIBUTING.md).
