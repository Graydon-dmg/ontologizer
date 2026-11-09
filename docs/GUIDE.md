<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Graydon-dmg/ontologizer/main/web/shared/brand/lockup-dark.svg">
  <img alt="ontologizer" src="https://raw.githubusercontent.com/Graydon-dmg/ontologizer/main/web/shared/brand/lockup-light.svg" width="408">
</picture>

# Ontologizer user guide

Ontologizer builds a live, color-coded map of any topic with Claude and streams it into a web page on your own machine. You say what you want to explore; the map draws itself while you watch.

## Contents

1. [Concepts](#1-concepts)
2. [Commands](#2-commands)
3. [Walkthroughs](#3-walkthroughs)
4. [The page](#4-the-page)
5. [Your data](#5-your-data)
6. [Your API key](#6-your-api-key)
7. [Cost](#7-cost)
8. [Privacy](#8-privacy)
9. [Troubleshooting](#9-troubleshooting)
10. [Service mode](#10-service-mode)
11. [Ports and private sources](#11-ports-and-private-sources)

---

## 1. Concepts

### The context check

Before anything is built, `ontologizer new` checks that your request is clear enough. It applies four tests to what you wrote:

| Test | Question it asks |
|---|---|
| subject | Does it name one subject with one meaning? ("modeling" could be plastic models, fashion, 3D, data...) |
| scope | Does the subject fan out into roughly 6 to 12 meaningful branches, neither too narrow nor "science"? |
| purpose | Can it tell why you want the map (getting started, a decision, teaching, curiosity, work)? |
| level | Can it tell if you are a beginner, intermediate or expert? |

If every test passes, it prints the brief (Subject, Scope, Purpose, Level, Suggested name) and asks `Build it?`. If a test fails, it asks up to 3 questions per round, each with a few answer options plus `Other…` for your own words. It runs at most 3 rounds. Pass `--yes` to skip all questions and build straight from what you wrote.

### The build, in waves

| Wave | What happens |
|---|---|
| 0 | The top-level **categories** (6 to 10) appear, one by one. |
| 1 | Each category is filled in with its children, in parallel (typically 5 to 8 per category). |
| 2 | Claude reads the whole map and adds **cross-links** between different branches, plus 1 to 3 **insights** about the shape of the field. |

If wave 2 fails, you keep the finished tree.

### Categories and colours

Each top-level branch is a category, and every node below it takes that category's colour. The legend on the page lists them.

### Cross-links

A cross-link joins two nodes in different branches and carries a one-sentence `why`. Each link has one of five types:

| Type | Meaning |
|---|---|
| influences | one thing shapes the other |
| requires | one needs the other |
| part-of | one belongs inside the other |
| bridge | joins two fields (the type fuse uses for the seam between two maps) |
| analog | one plays a similar role to the other |

### The node menu

Click a node and a small menu opens beside the pointer. The items depend on the node:

| Item | When it shows | What it does |
|---|---|---|
| Expand | the node is collapsed | shows its children again |
| Collapse | the node has children and is open | hides its children |
| Research (in context) | always | grows the map under this node, for your brief and purpose |
| Research (general) | always | grows the map under this node using only the node's label, as an encyclopedia would organise it, with no brief |
| Read explanation | the node already has an article | opens the explain panel |
| Explain | the node has no article yet | writes an article and opens the panel |
| Sources | always | finds web sources for the node |

Items ignore clicks for a moment after the menu opens, so a stray double-click cannot start a paid request.

### The jobs tray

Everything that calls Claude after the first build is a job. The jobs tray lists them, each with a state badge (`queued`, `running`, `done`, `failed`) and a line such as `Building Tools`, `Explaining <node>`, `Researching <node>` or `Finding sources for <node>`. A failed job shows its error in brackets. Clicking a row focuses that node. The tray shows every unfinished or failed job plus the last three finished ones, and hides itself when empty.

### The explain panel

Explaining a node opens a panel with:

- a **summary**,
- **Key facts**,
- **Why it matters**,
- **See also** (buttons that jump to related nodes),
- **Sources** (links that open in a new tab).

While the article is being written it shows `Researching…`. A node without an article says `No explanation yet. Use Explain on the node menu.`

### Lenses (Rosetta)

A lens re-explains your map for a persona. For each node, Claude names an **analog** from the persona's world and, where there is one, **where it breaks**. Add one with `ontologizer rosetta` (see below), or from the page itself with the **Rosetta** button → **New lens…**. The **Rosetta** menu lists **None**, every lens the map has, and **New lens…**; pick a lens to switch to it. In the 2D graph the analog appears as an italic "ghost" label under each node (with a warning sign when there is a "breaks" note, which shows on hover). In the explain panel you see `As <persona>: <analog>` and `Where it breaks: <note>`. You can add several lenses to one map.

### Fuse

`fuse` takes two maps and produces a **new draft**. You can start one from a terminal (`ontologizer fuse`) or from the page with the **Fuse** button. Both source maps are left untouched. The draft contains the categories of both maps (shown in separate colour families), a **Hybrids** category of things that exist only where the two fields meet, and **bridge** links across the seam. Hybrid nodes get a distinct outline. Fuse takes exactly two maps; to combine three, fuse the result with the third. Asking for three fails with: `fuse takes two maps; fuse the result again to add a third`.

### Chat: ask your map

Click **Ask the map** in the top bar, right of Search (on narrow screens it just says **Ask**). The **Chat** pane opens beside the map. Ask anything about the map in plain words, for example *"Which of these tools does a beginner actually need first?"*. An empty chat says `Ask anything about this map. Answers point to the nodes they use.` and offers three starter questions you can click.

Type in **Ask about this map…** and press **Send** (or Enter; Shift+Enter starts a new line). The chat is saved with the map, and the last 10 exchanges are sent along with each new question, so follow-ups work.

- **How it answers.** Claude looks things up in your map first (labels, summaries, articles, sources and links). The pane shows `Searching your map…` while it does. If the map doesn't cover something, it may also search the web (at most 3 searches per question), shown as `Searching the web…`. When it searches the web, the answer's text arrives all at once at the end, after `Searching the web…`, rather than word by word. That is how Anthropic's API returns web-search answers.
- **From your map.** Nodes the answer relies on appear in the text as buttons with the node's name. Click one to show it on the map (`Show on the map`); with several, **Show all *N* cited on the map** highlights them together. A bar then says `Cited nodes are highlighted on the map.`, and **Clear** removes the highlight. Only nodes that really exist in your map can be cited.
- **From the web.** Facts from the web are links in the text, and every page used is listed under **From the web** at the end of the answer. Links open in a new tab.
- **Images.** Click **Add image**, or paste or drop images onto the pane, to ask about a screenshot or photo. PNG, JPEG, WebP and GIF work; up to 4 images per message, 5 MB each. A message can be just an image. Text is limited to 4000 characters (an emoji counts as one).
- **Research suggestions.** When your map is thin on something, an answer may end with up to three buttons such as **Research Adhesives**. The chat never starts a job by itself: a suggestion runs only when you click it. It then shows `Researching Adhesives…`, and the job appears in the jobs tray like any other research.
- **How the search works.** Claude reads an outline of the whole map, searches it with a map-search tool, cites the nodes it used (click one to see it on the map), and searches the web for facts the map lacks, with links. No embeddings and no extra key: it uses the same Anthropic key. Each question is one strong-model conversation of up to 6 steps: about a cent or two, a little more with web search or images.
- **Limits.** One answer is written at a time per map. An answer that stalls is stopped with `The answer took too long and was stopped.`
- **Privacy.** The pane says it plainly: `Questions and images are sent to Anthropic. Images are saved with this map.` See [Privacy](#8-privacy).
- **Cost.** Each question is one strong-model conversation: roughly a cent or two, a little more with web search or images. See [Cost](#7-cost).

### Drafts and saved maps

A new map starts as a **draft** with an id like `draft-20261108-120053`. A draft is kept on disk, but it is not a named map until you save it.

- Press **Ctrl-C** during or after a build: in a terminal you are asked `Save as "<name>"?`. Say no and you get `Draft kept: <id>`.
- `ontologizer save [name]` promotes the current draft to a saved map. With no name it uses the map's own name.
- If the draft is open in another terminal, `save` tells you to press Ctrl-C there instead.

### Replay

`ontologizer load <name> --replay` plays the build back as it originally happened, with `--speed` as a multiplier (`--speed 3` is three times faster). Replay needs no API key and makes no calls; it does not change the saved map.

---

## 2. Commands

Run `ontologizer --help` for the list, or `ontologizer <command> --help` for any one command. Anywhere a command takes a map name, **a prefix works** (`plastic` finds `plastic-modeling`). If the prefix matches several maps, or none, you are asked which one in a terminal, or shown the list.

For tab completion, add this line to your shell file (`~/.zshrc`, `~/.bashrc`; for fish, see `ontologizer completion fish`):

```
eval "$(ontologizer completion zsh)"
```

| Command | What it does |
|---|---|
| `ontologizer` | Interactive start menu: New map, Load one of your 5 most recent maps, Fuse two maps, Quit. |
| `ontologizer new [--context "..."] [--yes]` | Build a new topic map. |
| `ontologizer load <name> [--replay] [--speed N]` | Open a saved map. |
| `ontologizer save [name]` | Save the current draft. |
| `ontologizer list [--drafts]` | List saved maps. |
| `ontologizer fuse <a> <b> [--into <name>]` | Fuse two maps into a new draft. |
| `ontologizer rosetta <map> --as "<persona>" [--name <lens>]` | Add a lens that re-explains the map for a persona. |
| `ontologizer explain <name> <node>` | Write an article for one node. |
| `ontologizer research <name> <node> [--general]` | Grow the map under one node. |
| `ontologizer update` | Update ontologizer to the latest version. |
| `ontologizer key [set\|clear]` | Show, set or clear the Anthropic API key. |
| `ontologizer doctor` | Check that everything ontologizer needs is in place. |
| `ontologizer completion [zsh\|bash\|fish]` | Print a shell completion script. |
| `ontologizer serve [--host] [--port] [--home] [--tokens] [--max-builds] [--allow-host] [--open]` | Service mode: serve every map. See [Service mode](#10-service-mode). |
| `ontologizer status [--home] [--json]` | The home, tenants, tokens and the running server. |
| `ontologizer token create\|list\|revoke` | Access tokens for service mode. |
| `ontologizer --version`, `-h` / `--help` | Version and help. |

### new

```
ontologizer new --context "I'm getting into plastic modeling" 
```

`--context` is what you want to explore and why. Without it, you are asked. `-y`/`--yes` skips all questions. Without a terminal you must pass `--context`. The page opens in your browser as the map builds, and the terminal prints each category as it appears, then `Built N nodes. Ctrl-C to stop.` The server keeps running until you press Ctrl-C.

### load

```
ontologizer load plastic-modeling --replay --speed 2
```

Opens a saved map and serves it. `load` never asks for a key; without one, the map opens and browses fine, and only actions that call Claude fail with `No Anthropic API key: run ontologizer key set`. Three maps ship with the package: `demo`, `manga` and `plastic-modeling`. The first time you `load` one of those names, it is imported into your store (`Imported the bundled "<name>" map.`).

### save

```
ontologizer save plastic-modeling
```

Saves the current draft under the given name. Names are lowercase letters, digits and hyphens. If the name is taken it tells you; `new`'s own Ctrl-C save picks `name-2`, `name-3`... automatically.

### list

```
ontologizer list --drafts
```

Prints one line per map: id, `(draft)` if it is one, name, node count and last-updated time. With nothing saved: `No saved maps yet. Run ontologizer new.`

### fuse

```
ontologizer fuse manga plastic-modeling --into gunpla
```

Prints `Fused into <draft id>`, opens the result and serves it. `--into` names the fused map; without it Claude suggests a name. Needs an API key. Both maps must already be in your store (see the `load` note above for the bundled ones).

### rosetta

```
ontologizer rosetta plastic-modeling --as "a home chef"
```

`--as` is required (200 characters at most). `--name` sets the lens id (turned into lowercase-with-hyphens); otherwise it is derived from the persona ("a home chef" becomes `chef`, and a second lens with the same id becomes `chef-2`). When done it prints a short confirmation and keeps serving; pick the lens from the **Rosetta** button on the page.

### explain and research

```
ontologizer explain plastic-modeling "Plastic Cement"
ontologizer research plastic-modeling Tools --general
```

`<node>` is a node id or label (an exact label, a unique prefix, or a unique part of it; if unsure it lists close matches). If the map is open in another terminal, the request is sent to that running page (`Sent to the open session (job <id>).`) and you watch it happen there. Otherwise it runs in your terminal and prints the article (summary, key facts, why it matters, see also, sources) or the labels it added (`Added N nodes under <node>:`). `--general` on `research` uses the node's label alone instead of your brief. There is a 10 minute limit.

### update, key, doctor, completion

`update` runs `npm i -g ontologizer@latest`. `key` is covered in [Your API key](#6-your-api-key), `doctor` in [Troubleshooting](#9-troubleshooting), `completion` above.

---

## 3. Walkthroughs

### a) Explore a new hobby

1. `ontologizer new`
2. At `Context: what do you want to explore, and why?` type something like: *I want to get into plastic modeling, building scale kits as a beginner.* If anything is ambiguous you get a short multiple-choice question.
3. Confirm the brief and answer `Build it?`. Your browser opens.
4. Watch the categories appear first, then each fills out, then the cross-links and insights arrive.
5. Click a node you do not know and choose **Explain**. The panel opens and fills in. Click a related name under **See also** to hop to it.
6. Click a branch and choose **Research (in context)** to grow it in the direction of your goal, or **Research (general)** to see the topic as a textbook would. Watch it in the jobs tray.
7. When done, press **Ctrl-C** in the terminal and answer `Save as "plastic-modeling"?`.

### b) Fuse two interests

Both maps need to be in your store. Using the bundled ones:

```
ontologizer load manga          # imports it; press Ctrl-C to stop
ontologizer load plastic-modeling
ontologizer fuse manga plastic-modeling --into gunpla
```

The fused draft shows the two original maps in two colour families. Look at the **Hybrids** category: that is where things live that belong to neither map alone, for example Gunpla, garage kits and figure painting. Dashed **bridge** lines run from nodes in one map to nodes in the other, each with a `why`. (The exact hybrids are chosen by Claude each time, so yours may differ.) Press Ctrl-C and say yes to save it as `gunpla`. `manga` and `plastic-modeling` are unchanged.

**From the page instead.** With a map open (say `ontologizer load manga`), click **Fuse** in the top bar, next to **Rosetta**. A dialog titled **Fuse this map with…** lists your other saved maps, with node counts and a **draft** badge on drafts; the map you are on is not listed. Use **Search your maps** to narrow the list, click the map to fuse with, and optionally fill in **Name the new map (optional)** (for example `gunpla`; if your text is not already lowercase-with-hyphens, it shows `Will be saved as "<slug>"`). Click **Fuse**.

A new browser tab opens on the fused map, which gets its own local page, and you watch it grow there. Back on the first map, the ticker says `Fusing with <name>…` and the jobs tray shows `Fusing with <name>` until it is done. The new map is a draft: save it with `ontologizer save`.

If something goes wrong, the dialog and the ticker show `Could not fuse: <reason>` and the new tab closes again. Typical reasons:

| Message | What it means |
|---|---|
| `fuse needs a different map than this one` | You picked the map you are on. |
| `no map named "<x>"` | That map is no longer in your store. |
| `into must be lowercase letters, digits and hyphens, at most 40 characters` | The name was not usable. |
| `cannot reach the server. Is ontologizer still running?` | The terminal that served the page was stopped. |

An API key problem shows as a failed job in the jobs tray, for example `Your Anthropic API key was rejected: run ontologizer key set`. If the dialog says `No other saved maps yet`, build and save a second map in a terminal first (`ontologizer new`).

### c) Rosetta for a persona

```
ontologizer rosetta plastic-modeling --as "a home chef"
```

The lens is called `chef`. On the page open the **Rosetta** button and choose it. Ghost labels appear under the nodes. Click a node and read the panel: it shows `As a home chef: <the kitchen equivalent>` and, where the comparison fails, `Where it breaks: <why>`. Choose **None** to go back.

You can do the same without the terminal: on an open map, choose **Rosetta → New lens…** and type the persona. The analogs stream in the same way.

### d) The offline demo

```
ontologizer load demo --replay
```

No account, no key, no network. The bundled demo map builds itself again in your browser. Add `--speed 4` to hurry it up. Try the menu, the search box and the 2D/3D toggle while it plays or after.

---

## 4. The page

The page is served from your machine at `http://127.0.0.1:<port>/` (the port is chosen automatically and printed as `Serving <name> at http://127.0.0.1:<port>/  (Ctrl-C to stop)`).

| Control | What it does |
|---|---|
| **2D / 3D** | Switches between the flat graph and the 3D sky view. Appears when both are available. |
| **Theme** | **System**, **Light** or **Dark**. Remembered in your browser. |
| **Search** | Type to find nodes by label (matches the start of the label first, then words, then anywhere). Matches highlight on the map and up to 8 are listed; click one to jump to it. |
| **Depth** | Show nodes down to depth **Any**, 1, 2, 3 or 4. |
| **Categories** | A dropdown of checkboxes to show only some categories; the title shows the count when filtered. |
| **Rosetta** | Lenses: **None**, each lens on the map, and **New lens…** to add one for a persona. |
| **Ask the map** | *Ask questions about this map; add screenshots or photos* (its tooltip). Shows **Ask** on narrow screens. Opens the **Chat** pane. See [Chat: ask your map](#chat-ask-your-map). |
| **Fuse** | *Make a new map that joins this one with another saved map* (its tooltip). The new draft opens in a new tab. See [Fuse two interests](#b-fuse-two-interests). |
| **Legend** | Colour key for categories; click its header to fold it. In a fused map it groups categories by source map (headed with each source map's name) and **Hybrids**, and adds a **Fusion** key for **Bridge** lines and **Hybrid** outlines. |
| **Minimap** | A small overview; the **−** / **+** button collapses and expands it. |
| **Jobs tray** | Running and recent jobs (see Concepts). |
| **Ticker** | Short notices as things are added; click one to focus that node. |

**Keyboard.** There are only a few shortcuts:

- **Escape** closes the node menu.
- In the search box, **Enter** jumps to the best match and **Escape** clears the search.
- In the chat box, **Enter** sends and **Shift+Enter** starts a new line.
- The 2D/3D, theme and menu buttons are ordinary buttons: Tab to them, then Enter or Space.

---

## 5. Your data

Everything lives in `~/.ontologizer`. To use another folder, set `ONTOLOGIZER_HOME`.

```
~/.ontologizer/
  index.json          the list of maps, and which one is current
  sessions.json       which maps are open right now (port and process)
  update-check.json   when the daily update check last ran
  <id>/
    events.jsonl      one line per thing that happened; append-only
    snapshot.json     the map as it stands now
    brief.json        the subject, scope, purpose and level
    attachments/      images you added to the chat, one file per image, named by its SHA-256
```

A map is stored as its **event log**: every category, node, link, job and lens is one line in `events.jsonl`. The map is rebuilt by reading the log from the top, so it reloads exactly, and replay is just that log played back with the original timing. A saved map's folder is named after the map; a draft's is `draft-<yyyymmdd-hhmmss>`.

---

## 6. Your API key

Ontologizer looks for your Anthropic API key in this order:

1. The `ANTHROPIC_API_KEY` environment variable. It wins if set.
2. Your operating system's keychain (service `ontologizer`, account `anthropic-api-key`).
3. A masked prompt (`Anthropic API key:`, asked up to 3 times; keys start with `sk-ant-`). Whatever you enter is stored in the keychain, so you are asked once. If there is no terminal to ask in, the command stops with a message instead of waiting.

| Command | Result |
|---|---|
| `ontologizer key` | Shows where the key comes from: `ANTHROPIC_API_KEY (environment)`, `keychain (service ontologizer, account anthropic-api-key)`, or `none: run ontologizer key set`. |
| `ontologizer key set` | Prompts for a key and stores it in the keychain. Needs a terminal. |
| `ontologizer key clear` | Removes it from the keychain (`Removed the key from the keychain.` or `No key in the keychain.`). |

The key is never printed, logged or written to a file. It is held only inside the connection to Anthropic. `ontologizer key` shows *where* it comes from, never its value. If `ANTHROPIC_API_KEY` is set when you run `key set`, you are reminded that it still takes precedence.

---

## 7. Cost

You pay Anthropic for the model calls, using your own key. Prices change, so none are listed here; see https://www.anthropic.com/pricing. By default, quick steps use `claude-haiku-5-5` and the heavier steps use `claude-sonnet-5-5`. To change either, set `ONTOLOGIZER_FAST_MODEL` or `ONTOLOGIZER_STRONG_MODEL`.

What a map costs, roughly:

- **A new map** is a handful of calls: the context check (fast), one fast call for categories, one fast call per category, and one strong call for cross-links and insights. Typically a few cents per map.
- **Explain** and **Sources** each add a strong call that also uses web search.
- **Research**, **fuse** and **rosetta** each add strong calls (rosetta works through the map in batches of 25 nodes, so a big map is several calls). Research does not use web search.
- **A chat question** is one strong call: roughly a cent or two, a little more when it also searches the web or includes an image.
- **Loading, browsing, searching, replay and `list`** make no calls at all.

---

## 8. Privacy

- **Sent to Anthropic:** your context and brief (subject, scope, purpose, level), and the labels, paths and short summaries of nodes the call is about. Fuse sends both maps' node labels; rosetta sends node paths and summaries. Explain and Sources also run web searches through Anthropic's search tool. **Chat** sends your question, the earlier messages in that conversation, any images you attach, and the parts of the map it looks up to answer; it may also search the web. Nothing else is sent.
- **The page** is served only on `127.0.0.1` (your own machine) on a free port. It is not reachable from other computers.
- **Your maps** stay in `~/.ontologizer`. They are not uploaded anywhere.
- **Chat images** are sent to Anthropic with your question and are also saved next to the map, in its `attachments/` folder (`~/.ontologizer/<map>/attachments/`). The same image is stored once. The chat transcript itself is part of the map's `events.jsonl` and refers to images only by their hash, never their contents. To delete the images, delete that folder (or single files in it): the chat still loads, only those thumbnails stop showing. Deleting a map's folder removes its images too.
- **Update check:** at most once a day, in an interactive terminal, ontologizer asks the npm registry (`https://registry.npmjs.org/ontologizer/latest`) for the newest version number. It sends nothing about you or your maps. Turn it off with `ONTOLOGIZER_NO_UPDATE_CHECK=1`. `ontologizer doctor` makes the same request, and also checks that `https://api.anthropic.com` answers.

---

## 9. Troubleshooting

Start with `ontologizer doctor`. Each line starts with `ok`, `warn` or `fail`, and failing or warning lines print a `fix:`.

| Row | Meaning and fix |
|---|---|
| Node | Needs Node 22 or newer. Fix: install Node 22+. |
| API key | `found (env)` / `found (keychain)`, or `fail` `not set`: run `ontologizer key set`. A `warn` that the keychain did not answer within 3 s means an access dialog may be open: allow it, or run `ontologizer key`. |
| Network | `api.anthropic.com reachable`, or a warning that it cannot be reached (`load demo --replay` still works): check your connection. |
| Store | `<folder> is writable`, or `fail`: fix the folder's permissions. |
| Completion | `warn` `not installed`: add the printed line to your shell file, for example `eval "$(ontologizer completion zsh)"` in `~/.zshrc`. |
| Version | `ok` with the version, or `warn` `<version>, <latest> is available` (fix: `ontologizer update`), or `could not check for updates`. |

Doctor exits with an error code only if a row says `fail`.

**"Your Anthropic API key was rejected: run ontologizer key set"**: Anthropic returned a 401. The key is wrong, revoked or from another account. Run `ontologizer key set` with a fresh key. If `ANTHROPIC_API_KEY` is set it overrides the keychain, so fix or unset that too.

**"No Anthropic API key. Run `ontologizer key set` in a terminal, or set ANTHROPIC_API_KEY."**: no key was found and there is no terminal to ask in. Set the environment variable, or run `ontologizer key set` once.

**"Could not save the key to the keychain: set ANTHROPIC_API_KEY to skip this prompt"**: there is no usable keychain, which is common on Linux without a Secret Service (such as GNOME Keyring). Your key still works for that run. Set `ANTHROPIC_API_KEY` in your shell profile to avoid the prompt next time.

**"command not found: ontologizer"** after `npm i -g ontologizer`: the folder where npm puts global commands is not on your `PATH`. `npm prefix -g` shows the folder; its `bin` directory needs to be on your `PATH`.

**`EACCES` (permission denied) from npm** during install or `ontologizer update`: npm cannot write to its global folder. Point npm at a folder you own (`npm config set prefix ~/.npm-global`, then add `~/.npm-global/bin` to `PATH`) rather than using `sudo`.

**The browser did not open.** Copy the address from the line `Serving <name> at http://127.0.0.1:<port>/  (Ctrl-C to stop)` into your browser. If you set `ONTOLOGIZER_NO_OPEN=1`, the browser is deliberately never opened.

**`No map named "<name>"`**: the error lists your maps. `ontologizer list --drafts` shows everything, including unsaved drafts.

**`No current draft to save.`**: `save` only works on a draft; the map may already be saved, or you have not built one.

**Something else broke.** Set `ONTOLOGIZER_DEBUG=1` and run it again to print a stack trace with the error.

---

## 10. Service mode

Service mode is opt-in. `ontologizer serve` runs one server, without a browser, for every map in your home (`~/.ontologizer` or `--home <dir>`). It suits a laptop you leave running, a terminal on another machine, or a Linux host. Nothing about `new`, `load` or the one-map page changes.

```bash
ontologizer serve                      # http://127.0.0.1:8787/, loopback only, no tokens needed
ontologizer serve --open               # the same, and opens the maps home in your browser
```

**The maps home** (`/`) lists your maps (name, root, nodes, last update). **New map** asks what you want to explore, runs the same context check as `ontologizer new` (up to three rounds of questions), shows the brief, and builds. The page opens the new map as it draws itself. The **Server** panel shows the tenant, the store, the map count and the tokens by name and scopes. It is read-only: tokens are managed from the command line. On a map page opened from the home, the same panel is behind the **Server** button in the top bar, and the logo at the top bar's left opens a menu with **All maps** and **New map**.

**Tokens.** To listen on anything other than loopback (`--host 0.0.0.0`, a LAN address), create a token first; `serve` refuses to start without one.

**Open mode is for this machine only.** With no tokens, the server trusts that nothing but this machine can reach its port. Never expose it through a reverse proxy, a tunnel (`ssh -R`, ngrok) or a port forward: create a token first. The server does refuse requests that carry proxy headers, but that is a safety net, not a lock.

**Use HTTPS beyond this machine.** The server speaks plain HTTP, so tokens and the sign-in cookie cross the network unencrypted. On a non-loopback `--host`, `serve` prints a warning saying so. Put it behind a reverse proxy that serves HTTPS (see below), or keep it on `127.0.0.1`.

```bash
ontologizer token create --name laptop                    # scopes read,build; tenant default
ontologizer token create --name ci --scopes read          # read-only
ontologizer token list                                    # names, tenants, scopes, created dates
ontologizer token revoke ci                               # takes effect at once, even while serving
ontologizer status                                        # home, tenants, tokens, running server
```

Revoking a token ends its browser sessions and event streams on its next request. An answer the model is already writing finishes.

A token is printed once (`ont_` and 43 characters); `<home>/tokens.json` keeps only its SHA-256 hash. In the browser, the home asks for the token once and keeps a session cookie. Scripts send `Authorization: Bearer <token>`. Opening a map link while signed out takes you to the home to sign in, then back to the map. Scopes are a ladder, each including the ones before it: `read` (list, view, events, wait, status), `ask` (ask the map: it calls the model and saves the conversation), `build` (check, build, node actions, save), `admin` (every tenant's status and the server's paths).

**Tenants.** A token belongs to one tenant (`--tenant`, default `default`). The `default` tenant is your home itself; any other tenant's maps live under `<home>/tenants/<tenant>/`. A token never sees another tenant's maps.

**The HTTP API** (every route under `/v1/t/<tenant>/` needs a token when tokens are loaded):

| Route | What it does |
|---|---|
| `GET /v1/t/<tenant>/maps` | The maps |
| `POST /v1/t/<tenant>/maps/check` `{ context, answers? }` | The context check: `{ ready, brief?, name?, questions? }` |
| `POST /v1/t/<tenant>/maps` `{ brief, name?, depth? }` | Start a build: 202 `{ id, viewUrl, eventsUrl }` at once |
| `GET /v1/t/<tenant>/maps/<id>/wait?timeout=ms` | Waits until the map is idle: `{ state, jobs }` |
| `GET /v1/t/<tenant>/maps/<id>/snapshot` | The map as JSON |
| `GET /v1/t/<tenant>/maps/<id>/events?from=n` | The event stream (server-sent events) |
| `POST /v1/t/<tenant>/maps/<id>/actions` | A node action, as the page sends it |
| `POST /v1/t/<tenant>/maps/<id>/save` `{ name }` | Save a draft under a name |
| `GET /v1/t/<tenant>/maps/<id>/view` | The map page |
| `GET /v1/t/<tenant>/status` | Tenant, store, map count, tokens (names and scopes) |
| `GET /v1/health/live`, `/v1/health/ready` | Health checks (no token) |

`--max-builds` (default 2) caps builds running at once; more wait in a queue, at most `--max-queued` (default 10) per tenant, started in turn across tenants. `--max-checks` (default 4) caps context checks at once. Past a limit the server answers 429. These caps limit new-map builds only. A `build` token can still start research, explain, fuse and rosetta jobs, and an `ask` token can chat, all on your Anthropic credits. Give `build` or `ask` only to people you trust with your API spend. Fuse from a map page makes the fused draft a new map on the same server. A map cannot be named `tenants` (that folder holds the other tenants).

**Behind a reverse proxy**, create a token first, then pass `--allow-host <name>` (or set `ONTOLOGIZER_ALLOW_HOST=name1,name2`) for the name the proxy forwards. Without tokens, `serve` refuses `--allow-host`, and refuses any request that came through a proxy: an open server is for this machine only. If the proxy sends `X-Forwarded-Proto: https`, the sign-in cookie is marked `Secure`. While it runs, `serve` writes `<home>/serve.json` (pid, URL, start time, auth mode) and removes it on exit (Ctrl-C or SIGTERM). A server started without tokens stays open until restarted, even if you create one meanwhile; `ontologizer status` and the Server panel say "tokens found: restart serve to require them".

**In a container.** The repository has a `Dockerfile` (`node:22-slim`, a non-root user, maps in `/data`, `serve --host 0.0.0.0`). It refuses to start until `/data` has a token:

```bash
docker build -t ontologizer .
docker run --rm -v "$PWD/data:/data" ontologizer token create --name me
docker run -p 127.0.0.1:8787:8787 -e ANTHROPIC_API_KEY -v "$PWD/data:/data" ontologizer
```

`-p 127.0.0.1:8787:8787` publishes the port to this machine only. To reach it from elsewhere, put an HTTPS reverse proxy in front and add `-e ONTOLOGIZER_ALLOW_HOST=maps.example.com`.

Service mode never asks for an API key. Without one, the server still runs, and a build fails with "No Anthropic API key" on the map.


## 11. Ports and private sources

Service mode has five **ports**, places where a team plugs in its own piece without forking: **identity** (who is calling), **policy** (what they may do), **store** (where maps live), **model** (which model client a call uses) and **sources** (your own documents, reached through MCP servers). With no config file, every port is the built-in one and service mode behaves exactly as in section 10.

### The config file

The ports are set in one file, `ontologizer.config.js`, an ES module with a default export. `serve` finds it, in this order, from `--config <file>`, the `ONTOLOGIZER_CONFIG` environment variable, or `<home>/ontologizer.config.js`. It never looks in the folder you run it from.

**Loading the config runs it as code,** with the server's own rights (it can read files, open connections, read the environment). Keep it where only you can write it, and treat a change to it like a change to the server. A config that fails to load, or has a key or value it does not understand, stops `serve` with exit 1 and a message naming the file and every problem.

Imports in the config resolve from the config file's own folder, like any ES module: install what it imports next to it (for example `npm install ontologizer pg` in that folder).

A full example, with a private team wiki and a public documentation site:

```js
// ontologizer.config.js
import { postgresStorePort } from 'ontologizer/store-postgres';   // only if you use the Postgres store
import Anthropic from '@anthropic-ai/sdk';

export default {
  // Your own MCP servers. Only tools listed in allowTools AND marked readOnlyHint by the server are
  // ever offered to the model. Nothing a source offers may write.
  sources: [
    {
      name: 'wiki',
      url: 'https://wiki.internal.example/mcp',          // streamable HTTP
      visibility: 'private',                              // a map built from it becomes private
      allowTools: ['search', 'get_page'],
      headers: (principal) => ({ 'X-On-Behalf-Of': principal.actor.id }),   // per caller
    },
    {
      name: 'docs',
      command: 'node', args: ['/opt/docs-mcp/server.js'], // stdio (headers do not apply)
      visibility: 'public',
      allowTools: ['search'],
    },
  ],

  // Where maps live: one store per tenant. The default is the files under your home.
  // postgresStorePort opens openPostgresStore({ url, tenant }) per tenant, and its exists(tenant) lets the
  // server check a tenant without opening (and locking) a store for it.
  store: postgresStorePort({ url: process.env.DATABASE_URL }),

  // Which client each model call uses. purpose is check, build, research, explain, sources, ask,
  // fuse or rosetta. The default is your own key, as everywhere else.
  model: ({ principal, purpose }) => new Anthropic({
    defaultHeaders: { 'X-Team': principal.tenant, 'X-Purpose': purpose },
  }),

  // identity and policy: see below.
};
```

### Sources

Each source is an MCP server: `url` for one reached over HTTP, or `command` and `args` for one Ontologizer starts itself. Its tools appear to the model as `<source>__<tool>` (for example `wiki__search`), beside web search, when it builds a map, researches or explains a node, or answers a question in the chat. They are never used for the context check, the Sources job, fuse or lenses.

A tool is offered only when **both** of these hold: you listed it in `allowTools`, and the server marks it `readOnlyHint`. A tool that changes anything is never offered, even if you list it; a call to a tool that was not offered never reaches the server.

```bash
ontologizer sources list            # name, visibility, allowed tools, reachable or not
ontologizer sources test wiki       # connects, lists every tool, says which are offered and why the others are not
```

Both are read-only: they never call a tool. The Server panel shows the same list (name, visibility, reachable), and the ports in use.

### Citations you can trust

When a node is built from a document a source returned, its details panel lists that document under **From sources** (`wiki · Choosing glue`), linked when the source gave a web address. The model can only cite documents a tool actually returned in the same build or job: a reference it makes up is dropped, and the title and link always come from the source, never from the model.

### Private maps

A source marked `visibility: 'private'` makes every map that uses it private, **for life**. **Picking** a private source in New map makes the map private from the start: it is stored private before the server even answers, so it stays private across a crash or a restart, even if the build ends up not using the source. A build a restart interrupts is marked failed ("Interrupted by a restart") rather than left waiting. The sources you pick are given to the build as your chosen references, to search for every category. And the first time a private source answers anything during a run (a result or an error), the map records it before the answer reaches the model. Nothing can make the map public again. A fused map is private if either input is. A private map shows a **Private** badge in its top bar and in the maps home, and `ontologizer list` shows it in the visibility column.

Who sees a private map: an admin, and anyone who **holds every private source** the map used. Anyone else gets "not found" for it (in the browser, a page saying "Not found, or you don't have access"), and it is not in their maps list or their fuse picker. Someone watching a public map when it becomes private stops receiving it at once, and so does a token whose sources you take away in `tokens.json`.

**A private map stays inside your sources.** Once a map is private, building, researching, explaining and the chat use only the map itself and the private sources it already uses: no web search and no public source. So explanations on a private map have no web links, and nothing from it is sent to a web search. The model is told that what a source returns is data, never instructions, and a source cannot make it call another tool that is not offered.

**Changing a source from private to public opens its maps.** Visibility is checked against the sources people hold, and a token without a list holds every public source, so making `wiki` public in the config lets those tokens read the maps that were private for `wiki`.

```bash
ontologizer token create --name reader                    # holds every public source, no private one
ontologizer token create --name team --sources wiki,docs  # holds wiki (private) and docs
```

**New map** shows a checkbox for each source you hold; a build uses only the ones you leave checked. A click on an existing map (research, explain, a question in the chat) uses your public sources and only the private ones the map already uses: a reader exploring a shared public map never turns it private by accident.

### Identity and policy

**Identity** decides who a request comes from. The default is the tokens and sessions of section 10. To sign people in through your organisation's single sign-on, put an OIDC-aware reverse proxy in front of the server and let an identity port read the user it vouches for:

```js
identity: {
  name: 'sso-proxy',
  // Called for every /v1/t/ request. Return a principal, or null for "not signed in" (401).
  authenticate(req) {
    const user = req.headers['x-auth-user'];         // set by your proxy, and only by it
    if (!user) return null;
    return {
      actor: { id: `user:${user}`, kind: 'human' },  // kind: human | agent | service
      tenant: 'default',
      scopes: ['read', 'ask', 'build'],
      sources: ['wiki', 'docs'],                     // the sources this person holds
    };
  },
},
```

A custom identity replaces tokens: the server then requires a principal on every map route and may listen beyond loopback. Make sure only your proxy can reach it, or anyone could send the header themselves. A principal without a valid actor, tenant or scopes is refused.

**Policy** decides what a principal may do. `can(principal, action, { tenant, mapId, map })` returns true or false; `action` is `read`, `build`, `ask`, `job` (node actions), `save`, `export` or `admin`. The default is the scope ladder of section 10 plus the private-map rule above. A policy that throws denies. No policy can let a principal into another tenant.

### Who did what

In service mode every change a request makes to a map is stamped with who made it: `actor: { id, kind }` on each event (`token:<name>` for a token, `local` on an open server, or your identity port's actor). The command line and the one-map page write exactly what they always did.

### The Postgres store

`ontologizer/store-postgres` keeps maps in Postgres instead of files: `openPostgresStore({ url, tenant })`. Install its driver yourself (`npm install pg@8.23.1`); it is an optional dependency. It creates two tables (`ontologizer_events`, `ontologizer_maps`), every row tagged with its tenant. It loads a tenant into memory when it opens and writes changes in order. Every change the server confirms is stored first, so a crash loses nothing it acknowledged. If a write ever fails, the store stops taking changes (the server answers 503) rather than leaving a gap, until you restart it. **One server per tenant**: a second server opening the same tenant is refused ("Another process already has the Postgres store for tenant … open"). If the store loses its database connection (a database restart, an administrator ending it), that tenant answers 503 and `/v1/health/ready` reports not ready until you restart the server; the server itself keeps running.

Each open tenant holds a few database connections. `serve --max-stores <n>` (default 16) caps how many tenants have a store open at once: keep it well below your database's `max_connections`. A store function you write yourself can carry `exists(tenant)` (sync or async) so the server never opens a store for a tenant that does not exist; `postgresStorePort` sets it for you. Chat images stay on local disk (`<home>/pg/<tenant>/`).
