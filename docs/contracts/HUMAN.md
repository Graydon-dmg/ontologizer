# The human epic

Everything in this build that needs a person: accounts, keys, starting the sessions, relaying messages, two decisions, the npm publish and the demo. Nothing here is delegated to a model.

## Before the clock (do this the day before)

### 1. Tools

| Tool | Check | Install |
|---|---|---|
| Node 20 or newer | `node -v` | nodejs.org, or `nvm install 22` |
| git 2.40 or newer | `git --version` | your OS package manager |
| GitHub CLI | `gh --version`, then `gh auth login` | cli.github.com |
| Claude Code | `claude --version`, then run `claude` and sign in | claude.com/claude-code |

Sign Claude Code in to **your own** Claude account. Six sessions run at once, three of them on Opus, so use a plan with enough usage for three hours of that.

### 2. The Anthropic API key (for the product itself)

The `ontologizer` command calls the Anthropic API with a key, separately from Claude Code.
1. Sign in at console.anthropic.com, add a little credit, and create an API key named `ontologizer-dev`.
2. Store it in the macOS keychain, in the same slot the `ontologizer` command reads (it prompts for the key, hidden; never paste it into a file or the repository):
   ```bash
   security add-generic-password -U -s ontologizer -a anthropic-api-key -w
   ```
3. Check it is there without printing it: `security find-generic-password -s ontologizer -a anthropic-api-key -w | cut -c1-7` prints `sk-ant-`.

Once the CLI is built you never need this again: on a machine with no stored key, the first `ontologizer new` asks for it and stores it itself. `ontologizer key set` replaces it; `ontologizer key clear` removes it. Epic C's live checks read it with `ANTHROPIC_API_KEY=$(security find-generic-password -s ontologizer -a anthropic-api-key -w) npm run check:c:live`.

A full map costs a dozen or so model calls, mostly on the small model: cents, not dollars. The live checks in Epic C cost about the same.

### 3. The npm account (for publishing)

1. Create an account at npmjs.com/signup and verify the email address. npm will not publish from an unverified account.
2. Turn on two-factor authentication: Account → Two-Factor Authentication → "Authorization and writes", using an authenticator app. Save the recovery codes.
3. On your machine:
   ```bash
   npm login            # opens the browser to sign in
   npm whoami           # prints your npm username
   ```
4. Check the name is still free:
   ```bash
   npm view ontologizer
   ```
   An `E404 Not Found` means it is free. It was free on 2026-11-07.
5. If the hackathon rules allow pre-work, you can claim the name now by publishing a placeholder. Otherwise skip this and publish at 2:50.
   ```bash
   mkdir /tmp/onto-claim && cd /tmp/onto-claim
   npm init -y && sed -i.bak 's/"name": ".*"/"name": "ontologizer"/; s/"version": ".*"/"version": "0.0.1"/' package.json
   echo "# ontologizer\nComing soon." > README.md
   npm publish                     # asks for the one-time password from your authenticator
   ```

## At 0:00: set up the repository and start six sessions (about 5 minutes)

### 1. Create the repository on your GitHub and put the contracts in it

```bash
cd ~/projects
gh repo create ontologizer --public --clone --description "Give it a topic and watch the whole field draw itself."
cd ontologizer
mkdir -p docs && cp -R <path-to>/contracts docs/contracts
git add . && git commit -m "Build contracts"
git branch -M main && git push -u origin main
```

### 2. Create one branch and one worktree per epic

```bash
for e in a-contract b-cli c-engine d-shell e-graph f-sky g-fuse h-ship; do
  git branch "epic/$e" && git push -u origin "epic/$e"
done
git worktree add ../onto-a epic/a-contract
git worktree add ../onto-b epic/b-cli
git worktree add ../onto-c epic/c-engine
git worktree add ../onto-d epic/d-shell
git worktree add ../onto-e epic/e-graph
git worktree add ../onto-f epic/f-sky
git worktree add ../onto-g epic/g-fuse
git worktree add ../onto-h epic/h-ship
```

Leave `~/projects/ontologizer` itself on `main`. It is your window onto the result: run `git pull` there to see what has landed.

### 3. Start the six sessions

Use one terminal tab per session:

| Tab | Folder | Start with |
|---|---|---|
| S0 | `../onto-a` | `claude --model opus --permission-mode acceptEdits` |
| S1 | `../onto-b` | `claude --model opus --permission-mode acceptEdits` |
| S2 | `../onto-c` | `claude --model opus --permission-mode acceptEdits` |
| S3 | `../onto-e` | `claude --model opus --permission-mode acceptEdits` |
| S4 | `../onto-f` | `claude --model opus --permission-mode acceptEdits` |
| S5 | `../onto-d` | `claude --model opus --permission-mode acceptEdits` |

In each one, paste this prompt, filling in the four blanks from the table in `docs/contracts/README.md`:

```text
You are the epic lead for Epic <X> of Ontologizer, a 3-hour hackathon build.
Read docs/contracts/README.md, docs/contracts/LEAD.md and docs/contracts/<epic file>, in that order.
You run on Opus 5.5. Your workers run on Sonnet 5.5: start them with the Agent tool, model "sonnet".
You personally check every body of work before you accept it, exactly as LEAD.md says.
You work on your branch and land on main yourself when the full check passes. No pull requests.
The clock started at <hh:mm>. Begin now. If you are not Epic A, read and plan until Epic A's first drop is on main, then merge main and build.
```

Epic A's `.claude/settings.json` lets the sessions run `npm`, `node` and `git` without asking, once it lands. Until then, approve the sessions' commands as they come.

## During the build: your jobs

> **With a train lead session (`lead`):** it messages the epic sessions directly, so it does the relay, the `main` watch and the clock calls below. You keep the decisions (3D at 2:10, cuts), the npm publish and the demo.

### Relay
The sessions cannot talk to each other. When a lead asks for a change in another epic, paste its one-paragraph request into that epic's session, then paste the answer back. Requests to change the shared contract always go to S0.

### Watch `main`
Every 10 minutes or so:
```bash
cd ~/projects/ontologizer && git pull && npm install && npm run check
```
- If `npm run check` fails on `main`, find the last commit to land (`git log --oneline -5`) and tell that epic's lead to fix it before anything else lands.
- Never fix code yourself in this folder.

### The clock

| Time | You do |
|---|---|
| about 0:15 | When S0 says drop 1 is on `main`, tell B to G: "Epic A drop 1 is on main: merge main and build." |
| about 0:25 | Same for drop 2. |
| 1:00 | Ask each lead for one line: what has landed, what is next, any risk. |
| 1:40 | **Integration.** Tell S1: "Swap the engine stub for createEngine." Then, in your folder, run `npm link`, then `ontologizer new` with the demo topic (below). Report what breaks to the owning lead. |
| 2:10 | **Decide on 3D.** If F's checks pass and `npm run check` is green on its branch merged with `main`, F lands. Otherwise 3D is cut. If Epic G's live check is not close, cut Rosetta, keep fuse. |
| 2:20 | **Feature freeze.** Only fixes for `main` and Epic H land. |
| 2:50 | When Epic H says "Ready to publish", publish (below). |

### If a session dies
Start it again in the same folder with the same prompt, plus: "You are resuming: read `git log --oneline` on your branch and `git status`, then continue from where the work stands." Uncommitted work in the worktree is still there.

## At about 2:50: publish to npm

From your folder, on the commit Epic H named:

```bash
cd ~/projects/ontologizer
git pull
git log --oneline -1                    # matches the commit Epic H named
npm install && npm run check            # must pass
npm whoami                              # you are logged in; if not: npm login
npm pack --dry-run                      # read the file list: src/, web/, fixtures/, README.md, LICENSE, package.json; nothing else
npm publish                             # asks for the one-time password; or: npm publish --otp=123456
```

**If you published a 0.0.1 placeholder earlier:** `package.json` says 0.1.0, so publish goes ahead. Any later fix needs a new version first:
```bash
npm version patch          # 0.1.0 -> 0.1.1, commits and tags
git push --follow-tags
npm publish
```

**Check it from a clean terminal:**
```bash
npm view ontologizer version            # 0.1.0
npm i -g ontologizer                    # the real install
ontologizer doctor                      # all rows ok
ontologizer load demo --replay          # the demo plays
```

**If npm refuses the name** (for example "too similar to an existing package"), publish under your own scope. The command people type stays `ontologizer`, because the `bin` field decides that.
1. Set `"name": "@<your-npm-username>/ontologizer"` in `package.json`.
2. Publish:
   ```bash
   npm publish --access public
   ```
3. Install with `npm i -g @<your-npm-username>/ontologizer`.
4. Update the README install line to match.

**Do not unpublish** to fix a mistake: publish a new patch version instead. An unpublished name is locked for 24 hours.

Afterwards, tag the release on GitHub:
```bash
git tag v0.1.0 && git push --tags
gh release create v0.1.0 --generate-notes
```

## The demo (about 3 minutes)

1. **Before going on stage:**
   - `ontologizer doctor` is all ok;
   - the browser is closed;
   - the terminal font is large;
   - a phone hotspot is ready as a network backup.
2. **Live build.** Run `ontologizer new` and paste this context:
   > I'm getting into scale plastic modeling, mostly 1/72 World War II aircraft, and I want to understand the tools, techniques, brands and community.

   The context check passes, the page opens, and the map grows. Point at the insight ticker.
3. **Drill down.**
   - Click Tools, then Adhesives, then Research (in context): plastic cement appears.
   - Do the same with Research (general): a different universe appears.
   - Explain a node, keep browsing, and come back to the panel.
4. **Zoom deep.** Point at the minimap. Collapse a branch.
5. **Fuse** (if it shipped): `ontologizer fuse manga plastic-modeling --into gunpla`.
6. **Rosetta** (if it shipped): `ontologizer rosetta plastic-modeling --as "a home chef"`. Then ask the audience for a hobby and run it again.
7. **If the network fails at any point:** `ontologizer load demo --replay`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| A session asks for permission on every command | Epic A's `.claude/settings.json` has not landed or been merged yet: approve for now, or have the lead merge `main`. |
| `git push origin HEAD:main` rejected | Someone landed first. The lead fetches, merges, checks and pushes again. That is normal. |
| `npm run check` fails on `main` | Stop all landings, find the last commit, and have its lead fix it. |
| The page is blank | Open the browser console. A failing `/vendor/...` path means the import map is wrong: that is S0's. |
| `401` from the API | The stored key is wrong or revoked: `ontologizer key set`. If `ANTHROPIC_API_KEY` is set in that terminal it wins over the keychain: unset it. |
| `npm publish` says you need to log in or verify your email | `npm login`, then check the verification email from npm. |
| `npm publish` says `E403` "You do not have permission" | The name is taken: use the scoped name (above). |
