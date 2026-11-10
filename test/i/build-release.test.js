// @ts-check
// The release workflow builds the export bundle in its own `build` job (esbuild only, no tests),
// hands exactly those bytes and their SHA-256s on, and `publish`, which holds the publish token,
// must never install or run a dependency and ships only the bytes build hashed.
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

const HASH_EMBED = /\[ "\$\(sha256sum "?[^"\n]*embed\.js"? \| cut -d' ' -f1\)" = "\$EMBED_SHA256" \]/;
const HASH_3D = /\[ "\$\(sha256sum "?[^"\n]*embed-3d\.js"? \| cut -d' ' -f1\)" = "\$EMBED_3D_SHA256" \]/;
const OUTPUTS_ENV = /EMBED_SHA256: \$\{\{ needs\.build\.outputs\.embed-sha256 \}\}[\s\S]*?EMBED_3D_SHA256: \$\{\{ needs\.build\.outputs\.embed-3d-sha256 \}\}/;

/** @param {string} yml @returns {string[]} */
function releaseProblems(yml) {
  const problems = [];
  const build = job(yml, 'build');
  const verify = job(yml, 'verify');
  const publish = job(yml, 'publish');
  if (!build || !verify || !publish) return ['release.yml needs build, verify and publish jobs'];
  const bld = code(build);
  const ver = code(verify);
  const pub = code(publish);

  // build: no token, builds with build-embed only, hashes, uploads exactly the two files + sums.
  if (/id-token/.test(bld)) problems.push('build can mint a token');
  if (!/permissions:\s*\n\s*contents: read\s*\n/.test(bld)) problems.push('build is not contents: read only');
  if (/npm[ \t]+(?:run|test|pack)\b|scripts\/test\.js/.test(bld)) problems.push('build runs more than the bundle build');
  const buildAt = bld.search(/run: node scripts\/build-embed\.js\s*$/m);
  if (buildAt < 0) problems.push('build does not run node scripts/build-embed.js');
  if (!/embed-sha256: \$\{\{ steps\.hash\.outputs\.embed \}\}/.test(bld) || !/embed-3d-sha256: \$\{\{ steps\.hash\.outputs\.embed3d \}\}/.test(bld)) problems.push('build does not expose the hashes as outputs');
  if (!/sha256sum embed\.js embed-3d\.js > SHA256SUMS/.test(bld)) problems.push('build writes no SHA256SUMS');
  const up = bld.match(/uses:\s*actions\/upload-artifact@[0-9a-f]{40}\b[\s\S]*$/);
  if (!up) problems.push('build does not upload the bundle');
  else {
    const paths = (up[0].match(/path: \|\n((?: {12}\S[^\n]*\n)+)/)?.[1] ?? '').trim().split('\n').map((p) => p.trim().split('/').pop()).sort();
    if (paths.join(' ') !== 'SHA256SUMS embed-3d.js embed.js') problems.push(`build uploads ${paths.join(', ') || 'a directory'}, not exactly the two bundles and SHA256SUMS`);
    if (!/if-no-files-found: error/.test(up[0]) || !/retention-days: 1\b/.test(up[0])) problems.push('build upload is not retention 1 day / if-no-files-found: error');
    if (up.index !== undefined && up.index < buildAt) problems.push('build uploads before building');
  }

  // verify: needs build, no token, tests the downloaded bytes and re-checks them afterwards; uploads nothing.
  if (/id-token/.test(ver)) problems.push('verify can mint a token');
  if (!/needs: build\b/.test(ver)) problems.push('verify does not need build');
  if (/upload-artifact/.test(ver)) problems.push('verify uploads something');
  const vDownload = ver.search(/uses:\s*actions\/download-artifact@[0-9a-f]{40}\b/);
  const checkAt = ver.search(/npm run check\b/);
  if (vDownload < 0 || checkAt < 0 || vDownload > checkAt) problems.push('verify does not download the bundle before npm run check');
  const after = checkAt < 0 ? '' : ver.slice(checkAt);
  if (!HASH_EMBED.test(after) || !HASH_3D.test(after) || !OUTPUTS_ENV.test(after)) problems.push('verify does not re-check the hashes after npm run check');
  if (!/REF_NAME" != "v\$PKG_VERSION"/.test(ver)) problems.push('verify lost the tag == package.json version check');

  // publish: needs both, runs nothing, verifies hashes against build outputs, rejects extra files.
  if (!/needs: \[build, verify\]/.test(pub)) problems.push('publish does not need [build, verify]');
  if (!/environment: npm-publish\b/.test(pub)) problems.push('publish lost the npm-publish environment gate');
  const withoutNpmUpgrade = pub.replace(/npm install -g --ignore-scripts npm@\d+\.\d+\.\d+/g, '');
  const ran = withoutNpmUpgrade.match(/\b(?:npm[ \t]+(?:ci|install|i|run|run-script|test|exec|rebuild|x)\b|npx\b|node[ \t]+scripts\/)/);
  if (ran) problems.push(`publish runs project code: "${ran[0]}"`);
  const publishAt = pub.search(/npm publish\b/);
  if (publishAt < 0) problems.push('publish never runs npm publish');
  else if (!/npm publish[^\n]*--ignore-scripts/.test(pub)) problems.push('npm publish is missing --ignore-scripts');
  const downloadAt = pub.search(/uses:\s*actions\/download-artifact@[0-9a-f]{40}\b/);
  if (downloadAt < 0 || downloadAt > publishAt) problems.push('publish does not download the bundle before npm publish');
  const before = publishAt < 0 ? pub : pub.slice(0, publishAt);
  if (!HASH_EMBED.test(before) || !HASH_3D.test(before) || !OUTPUTS_ENV.test(before)) problems.push('publish does not check the hashes against build before npm publish');
  if (!/ls -A web\/dist \| LC_ALL=C sort \| tr '\\n' ' '\)" = "embed-3d\.js embed\.js " \]/.test(before)) problems.push('publish does not reject extra files in web/dist/');
  if (!/test -s web\/dist\/embed\.js && test -s web\/dist\/embed-3d\.js/.test(before)) problems.push('publish does not check the bundle arrived before npm publish');
  if (!/sha256sum web\/dist\/embed\.js web\/dist\/embed-3d\.js\s*$/m.test(before)) problems.push('publish does not print the hashes it ships');

  // Whole file: every action pinned to a full commit SHA, no pull_request_target.
  for (const m of yml.matchAll(/uses:\s*(\S+)/g)) if (!/@[0-9a-f]{40}$/.test(m[1])) problems.push(`action not pinned to a commit: ${m[1]}`);
  if (/pull_request_target/.test(code(yml))) problems.push('release runs on pull_request_target');
  return problems;
}

test('release.yml: build hashes the bundle; verify tests and re-checks those bytes; publish ships only them, runs nothing', () => {
  assert.deepEqual(releaseProblems(WORKFLOW), []);
});

test('release.yml: only publish holds id-token, and build runs no tests', () => {
  assert.equal((code(WORKFLOW).match(/id-token: write/g) ?? []).length, 1);
  assert.ok(/id-token: write/.test(job(WORKFLOW, 'publish') ?? ''));
});

/** @param {string} yml @param {string} from @param {string} to */
function plant(yml, from, to) {
  const out = yml.replace(from, to);
  assert.notEqual(out, yml, `planted fault did not apply: ${from}`);
  return out;
}

test('planted fault: a publish job that builds the bundle itself is reported', () => {
  const faulty = plant(WORKFLOW, '      - run: npm publish --access public --ignore-scripts',
    '      - run: npm ci --ignore-scripts && npm run build\n\n      - run: npm publish --access public --ignore-scripts');
  assert.ok(releaseProblems(faulty).some((p) => p.startsWith('publish runs project code')), releaseProblems(faulty).join('\n'));
});

test('planted faults: no download, publish without --ignore-scripts, build without upload', () => {
  const pubStart = WORKFLOW.indexOf('  publish:');
  const noDownload = WORKFLOW.slice(0, pubStart) + WORKFLOW.slice(pubStart).replace(/ {6}- uses: actions\/download-artifact@[^\n]*\n(?: {8}[^\n]*\n)*/, '');
  assert.ok(releaseProblems(noDownload).includes('publish does not download the bundle before npm publish'));
  const scripts = plant(WORKFLOW, 'npm publish --access public --ignore-scripts', 'npm publish --access public');
  assert.ok(releaseProblems(scripts).includes('npm publish is missing --ignore-scripts'));
  const noUpload = WORKFLOW.replace(/ {6}- uses: actions\/upload-artifact@[^\n]*\n(?: {8,}[^\n]*\n)*/, '');
  assert.ok(releaseProblems(noUpload).includes('build does not upload the bundle'));
});

test('planted faults: build with a token or running the tests, build uploading all of web/dist/', () => {
  const token = plant(WORKFLOW, '  build:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    permissions:\n      contents: read\n',
    '  build:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    permissions:\n      contents: read\n      id-token: write\n');
  assert.ok(releaseProblems(token).includes('build can mint a token'));
  const tests = plant(WORKFLOW, '      - run: node scripts/build-embed.js\n', '      - run: npm run check\n');
  const p = releaseProblems(tests);
  assert.ok(p.includes('build runs more than the bundle build') && p.includes('build does not run node scripts/build-embed.js'), p.join('\n'));
  const wide = WORKFLOW.replace(/path: \|\n(?: {12}\S[^\n]*\n)+/, 'path: web/dist/\n');
  assert.ok(releaseProblems(wide).some((x) => x.startsWith('build uploads a directory')), releaseProblems(wide).join('\n'));
});

test('planted faults: publish skips the hash check or the extra-file check; verify skips the re-check', () => {
  const pubStart = WORKFLOW.indexOf('  publish:');
  const pubNoHash = WORKFLOW.slice(0, pubStart) + WORKFLOW.slice(pubStart).replace(/ {10}\[ "\$\(sha256sum "\$IN\/embed\.js"[^\n]*\n/, '');
  assert.ok(releaseProblems(pubNoHash).includes('publish does not check the hashes against build before npm publish'));
  const pubExtra = WORKFLOW.slice(0, pubStart) + WORKFLOW.slice(pubStart).replace(/ {10}\[ "\$\(ls -A web\/dist[^\n]*\n/, '');
  assert.ok(releaseProblems(pubExtra).includes('publish does not reject extra files in web/dist/'));
  const noRecheck = WORKFLOW.replace(/ {6}- name: Re-check the bundle after the tests\n(?: {8,}[^\n]*\n)*/, '');
  assert.notEqual(noRecheck, WORKFLOW);
  assert.ok(releaseProblems(noRecheck).includes('verify does not re-check the hashes after npm run check'));
  const pubUnpinned = plant(WORKFLOW, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/checkout@v7');
  assert.ok(releaseProblems(pubUnpinned).some((x) => x.startsWith('action not pinned')));
});
