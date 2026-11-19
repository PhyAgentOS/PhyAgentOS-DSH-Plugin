English | [中文](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/README_zh.md)

# dsh-PhyAgentOS

DeepSeek Harness (DSH) plugins and tools for installing, running and managing [Forge](https://github.com/PhyAgentOS/forge) skills: Dora dataflows, node artifacts and Gateway Tool APIs.

[User guide](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/usage_en.md) · [Release guide](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/releasing.md) · [npm packages](https://www.npmjs.com/org/x-era) · [GitHub Releases](https://github.com/PhyAgentOS/dsh-PhyAgentOS/releases) · [npm package management — maintainers](https://www.npmjs.com/settings/x-era/packages)

## Packages

All five packages are public on npm and support independent, tag-triggered releases through GitHub Actions trusted publishing.

| Package | Purpose | Installed with the DSH bundle? |
| --- | --- | --- |
| [`@x-era/dsh-forge`](https://www.npmjs.com/package/@x-era/dsh-forge) | DSH bundle and plugin entry point | Yes |
| [`@x-era/dsh-forge-skill`](https://www.npmjs.com/package/@x-era/dsh-forge-skill) | Skill provider, management tools and built-in instructions | Yes, dependency |
| [`@x-era/forge-core`](https://www.npmjs.com/package/@x-era/forge-core) | Manifests, registry, verified installation, runtime and Tool API client | Yes, transitive dependency |
| [`@x-era/forge-cli`](https://www.npmjs.com/package/@x-era/forge-cli) | Standalone `forge` command | No, optional |
| [`@x-era/forge-mcp`](https://www.npmjs.com/package/@x-era/forge-mcp) | MCP stdio server for other agent clients | No, optional |

The npm management page requires an npm account with organization permissions. Public package pages are available to consumers.

## Quick start: DSH Web

Use Node.js **>=24.9.0** for the tested DSH host. If `dsh` is not installed:

```sh
node --version
npm install --global @deepseek-ai/dsh@0.2.2-rc.1
dsh --version
```

Install into the profile you will launch:

```sh
dsh plugin --profile web add @x-era/dsh-forge
dsh web
```

For a DSH source checkout, run these commands in the **deepseek-harness repository**:

```sh
pnpm dsh plugin --profile web add @x-era/dsh-forge
pnpm dsh web
```

`dsh web` selects the `web` profile. Installing with `--profile dev` only affects `dev`; it does not enable the plugin in `web`. Restart an already-running profile after adding the bundle and open a new conversation.

Expected capabilities: `forge-usage`, `forge-skill-development` and `forge_*` management tools. This installs the plugin, not a robot skill, Dora or hardware/model dependencies. See the [user guide](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/usage_en.md) for checks and configuration.

Validation baselines: npm DSH `0.2.2-rc.1`; Web plugin registration also checked with a DSH `0.2.2-rc.2` source checkout.

## Usage examples

In DSH, ask for the operation directly:

| Goal | Example request | Main tool |
| --- | --- | --- |
| Installed skills | “List installed Forge skills and their runtime states.” | `forge_skill_list` |
| Environment | “I just installed the plugin — check whether this machine can run Forge.” | `forge_environment_check` |
| Available skills | “Search the Forge registry for robot simulation skills.” | `forge_skill_search` |
| Choose a profile | “Inspect robot-control-sim and list its profiles and requirements.” | `forge_skill_inspect` after installation |
| Install | “Install robot-control-sim with its nodes and report installation progress.” | `forge_skill_install`, `forge_install_status` |
| Start simulation | “Check robot-control-sim / mujoco-piper, then start it if preflight passes.” | `forge_skill_doctor`, `forge_runtime_start` |
| Read robot state | “Call sim.get_robot_info on the running robot-control-sim skill.” | `forge_tool_call` |
| Stop | “Stop the robot-control-sim runtime and confirm its state.” | `forge_runtime_stop`, `forge_runtime_status` |

The registry currently provides `robot-control-sim` / `mujoco-piper`. Inspect its current requirements and platform support before starting it.

For a shell workflow, install the optional CLI first:

```sh
npm install --global @x-era/forge-cli
forge env
forge search robot
forge list
forge install robot-control-sim --wait
forge inspect robot-control-sim
forge doctor robot-control-sim --profile mujoco-piper
# Continue only if the required binaries, environment and platform checks pass.
forge start robot-control-sim mujoco-piper
forge status robot-control-sim
forge call robot-control-sim sim.get_robot_info
forge stop robot-control-sim
```

CLI output is JSON. Action/session acceptance is not completion: use `forge_invocation_read` in DSH/MCP to check an invocation; do not repeat an action with an unknown result. See [workflow details](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/usage_en.md#run-a-skill).

## Configuration

Set the `forge-skill` row in `$DSH_HOME/profiles/web/cordis.patch.yml` (default home: `~/.dsh`):

```yaml
- id: forge-skill
  config:
    registry:
      url: https://paos-resource-platform.dev.x-era.com
      tokenEnv: DSH_FORGE_REGISTRY_TOKEN
    runtime:
      dora: /path/to/dora
      dora1: /path/to/dora1
```

Replace the executable paths with those required by your skill. `DSH_FORGE_HOME`, `DSH_FORGE_REGISTRY_URL`, `DSH_FORGE_DORA` and `DSH_FORGE_DORA1` provide environment defaults. See [configuration and data](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/usage_en.md#configuration-and-data) for precedence, authenticated registries and the optional console.

## Develop and release

```sh
git clone https://github.com/PhyAgentOS/dsh-PhyAgentOS.git
cd dsh-PhyAgentOS
pnpm install --frozen-lockfile
pnpm test
dsh plugin --profile web add file:/absolute/path/to/dsh-PhyAgentOS/bundle
```

Use the explicit `file:` form and reinstall after rebuilding. The DSH host is a separate project. `DSH_CHECKOUT=/path/to/deepseek-harness pnpm check:dsh` checks the declared upstream API baseline; a changed hash alone does not establish runtime compatibility.

Release one package by updating its own manifest, merging a personal-fork PR into `main`, then creating its matching tag, such as `forge-cli/v0.1.2`. A new remote tag triggers tests, npm publishing and a GitHub Release with the tarball. Upload processing is polled every 15 seconds for up to approximately 15 minutes.

See the [release guide](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/releasing.md) for all five version files, tag naming, OIDC setup, GitHub-page steps and recovery. Maintainers can use [npm package management](https://www.npmjs.com/settings/x-era/packages).

## Documentation

| Guide | English | 中文 |
| --- | --- | --- |
| Installation, usage, CLI/MCP and troubleshooting | [User guide](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/usage_en.md) | [使用手册](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/usage.md) |
| Independent releases, tags and npm authorization | [Release guide](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/releasing.md) | [发布手册](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/releasing_zh.md) |

Additional guides in Chinese: [deployment](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/deployment.md) · [operations](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/operations.md) · [security](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/security.md) · [skill development](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/skill-development.md) · [portability](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/docs/portability.md).

## License

MIT. See [LICENSE](https://github.com/PhyAgentOS/dsh-PhyAgentOS/blob/main/LICENSE).
