English | [中文](releasing_zh.md) · [README](../README.md) · [User guide](usage_en.md)

# Independent npm releases

[Publish workflow](../.github/workflows/publish.yml) · [Actions](https://github.com/PhyAgentOS/dsh-PhyAgentOS/actions/workflows/publish.yml) · [GitHub Releases](https://github.com/PhyAgentOS/dsh-PhyAgentOS/releases) · [npm package management](https://www.npmjs.com/settings/x-era/packages)

## Current setup and version files

All five public packages have completed a real GitHub Actions OIDC publication. Routine releases use trusted publishing without a local npm login or an `NPM_TOKEN`. Changing npm trust settings or introducing a new package requires separate setup.

One tag releases one package. The root `package.json` remains private; generated files under `dist/publish` are not version sources.

| npm package | Edit this version field | Release tag |
| --- | --- | --- |
| [`@x-era/forge-core`](https://www.npmjs.com/package/@x-era/forge-core) | [packages/core/package.json](../packages/core/package.json) | `forge-core/v<version>` |
| [`@x-era/dsh-forge-skill`](https://www.npmjs.com/package/@x-era/dsh-forge-skill) | [packages/skill/package.json](../packages/skill/package.json) | `dsh-forge-skill/v<version>` |
| [`@x-era/forge-cli`](https://www.npmjs.com/package/@x-era/forge-cli) | [packages/cli/package.json](../packages/cli/package.json) | `forge-cli/v<version>` |
| [`@x-era/forge-mcp`](https://www.npmjs.com/package/@x-era/forge-mcp) | [packages/mcp/package.json](../packages/mcp/package.json) | `forge-mcp/v<version>` |
| [`@x-era/dsh-forge`](https://www.npmjs.com/package/@x-era/dsh-forge) | [bundle/package.json](../bundle/package.json) | `dsh-forge/v<version>` |

The npm management link requires an organization-authorized account; public package pages work for consumers.

## Routine release

Use the workflow toolchain: Node.js 24.22.3, npm 11.19.1 and pnpm 11.28.5.

### 1. Update only the target package

Example: release a future CLI `0.1.2`. Confirm that the version is unused before selecting it.

```sh
git switch -c fix/release-forge-cli-0.1.2
npm pkg set version=0.1.2 --prefix packages/cli
pnpm install --lockfile-only
pnpm test
pnpm release:prepare
pnpm release:verify
```

Review the staged manifest under `dist/publish/@x-era/forge-cli/package.json`. Source `file:` dependencies are rewritten to the exact versions in the current source manifests. Those versions must already be public on npm.

Publish dependencies before consumers: core → skill adapter → bundle; CLI and MCP depend on core and can release independently of each other. A release does not require unrelated package version bumps.

### 2. Merge through a personal-fork PR

Before publishing the source branch and again before creating the PR:

```sh
gh api user --jq .login
```

Verify the intended account (the current maintainer default is `mrgh97`); keep Git author/committer identities consistent. Use a `feature/`, `fix/` or `docs/` branch in a personal fork, not a development branch in the upstream repository. Merge into `main` after checks pass.

### 3. Create the exact package tag on merged main

```sh
git fetch origin main
git switch main
git merge --ff-only origin/main
node -p "require('./packages/cli/package.json').version"
git tag forge-cli/v0.1.2
git push origin refs/tags/forge-cli/v0.1.2
```

Run the tagging commands only when the printed version is `0.1.2`. Here `origin` is the upstream `PhyAgentOS/dsh-PhyAgentOS` repository. A local tag alone does not trigger Actions; the new remote tag does. A PR merge or ordinary main push does not publish.

The workflow checks the exact tag checkout, clean source tree, package version, repository metadata and ancestry in `origin/main`, then tests and publishes only that package. Stable versions use `latest`; prereleases such as `forge-cli/v0.2.0-rc.1` use `next`. Build metadata is rejected, and stable publication cannot move `latest` backwards.

### Alternative: create the tag on GitHub

In the upstream repository, choose Releases → Draft a new release → Choose a tag → Create new tag. Enter the full package tag (for example `forge-cli/v0.1.2`), select the merged `main` target and publish the release.

Creating a new tag triggers the same push workflow. Adding a release to an existing tag does not emit another tag push; saving a draft is not the completed publication step.

### 4. Verify publication

Check [Actions](https://github.com/PhyAgentOS/dsh-PhyAgentOS/actions/workflows/publish.yml), then inspect the exact npm version:

```sh
npm view @x-era/forge-cli@0.1.2 version gitHead dist.integrity _npmUser --json --prefer-online --registry=https://registry.npmjs.org
gh release view forge-cli/v0.1.2 --repo PhyAgentOS/dsh-PhyAgentOS
```

A successful workflow creates or completes the GitHub Release and attaches the exact npm tarball. For an OIDC release, npm records GitHub Actions as its trusted publisher. Validate consumers through actual npm installation; see the [user guide](usage_en.md).

## npm trusted publisher settings

For each package, open npm package Settings → Trusted publishing → GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `PhyAgentOS` |
| Repository | `dsh-PhyAgentOS` |
| Workflow filename | `publish.yml` (filename only) |
| Environment | Blank; this workflow does not declare an environment |
| Allow direct npm publish | Enabled |

The job uses a GitHub-hosted runner and `id-token: write`; no long-lived publish token is required. A newly configured publisher must perform a real successful publication within two days. Skipping an already-published version does not validate it. npm does not validate field correctness on save; the actual publish is the check. [Official npm documentation](https://docs.npmjs.com/trusted-publishers/).

For several package configurations, npm can offer a five-minute 2FA skip window on the verification page. Complete each fresh challenge promptly; npm processing can outlast that verification window.

## First publication of a new package

This is not needed for routine releases of the existing five packages. For a newly introduced package, add its source mapping and tag trigger to the release scripts/workflow first and merge those changes.

An initial interactive npm publication may be needed before the package settings exist:

1. Select an unpublished version and create its local tag at the merged commit.
2. Check out that exact tag; keep the worktree clean.
3. Run `pnpm release:publish <package-id>/v<version>`.
4. Open the newly generated npm verification URL in the browser signed into the correct npm account. CLI login and browser login are separate.
5. Wait for the script to verify public metadata and integrity; configure that package's trusted publisher.
6. Publish a subsequent version through its tag to validate OIDC, as done for the existing packages.

An initial upload already fixes that version's source commit and bytes. Do not repoint its tag. Rebuilding the same tag in another environment can change compressed bytes; existing-version retries require exact SHA512 equality and must not bypass a mismatch.

## Waiting, retries and diagnostics

After npm accepts an upload, the script checks that exact version every 15 seconds for up to approximately 15 minutes. A temporary 404 prints progress instead of immediately failing; waiting does not upload again. Public metadata must still match the source commit and tarball SHA512.

Only 404 is retried. Authentication, network, other registry errors, content mismatches and expiry of the wait remain failures. If waiting expires, inspect npm service status and notification email; 404 alone does not distinguish ongoing scanning from a rejected version.

```sh
gh run list --repo PhyAgentOS/dsh-PhyAgentOS --workflow publish.yml --limit 10
gh workflow run publish.yml --repo PhyAgentOS/dsh-PhyAgentOS --ref forge-cli/v0.1.2
```

A manual dispatch must select an existing release tag, not `main`. Existing versions are skipped only when source and tarball bytes match. Old tags run their original scripts and do not acquire later fixes.

| Failure | Action |
| --- | --- |
| `Check out the exact release tag` | Check `git rev-parse HEAD` and `git rev-parse '<tag>^{commit}'`; check out the tag for a retry |
| Tag/manifest mismatch | Update the package through a PR before creating a new matching tag |
| `Publish dependency first` | Publish the exact staged dependency version and wait until public |
| `Pending validation` on npm | Perform an actual OIDC publish of a new version within the stated deadline |
| npm authorization failure | Check owner, repository, filename, environment and direct-publish permission |
| `different source or bytes` | Check source/toolchain/packaging environment; never overwrite the existing version |
| npm CLI link expired | Reissue the appropriate operation for a fresh verification link |

Do not force-push published release tags or reuse published npm versions. If a published version needs changes, fix the source and release a new version through CI.
