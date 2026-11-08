# The epic lead contract

You are the lead for one epic. This file says how every lead works. Your epic's own contract (`epic-*.md`) says what to build. Read both before you write any code.

## Your job in one paragraph

- **What you own:** your epic's result, inside a 3-hour build.
- **How the work gets done:** you split your epic into bodies of work, hand each one to a worker, and personally check what comes back before you accept it.
- **Landing:** you land accepted work on `main` as soon as the full check passes, early and often.
- **Staying in bounds:** you keep your epic inside its files and its interface, and ask through the human before you touch anything else.
- **The bar:** speed matters more than polish. A working thing on `main` at 1:00 beats a perfect thing at 2:50.

## The train lead

A train lead session (named `lead`) runs the whole build and can message every epic session directly. Wherever this file or your contract says "tell the human" or "ask the human", tell `lead` instead: it relays, decides what it can, and brings the rest to the human. Send it one short line whenever you land something on `main` (`landed: epic-<x>: <what>`), and at once if `main` is broken or you will miss your window. You still land your own work: do not wait for `lead` to approve a landing that passes the full check.

## Models

| Role | Model | How it runs |
|---|---|---|
| Lead (you) | Opus 5.5 | This Claude Code session, started with `claude --model opus` |
| Worker | Sonnet 5.5 | Subagents you start with the Agent tool, `model` set to `sonnet` |

Every epic uses the same pair: Opus leads coordinate and check, Sonnet workers build. Never start a worker on Opus or Haiku.

**When to do it yourself:** if a worker fails twice on the same body of work, do it yourself. If something takes you less time to write than to describe, write it.

## How you hand out work

Your contract lists the bodies of work (W1, W2, ...). Work through them like this:

1. **Brief each worker completely.** The worker has no memory of this session. Give it:
   - the body of work, copied from your contract,
   - the interface it must match, copied from your contract or from Epic A's files,
   - the exact files it may create or change, and that it must not touch any other file,
   - the check it must make pass (`npm run check:<epic>`), and that it must run the check before reporting,
   - that it must not commit, merge or push: you do that.
2. **Run independent bodies of work in parallel.** Start them in one message so they run at once. Never give two workers the same file at the same time.
3. **Keep the briefs short and literal.** Paste the interface; do not paraphrase it.

## How you check every body of work

Nothing is accepted until you have done all of these yourself:

1. **Read the whole diff:** `git diff` (or `git diff --stat` first, then each file). You should be able to explain every line that matters.
2. **Check that it stays inside its files.** Any change outside the files the worker was given is rejected, however reasonable.
3. **Check the interface.** Names, arguments, event shapes and file paths match your contract and Epic A exactly. Small drift here breaks other epics at integration.
4. **Run the checks:** `npm run check:<epic>`, then `npm run check` (everything). Both must pass.
5. **Try it.** Run the command, open the page, replay the fixture: whatever your contract's "Try it" line says. Tests passing is not the same as working.
6. **Decide:**
   - Accept: commit it (`git add` the files, `git commit -m "epic-<x>: <what>"`).
   - Send back: tell the same worker exactly what to fix (by name, with the Agent tool's follow-up), then check again from step 1.
   - Take over: if it is faster, fix it yourself and check again.

Every check in a contract comes with a **planted fault**: a deliberately broken input or implementation the check must catch. Build the planted fault into the test itself (the test feeds the fault and asserts the check reports failure). A check whose planted fault passes is not a check: fix it before you trust it.

## Branches and worktrees

- You work in your own git worktree on your own branch (contract header). Never check out `main` in your worktree.
- At the start, and whenever another epic lands something you need, bring `main` in:

```bash
git fetch origin
git merge --no-edit origin/main
```

## Landing on `main`

Land as soon as a body of work is accepted and the whole repository still passes. Do not save it all for the end.

```bash
git fetch origin
git merge --no-edit origin/main     # bring in what others landed
npm install                         # only if package.json changed
npm run check                       # everything; must pass
git push origin HEAD:main           # rejected? someone landed first: start again at fetch
git push origin HEAD                # keep your branch on GitHub as well
```

- **No pull requests and no CI.** `npm run check` on your machine is the gate, and you are the reviewer.
- **Never force-push `main`.** Never use `--force` anywhere.
- **Conflicts:** resolve conflicts in files you own. If a conflict is in a file you do not own, take `main`'s version of that file (`git checkout --theirs <file>` during the merge) and adapt your own code to it. Then run the full check again.
- **No shared lists:** Epic A creates every file that two epics would otherwise both edit (`src/core/index.js`, `web/views/index.js`) and a placeholder for each epic's own entry file, so you only ever replace files you own. The one exception is a `deps:` line in `package.json`: if that conflicts, keep both sides' lines.
- **If `main` is broken when you fetch it** (the full check fails before your merge), tell the human at once with the failing output. Do not land on top of a broken `main`, and do not fix another epic's files yourself.

## Staying in bounds

- **Files:** your contract lists what you own, what you may touch, and what you must not touch.
- **`package.json`:** it belongs to Epic A. If you need a dependency that is not already there, add only that line to `dependencies`, commit it alone as `deps: add <name>`, and land it straight away so other leads get it.
- **Interface changes:** if you need something from another epic's interface, or a change to Epic A's schema, events or view standard:
  1. Stop.
  2. Write the request in one paragraph: what, why, the exact shape.
  3. Ask the human to pass it to that epic's lead.
  4. Build against what exists until the answer lands.
- **Workarounds:** never work around another epic by copying its code into your files.

## Time

- Your contract gives your window. At the halfway point of your window, land whatever works, even if not everything is done.
- **15 minutes before your window ends,** stop starting new bodies of work. Finish, check, land.
- If you will miss your window, tell the human what will and will not land, so the cut order can be applied.

## Done

Your epic is done when:
1. every body of work in your contract is accepted and landed on `main`, or explicitly cut by the human;
2. `npm run check` passes on `main`;
3. your contract's "Try it" works from a fresh clone of `main`;
4. you have told the human, in one short message, what landed and anything left undone.
