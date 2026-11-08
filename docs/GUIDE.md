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

The **⟦Chat⟧** panel lets you ask questions about the whole map in plain words, for example *"Which of these tools does a beginner actually need first?"* or *"How does Gunpla connect to the manga side?"*.

- **How it answers.** Claude first searches your map (labels, summaries, articles and links) and answers from that. When the map doesn't cover something, it can also search the web.
- **Citations.** Each claim is marked with where it came from. ⟦Map citation⟧ means *from your map*: click it to jump to that node. ⟦Web citation⟧ means *from the web*: the source is listed under ⟦Sources⟧ and opens in a new tab.
- **Images.** Paste an image (or drop one onto the panel) to ask about it, for example a photo of a kit's sprue or a page you're stuck on. PNG, JPEG, WebP and GIF work; up to 4 images per message, 5 MB each. A message can be just an image. Text is limited to 4000 characters (an emoji counts as one). One answer is written at a time per map, and an answer that stalls is stopped with `The answer took too long and was stopped.`
- **Research suggestions.** When an answer shows a gap in your map, the chat may suggest a node to research. It never starts a job by itself: a suggestion is a button (⟦Research suggestion label⟧) that you click to queue the research, and it then appears in the jobs tray like any other job.
- **Cost.** Each question is one model call, roughly a cent or two more when it searches the web. See [Cost](#7-cost).

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
| **⟦Chat⟧** | Opens the chat panel: ask questions about the map, with citations. See [Chat: ask your map](#chat-ask-your-map). |
| **Fuse** | *Make a new map that joins this one with another saved map* (its tooltip). The new draft opens in a new tab. See [Fuse two interests](#b-fuse-two-interests). |
| **Legend** | Colour key for categories; click its header to fold it. In a fused map it groups categories by source map (headed with each source map's name) and **Hybrids**, and adds a **Fusion** key for **Bridge** lines and **Hybrid** outlines. |
| **Minimap** | A small overview; the **−** / **+** button collapses and expands it. |
| **Jobs tray** | Running and recent jobs (see Concepts). |
| **Ticker** | Short notices as things are added; click one to focus that node. |

**Keyboard.** There are only a few shortcuts:

- **Escape** closes the node menu.
- In the search box, **Enter** jumps to the best match and **Escape** clears the search.
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
