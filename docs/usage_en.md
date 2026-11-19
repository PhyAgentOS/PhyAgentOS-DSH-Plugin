English | [中文](usage.md) · [README](../README.md) · [Release guide](releasing.md)

# Forge Skill user guide

Use the published packages through DSH, the standalone `forge` CLI or MCP.

## Installation and terminology

| Name | Meaning |
| --- | --- |
| DSH profile | Host configuration such as `web` or `dev`; selects enabled plugins |
| Forge skill | Registry-installed bundle containing a manifest, instructions, deployment profiles and locked artifacts |
| Forge skill profile | Deployment choice inside a skill, such as `robot-control-sim` / `mujoco-piper` |
| Runtime | Running Dora dataflow and Gateway for one skill/profile |
| Invocation | Identifier returned when a Gateway accepts an action/session |

Plugin enablement is specific to a DSH profile. Installing into `dev` does not enable the plugin in `web`. Forge data defaults to `$DSH_HOME/forge` and is not automatically separated by DSH profile.

The DSH bundle installs `@x-era/dsh-forge-skill` and `@x-era/forge-core`. The standalone CLI, MCP server, DSH host, Dora and skill-specific artifacts/model requirements are separate installations.

## Install the DSH plugin

The validated npm DSH host is `0.2.2-rc.1`, requiring Node.js >=24.9.0. Standalone CLI/MCP packages declare Node.js >=22.

```sh
node --version
npm install --global @deepseek-ai/dsh@0.2.2-rc.1
dsh --version
dsh plugin --profile web add @x-era/dsh-forge
dsh web
```

For a source-built host, run inside the `deepseek-harness` repository:

```sh
pnpm dsh plugin --profile web add @x-era/dsh-forge
pnpm dsh web
```

For a custom `dev` profile, install with `--profile dev` and launch `dsh --profile dev`. That name is not an alias for Web mode.

After adding the bundle, restart the existing host, refresh the page and open a new conversation. Verify both configuration and runtime registration:

1. `dsh web --dump-config` should contain `id: forge-skill`; use `pnpm dsh web --dump-config` for a source host.
2. Check for `forge-usage`, `forge-skill-development` and tools such as `forge_skill_list`. A configuration row alone does not confirm successful module loading; inspect terminal import/dependency errors.

Configure the model according to DSH's own instructions before model conversations. Installation and tool-registration checks do not require robot or model calls.

## Use through conversation

| Goal | Example request | Tools |
| --- | --- | --- |
| Installed skills | List installed Forge skills and their runtime states. | `forge_skill_list` |
| Registry discovery | Search installable robot simulation skills and show their returned profiles. | `forge_skill_search` |
| Install | Install robot-control-sim and its nodes, then report installation progress. | `forge_skill_install`, `forge_install_status` |
| Inspect and diagnose | Inspect robot-control-sim, read its documentation and diagnose mujoco-piper. | `forge_skill_inspect`, `forge_skill_docs`, `forge_skill_doctor` |
| Environment | Just installed the plugin: check whether this machine can run Forge (dora/dora1, Node, Python, data root, disk, registry, ports). | `forge_environment_check` |
| Start | Start robot-control-sim / mujoco-piper after preflight succeeds and confirm readiness. | `forge_runtime_start`, `forge_runtime_status` |
| Query | Call sim.get_robot_info on the running skill to read joints and limits. | `forge_tool_context`, `forge_tool_call` |
| Stop | Stop robot-control-sim and confirm its final state. | `forge_runtime_stop` |

The two built-in skills are agent instructions, not downloaded robot runtimes. An empty `forge_skill_list` is expected before installation; use `forge_skill_search` for registry discovery.

## Run a skill

This example uses the registry's `robot-control-sim` skill and `mujoco-piper` simulation profile. Current manifests and diagnostics determine the required binaries, model assets, environment and platform support.

Install the optional CLI separately:

```sh
npm install --global @x-era/forge-cli
forge --help
forge search robot
forge list
forge versions robot-control-sim
forge install robot-control-sim --wait
forge inspect robot-control-sim
forge doctor robot-control-sim --profile mujoco-piper
```

Continue only after binary, platform, environment and port checks pass:

```sh
forge start robot-control-sim mujoco-piper
forge status robot-control-sim
forge call robot-control-sim sim.get_robot_info
forge logs robot-control-sim 120
forge stop robot-control-sim
```

- The default `start` mode uses a coordinator: `dora up` and `dora start --detach`.
- `forge start <name> <profile> --run` uses an isolated `dora run` process.
- The manifest's `forge_version` selects `dora` or `dora1` independently of launch mode.
- One skill has one active runtime; a Gateway address already in use prevents another start.
- Real-hardware profiles require device connectivity, calibration, deployment environment and emergency-stop checks first.

Gateway queries usually return synchronously. Actions/sessions can return an invocation id before completion. Call `forge_invocation_read` in DSH/MCP with `name` and `invocation_id` to inspect status and result. Acceptance or timeout does not establish failure; do not repeat an unknown action.

The CLI currently has no `forge call --status`, `--result` or `--cancel` form. `forge cancel <job-id>` cancels installation jobs, not robot actions. Use the particular Gateway's cancellation/stop protocol and reconcile the final state when cancelling an action.

## Common CLI operations

CLI output is JSON by default; no `--json` flag is needed.

| Operation | Command |
| --- | --- |
| Inspect, versions and docs | `forge inspect <name>`, `forge versions <name>`, `forge docs <name> [file]` |
| Install a version | `forge install <name> --version <version> --wait` |
| Read/cancel installation jobs | `forge jobs`, `forge job <id>`, `forge cancel <id>` |
| Check/apply updates | `forge update <name>`, `forge update <name> --apply` |
| List profile files | `forge files <name> [profile]` |
| Read/write a profile file | `forge file-read <name> <profile> <file>`, `forge file-write <name> <profile> <file>` (new content on stdin) |
| Diagnose | `forge doctor <name> --profile <profile>` |
| Environment check (run right after installing) | `forge env [--offline]` |
| Export a diagnostic report | `forge report [name]` |
| Inspect/collect unused artifacts | `forge cache summary`, `forge cache gc --dry-run`, `forge cache gc` |
| Export a portable skill | `forge export <name> --out <directory>` |
| Remove a stopped skill | `forge remove <name>` |

Use `--wait` for CLI installation and inspect the final job result. DSH/MCP installations return a job id; use `forge_install_status` to monitor and `forge_install_cancel` to cancel installation.

Profile writes validate formats, create backups and return differences. Follow the returned restart guidance for the affected runtime.

## Configuration and data

The default profile patch is `~/.dsh/profiles/web/cordis.patch.yml`, or `$DSH_HOME/profiles/web/cordis.patch.yml` for a custom home.

```yaml
- id: forge-skill
  config:
    registry:
      url: https://paos-resource-platform.dev.x-era.com
      tokenEnv: DSH_FORGE_REGISTRY_TOKEN
    runtime:
      dora: /path/to/dora
      dora1: /path/to/dora1
    gateway:
      dynamic: off
```

Use valid executable paths required by your skill. Data-root precedence: row `home` → `DSH_FORGE_HOME` → `$DSH_HOME/forge` → `~/.dsh/forge`. Set the same `DSH_FORGE_HOME` for CLI/MCP and DSH when sharing data; CLI/MCP do not read custom values from the DSH profile row.

Registry configuration supports `DSH_FORGE_REGISTRY_URL`, `registry.token` or a Bearer token from `registry.tokenEnv` (default: `DSH_FORGE_REGISTRY_TOKEN`). CLI/MCP use environment variables for registry configuration. Keep real credentials out of public repositories.

`DSH_FORGE_DORA` and `DSH_FORGE_DORA1` provide executable defaults. Deployment `profile.environment` and host-supplied `required_environment` values are injected into runtime nodes.

The generic `forge_tool_call` tool is available by default. Typed Gateway tools require `gateway.dynamic` set to `whitelist` or `all` and are registered after runtime readiness.

### Configuration API and optional console

With the default `ui.enabled: true`, the plugin mounts a same-origin `/forge/api` configuration API on DSH Web. Tool and skill registration does not require a standalone console or imply an additional Forge navigation item in the Web interface.

The separate local console is disabled by default. Enable it when needed:

```yaml
- id: forge-skill
  config:
    ui:
      enabled: true
      standalone: true
      port: 19080
```

After reloading, open `http://127.0.0.1:19080/`. This is separate from the DSH Web port. The console can write/restore configuration and has no separate authentication; keep it accessible only locally. More fields: [deployment guide (中文)](deployment.md).

## MCP integration

Install the server separately, then configure a stdio-capable MCP client to launch `forge-mcp`:

```sh
npm install --global @x-era/forge-mcp
```

Set the same `DSH_FORGE_HOME` in the client environment when sharing skills with DSH. The MCP server does not install DSH or automatically start a skill runtime.

## Trust and hardware

Skills execute node binaries delivered by the registry. Install only from trusted sources; digest/size checks verify the locked artifact and do not establish publisher trust. Check calibration, joint limits and emergency-stop procedures before hardware use, and reconcile unknown action outcomes. Supply credentials through the host environment. See the [security guide (Chinese)](security.md).

## Troubleshooting and upgrades

| Symptom | Check |
| --- | --- |
| `dsh: command not found` | Install the DSH host; verify Node and the global npm executable directory in PATH |
| `forge: command not found` | Install `@x-era/forge-cli`; the DSH bundle does not install a global CLI |
| Forge absent in Web | Install into `web`, restart that host and open a new conversation; inspect import failures |
| Empty installed list | `forge list` shows installed skills; `forge search` searches the registry |
| Missing/incompatible nodes | Inspect the manifest, platform artifacts and `forge doctor <name> --profile <profile>` |
| Gateway unavailable/port occupied | Check `forge status <name>` and `forge logs <name>`; identify an existing runtime before stopping it |
| Unknown action outcome | Reconcile with `forge_invocation_read`; retain the invocation id and do not resubmit |
| Diagnostic report | Use `forge report [name]`, not `forge doctor --report` |

Upgrade or remove the plugin in the same DSH profile:

```sh
dsh plugin --profile web add @x-era/dsh-forge@latest
# Restart that host; stop skill runtimes that are still in use first.
dsh plugin --profile web remove @x-era/dsh-forge
```

Plugin upgrades and skill updates are separate: `forge update <name> --apply` updates a registry skill, not the npm plugin. Uninstallation retains the data directory. MCP clients can separately install `@x-era/forge-mcp` and launch `forge-mcp` over stdio; it uses the same capability layer as DSH management tools.

For tags, publishing and npm permissions, see the [release guide](releasing.md). The [npm management page](https://www.npmjs.com/settings/x-era/packages) requires organization access.
