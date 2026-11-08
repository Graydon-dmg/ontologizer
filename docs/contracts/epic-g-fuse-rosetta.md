# Epic G · Fuse and Rosetta

| Session | Branch | Worktree | Lead | Workers | Window |
|---|---|---|---|---|---|
| `epic-g-fuse-rosetta` | `epic/g-fuse` | `../onto-g` | Opus 5.5 | Sonnet 5.5 | 0:15 to 2:20 (plan and draft prompts from 0:00; offline checks landed by 1:40; live check right after integration) |

Read `LEAD.md` first, then Epic A's files on `main` and the engine interface in `epic-c-engine.md`. Build against Epic A's fixtures (`plastic-modeling`, `manga`) and a fake client of your own in `test/g/`; you need nothing from Epic B, C or D to start.

**The shell half moved to Epic D (its W5).** This epic is the engine side only.

## Goal

Two features that make Ontologizer more than a map:

- **Fuse.** `ontologizer fuse manga plastic-modeling --into gunpla` makes a third, new map from two existing ones. Both sources stay intact. Bridges and hybrid nodes sit at the seam between them; manga and plastic modeling should surface things like Gunpla, garage kits and figure painting.
- **Rosetta.** `ontologizer rosetta plastic-modeling --as "a home chef"` adds a lens that shows every node through a domain the reader already knows (priming is seasoning a pan, the sprue is mise en place), and marks where each analogy breaks. The breaks are where intuition misleads, so they are the parts most worth learning.

## You own

- `src/core/engine/fuse.js`, `src/core/engine/rosetta.js` (Epic A leaves placeholders; replace them)
- `src/core/engine/prompts-g.js` (your prompts; Epic C's `prompts.js` stays Epic C's)
- `test/g/`

**May touch:** `package.json` (dependency lines only).
**Must not touch:** anything else. Epic C's `createEngine` already attaches your functions, and Epic B's `fuse` and `rosetta` commands already call them. The event types `lens.added` and `lens.analog` already exist in Epic A.

### How your functions are called

```js
// Epic C's createEngine does this; you implement the two functions:
export async function fuse(ctx, a, b, { into } = {}) {}            // -> draftId
export async function rosetta(ctx, ontologyId, persona, { name } = {}) {} // -> lensId
// ctx = { store, models: { fast, strong }, getClient, jsonLines }
//   store: Epic B's store (read, append, createDraft); getClient(): the Anthropic client (lazy)
//   jsonLines: from ./jsonl.js. Until Epic C lands it, import nothing from Epic C: take it from ctx.
// Stream every call exactly as Epic C does (client.messages.stream, text_delta -> jsonLines).
// For Rosetta's parallel batches, run at most 3 calls at once (p-queue).
```

## Interface

### Fuse

```js
engine.fuse(a, b, { into } = {}) -> draftId
// a, b: ontology ids. A third map is refused with:
//   "fuse takes two maps; fuse the result again to add a third"
// The new draft, in this order (every parent is emitted before its children):
//   ontology.created      root = into ?? a suggested name (strong model; kebab-case)
//   category.added        every category of a (family 0), then of b (family 1), then
//                         { id: 'hybrids', label: 'Hybrids', family: 2 }
//   node.added            the new root (depth 0, parent null, category '')
//   node.added            a's root and b's root: parent = the new root, depth 1, category ''
//   node.added            '<new root>/hybrids': parent = the new root, depth 1, category 'hybrids'
//   node.added            every other node of a and b, in a's then b's event order, with:
//                         id, label, parent and category unchanged (each keeps its own root prefix
//                         and its source map's category), depth + 1
//   node.added            3 to 8 hybrids: parent '<new root>/hybrids', depth 2, category 'hybrids',
//                         origin 'fuse'
//   edge.added            every cross-link of a and b, unchanged; then 8 to 20 bridges between a
//                         node of a and a node of b (or a hybrid), type 'bridge', each with a `why`
// One strong call reads both maps' labels (not their summaries) and streams bridges and hybrids as
// JSON lines, so the seam appears live.
```

### Rosetta

```js
engine.rosetta(ontologyId, persona, { name } = {}) -> lensId
// lensId = name ?? slug of the persona's main noun ("a home chef" -> "chef")
// Emits { t: 'lens.added', at, lens: { id, persona, analogs: {} } }  (note the `lens` wrapper,
// exactly as Epic A defines it), then one per node:
//   { t: 'lens.analog', at, lensId, nodeId, label: '<the analog in the persona's domain>',
//     breaks?: '<where it misleads>' }
// Batches of about 25 nodes per strong call, run in parallel on the job queue, streaming JSON lines.
// Every analog names a specific thing in the persona's domain, never a generic word.
```

### Shell half

- **The "See as" switcher** lists `none` plus every lens in the snapshot. Choosing one sends `{ type: 'lens', value }` and calls `view.setLens`.
- **The explain panel** shows the selected node's analog and its break, if a lens is active.
- **Fused maps:**
  - The legend groups categories by source map (family 0, then family 1, then Hybrids).
  - Bridges and hybrids use the `bridge` edge style and the `fuse` outline from `tokens.js`.
  - Nothing else changes: the views already draw those styles.

## Work

- **W1: `fuse.js`.** The structure copy, the seam call, the third-map refusal.
- **W2: `rosetta.js`.** Batching, analog events.
- **The lead:** write both prompts yourself in `prompts-g.js`.

Land W1 and W2 as soon as their offline checks pass (target 1:40). Run the live check below right after integration and land prompt fixes by 2:20.

## Checks: `npm run check:g`

Run offline with your own fake client and fake store in `test/g/`, plus `fixtures/plastic-modeling.events.jsonl` and `fixtures/manga.events.jsonl`.

| Check | Planted fault it must catch |
|---|---|
| Fusing plastic-modeling with manga gives a draft containing every node of both, categories of families 0 and 1 both present, and at least 3 bridges. | A fuse that drops the second map's nodes. |
| In the fused draft, every node's parent is emitted before the node and exists, depths are parent + 1, and every node's category is a category id or ''. | Hybrids parented to a 'Hybrids' category with no node. |
| Folding the Rosetta events gives `lenses[lensId].analogs` filled in. | A `lens.added` emitted without the `lens` wrapper (fold ignores it). |
| `fuse` with a third map is refused with the chaining message. | Accepting three maps. |
| Rosetta on the fixture emits an analog for at least 90% of nodes and at least one `breaks`. | A fake model that returns no breaks: the check must flag it. |

**Live (lead, before landing):** fuse the two fixture maps and confirm the hybrids are real crossovers, not generic words. Run Rosetta "as a home chef" on plastic-modeling and read ten analogs: each names a specific cooking thing, and the breaks make sense.

## Try it

```bash
ontologizer fuse manga plastic-modeling --into gunpla      # the seam fills in live
ontologizer rosetta plastic-modeling --as "a home chef"    # ghost labels appear; switch lenses in the top bar
```

## Not in this epic

- No fusing more than two maps in one step.
- No Keystones (threshold concepts); a later version could add them.
- No new event types.

## Hand-offs

- Offline checks landed by 1:40; live-checked by 2:20 (the freeze).
- If the clock is short, the human cuts Rosetta before fuse.
