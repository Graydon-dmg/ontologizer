# Changelog

## 1.1.0 (2026-11-08)

- **Fuse from the browser.** A "Fuse with…" button in the top bar lists your other maps, then fuses the open map with the one you pick into a new map that opens in its own tab. Both originals stay untouched.
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
