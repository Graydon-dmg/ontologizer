# Epic C · The engine

| Session | Branch | Worktree | Lead | Workers | Window |
|---|---|---|---|---|---|
| `epic-c-engine` | `epic/c-engine` | `../onto-c` | Opus 5.5 | Sonnet 5.5 | 0:15 to 1:40 (plan and draft prompts from 0:00; build after Epic A's first drop) |

Read `LEAD.md` first, then Epic A's files on `main`.

## Goal

The part that thinks:
- it checks a context before any work;
- it builds a map in waves that stream node by node, so the first ring is on screen in about a second;
- it runs research, explain and sources as jobs on one small queue, so the reader keeps browsing while several jobs run.

The engine writes only events, only through the store.

## You own

- `src/core/engine/` (entry point `src/core/engine/index.js`; Epic A leaves a placeholder there: replace it)
- `test/c/` (offline checks) and `test/c/live/` (checks that call the API). `scripts/test.js` skips `live/` unless `LIVE=1`, and each live test also skips itself when `ANTHROPIC_API_KEY` is unset. To run them with the key the human stored in the keychain: `ANTHROPIC_API_KEY=$(security find-generic-password -s ontologizer -a anthropic-api-key -w) npm run check:c:live` (the key stays in that one command's environment; never echo it).

**May touch:** `package.json` (dependency lines only). `src/core/index.js` already re-exports `createEngine`: do not edit it.
**Must not touch:** `src/core/schema.js`, `src/core/events.js`, `src/core/store.js`, `src/cli/`, `src/server/`, `web/`.

## Interface

```js
// @ts-check
export function createEngine({ store, id, client = null, models = defaultModels(),
                               concurrency = 3 }) {}
// Epic B calls createEngine({ store, id, client }), passing a client built from the key it resolved
// (env or OS keychain). client and models MUST still default, for headless use and tests.
// store:  Epic B's store (or any object with append(id, event) and read(id))
// client: when null, the engine creates new Anthropic() from '@anthropic-ai/sdk' (reads
//         ANTHROPIC_API_KEY) on its first model call; tests pass the fake client
// defaultModels() = { fast: process.env.ONTOLOGIZER_FAST_MODEL ?? 'claude-haiku-5-5',
//                     strong: process.env.ONTOLOGIZER_STRONG_MODEL ?? 'claude-sonnet-5-5' }
// Create the default client lazily (on the first call), so createEngine never throws without a key.
//
// .check(context, answers = []) ->
//     { ready: true, brief, name }
//   | { ready: false, questions: [{ id, text, options: string[] }] }
//   Four tests: subject (one meaning), scope (fans out into roughly 6 to 12 meaningful branches),
//   purpose (why the reader wants it), level (beginner / intermediate / expert).
//   At most 3 questions per round. The CLI allows two rounds, then builds with what it has.
//   name: a short kebab-case suggestion, e.g. "plastic-modeling".
//
// .build(brief, { depth = 2 } = {}) -> Promise<void>
//   Emits ontology.created, then:
//   wave 0: one fast call -> 6 to 10 categories (category.added + node.added each)
//   wave 1: one fast call per category, about 5 at once -> that category's children (and depth 3
//           where depth > 2)
//   wave 2: one strong call over the built tree -> 10 to 25 cross-links (edge.added), then 1 to 3
//           insight events
//
// .enqueue(job, { priority = 0 } = {}) -> jobId
//   job = { kind: 'research', nodeId, mode: 'context'|'general' }
//       | { kind: 'explain', nodeId }
//       | { kind: 'sources', nodeId }
//   Emits job.queued now, job.started when it runs, job.done or job.failed at the end.
//   Clicked jobs use priority 10; build waves use priority 0. The same kind on the same node is
//   never queued twice while one is queued or running.
//
// .fuse(a, b, opts) and .rosetta(id, persona, opts): attach them from the start, so Epic G never
//   edits this file:
//     import { fuse } from './fuse.js'; import { rosetta } from './rosetta.js';
//     const ctx = { store, models, getClient, jsonLines };   // getClient(): the lazy client
//     engine.fuse = (a, b, opts) => fuse(ctx, a, b, opts);
//     engine.rosetta = (id, persona, opts) => rosetta(ctx, id, persona, opts);
//   Until Epic G lands, Epic A's placeholders throw "fuse: not built yet" / "rosetta: not built yet".

// src/core/engine/jsonl.js
export async function* jsonLines(textChunks) {}
// Takes an async iterable of text chunks. Yields one parsed object per complete line, across any
// chunk boundary. Skips blank lines and lines that are not JSON objects (never throws on them).
// Strips a leading ``` fence line if the model adds one.
```

### Calling the model

- Use `@anthropic-ai/sdk`.
- Stream every call with `client.messages.stream({...})`. Feed the `text_delta` text of each `content_block_delta` event into `jsonLines`, so a node becomes a `node.added` event the moment its line closes.
- Do not wait for the call to finish before emitting.

```js
const stream = client.messages.stream({ model, max_tokens: 16000, system, messages,
                                        output_config: { effort: 'low' } });
async function* text() {
  for await (const e of stream) {
    if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') yield e.delta.text;
  }
}
for await (const obj of jsonLines(text())) { /* validate, then store.append(...) */ }
const final = await stream.finalMessage();   // check final.stop_reason
```

- **Fast model:** effort `low` for build waves and the context check.
- **Strong model:** effort `medium` for cross-links, explain, research, sources, and Epic G.
- **Web search** (sources, explain, research only, strong model only): add `{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }` to `tools`. It does not work on the fast model.
- **Stop reasons:**
  - `refusal`: the job fails with a short reason; never crash the build.
  - `pause_turn` (a long server-tool turn): send the conversation back with the assistant content appended, at most twice.
  - `max_tokens`: keep what streamed and mark the job done.
- **Search results arrive as `web_search_tool_result` blocks.** A success holds a list of results; an error holds a single object with an `error_code`. Branch on that before reading sources.
- The SDK retries rate limits and server errors twice by default. Keep that.

### What each call returns (one JSON object per line)

```text
wave 0, research   {"label":"Tools","summary":"…","hook":"…"}
wave 1             {"label":"Adhesives","parent":"Tools","summary":"Glues that bond styrene parts.",
                    "hook":"Plastic cement does not glue: it melts both faces into one."}
wave 2             {"from":"<node label path>","to":"<node label path>","type":"influences","why":"…"}
explain            one object: {"summary":"…","keyFacts":["…"],"whyItMatters":"…","seeAlso":["<label>"]}
                   sources come from the search result blocks, not from the model's text
check              one object: {"ready":true,"brief":{…},"name":"…"} or {"ready":false,"questions":[…]}
```

The engine turns labels into ids:
- id = parent id + `/` + slug(label);
- a duplicate id gets a `-2` suffix;
- a parent label that matches nothing becomes the node's category, so a node is never dropped and the build never crashes.

Every node carries `origin`, `createdBy` and `status: 'done'`. Research marks new nodes `origin: 'context'` or `'general'`.

### Research: in context versus general

- **In context:** the prompt carries the Brief and the node's full label path: *plastic modeling › tools › adhesives* → plastic cement, CA glue, PVA for clear parts.
- **General:** the prompt carries only the node's label: *adhesives* → epoxies, pressure-sensitive adhesives, structural bonding.

Both attach the new nodes as children of the node that was researched.

## Work

- **W1: `jsonl.js` and its offline tests.**
- **W2: the job queue (`p-queue`, priorities, dedupe, job events) and its offline tests, using a fake client.**
- **W3: the fake client for tests.** It streams canned text in small random chunks from a fixture and can be told to delay, refuse or pause.
- **W4 (lead writes the prompts; worker wires them): `check` and `build` (waves 0 to 2)**, label-to-id mapping, validation.
- **W5 (lead writes the prompts; worker wires them): `research`, `explain`, `sources`**, with web search and stop-reason handling.
- **W6: live checks in `test/c/live/`.**

The prompts are yours, the lead's: write them yourself and keep them in `src/core/engine/prompts.js`. Each prompt states the output format above exactly, says "one JSON object per line, nothing else", and gives one example line.

## Checks

`npm run check:c` runs offline, with no API key:

| Check | Planted fault it must catch |
|---|---|
| `jsonLines` yields exactly one object when a line arrives split across chunks. | Splitting `{"label":"Adhe` / `sives"}` across two chunks. |
| `jsonLines` skips a fence line and a non-JSON line without throwing. | A line reading "Here are the categories:". |
| With the fake client, `build` emits the first `node.added` before the fake call finishes. | An engine that waits for `finalMessage()` before emitting. |
| A model line naming an unknown parent is attached to its category, not dropped. | A parent label that matches nothing. |
| Explain clicked twice on the same node queues one job. | A queue without the dedupe. |
| A refused call ends its job as `job.failed` and the build carries on. | The fake client set to refuse wave 1 for one category. |
| `createEngine({ store, id })` with no client and no `ANTHROPIC_API_KEY` returns an engine without throwing. | A constructor that builds the client eagerly. |

`npm run check:c:live` (run it yourself before landing; it costs a few cents):

| Check | Planted fault it must catch |
|---|---|
| `check('modeling')` returns questions; `check` on the full plastic-modeling brief returns `ready: true`. | Swap in a check prompt with the four tests removed: it must say ready to "modeling". |
| On the plastic-modeling brief, the first `node.added` arrives within 2 s of `build` starting. | A fake client that answers after 3 s. |
| Research in context and research general on "adhesives" share fewer than half their child labels. | Sending the same prompt for both modes. |
| Explain on "Adhesives" returns an article with at least one source URL. | Web search removed from the tools list. |

## Try it

```bash
ANTHROPIC_API_KEY=… node -e "
  import('./src/core/engine/index.js').then(async ({ createEngine }) => {
    const events = []; const store = { append: (_, e) => { events.push(e); console.log(e.t, e.node?.label ?? '') }, read: () => ({}) };
    const engine = createEngine({ store, id: 'try', client: new (await import('@anthropic-ai/sdk')).default() });
    await engine.build({ context: 'plastic modeling for a beginner', subject: 'scale plastic modeling', scope: 'hobby', purpose: 'getting started', level: 'beginner' });
  })"
```
Category lines start printing within about a second, then children stream by category, then links.

## Not in this epic

- No ontology import (OWL, RDF).
- No retries beyond the SDK's.
- No resuming interrupted jobs after a restart: they stay failed and can be clicked again.
- No UI.

## Hand-offs

- **Epic B** swaps its stub for `createEngine` at integration, passing `client`. Keep the stub's shape.
- A model call that fails with an SDK `AuthenticationError` (401) ends its job as `job.failed` with error "Your Anthropic API key was rejected: run ontologizer key set", and `check`/`build` rethrow it unchanged so the CLI can say the same.
- **Epic D** sees the engine only as events. A new job kind needs a menu item: tell the train lead, who tells `epic-d-web-shell`.
- **Epic G** (its own session) builds `fuse.js` and `rosetta.js` against the `ctx` above. Land `jsonl.js` and the `ctx` wiring early so G can build on them; tell the train lead when they are on `main`.
