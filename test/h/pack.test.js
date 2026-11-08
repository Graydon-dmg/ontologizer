// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED, packedFiles, auditPack, checkShebang } from './pack.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Build a throwaway package, run the real packedFiles + auditPack on it, then clean up. */
function audit(/** @type {string[]} */ files, /** @type {Record<string, string>} */ extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'h-fault-'));
  try {
    const layout = {
      'package.json': JSON.stringify({ name: 'h-fault', version: '0.0.0', files }),
      'src/cli/index.js': '#!/usr/bin/env node\n',
      'web/shared/importmap.json': '{}\n',
      'web/index.html': '<!doctype html>\n',
      'fixtures/demo.events.jsonl': '{}\n',
      ...extra,
    };
    for (const [p, text] of Object.entries(layout)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    return auditPack(dir, packedFiles(dir), REQUIRED);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('real package ships the required files and nothing it should not', () => {
  assert.deepEqual(auditPack(repoRoot, packedFiles(repoRoot), REQUIRED), []);
});

test('planted fault: files field leaves out web/ is reported', () => {
  const problems = audit(['src', 'fixtures']);
  assert.ok(problems.some((p) => p.includes('web/shared/importmap.json')), problems.join('\n'));
  assert.deepEqual(audit(['src', 'web', 'fixtures']), []); // positive control
});

test('planted fault: test/.env with sk-ant-test is reported as env, test/ and key problems', () => {
  const problems = audit(['src', 'web', 'fixtures', 'test'], { 'test/.env': 'KEY=sk-ant-test\n' });
  assert.ok(problems.some((p) => p.includes('.env')), 'env file');
  assert.ok(problems.some((p) => p.includes('test/')), 'test/ file');
  assert.ok(problems.some((p) => p.includes('sk-ant-')), 'key content');
  assert.equal(problems.length, 4); // the three above plus "unexpected file" (test/ is not allowed)
  assert.ok(problems.every((p) => !p.includes('sk-ant-test')), 'must not print matched text');
});

test('planted fault: sk-ant- in an ordinary src file is caught by content alone', () => {
  const problems = audit(['src', 'web', 'fixtures'], { 'src/x.js': "export const k = 'sk-ant-test';\n" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /src\/x\.js/);
});

test('a bare "sk-ant-" prefix check (like src/cli/apikey.js) is not flagged', () => {
  const src = 'export const ok = (k) => { if (!k.startsWith("sk-ant-")) throw new Error("bad"); };\n';
  assert.deepEqual(audit(['src', 'web', 'fixtures'], { 'src/cli/apikey.js': src }), []);
});

test('planted fault: shebang removed or wrong is reported', () => {
  assert.equal(checkShebang('#!/usr/bin/env node\nconsole.log(1)'), null);
  assert.ok(checkShebang('console.log(1)'));
  assert.ok(checkShebang('#!/usr/bin/node\n'));
});

test('real src/cli/index.js starts with the node shebang', () => {
  assert.equal(checkShebang(readFileSync(join(repoRoot, 'src/cli/index.js'), 'utf8')), null);
});

test('planted fault: a stray .playwright-mcp/ folder in files is reported', () => {
  const problems = audit(['src', 'web', 'fixtures', '.playwright-mcp'], { '.playwright-mcp/page.yml': 'x: 1\n' });
  assert.deepEqual(problems, ['unexpected file packed: .playwright-mcp/page.yml']);
});
