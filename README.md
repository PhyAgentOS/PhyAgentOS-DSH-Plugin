English | [中文](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/README_zh.md)

# dsh-PhyAgentOS

DeepSeek Harness (DSH) plugins and tools for installing, running and managing
[Forge](https://github.com/PhyAgentOS/forge) skills. A skill combines a Dora
dataflow, node artifacts and Gateway Tool APIs.

| Package | Purpose |
| --- | --- |
| `@x-era/forge-core` | Host-neutral manifests, registry, verified installation, node storage, runtime and Tool API client |
| `@x-era/dsh-forge-skill` | DSH skill provider, management tools, configuration UI and built-in usage/development skills |
| `@x-era/forge-cli` | `forge` shell command sharing the same home and state |
| `@x-era/forge-mcp` | MCP stdio server exposing management and forwarding tools |
| `@x-era/dsh-forge` | Installable DSH bundle that mounts the plugin |

## Install

Use a supported DSH installation. The plugin packages require Node.js >=22;
this repository's release workflow uses Node.js 24 and pnpm 11.28.5.

```sh
dsh plugin --profile dev add @x-era/dsh-forge
dsh --profile dev --dump-config
dsh --profile dev
```

Restart an already-running profile after installing the bundle. The composition
should contain `forge-skill`; the running host should expose `forge-usage`,
`forge-skill-development` and `forge_*` tools. The `dev` profile name is arbitrary.
The CLI and MCP server are separate packages; installing the DSH bundle does not
install global commands or the Dora runtime.

```sh
npm install --global @x-era/forge-cli
forge search robot
```

## Capabilities

- Search, install, update and remove registry skills with digest/size validation,
  resumable downloads and asynchronous installation of large node artifacts.
- Preflight, materialization, Dora lifecycle, Gateway readiness and state reconciliation.
- Forge 1 (Dora 0.4.x) and Forge 2 (Dora 1.x), with coordinator and isolated run modes.
- Environment injection, invocation polling/cancellation, diagnostics and structured logs.
- Built-in agent instructions for skill use and development.

## Configuration

Configure the `forge-skill` row in `$DSH_HOME/profiles/<name>/cordis.patch.yml`:

```yaml
- id: forge-skill
  config:
    home: ~/.dsh/forge
    registry:
      url: https://paos-resource-platform.dev.x-era.com
    runtime:
      dora: /path/to/dora
      dora1: /path/to/dora1
```

`DSH_FORGE_HOME`, `DSH_FORGE_DORA` and `DSH_FORGE_DORA1` can supply paths.
Use a reachable registry for your deployment and install the appropriate Dora
CLI and skill-specific hardware/simulation prerequisites before starting a skill.

## Develop from source

```sh
git clone https://github.com/PhyAgentOS/dsh-PhyAgentOS.git
cd dsh-PhyAgentOS
pnpm install --frozen-lockfile
pnpm test
dsh plugin --profile dev add file:/absolute/path/to/dsh-PhyAgentOS/bundle
```

Use the explicit `file:` form on DSH 0.2.2-rc.1 so the installed package uses
the profile resolver for host-provided peers. Reinstall after rebuilding source.
The repository does not include the DSH host. Compatibility baseline:
`compat/dsh-baseline.json`. `DSH_CHECKOUT=/path/to/deepseek-harness pnpm check:dsh`
detects changes in upstream interfaces; update the baseline only after reviewing
the change and validating a real host. A hash change alone does not establish
runtime incompatibility or compatibility.

## Release

Each package has an independent version and Git tag. For example,
`forge-core/v0.1.0` publishes only core; `dsh-forge/v0.1.0` publishes only the bundle.
Stable versions use npm `latest`; prereleases use `next`. Release checks require
an exact tag checkout, a clean working tree, a matching manifest and published
internal dependencies. The npm tarball records its source commit.
After npm accepts an upload, the release waits up to approximately 15 minutes
for public metadata instead of failing on a temporary 404.

See the [release guide](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/releasing.md)
for bootstrap, OIDC, independent releases and safe retry instructions.

## Documentation

The existing detailed guides are in Chinese:
[usage](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/usage.md),
[deployment](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/deployment.md),
[operations](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/operations.md),
[security](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/security.md),
[skill development](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/skill-development.md).

## License

MIT. Published packages include `LICENSE`.
