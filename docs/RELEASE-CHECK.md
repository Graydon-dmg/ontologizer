# Release check

Run this in a real browser before every publish, on the exact commit being published. It is not shipped in the package. Tick each box only after you have seen the result with your own eyes. Any unticked box blocks the publish.

Record at the top of the run: commit `_______`, date `_______`, browser `_______`, who `_______`.

## 0. Setup: install the tarball, exactly as users will get it

```bash
npm pack                                       # ontologizer-1.0.0.tgz
npm i -g --prefix /tmp/onto-rc ./ontologizer-1.0.0.tgz   # needs Node 22+
export PATH=/tmp/onto-rc/bin:$PATH
export ONTOLOGIZER_HOME=/tmp/onto-rc-home      # a throwaway store; delete it to start fresh
rm -rf "$ONTOLOGIZER_HOME"
which ontologizer                              # must print /tmp/onto-rc/bin/ontologizer
ontologizer doctor                             # every row ok (completion and the update check may warn)
```

## 1. The offline demo (`load demo`, no key needed)

```bash
ontologizer load demo --replay
```

- [ ] The browser opens on its own, and the terminal says `Imported the bundled "demo" map.`
- [ ] **Initial size:** the graph fills the window, isn't a small cluster in a corner or cut off at an edge. The whole map is visible without scrolling.
- [ ] **Live streaming:** nodes appear in waves (categories first, then their children, then cross-links), not all at once. The jobs panel (bottom right) shows steps going to `done`.
- [ ] **Legend:** one color per category, and they match the node colors.
- [ ] **Resize:** make the window narrow, then wide, then full-screen. Each time the graph re-fits, nothing is clipped, the top bar doesn't wrap over the graph, and the minimap redraws.
- [ ] **Minimap:** dragging or clicking in it moves the main view, and the button in its corner hides and shows it.
- [ ] **Search:** type `brush`. Matching nodes are highlighted or listed, and picking one centers the view on it.
- [ ] **Categories filter:** turn off two categories. Their nodes disappear. Turn them back on and they return.
- [ ] **Depth filter hides:** set Depth to `1`. Only the root and the categories remain. Set `2`, and the children come back while deeper nodes stay hidden. Set `Any`, and everything is back.
- [ ] **Depth filter persists across a reload:** set Depth to `1`, then reload the page. It is still `1` and the graph still shows depth 1.
- [ ] **Theme (Light | Dark):** on first open the page follows the OS setting. Clicking `Light` or `Dark` switches the whole page: text, nodes, edges, panels and the minimap stay readable in both. The choice survives a reload.
- [ ] **2D / 3D switch:** click `3D`. The 3D view appears with the same nodes and colors. Click `2D`. You're back, with the same filters still applied. Do this twice.
- [ ] **Node menu, view items:** click a node with children. The menu opens next to it. `Collapse` hides its children; the menu now offers `Expand`, which brings them back. `Esc` closes the menu.
- [ ] **Lost connection:** press Ctrl-C in the terminal. The server exits cleanly, and the open page shows a lost-connection banner instead of failing silently.

## 2. Offline, for real

- [ ] Turn Wi-Fi off (or unplug), run `ontologizer load demo --replay` again, and check the full map replays, with the same as step 1's first three boxes. Turn the network back on.

## 3. A live map (`new`, uses your key, about a dozen model calls)

```bash
ontologizer new
```

- [ ] With no key in env or the keychain (`ontologizer key clear` first), it asks for the key once, says it saved it to the keychain, and doesn't ask again on the next `new`.
- [ ] It asks a few context questions, shows Subject / Scope / Purpose / Level / Suggested name, asks `Build it?`, and the browser opens on the map building live.
- [ ] **Every node-menu item does something visible.** On one node, try each one:
  - [ ] `Research (in context)`: a job appears in the jobs panel, and new child nodes appear under that node.
  - [ ] `Research (general)`: same as above, with children that are broader rather than tied to your brief.
  - [ ] `Explain` on a node with no article: the **explain panel** opens at once with the node's summary and "Writing an explanation…", then the article replaces it. Afterwards the same node's menu says `Read explanation`, which reopens it.
  - [ ] **See also → Write an explanation:** in an open article, click a `See also` link. The panel switches to that node and the map focuses it, beside the panel rather than behind it. If that node has no article, the panel shows a **Write an explanation** button. Click it: "Writing an explanation…", then the article. (After a failed or unanswered Explain, the same button reads **Try again**.)
  - [ ] `Sources`: a job appears, then sources (links) show up for the node, in the explain panel or wherever the shell shows them.
  - [ ] `Expand` / `Collapse`: as in step 1.
  - [ ] No item silently does nothing. If one fails, an error is shown in the page or jobs panel rather than nothing happening.
- [ ] **Explain panel:** it closes, it reopens from `Read explanation`, long articles scroll inside the panel, and the jobs panel never covers the article text.
- [ ] **Rosetta:** open the `Rosetta` button in the top bar, choose `New lens…`, enter `a home chef`. A job runs, then ghost labels (the chef's analogies) appear next to the nodes. Switch the lens to `None`: the ghost labels go away. Switch back to the chef lens: they return.
- [ ] **Ctrl-C save:** press Ctrl-C in the terminal. It asks `Save as "<name>"? (Y/n)`. Answer `y` and it prints `Saved as <name>`.
- [ ] `ontologizer list` shows the map with its node count.
- [ ] `ontologizer load <first letters>` (a prefix) opens it, with the research children, articles and **the depth filter you last set** all still there.

## 4. Fuse, on two freshly generated maps

Generate two maps live (as in step 3, with a different topic each, e.g. plastic modeling and manga) and save them as `a` and `b`. Then record their fingerprints before fusing:

```bash
ontologizer list                                   # note a's and b's node counts
shasum -a 256 "$ONTOLOGIZER_HOME"/a/events.jsonl "$ONTOLOGIZER_HOME"/b/events.jsonl > /tmp/onto-rc-before.txt
ontologizer fuse a b --into c                      # the browser opens and the seam fills in live
```

- [ ] The terminal and the jobs panel show the fuse running, and it ends without an error.
- [ ] **Both sources are unchanged:** `shasum -a 256 -c /tmp/onto-rc-before.txt` prints `OK` for both files, and `ontologizer list` shows the same node counts for `a` and `b` as before.
- [ ] `c` contains every node of both maps: its node count is at least a's plus b's (plus the Hybrids group and its hybrids).
- [ ] **Legend groups:** the legend shows three groups in this order: map `a`'s categories, then map `b`'s, then `Hybrids`. Each group's colors match its nodes in the graph.
- [ ] **Bridges:** there are several bridges, drawn as dashed, curved, purple-pink lines that connect a node of `a` to a node of `b` (or to a hybrid). They are visibly different from ordinary cross-links.
- [ ] **Hybrids:** 3 to 8 hybrid nodes sit under `Hybrids`, each with a double lavender outline. They read as real crossovers of the two topics, not generic words.
- [ ] **Explain on a hybrid:** open a hybrid's node menu, then click `Explain`. A job appears, and the explain panel opens with an article about that crossover. Afterwards the menu says `Read explanation`.
- [ ] **Fuse refuses a third map:** `ontologizer fuse a b c` (three names) is refused before any model call, with a message naming the extra argument, and no new map appears in `ontologizer list`.
- [ ] Ctrl-C saves `c` (or it is already saved under `c`), and `ontologizer load c` reopens it with the legend groups and bridges intact.

## 5. Brand

- [ ] **Favicon:** with the OS in light mode, `ontologizer load demo` opens a tab that shows the Ontologizer favicon, not a blank page icon. Switch the OS to dark mode and reload: the favicon is still visible against the dark tab strip. `http://127.0.0.1:<port>/favicon.ico` answers 200.
- [ ] **Top-bar symbol:** the symbol shows at the left of the top bar in both Light and Dark, crisp and not stretched.
- [ ] **CLI banner, wide:** in a 120-column terminal, `ontologizer` (the start menu) shows the animated ASCII banner, aligned, with no wrapped lines, and it settles before the menu appears.
- [ ] **CLI banner, medium and narrow:** at 60 columns, then at 30 columns (resize the window, then run it again), the banner switches to a smaller form or leaves itself out. No line wraps or breaks into garbage.
- [ ] **CLI banner, piped:** `ontologizer --help | cat` and `ontologizer list | cat` print no ANSI escape codes (no `\x1b[`) and no animation frames.
- [ ] **README on GitHub:** the repository page renders the logo lockup (light and dark GitHub themes), and the ASCII art sits in a code block with its columns aligned.
- [ ] **Package contents:** `npm pack --dry-run` lists the files under `web/shared/brand/` and nothing under `docs/brand/` (`npm run check:h` enforces both).

## 6. Ask the map (chat panel)

Use a live map (step 3), plus G's "frontier AI coding harnesses" map for the example question.

- [ ] **Text question:** open the chat panel and ask "What should a beginner learn first?". The answer streams in (words arrive as it writes, not all at once at the end), and it cites map nodes as clickable chips or links.
- [ ] **Citations focus and highlight:** click a cited node. The map focuses it, beside the open panels rather than behind them, and highlights it. Click a second citation and the highlight moves.
- [ ] **The example question:** on the coding-harnesses map, ask: "give me some examples of the world's best coding harnesses and statistics to show how effective they are". The answer cites map nodes and gives web-sourced statistics, each with a source link that opens the right page in a new tab. No statistic appears without a link.
- [ ] **Image input:** paste a screenshot (Cmd/Ctrl-V) into the chat box, or attach one, and ask about it ("what's in this picture and where does it fit on the map?"). A thumbnail shows before sending, and the answer is clearly about that image.
- [ ] **Bad uploads are refused:** attaching a file that is not an image (a `.txt` or `.pdf`), or an image over the size limit, is refused with a clear message and nothing is sent.
- [ ] **Reload keeps the chat:** reload the page. The conversation, citations and image thumbnails are still there. `ontologizer load <map>` in a new session shows the same chat.
- [ ] **Nothing runs without a click:** when an answer suggests growing the map, it shows a **Research** suggestion button. No job appears in the jobs tray until you click it. Clicking it runs exactly one Research job, on the node it names.
- [ ] **Light and Dark:** the chat panel, citations, thumbnails and suggestion buttons are readable in both themes.
- [ ] **2D and 3D:** clicking a citation highlights the node in 2D, and again after switching to 3D.
- [ ] **Uploads stay private:** pasted images live only in the map's own folder under `~/.ontologizer/`, and `npm pack --dry-run` lists no uploaded or chat files (`npm run check:h` enforces the package side).

## 7. Sign-off

- [ ] `npm run check` passes on this commit.
- [ ] Every box above is ticked. Write any bug found here, with the step number, and don't publish until it's fixed and this check has been re-run from the step it affects.
