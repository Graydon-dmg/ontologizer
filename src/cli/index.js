#!/usr/bin/env node
// @ts-check
// Entry point. `__complete` takes a fast path that loads no yargs, prompts or SDK, so Tab
// answers in well under 100 ms. Everything else goes through main().
const argv = process.argv.slice(2);

if (argv[0] === '__complete') {
  const { complete } = await import('./complete.js');
  process.stdout.write(complete(argv.slice(1)).map((c) => `${c}\n`).join(''));
  process.exit(0);
}

const { main } = await import('./main.js');
const code = await main(argv);
// Exit explicitly: a pending once-a-day update check must never hold the process open.
process.exit(code);
