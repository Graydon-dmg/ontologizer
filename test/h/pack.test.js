// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED, REQUIRED_DIRS, packedFiles, auditPack, checkShebang, checkLicense } from './pack.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const LEGAL = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'TRADEMARKS.md'];
/** Build a throwaway package (legal files listed in `files` unless legal: false), audit it, clean up. */
function audit(/** @type {string[]} */ files, /** @type {Record<string, string>} */ extra = {}, { legal = true } = {}) {
  if (legal) files = [...files, ...LEGAL];
  const dir = mkdtempSync(join(tmpdir(), 'h-fault-'));
  try {
    const layout = {
      'package.json': JSON.stringify({ name: 'h-fault', version: '0.0.0', files }),
      'src/cli/index.js': '#!/usr/bin/env node\n',
      'web/shared/importmap.json': '{}\n',
      'web/index.html': '<!doctype html>\n',
      'fixtures/demo.events.jsonl': '{}\n',
      'LICENSE': 'MIT License\n', 'THIRD_PARTY_NOTICES.md': '# t\n', 'TRADEMARKS.md': '# t\n',
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
  assert.deepEqual(auditPack(repoRoot, packedFiles(repoRoot), REQUIRED, REQUIRED_DIRS), []);
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

test('planted fault: the dev harness and internal .md docs are reported', () => {
  const extra = { 'web/dev/index.html': '<!doctype html>\n', 'web/shell/API.md': '# api\n' };
  assert.deepEqual(audit(['src', 'web', 'fixtures'], extra).sort(),
    ['dev harness packed: web/dev/index.html', 'internal doc packed: web/shell/API.md']);
  assert.deepEqual(audit(['src', 'web', '!web/dev', '!web/shell/API.md', 'fixtures'], extra), []); // the real files field's negations work
});

test('planted fault: brand assets left out, or docs/brand shipped, are reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-brand-'));
  const write = (/** @type {string} */ p, /** @type {string} */ t) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), t); };
  try {
    write('web/shared/brand/mark.svg', '<svg/>\n');
    write('docs/brand/lockup.svg', '<svg/>\n');
    write('src/cli/index.js', '#!/usr/bin/env node\n');
    const run = (/** @type {string[]} */ files) => {
      write('package.json', JSON.stringify({ name: 'h-brand', version: '0.0.0', files }));
      return auditPack(dir, packedFiles(dir), [], REQUIRED_DIRS);
    };
    assert.deepEqual(run(['src', 'web']), []); // positive control: brand ships, docs/brand does not
    assert.deepEqual(run(['src', 'web', '!web/shared/brand']), ['missing required folder: web/shared/brand/']);
    assert.deepEqual(run(['src', 'web', 'docs']), ['unexpected file packed: docs/brand/lockup.svg']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legal files at the top level are allowed; other .md files still are not', () => {
  const extra = { 'THIRD_PARTY_NOTICES.md': '# Third-party notices\n', 'TRADEMARKS.md': '# Trademarks\n', 'NOTES.md': '# notes\n' };
  const problems = audit(['src', 'web', 'fixtures', 'NOTES.md'], extra);
  assert.deepEqual(problems.sort(), ['internal doc packed: NOTES.md', 'unexpected file packed: NOTES.md']);
});

test('planted fault: a leftover Apache NOTICE file in the package is reported', () => {
  const problems = audit(['src', 'web', 'fixtures', 'NOTICE'], { 'NOTICE': 'Ontologizer\n' });
  assert.deepEqual(problems, ['unexpected file packed: NOTICE']);
});

test('the real package is MIT in both package.json and LICENSE', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.deepEqual(checkLicense(pkg, readFileSync(join(repoRoot, 'LICENSE'), 'utf8')), []);
});

test('planted faults: Apache license field, Apache LICENSE text, legal file left out of the package', () => {
  const mit = 'MIT License\n\nCopyright (c) 2026 Graydon Garden\n';
  const apache = '\n                                 Apache License\n                           Version 2.0, January 2004\n';
  assert.deepEqual(checkLicense({ license: 'MIT' }, mit), []); // positive control
  assert.equal(checkLicense({ license: 'Apache-2.0' }, mit).length, 1);
  assert.equal(checkLicense({ license: 'MIT' }, apache).length, 1);
  const problems = audit(['src', 'web', 'fixtures', 'LICENSE', 'TRADEMARKS.md'], {}, { legal: false }); // THIRD_PARTY_NOTICES.md left out
  assert.ok(problems.includes('missing required file: THIRD_PARTY_NOTICES.md'), problems.join('\n'));
});

test('planted fault: an uploaded image or chat log under fixtures/ is reported', () => {
  const problems = audit(['src', 'web', 'fixtures'], { 'fixtures/paste-1.png': 'png\n', 'fixtures/demo.chat.jsonl': '{}\n' });
  assert.deepEqual(problems.sort(), ['non-fixture file in fixtures/: fixtures/demo.chat.jsonl', 'non-fixture file in fixtures/: fixtures/paste-1.png']);
});
