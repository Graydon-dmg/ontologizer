#!/usr/bin/env node
// @ts-check
// Entry point. `__complete` takes a fast path that loads no yargs, prompts or SDK, so Tab
// answers in well under 100 ms. Everything else goes through main().
const argv = process.argv.slice(2);

// `ontologizer doctor | head -3`: once the reader closes the pipe, the next write fails with EPIPE.
// That is the reader saying "enough", not an error: exit quietly (0 for stdout), for every command.
for (const [stream, code] of /** @type {const} */ ([[process.stdout, 0], [process.stderr, 1]])) {
  stream.on('error', (/** @type {any} */ err) => {
    if (err && err.code === 'EPIPE') process.exit(code);
    throw err;
  });
}

if (argv[0] === '__complete') {
  const { complete } = await import('./complete.js');
  process.stdout.write(complete(argv.slice(1)).map((c) => `${c}\n`).join(''));
  process.exit(0);
}

const { main } = await import('./main.js');
const code = await main(argv);
// Exit explicitly: a pending once-a-day update check must never hold the process open.
process.exit(code);
