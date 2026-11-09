# Releasing ontologizer

Releases publish to npm from GitHub Actions with **trusted publishing**: npm trusts this repository's `release.yml` workflow directly through GitHub's OIDC identity, so **no npm token is ever created or stored** — not in GitHub secrets, not on a laptop. Every release also gets a signed **provenance** statement (proof on npmjs.com of which commit and workflow built it).

Every publish waits for your approval in GitHub before it runs.

## One-time setup

Do these in order. Steps 2 to 4 only work once the package exists on npm.

### 1. First publish (1.0.0), by hand

Trusted publishing can only be configured on a package that already exists, so the very first version goes out from your machine with your 2FA code.

```bash
git clone https://github.com/Graydon-dmg/ontologizer.git && cd ontologizer
git checkout v1.0.0            # or main, at the commit you are releasing
npm ci && npm run check
npm login                      # your npm account, with 2FA
npm publish --access public --provenance=false --otp=<6-digit code>
```

`--provenance=false` is required here: `package.json` asks for provenance, and provenance can only be generated inside CI. Every later release (from the workflow) has provenance.

### 2. npm: add the trusted publisher

Only do this when you are ready to cut the next release within **2 days**: npm expires a new trusted-publisher entry if it has not published within 2 days.

npmjs.com → your avatar → **Packages** → `ontologizer` → **Settings** → **Trusted Publisher** → under **Select your publisher**, choose **GitHub Actions**, and fill in (case-sensitive):

| Field | Value |
|---|---|
| Organization or user | `Graydon-dmg` |
| Repository | `ontologizer` |
| Workflow filename | `release.yml` (file name only, not the path) |
| Environment name | `npm-publish` |
| Allowed actions | tick **npm publish** (new entries default to `npm stage publish` only, which this workflow does not use) |

npm does not validate this when you save; a typo only shows up as an `ENEEDAUTH` error at publish time. To fix an entry, delete it and add it again.

### 3. npm: switch off token publishing

Same **Settings** page → **Publishing access** → **Require two-factor authentication and disallow tokens** → **Update Package Settings**.

After this, no npm token of any kind can publish `ontologizer`. Trusted publishing keeps working (it does not use tokens), and you can still publish by hand with 2FA in an emergency. If you have any old npm automation tokens, revoke them (npmjs.com → avatar → **Access Tokens**).

### 4. GitHub: require your approval

github.com/Graydon-dmg/ontologizer → **Settings** → **Environments** → **New environment** `npm-publish` (if it does not exist yet) → tick **Required reviewers** → add yourself → **Save protection rules**.

Recommended, on the same page: **Deployment branches and tags** → **Selected branches and tags** → add a tag rule `v*.*.*`, so only version tags can ever reach this environment.

### 5. GitHub: social preview image

github.com/Graydon-dmg/ontologizer → **Settings** → **General** → **Social preview** → **Edit** → **Upload an image…** → `docs/brand/social-preview.png` (1280×640).

## Releasing a new version

```bash
git checkout main && git pull
npm version patch          # or: npm version minor  (bumps package.json, commits, tags vX.Y.Z)
git push --follow-tags     # pushes the commit and the tag
```

Then on GitHub → **Actions** → **release** → the waiting run → **Review deployments** → approve `npm-publish`.

The workflow runs two jobs:
1. **verify** (no publish rights): refuses to go on unless the tag is exactly `v` + the `package.json` version, installs exactly the locked dependencies (`npm ci --ignore-scripts`) and runs the full check.
2. **publish** (only after verify passes **and** you approve): checks out the same commit and runs `npm publish --access public --ignore-scripts`; npm attaches provenance automatically. This job installs no dependencies and runs no tests.

**The export bundle.** The package ships `web/dist/embed.js` and `web/dist/embed-3d.js`, built from `web/embed/` by esbuild, a development dependency. `verify` builds them (`npm run check` runs the build first) and uploads `web/dist/` as a short-lived artifact; `publish` downloads it, checks both files are there and non-empty, and packs them. Publish only receives files: it never installs or runs a dependency, so the rule above still holds.

Check the result on npmjs.com: the version page shows a **Provenance** badge linking to the exact commit and workflow run.

### Verifying a release

**Check contents, not the checksum.** CI packs on Linux with its own npm (11.21.x), so the registry tarball's shasum will not match an `npm pack` you run locally: tar metadata and compression differ. Compare the files instead (run from the repository; replace `X.Y.Z`):

```bash
V=X.Y.Z
D=$(mktemp -d) && mkdir "$D/pub" "$D/loc"
(cd "$D/pub" && npm pack "ontologizer@$V" && tar -xzf "ontologizer-$V.tgz")
git archive "v$V" | tar -x -C "$D/loc" && (cd "$D/loc" && npm ci --ignore-scripts && npm pack && tar -xzf "ontologizer-$V.tgz")
diff -r "$D/pub/package" "$D/loc/package" && echo identical
```

Then confirm provenance: `npm view ontologizer@$V dist.attestations` should show `https://slsa.dev/provenance/v1`, and `npm audit signatures` (in a project that has ontologizer installed) should report verified attestations.

Checked on 1.1.0: the shasums differ, all 107 files are identical, and SLSA provenance v1 is present.

**Manual re-run:** Actions → **release** → **Run workflow**, and pick the **tag** (not a branch) in the "Use workflow from" menu. Started from a branch, the run fails at the tag check by design.

## What protects the release

- **No stored credential:** the publish credential is minted per run by npm from GitHub's OIDC token, and only for `Graydon-dmg/ontologizer`, `release.yml`, environment `npm-publish`.
- **Human gate:** the `npm-publish` environment requires your approval for every run.
- **Least privilege:** only the publish job can request an OIDC token (`contents: read`, `id-token: write`); everything else is read-only.
- **Dependency code never meets the token:** tests (which run dependency code) happen in the verify job, which cannot mint a token. The publish job installs no dependencies, and every install and publish runs with `--ignore-scripts`, so no package lifecycle script runs anywhere in CI.
- **Pinned actions:** third-party actions are pinned to full commit hashes, so a moved tag upstream cannot change what runs.
- **Exact npm:** the npm CLI used to publish is pinned to an exact version.
- **No untrusted input:** the workflows never run on `pull_request_target`, and no event text is pasted into a shell script.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `ENEEDAUTH` / "Unable to authenticate" at publish | Trusted-publisher entry does not match exactly (owner, repo, `release.yml`, `npm-publish`), or **npm publish** is not ticked under Allowed actions, or the entry expired (re-create it). |
| Provenance error mentioning the repository | `package.json` `repository.url` must stay `git+https://github.com/Graydon-dmg/ontologizer.git`. |
| "tag … does not match package.json version" | Tag was created by hand. Use `npm version`, or delete the tag and re-tag at the right commit. |
| Run waits forever | Nobody approved the `npm-publish` environment. |
