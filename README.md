# Ontologizer

Ontologizer is an open-source command-line tool: give it a topic and it builds a live, color-coded map of everything inside that topic, streaming it into a local web page as it goes.

![Ontologizer's 2D graph mid-build](https://raw.githubusercontent.com/Graydon-dmg/ontologizer/main/docs/screenshot.png)

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

| Command | What it does |
|---|---|
| `ontologizer` | Interactive start menu |
| `ontologizer new [--context "..."] [--yes]` | Build a new topic map |
| `ontologizer load <name> [--replay] [--speed <n>]` | Open a saved map (add `--replay` to watch it build again) |
| `ontologizer save [name]` | Save the current draft |
| `ontologizer list [--drafts]` | List saved maps |
| `ontologizer fuse <a> <b> [--into <name>]` | Fuse two maps into a new draft |
| `ontologizer rosetta <map> --as "<persona>" [--name <lens>]` | Add a lens that re-explains the map for a persona |
| `ontologizer explain <name> <node>` | Write an article for one node |
| `ontologizer research <name> <node> [--general]` | Grow the map under one node |
| `ontologizer key [set\|clear]` | Show, set or clear the Anthropic API key |
| `ontologizer doctor` | Check that everything ontologizer needs is in place |
| `ontologizer completion [zsh\|bash\|fish]` | Print a shell completion script |
| `ontologizer update` | Update ontologizer to the latest version |

Map names accept a prefix. `ontologizer <command> --help` shows every option.

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
