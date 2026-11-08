# Agent notes

- **Installing Ontologizer for a human:** follow [docs/AGENT-INSTALL.md](docs/AGENT-INSTALL.md) step by step. Never ask for or handle their Anthropic API key.
- **After install:** the human can click **Ask the map** in the page to question a map. Don't call `/api/chat` on their behalf unless they ask: it spends their Anthropic credits.
- **Working on this code:** read [CONTRIBUTING.md](CONTRIBUTING.md) and the specs in [docs/contracts/](docs/contracts/) first.
