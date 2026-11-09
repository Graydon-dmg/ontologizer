// @ts-check
// Tab completion knows the service-mode commands' subcommands and flags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complete } from '../../src/cli/complete.js';

/** @param {(words: string[]) => string[]} c @returns {string[]} */
function completionProblems(c) {
  const problems = [];
  const want = /** @type {Array<[string[], string[]]>} */ ([
    [['token', ''], ['create', 'list', 'revoke']],
    [['token', 'r'], ['revoke']],
    [['serve', '--h'], ['--host', '--home']],
    [['serve', '--max'], ['--max-builds', '--max-queued', '--max-checks']],
    [['status', '--j'], ['--json']],
    [['token', 'create', '--sc'], ['--scopes']],
  ]);
  for (const [words, out] of want) {
    const got = c(words);
    if (JSON.stringify(got) !== JSON.stringify(out)) problems.push(`${words.join(' ')}: ${JSON.stringify(got)}`);
  }
  return problems;
}

test('completion covers token subcommands and the serve, status and token flags', () => {
  assert.deepEqual(completionProblems(complete), []);
  // Planted fault: a completer that does not know the new commands is reported.
  assert.equal(completionProblems(() => []).length, 6);
});
