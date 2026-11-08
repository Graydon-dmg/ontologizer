# Changelog

## Unreleased

- Licence changed from Apache-2.0 to MIT (1.0.0 remains Apache-2.0).

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
