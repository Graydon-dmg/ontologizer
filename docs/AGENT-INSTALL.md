# Installing Ontologizer (for AI coding agents)

Follow these steps in order. Do not skip ahead.

> **KEY RULE: Never ask for, read, paste, echo or store the Anthropic API key.** Never set `ANTHROPIC_API_KEY` in a shell rc file or any other file. The human enters the key themselves, in their own terminal, with `ontologizer key set` (or the first time they build a map with `ontologizer new`), at a masked prompt.

## Steps

1. **Check Node.** Run `node -v`. It must be 22 or newer. If not, stop and tell the human: install Node 22+ from https://nodejs.org, or with nvm: `nvm install 22`. Then continue.

2. **Install.**

   ```bash
   npm i -g ontologizer
   ```

3. **Run the health check.**

   ```bash
   ontologizer doctor
   ```

   Its output is only a few lines; piping it (for example `ontologizer doctor | head`) is safe. Each row starts with `ok`, `warn` or `fail`; problems add a `fix:` line. Example output:

   ```
   ok   Node 26.0.0
   fail API key not set
        fix: ontologizer key set
   ok   Network api.anthropic.com reachable
   ok   Store /Users/you/.ontologizer is writable
   warn Completion not installed
        fix: add to ~/.zshrc: eval "$(ontologizer completion zsh)"
   warn Version 1.0.0 (could not check for updates)
   ```

   - The API key row may show `not set` until step 4.
   - The two `warn` rows, Completion and Version (the update check), need no action for the install.
   - Any other `fail`: see Troubleshooting.

4. **Hand the key off to the human.** If `ontologizer doctor` already shows the API key row as `ok`, skip to step 5. Otherwise, say exactly this:

   > I can't handle your Anthropic API key, and shouldn't see it. Please open your own terminal and run `ontologizer key set`, then paste your key at the masked prompt (it starts with `sk-ant-`). It will be saved to your system keychain. Tell me when you're done.

   Wait for the human to confirm. Do not run `ontologizer key set` yourself.

5. **Verify.** Run `ontologizer key`. It prints only where the key comes from, never the key itself. It prints exactly one of:

   ```
   keychain (service ontologizer, account anthropic-api-key)
   ANTHROPIC_API_KEY (environment)
   none: run ontologizer key set
   ```

   (`none` also exits with code 1.) Then run `ontologizer doctor` again; the API key row should now be `ok`.

6. **Suggest a first run to the human.** Don't run these yourself in the foreground: each starts a local web server that keeps running until Ctrl-C. Tell the human to run them in their own terminal:
   - `ontologizer load demo --replay` (offline, no key needed)
   - `ontologizer new` (builds a new map with Claude)

   Once a map is open, the human can click **Ask the map** in the page to ask it questions. Do **not** call the page's `/api/chat` endpoint for them unless they ask you to: every question spends their Anthropic credits.

   If you want to confirm the demo starts, run it in the background for a few seconds, check that it prints `Serving … at http://127.0.0.1:<port>/`, then stop it.

7. **Optional: give yourself (or the human's other agents) the map tools over MCP.** To read a map's outline or context pack, search it, put it into a document, or build and extend one:
   - Claude Code: run `claude mcp add ontologizer -- ontologizer mcp`, start a new session, and check that `claude mcp list` (or `/mcp`) shows `ontologizer` as connected. A first `list_maps` call should answer, with an empty list on a fresh install.
   - Claude Desktop or another MCP client: `{ "mcpServers": { "ontologizer": { "command": "ontologizer", "args": ["mcp"] } } }` in its MCP config, then restart it. Use the full path from `which ontologizer` if the client can't find it.
   - A team server with tokens: ask the human for a token *file* and use `ontologizer mcp --url <server> --token-file <file>`.

   [FOR-AGENTS.md](../FOR-AGENTS.md) shows what the tools can do and how to start; [MCP.md](MCP.md) has the workflows, costs and errors. Tools that call the model say so in their description: ask the human before using them, as for the chat.

## Optional: shell completion

Doctor's fix line for zsh is `eval "$(ontologizer completion zsh)"` (added to `~/.zshrc`). For bash or fish use `ontologizer completion bash` or `ontologizer completion fish`. Only edit an rc file if the human agrees.

## Troubleshooting

- **`EACCES` on `npm i -g`.** Do not use sudo. Either fix npm's global prefix (`npm config set prefix ~/.npm-global`, then add `~/.npm-global/bin` to PATH) or use nvm.
- **`ontologizer: command not found` after install.** npm's global bin folder is not on PATH. Run `npm prefix -g` and add its `bin` folder to PATH.
- **No keychain on Linux (no Secret Service, e.g. headless or WSL).** `ontologizer key set` prints "Could not save the key to the keychain: set ANTHROPIC_API_KEY to skip this prompt". The human can install and unlock a Secret Service keyring (such as gnome-keyring), or export `ANTHROPIC_API_KEY` in their own session. The agent must not do either for them.
- **401 / "Your Anthropic API key was rejected: run ontologizer key set".** The key is wrong or revoked. The human runs `ontologizer key set` again.
- **Port in use / browser did not open.** Ontologizer picks a free port on 127.0.0.1 every time, so a clash should not happen. If the browser did not open, open the URL the command printed: "Serving <name> at http://127.0.0.1:<port>/  (Ctrl-C to stop)".
- **Doctor warns "cannot reach api.anthropic.com (load demo --replay still works)".** The network check failed: check proxy or firewall settings. `ontologizer load demo --replay` still works.
