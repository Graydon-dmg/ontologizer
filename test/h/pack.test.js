// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
  const problems = audit(['src']);
  assert.ok(problems.some((p) => p.includes('web/shared/importmap.json')), problems.join('\n'));
  assert.deepEqual(audit(['src', 'web']), []); // positive control
});

test('planted fault: test/.env with sk-ant-test gives three separate problems', () => {
  const problems = audit(['src', 'web', 'test'], { 'test/.env': 'KEY=sk-ant-test\n' });
  assert.ok(problems.some((p) => p.includes('.env')), 'env file');
  assert.ok(problems.some((p) => p.includes('test/')), 'test/ file');
  assert.ok(problems.some((p) => p.includes('sk-ant-')), 'key content');
  assert.equal(problems.length, 3);
  assert.ok(problems.every((p) => !p.includes('sk-ant-test')), 'must not print matched text');
});

test('planted fault: sk-ant- in an ordinary src file is caught by content alone', () => {
  const problems = audit(['src', 'web'], { 'src/x.js': "export const k = 'sk-ant-test';\n" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /src\/x\.js/);
});

test('a bare "sk-ant-" prefix check (like src/cli/apikey.js) is not flagged', () => {
  const src = 'export const ok = (k) => { if (!k.startsWith("sk-ant-")) throw new Error("bad"); };\n';
  assert.deepEqual(audit(['src', 'web'], { 'src/cli/apikey.js': src }), []);
});

test('planted fault: shebang removed or wrong is reported', () => {
  assert.equal(checkShebang('#!/usr/bin/env node\nconsole.log(1)'), null);
  assert.ok(checkShebang('console.log(1)'));
  assert.ok(checkShebang('#!/usr/bin/node\n'));
});

// The lead adds the real check here when Epic B lands: checkShebang(readFileSync('src/cli/index.js', 'utf8')) === null.
