// @ts-check
// The release workflow builds the export bundle in `verify` and only hands the files to `publish`,
// which holds the publish token and must never install or run a dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const WORKFLOW = fs.readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');

/** The text of one job (from `  <name>:` to the next job or the end). @param {string} yml @param {string} name */
function job(yml, name) {
  const start = yml.search(new RegExp(`^  ${name}:\\s*$`, 'm'));
  if (start < 0) return null;
  const rest = yml.slice(start + 1);
  const next = rest.search(/^ {2}[a-z][\w-]*:\s*$/m);
  return next < 0 ? yml.slice(start) : yml.slice(start, start + 1 + next);
}

/** Commands only (comments dropped). @param {string} text */
const code = (text) => text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');

/** @param {string} yml @returns {string[]} */
function releaseProblems(yml) {
  const problems = [];
  const verify = job(yml, 'verify');
  const publish = job(yml, 'publish');
  if (!verify || !publish) return ['release.yml has no verify or publish job'];
  const pub = code(publish);
  // The one allowed npm install: upgrading npm itself, exact version, no scripts.
  const withoutNpmUpgrade = pub.replace(/npm install -g --ignore-scripts npm@\d+\.\d+\.\d+/g, '');
  const ran = withoutNpmUpgrade.match(/\b(?:npm[ \t]+(?:ci|install|i|run|run-script|test|exec|rebuild|x)\b|npx\b|node[ \t]+scripts\/)/);
  if (ran) problems.push(`publish runs project code: "${ran[0]}"`);
  const publishAt = pub.search(/npm publish\b/);
  if (publishAt < 0) problems.push('publish never runs npm publish');
  else if (!/npm publish[^\n]*--ignore-scripts/.test(pub)) problems.push('npm publish is missing --ignore-scripts');
  const downloadAt = pub.search(/uses:\s*actions\/download-artifact@[0-9a-f]{40}\b/);
  if (downloadAt < 0 || downloadAt > publishAt) problems.push('publish does not download the bundle before npm publish');
  const guardAt = pub.search(/test -s web\/dist\/embed\.js && test -s web\/dist\/embed-3d\.js/);
  if (guardAt < 0 || guardAt > publishAt || guardAt < downloadAt) problems.push('publish does not check the bundle arrived before npm publish');
  const ver = code(verify);
  const checkAt = ver.search(/npm run check\b/);
  const uploadAt = ver.search(/uses:\s*actions\/upload-artifact@[0-9a-f]{40}\b[\s\S]*?path:\s*web\/dist\//);
  if (uploadAt < 0 || uploadAt < checkAt) problems.push('verify does not upload web/dist/ after npm run check');
  if (/id-token/.test(ver)) problems.push('verify can mint a token');
  return problems;
}

test('release.yml: verify builds and uploads the bundle; publish only downloads it, runs nothing, keeps --ignore-scripts', () => {
  assert.deepEqual(releaseProblems(WORKFLOW), []);
});

test('planted fault: a publish job that builds the bundle itself is reported', () => {
  const faulty = WORKFLOW.replace('      - run: npm publish --access public --ignore-scripts',
    '      - run: npm ci --ignore-scripts && npm run build\n\n      - run: npm publish --access public --ignore-scripts');
  assert.notEqual(faulty, WORKFLOW);
  assert.ok(releaseProblems(faulty).some((p) => p.startsWith('publish runs project code')), releaseProblems(faulty).join('\n'));
  const build = WORKFLOW.replace('      - run: npm publish --access public --ignore-scripts', '      - run: npm run build\n      - run: npm publish --access public --ignore-scripts');
  assert.ok(releaseProblems(build).length > 0);
});

test('planted faults: no download, publish without --ignore-scripts, no upload', () => {
  const noDownload = WORKFLOW.replace(/ {6}- uses: actions\/download-artifact@[^\n]*\n(?: {8}[^\n]*\n)*/, '');
  assert.ok(releaseProblems(noDownload).includes('publish does not download the bundle before npm publish'));
  const scripts = WORKFLOW.replace('npm publish --access public --ignore-scripts', 'npm publish --access public');
  assert.ok(releaseProblems(scripts).includes('npm publish is missing --ignore-scripts'));
  const noUpload = WORKFLOW.replace(/ {6}- uses: actions\/upload-artifact@[^\n]*\n(?: {8}[^\n]*\n)*/, '');
  assert.ok(releaseProblems(noUpload).includes('verify does not upload web/dist/ after npm run check'));
});
