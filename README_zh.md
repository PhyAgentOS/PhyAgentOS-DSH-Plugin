[English](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/README.md) | 中文

# PhyAgentOS-DSH-Plugin

DeepSeek Harness（DSH）插件与工具集，用于安装、运行和管理 [Forge](https://github.com/PhyAgentOS/forge) skill：Dora dataflow、节点制品和 Gateway Tool API 的组合。

[使用手册](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/docs/usage.md) · [发布手册](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/docs/releasing_zh.md) · [npm 包列表](https://www.npmjs.com/org/x-era) · [GitHub Releases](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/releases) · [npm 包管理（维护者）](https://www.npmjs.com/settings/x-era/packages)

## 包与安装范围

五个包均已在公共 npm 发布，支持通过各自的 tag 触发 GitHub Actions，以 OIDC 自动发布。

| 包 | 用途 | 安装 DSH 组合包时是否包含 |
| --- | --- | --- |
| [`@x-era/dsh-forge`](https://www.npmjs.com/package/@x-era/dsh-forge) | DSH 组合包与插件入口 | 包含 |
| [`@x-era/dsh-forge-skill`](https://www.npmjs.com/package/@x-era/dsh-forge-skill) | Skill provider、管理工具和内置使用/开发指南 | 自动安装 |
| [`@x-era/forge-core`](https://www.npmjs.com/package/@x-era/forge-core) | Manifest、registry、校验安装、runtime 与 Tool API 客户端 | 间接依赖，自动安装 |
| [`@x-era/forge-cli`](https://www.npmjs.com/package/@x-era/forge-cli) | 独立 `forge` 命令 | 按需另装 |
| [`@x-era/forge-mcp`](https://www.npmjs.com/package/@x-era/forge-mcp) | 供其他 Agent 客户端接入的 MCP stdio server | 按需另装 |

npm 包管理页需要登录具备组织权限的 npm 账号；普通使用者直接访问各包的公共页面即可。

Forge 支持安装 LIBERO 等 Skill 使用的 `directory_tar_gz` 节点及其运行库。可执行文件位于包内的 `<entrypoint>/<entrypoint>`，相对软链接必须解析到包内。

## 快速开始：DSH Web

已验证的 DSH 宿主要求 Node.js **>=24.9.0**。本机没有 `dsh` 命令时，先安装宿主：

```sh
node --version
npm install --global @deepseek-ai/dsh@0.2.2-rc.1
dsh --version
```

把插件安装到实际要启动的 profile：

```sh
dsh plugin --profile web add @x-era/dsh-forge
dsh web
```

如果通过 DSH 源码启动，请在 **deepseek-harness 仓库**中执行：

```sh
pnpm dsh plugin --profile web add @x-era/dsh-forge
pnpm dsh web
```

`dsh web` 使用 `web` profile；`--profile dev` 的安装只对 `dev` 生效。新增组合包后，请重启已经运行的对应 profile，并新建对话。

安装后应能加载 `forge-usage`、`forge-skill-development` 及 `forge_*` 管理工具。插件安装不等于安装机器人 skill、Dora 或硬件/模型依赖，完整验证步骤见 [使用手册](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/docs/usage.md)。

验证基线：npm DSH `0.2.2-rc.1`；另已验证 DSH `0.2.2-rc.2` 源码版 Web 的插件注册。

### 新机器首次配置（直接用自然语言）

装好插件并打开 DSH 新对话后，无需手动配置 Dora 或编辑 `cordis.patch.yml`，直接依次发送即可：

1. **体检**：“刚装完 Forge 插件，检查一下这台机器的 Forge 运行环境还缺什么。”（`forge_environment_check`）
2. **装运行时**：“帮我初始化 Forge 初始环境：把 Forge 1 `dora 0.4.1` 和 Forge 2 `dora1 1.0.1` 装到 `~/.dsh/forge/support/` 并自检（需要镜像时可附带 PyPI 镜像地址）。”（`forge_environment_setup`）
3. **调配置**：“查看 `web` profile 下的 Forge 配置，如需修改模型目录 `models.root` 或 Registry 请帮我安全更新并留备份。”（`forge_config_read` / `forge_config_write`）

更多镜像、离线二进制与配置回滚示例见 [部署与配置](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/docs/deployment.md)。

## 使用示例

在 DSH 对话中直接描述目标：

| 目标 | 可以这样提问 | 主要工具 |
| --- | --- | --- |
| 查看已安装 skill | “列出本机已安装的 Forge skill，以及各自的运行状态。” | `forge_skill_list` |
| 环境体检 | “刚装完插件，检查这台机器能不能跑 Forge（dora、Node、Python、数据根、磁盘、registry、端口）。” | `forge_environment_check` |
| 新机环境初始化 | “帮我把 Forge 1 `dora 0.4.1` 和 Forge 2 `dora1 1.0.1` 装到 `~/.dsh/forge/support/` 并配好验证。” | `forge_environment_setup`、`forge_config_write` |
| 本地模型检索 | “检索 `~/.dsh/forge/models` 下的本地模型权重，查看或校验 `sam3`。” | `forge_model_search`、`forge_model_info`、`forge_model_verify` |
| 查看可下载 skill | “搜索 Forge registry 中与机器人仿真有关的 skill。” | `forge_skill_search` |
| 选择 profile | “查看 robot-control-sim 的可用 profile 和运行条件。” | 安装后使用 `forge_skill_inspect` |
| 安装 skill | “安装 robot-control-sim 及其节点，并持续查询安装进度。” | `forge_skill_install`、`forge_install_status` |
| 运行仿真 | “先检查 robot-control-sim 的 mujoco-piper profile，检查通过后启动。” | `forge_skill_doctor`、`forge_runtime_start` |
| 查看机器人状态 | “调用运行中 robot-control-sim 的 sim.get_robot_info。” | `forge_tool_call` |
| 停止 skill | “停止 robot-control-sim 的运行时，并确认最终状态。” | `forge_runtime_stop`、`forge_runtime_status` |

当前 registry 提供 `robot-control-sim` / `mujoco-piper`。实际运行前仍需查看当前版本的依赖和平台要求。

如果希望通过终端完成同样操作，先独立安装 CLI：

```sh
npm install --global @x-era/forge-cli
forge search robot
forge list
forge install robot-control-sim --wait
forge inspect robot-control-sim
forge env
forge doctor robot-control-sim --profile mujoco-piper
# 仅在可执行文件、环境变量与平台检查通过后继续。
forge start robot-control-sim mujoco-piper
forge status robot-control-sim
forge call robot-control-sim sim.get_robot_info
forge stop robot-control-sim
```

CLI 默认输出 JSON。action/session 的受理不等于执行完成，应通过 DSH/MCP 的 `forge_invocation_read` 查询 invocation，结果未知时不要重复提交动作。详见 [运行 skill](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/docs/usage.md#运行-skill)。

## 配置

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中设置 `forge-skill`（默认 DSH home 为 `~/.dsh`）：

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

请按 skill 要求替换可执行文件路径。`DSH_FORGE_HOME`、`DSH_FORGE_REGISTRY_URL`、`DSH_FORGE_DORA`、`DSH_FORGE_DORA1` 可提供环境默认值。优先级、鉴权 registry 和可选配置台见 [配置与数据](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/docs/usage.md#配置与数据)。

## 开发与发布

```sh
git clone https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin.git
cd PhyAgentOS-DSH-Plugin
pnpm install --frozen-lockfile
pnpm test
dsh plugin --profile web add file:/absolute/path/to/PhyAgentOS-DSH-Plugin/bundle
```

源码安装使用显式 `file:`，构建更新后重新安装。DSH 宿主属于另一个项目。`DSH_CHECKOUT=/path/to/deepseek-harness pnpm check:dsh` 用于比较上游 API 基线；哈希变化本身不能判定运行时是否兼容。

单包发版流程：修改该包的版本 → 通过个人 fork PR 合入 `main` → 创建匹配 tag，例如 `forge-cli/v0.1.2`。新远端 tag 自动触发测试、npm 发布和带 tarball 的 GitHub Release；上传后每 15 秒查询公开状态，最多等待约 15 分钟。

五个版本文件、tag 命名、OIDC、网页创建 tag 及失败恢复见 [发布手册](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/docs/releasing_zh.md)。维护者可直接进入 [npm 包管理](https://www.npmjs.com/settings/x-era/packages)。

## 文档导航

| 内容 | 中文 | English |
| --- | --- | --- |
| 安装、使用、CLI/MCP 与排障 | [使用手册](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/docs/usage.md) | [User guide](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/docs/usage_en.md) |
| 独立发版、tag 与 npm 授权 | [发布手册](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/docs/releasing_zh.md) | [Release guide](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/docs/releasing.md) |

其他文档：[部署与配置](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/docs/deployment.md) · [运维](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/docs/operations.md) · [安全](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/docs/security.md) · [Skill 开发](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/docs/skill-development.md) · [可移植性](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/docs/portability.md)。

## 许可

MIT，见 [LICENSE](https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin/blob/main/LICENSE)。
