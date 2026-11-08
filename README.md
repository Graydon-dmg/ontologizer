# Ontologizer

Ontologizer is an open-source command-line tool: give it a topic and it builds a live, color-coded map of everything inside that topic, streaming it into a local web page as it goes.

![Ontologizer's 2D graph mid-build](docs/screenshot.png)

## Install and first run

```bash
npm i -g ontologizer
ontologizer new
```

The first run asks for your Anthropic API key once and keeps it in your system keychain, so no `export` is needed. Those two commands end on a live map in your browser.

To try it offline, with no network and no key:

```bash
ontologizer load demo --replay --speed 1
```

## Commands

<!-- Commands: replace with the real ontologizer --help output once Epic B's CLI lands -->

| Command | What it does |
|---|---|
| `ontologizer` | Interactive start menu: New, Load (recent five), Fuse, Quit |
| `ontologizer new [--context "..."] [--yes]` | Check the context, build the map, serve it and open the browser |
| `ontologizer load <name> [--replay] [--speed <n>]` | Open a saved map; `--replay` streams its saved events with their original timing |
| `ontologizer save [name]` | Promote the current draft to a named map |
| `ontologizer list [--drafts]` | List saved maps, or drafts |
| `ontologizer fuse <a> <b> [--into <name>]` | Fuse two maps into one |
| `ontologizer rosetta <name> --as "<persona>" [--name <lens>]` | Add a lens that explains a map through a field you already know |
| `ontologizer explain <name> <node>` | Explain one node |
| `ontologizer research <name> <node> [--general]` | Research one node further |
| `ontologizer key [set\|clear]` | Show where your API key comes from; set a new one; or delete it from the keychain |
| `ontologizer doctor` | Check Node, API key, network, storage, completion and version, with a fix for each problem |
| `ontologizer completion [zsh\|bash\|fish]` | Print the shell completion script |
| `ontologizer update` | Update to the latest version |

## How it works

- **Context check.** Before building, it asks a few questions to pin down what you mean by the topic.
- **Streaming waves.** The map is built in waves: top-level categories first, then their children, then cross-links. Nodes stream into the page as they arrive.
- **Event log.** Every change is an append-only event, so maps can be saved, loaded and replayed.
- **Views.** A 2D graph, with an optional 3D view.
- **Fuse and Rosetta.** Fuse merges two maps into one and adds bridges between them. Rosetta explains a map through an analogy to a field you already know, and marks where the analogy breaks.

## Requirements

- Node 20 or newer.
- An Anthropic API key. It is asked for on first run and kept in your system keychain. `ANTHROPIC_API_KEY` overrides it. Use `ontologizer key set` or `ontologizer key clear` to change it.

### Cost and privacy

- Each map makes a dozen or so model calls, billed to your Anthropic account.
- Your topics and maps are sent to the Anthropic API.
- Maps are stored locally in `~/.ontologizer/`.

## License

MIT
