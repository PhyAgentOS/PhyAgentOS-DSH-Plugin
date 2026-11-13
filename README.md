# dsh-PhyAgentOS

DeepSeek Harness（DSH）插件与工具集：安装、运行、调用和管理 [Forge](https://github.com/PhyAgentOS/forge) skill。

一个 Forge skill 是一套 Dora dataflow + 节点制品 + Gateway Tool API 的组合。本仓库提供：

| 包 | 作用 |
|---|---|
| `@x-era/forge-core` | 能力层：manifest、catalog、registry 客户端、事务安装、NodeStore、Skill Runtime、Tool API、doctor |
| `@x-era/dsh-forge-skill` | DSH 插件：skill provider、管理工具、只读配置页、内置 `forge-usage` / `forge-skill-development` |
| `@x-era/forge-cli` | `forge` 命令行（与 DSH 共享同一 home 与 state） |
| `@x-era/forge-mcp` | MCP stdio server：把 forge 工具暴露给 MCP 宿主 |
| `@x-era/dsh-forge` | DSH 组合包（一行挂载） |

## 能力

- 搜索、安装、更新、卸载 registry 中的 Forge skill（sha256/size 校验、断点续传、GB 级节点异步安装）；
- profile 级 runtime：preflight、节点物化、Dora 启停、Gateway readiness、状态对账；
- 同时支持 Forge 1（dora 0.4.x，coordinator）与 Forge 2（dora 1.x），启动模式可选 `start`（coordinator）或 `run`（本地隔离进程）；
- 部署参数注入（profile.environment + 宿主提供的 required_environment），按 flow 标记清理残留节点；
- Gateway Tool API 统一调用：query / action / session、invocation 轮询与取消；
- 诊断：`doctor`、事件日志、结构化报告；
- agent 侧内置使用手册与开发指南两个 skill。

## 从源码安装

前置条件：Node.js >= 22、pnpm、可用的 DSH 宿主（本仓库不包含 DSH 本体）。

```sh
git clone https://github.com/PhyAgentOS/dsh-PhyAgentOS.git
cd dsh-PhyAgentOS
pnpm install
pnpm build
pnpm test
```

把组合包挂到某个 DSH profile（示例用 `dev`）：

```sh
dsh plugin --profile dev add /absolute/path/to/dsh-PhyAgentOS/bundle
dsh --profile dev --dump-config | grep -A4 forge-skill
```

随后启动该 profile（若它已在运行，需要重启以加载首次安装的插件）：

```sh
dsh --profile dev
```

验证：

```sh
dsh --profile dev --dump-config | grep -A6 'id: forge-skill'
```

安装完成后，对话中应出现 `forge-usage` / `forge-skill-development` 两个内置 skill，以及 `forge_*` 工具。

### 从 npm 安装（发布后）

```sh
dsh plugin --profile dev add @x-era/dsh-forge
```

## 配置

插件配置位于 DSH profile 的 patch 中（`$DSH_HOME/profiles/<name>/cordis.patch.yml`），常用项：

```yaml
- id: forge-skill
  config:
    home: ~/.dsh/forge            # skill、节点、runtime 状态
    registry:
      url: https://paos-resource-platform.dev.x-era.com
    runtime:
      dora: /path/to/dora         # Forge 1（0.4.x）
      dora1: /path/to/dora1       # Forge 2（1.x）
```

`home` 也可用 `DSH_FORGE_HOME` 覆盖；dora 路径也可用 `DSH_FORGE_DORA` / `DSH_FORGE_DORA1`。

## 使用

```sh
# CLI
forge search robot
forge install robot-control-sim --wait
forge start robot-control-sim mujoco-piper
forge call robot-control-sim sim.get_robot_info
forge stop robot-control-sim
```

在 DSH 对话中，模型会通过 `forge_skill_install`、`forge_runtime_start`、`forge_tool_call` 等工具完成同样操作。完整说明见 [docs/usage.md](docs/usage.md)。

## 文档

- [使用手册](docs/usage.md)
- [部署](docs/deployment.md) · [运维](docs/operations.md) · [安全](docs/security.md)
- [skill 开发](docs/skill-development.md) · [可移植性](docs/portability.md)
- [路线图与验收](docs/roadmap.md)

## 开发

```sh
pnpm install
pnpm build
pnpm test            # 构建 + node:test
pnpm release:prepare # 生成 dist/publish 下 5 个包
pnpm release:verify  # 校验包内容与依赖
```

兼容性检查（需要一份 DSH 源码 checkout）：

```sh
DSH_CHECKOUT=/path/to/deepseek-harness pnpm check:dsh
```

它会把上游 DSH 的公开类型面与 `compat/dsh-baseline.json` 对比；上游变更时更新基线并评估 shims。

## 许可

MIT，见 [LICENSE](LICENSE)。
