[English](usage_en.md) | 中文 · [README](../README_zh.md) · [发布手册](releasing_zh.md)

# Forge Skill 使用手册

适用于通过 DSH、独立 `forge` CLI 或 MCP 使用已发布 npm 包的用户。

## 安装入口与概念

| 名称 | 含义 |
| --- | --- |
| DSH profile | 宿主配置，如 `web`、`dev`；决定当前宿主启用哪些插件 |
| Forge skill | 从资源 registry 安装的技能包，包含 manifest、文档、profiles 和节点锁 |
| Forge skill profile | 某个 skill 的部署选择，如 `robot-control-sim` 的 `mujoco-piper` |
| runtime | 某个 skill/profile 正在运行的 Dora dataflow 与 Gateway |
| invocation | Gateway 受理一次 action/session 后返回的执行标识 |

插件启用按 DSH profile 隔离；安装到 `dev` 不会启用在 `web`。Forge 数据默认位于同一 `$DSH_HOME/forge` 下，并不自动按 DSH profile 隔离。

`@x-era/dsh-forge` 会带上 `@x-era/dsh-forge-skill` 和 `@x-era/forge-core`。独立 CLI、MCP、DSH 宿主、Dora 和 skill 节点/模型依赖分别安装。

## 安装 DSH 插件

DSH 验证基线为 `0.2.2-rc.1`，要求 Node.js >=24.9.0；独立 CLI/MCP 的包要求为 Node.js >=22。

```sh
node --version
npm install --global @deepseek-ai/dsh@0.2.2-rc.1
dsh --version
dsh plugin --profile web add @x-era/dsh-forge
dsh web
```

使用 DSH 源码时，在 `deepseek-harness` 仓库中执行：

```sh
pnpm dsh plugin --profile web add @x-era/dsh-forge
pnpm dsh web
```

如果实际启动 `dev`，则安装时也使用 `--profile dev`，随后运行 `dsh --profile dev`。`dev` 是自定义 profile 名，不是 Web 模式的别名。

新增组合包后重启原宿主、刷新页面并新建对话。验证分两步：

1. `dsh web --dump-config` 中应有 `id: forge-skill`；源码方式使用 `pnpm dsh web --dump-config`。
2. 在运行中的宿主检查 `forge-usage`、`forge-skill-development` 和 `forge_skill_list` 等工具。仅看到配置行不等于插件已成功导入；失败时检查终端中的 import/依赖错误。

模型调用还需要按 DSH 自身说明完成模型配置。插件安装与注册验证本身不需要启动机器人或调用模型。

## 在对话中使用

| 目标 | 示例请求 | 工具 |
| --- | --- | --- |
| 本机有什么 skill | 列出已安装 Forge skill 与运行状态。 | `forge_skill_list` |
| Registry 有什么 skill | 搜索可安装的机器人仿真 skill，并列出返回的 profile。 | `forge_skill_search` |
| 安装 | 安装 robot-control-sim 及节点，持续查询安装进度。 | `forge_skill_install`、`forge_install_status` |
| 查看与检查 | 查看 robot-control-sim 的 profile、依赖和文档，诊断 mujoco-piper。 | `forge_skill_inspect`、`forge_skill_docs`、`forge_skill_doctor` |
| 启动 | 检查通过后启动 robot-control-sim / mujoco-piper，并确认就绪状态。 | `forge_runtime_start`、`forge_runtime_status` |
| 调用 | 调用运行中 skill 的 sim.get_robot_info，读取关节信息和限制。 | `forge_tool_context`、`forge_tool_call` |
| 停止 | 停止 robot-control-sim 并确认状态。 | `forge_runtime_stop` |

两个内置 skill 是给 Agent 的使用/开发指南，不是从 registry 下载的机器人 runtime。初次安装后 `forge_skill_list` 为空是正常情况；使用 `forge_skill_search` 查可下载项。

## 运行 skill

下面以当前 registry 中的仿真技能 `robot-control-sim` / `mujoco-piper` 为例。节点、模型、平台支持和所需环境以当前 manifest 与 doctor 结果为准。

独立 CLI 需要另装：

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

确认依赖、平台、环境变量和端口检查通过后，才继续：

```sh
forge start robot-control-sim mujoco-piper
forge status robot-control-sim
forge call robot-control-sim sim.get_robot_info
forge logs robot-control-sim 120
forge stop robot-control-sim
```

- 默认 `start` 使用 coordinator：`dora up` 和 `dora start --detach`。
- `forge start <name> <profile> --run` 使用隔离的 `dora run` 进程。
- Forge 版本与启动模式分别选择；manifest 的 `forge_version` 决定使用 `dora` 还是 `dora1`。
- 同一个 skill 同时只有一个活动 runtime；Gateway 地址已被占用时不能再次启动。
- 真实硬件 profile 需要先完成设备连接、标定、环境配置和急停检查。

Gateway 的 query 通常同步返回；action/session 可能先返回 invocation id。通过 DSH/MCP 调用 `forge_invocation_read`，传入 `name` 与 `invocation_id` 查询状态和结果。超时或受理不代表动作失败，不要盲目重发。

当前 CLI 没有 `forge call --status`、`--result` 或 `--cancel` 子用法；不要将安装任务的 `forge cancel <job-id>` 当成物理动作取消。需要取消动作时，按该 Gateway 的取消/停止协议操作并核对终态。

## 常用 CLI 操作

CLI 默认输出 JSON，不需要额外添加 `--json`。

| 操作 | 命令 |
| --- | --- |
| 查看技能、版本和文档 | `forge inspect <name>`、`forge versions <name>`、`forge docs <name> [file]` |
| 安装指定版本 | `forge install <name> --version <version> --wait` |
| 查询/取消安装任务 | `forge jobs`、`forge job <id>`、`forge cancel <id>` |
| 查询更新/应用更新 | `forge update <name>`、`forge update <name> --apply` |
| 查看 profile 文件 | `forge files <name> [profile]` |
| 读取/写入 profile 文件 | `forge file-read <name> <profile> <file>`、`forge file-write <name> <profile> <file>`（新内容从 stdin 输入） |
| 诊断 | `forge doctor <name> --profile <profile>` |
| 导出诊断报告 | `forge report [name]` |
| 查看/清理未引用节点 | `forge cache summary`、`forge cache gc --dry-run`、`forge cache gc` |
| 导出便携技能 | `forge export <name> --out <directory>` |
| 卸载技能 | `forge remove <name>`，先停止运行时 |

CLI 安装时建议使用 `--wait`，确认安装任务最终结果。DSH/MCP 安装返回 job id，可通过 `forge_install_status` 查询；`forge_install_cancel` 只针对安装任务。

Profile 文件写入会校验格式、保留备份并返回差异；按返回的重启提示停止并重新启动该 runtime。

## 配置与数据

DSH profile 配置文件默认为 `~/.dsh/profiles/web/cordis.patch.yml`。自定义 `DSH_HOME` 时，路径为 `$DSH_HOME/profiles/web/cordis.patch.yml`。

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

只填写当前 skill 需要的有效路径。数据目录优先级为：行配置 `home` → `DSH_FORGE_HOME` → `$DSH_HOME/forge` → `~/.dsh/forge`。CLI/MCP 共用同一数据目录时，设置相同的 `DSH_FORGE_HOME`；它们不会读取 DSH profile 行配置中的自定义值。

Registry 支持 `DSH_FORGE_REGISTRY_URL`，以及 `registry.token` 或 `registry.tokenEnv` 指定的 Bearer token，默认 token 环境变量为 `DSH_FORGE_REGISTRY_TOKEN`。CLI/MCP 使用环境变量配置 registry。密钥不要写入公开仓库。

`DSH_FORGE_DORA`、`DSH_FORGE_DORA1` 可设置 Dora 路径。部署环境中的 `profile.environment` 和宿主提供的 `required_environment` 会注入运行节点。

管理工具 `forge_tool_call` 默认可用；按 Gateway ToolSpec 生成类型化工具需另外启用 `gateway.dynamic` 的 `whitelist` 或 `all`，并在 runtime 就绪后注册。

### 配置 API 与可选配置台

`ui.enabled: true` 默认启用 DSH Web 同源 `/forge/api` 配置 API。工具和 skill 注册不依赖独立配置台，也不意味着 Web 主界面一定新增一个 Forge 导航项。

独立本地配置台默认关闭，需要时配置：

```yaml
- id: forge-skill
  config:
    ui:
      enabled: true
      standalone: true
      port: 19080
```

重载后访问 `http://127.0.0.1:19080/`。这个端口与 DSH Web 本身的端口不同；配置台具备配置写入/恢复能力，未提供独立身份认证，请保持仅本机访问。更多字段见 [部署与配置](deployment.md)。

## MCP 接入

独立安装 MCP server，并在支持 stdio 的 MCP 客户端中将启动命令设为 `forge-mcp`：

```sh
npm install --global @x-era/forge-mcp
```

若与 DSH 共用技能数据，在客户端环境中设置同一 `DSH_FORGE_HOME`。MCP server 自身不会安装 DSH，也不会自动启动 skill runtime。

## 安全边界

Skill 会运行 registry 下发的节点二进制。仅从可信来源安装；摘要和大小校验用于核对锁定制品，不能代替来源审查。真实硬件运行前检查标定、关节限制和急停；动作结果未知时先对账。密钥通过宿主环境提供，完整规则见 [安全说明](security.md)。

## 排障与升级

| 现象 | 排查 |
| --- | --- |
| `dsh: command not found` | 先安装 DSH 宿主，确认 Node 版本及全局 npm 命令目录在 PATH 中 |
| `forge: command not found` | 独立安装 `@x-era/forge-cli`；DSH 插件不会安装全局 `forge` |
| Web 没有 Forge 工具 | 确认安装的是 `web` profile，重启对应宿主并新建对话；检查导入错误 |
| 技能列表为空 | `forge list` 是本机已安装项，`forge search` 才是 registry 可下载项 |
| 节点/平台不匹配 | 查看 manifest、`forge doctor <name> --profile <profile>` 与平台制品 |
| Gateway 不可达/端口占用 | `forge status <name>`、`forge logs <name>`；确认现有 runtime 的归属再停止 |
| 动作没有最终结果 | 用 `forge_invocation_read` 对账，保留 invocation id，不重复提交 |
| 导出诊断 | 使用 `forge report [name]`，不是 `forge doctor --report` |

升级或卸载插件时选择同一个 DSH profile：

```sh
dsh plugin --profile web add @x-era/dsh-forge@latest
# 重启对应宿主；先停止仍在使用的 skill runtime。
dsh plugin --profile web remove @x-era/dsh-forge
```

插件升级与 skill 更新是两件事；`forge update <name> --apply` 更新技能包，不更新 npm 插件。数据目录在卸载后保留。MCP 客户端可独立安装 `@x-era/forge-mcp` 并以 `forge-mcp` 命令连接 stdio；其工具与 DSH 管理工具使用同一能力层。

维护者发版、tag 与 npm 权限设置见 [发布手册](releasing_zh.md)；[npm 包管理页](https://www.npmjs.com/settings/x-era/packages) 需要相应组织权限。
