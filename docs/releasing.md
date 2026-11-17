English | [中文](releasing_zh.md)

# Independent npm releases

A release is identified by **one package tag**, not a repository-wide version.
The root manifest remains private. The release workflow never publishes all five
packages in response to one tag, and manual retries must target an existing tag.

| npm package | Source directory | Tag example |
| --- | --- | --- |
| `@x-era/forge-core` | `packages/core` | `forge-core/v0.1.0` |
| `@x-era/dsh-forge-skill` | `packages/skill` | `dsh-forge-skill/v0.1.0` |
| `@x-era/forge-cli` | `packages/cli` | `forge-cli/v0.1.0` |
| `@x-era/forge-mcp` | `packages/mcp` | `forge-mcp/v0.1.0` |
| `@x-era/dsh-forge` | `bundle` | `dsh-forge/v0.1.0` |

## Initial setup

Use Node.js 24.22.3, npm 11.19.1, pnpm 11.28.5, Git and `gh`. The npm publisher needs a verified
account, 2FA and publish access to the npm `x-era` organization. npm and GitHub
identities/organizations are independent.

```sh
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm org ls x-era --registry=https://registry.npmjs.org
```

Release code must first be merged into upstream `main` through a personal-fork
PR. Verify `gh api user --jq .login` is `mrgh97` before publishing a source branch
and creating that PR. Never create upstream development branches.

## First publication of a new package

A new npm package may need an initial interactive publish before its package
settings can be configured for OIDC. Create the tag locally first, check out its
commit, and publish only the package selected by that tag:

```sh
git fetch origin main
git switch main
git merge --ff-only origin/main
pnpm install --frozen-lockfile
pnpm test

git tag forge-core/v0.1.0
pnpm release:publish forge-core/v0.1.0
```

Complete npm's interactive authentication in the browser/terminal when requested.
After successful publication, push this same tag. Do not move or recreate it:

```sh
git push origin refs/tags/forge-core/v0.1.0
```

The tag workflow rebuilds and compares the registry's source commit and SHA512
against the exact tarball. If both match, it skips npm publication and creates
or completes the GitHub release with that tarball. A mismatch fails; it never
silently overwrites an existing version.

Bootstrap the initial versions in this dependency order, repeating the tag,
`release:publish`, and tag push for each package:

1. `forge-core`
2. `dsh-forge-skill`
3. `forge-cli` and `forge-mcp` (either order)
4. `dsh-forge`

Local development uses `file:` links. `release:prepare` stages five manifests with
exact internal dependency versions, public repository metadata, README and
LICENSE. The release command packs/publishes only the tagged package. If its
staged dependency version is absent from npm, publish that dependency first.
Other packages do not need version bumps merely because one package changes.

## Configure OIDC for every package

In each npm package's Settings → Trusted publishing, add GitHub Actions:

- Organization/user: `PhyAgentOS`
- Repository: `dsh-PhyAgentOS`
- Workflow filename: `publish.yml`
- Environment: blank (the workflow does not use a GitHub environment)
- Allow direct `npm publish`

The workflow uses a GitHub-hosted runner, Node.js 24.22.3, npm 11.19.1 and
`id-token: write`. No `NPM_TOKEN` is required. Complete the first successful
publication using each newly configured trusted publisher within npm's required
validation period (currently two days), or configure it immediately before the
next release. A registry check that skips an already-published version does not
validate the OIDC publisher. See https://docs.npmjs.com/trusted-publishers/.

## Subsequent independent release

Example: change only core from 0.1.0 to 0.1.1 on a new personal-fork PR branch:

```sh
npm pkg set version=0.1.1 --prefix packages/core
pnpm install --lockfile-only
pnpm test
pnpm release:prepare
pnpm release:verify
```

Commit the change and submit/merge the PR through the normal review process.
Then tag the merged commit; do not tag an unmerged development branch:

```sh
git fetch origin main
git switch main
git merge --ff-only origin/main
node -p "require('./packages/core/package.json').version"
git tag forge-core/v0.1.1
git push origin refs/tags/forge-core/v0.1.1
```

Only `@x-era/forge-core@0.1.1` is published. The bundle, skill plugin, CLI and MCP
versions stay unchanged. To ship a consumer against a newer core, bump that
consumer separately and tag it after the required core version is published.
Source manifests in the tagged commit determine the exact staged dependencies;
review them with `pnpm release:prepare` before tagging.

Stable versions publish to `latest`; prereleases (for example
`forge-core/v0.2.0-rc.1`) publish to `next`. Build metadata in tags is rejected.
A stable release cannot move `latest` backwards.

## Verify installation

```sh
npm view @x-era/dsh-forge version dependencies --registry=https://registry.npmjs.org
dsh plugin --profile release-check add @x-era/dsh-forge
dsh --profile release-check --dump-config
dsh --profile release-check
```

Confirm the `forge-skill` row, both built-in skills (`forge-usage` and
`forge-skill-development`) and the `forge_*` tools. Plugin installation alone
does not install Dora or hardware/simulation requirements. Test CLI and MCP
separately if releasing those packages:

```sh
npm exec --yes --package=@x-era/forge-cli -- forge --help
```

## Retry and diagnose

After a successful `npm publish`, the script polls the exact version every
15 seconds for up to approximately 15 minutes while npm processes it. Temporary
404 responses show progress instead of failing the workflow. Once public, the
version must still match the tag's source commit and tarball integrity. Only
404 is retried; registry, network, authentication and integrity errors still fail.
If the wait expires, check npm status and the account's notification email, then
retry the same tag once the version is public. The wait never uploads again.
This behavior applies to future tags containing this script; old tags keep
their original release script when rerun.

```sh
gh run list --repo PhyAgentOS/dsh-PhyAgentOS --workflow publish.yml --limit 10
gh workflow run publish.yml --repo PhyAgentOS/dsh-PhyAgentOS --ref forge-core/v0.1.1
```

A manual dispatch against `main` does not publish. An existing version is accepted
only when its source commit and tarball integrity match the checked-out tag.
Registry/network/authentication failures are not treated as missing packages.
If a version was published with incorrect contents, fix the code and bump the
version. Never force-push a release tag or reuse a published npm version.
