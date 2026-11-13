# Forge Skill 使用手册

适用于通过 DSH 插件、`forge` CLI 或 MCP 管理 Forge skill 的使用者。

## 1. 概念

| 概念 | 含义 |
|---|---|
| skill | 一个可安装的 Forge 技能包（`skill.yaml` + `SKILL.md` + `profiles/` + assets） |
| profile | skill 的一种部署选择（不同机器人/模型/参数），一个 skill 可有多套 |
| runtime | 某个 skill+profile 的一次运行（一个 Dora dataflow + 一个 Gateway） |
| Gateway | 运行时暴露的 HTTP Tool API（`/tools`、`/tools/{id}:invoke`） |
| 节点 | dataflow 中的进程：gateway、provider、控制器、仿真器、相机适配器等 |

同一时刻一个 skill 只有一个活动 runtime；同一个 Gateway 地址只能被一个 runtime 占用。

## 2. 安装与卸载

```sh
forge search robot                 # 搜索 registry
forge versions robot-control-sim   # 查看可用版本
forge install robot-control-sim --wait          # 安装当前版本（含节点）
forge install robot-control-sim --version 0.1.2 # 指定版本
forge update robot-control-sim --apply          # 升级
forge remove robot-control-sim                  # 卸载（需先停止 runtime）
```

节点制品较大（可能到 GB 级），安装是异步任务：`forge install` 返回 job id，用 `forge job <id>` 查看进度，`forge cancel <job>` 中止。

## 3. 查看

```sh
forge list                      # 已安装 skill 与 runtime 状态
forge status [name]             # 运行态详情
forge inspect <name>            # manifest、profiles、锁、静态检查
forge doctor <name> [profile]   # 依赖/端口/环境诊断
forge logs <name> [lines]       # runtime 日志
forge docs <name> [file]        # skill 自带文档
forge files <name> [profile]    # profile 文件列表
```

## 4. 启动与停止

```sh
forge start <name> <profile>          # 默认：coordinator 模式（可管理）
forge start <name> <profile> --run    # 本地隔离进程（无 coordinator）
forge stop <name> [--force]
```

- `start` 模式：`dora up` + `dora start --detach`，flow 注册在 coordinator，支持按名字停止；
- `run` 模式：`dora run`，forge 记录 pid 并用 flow 标记回收全部节点；适合开发/调试/CI；
- Forge 1/2 由 skill 的 `forge_version` 决定使用 `dora` 还是 `dora1`，与启动模式无关。

启动前会做 preflight：dora 可执行、节点制品已就绪、assets 存在、必需环境变量、Gateway 端口空闲。

## 5. 调用工具

```sh
forge call <name> <tool_id> ['{"json":"args"}']   # 统一入口
forge call <name> sim.get_robot_info
forge call <name> sim.set_joint_positions '{"positions":{"joint1":0.5}}'
```

语义由 Gateway 的 ToolSpec 决定：

- **query**：同步返回（如 `sim.get_robot_info`）；
- **action/session**：返回 invocation id，用 `forge call --status <id>` / `forge call --result <id>` 轮询，`--cancel` 取消。

action/session 返回的受理不等于动作完成；以 invocation 的终态与 Gateway 状态为准。

## 6. 调参

```sh
forge files <name> <profile>              # 找到配置文件
forge file-read <name> <profile> <path>
forge file-write <name> <profile> <path>  # 从 stdin 读入
```

在 DSH 中也可让 agent 用 `forge_profile_read` / `forge_profile_write` 修改，写入前会校验 YAML 并备份；改动通常需要重启 runtime 生效。

## 7. 环境变量

启动时 forge 会把部署环境注入到运行中的节点（节点级 `env`）：

- `profile.environment` 里的固定值；
- `required_environment` 中、宿主进程里存在的变量；
- `FORGE_RUNTIME_BIN`、`PAOS_SKILL_*`、`FORGE_FLOW_ID`。

`DISPLAY`、代理、模型缓存等机器级变量由 DSH/daemon 或宿主环境提供。

## 8. 排障

| 症状 | 排查 |
|---|---|
| `FORGE_SKILL_NOT_FOUND` | `forge list`；确认 skill 目录 |
| `FORGE_NODE_MISSING` | 安装节点：`forge install <name>`；检查平台/架构 |
| `FORGE_PORT_CONFLICT` | 该 Gateway 已被占用；先 `forge stop` |
| Gateway 不可达 | `forge logs`；确认 dora 在运行；`forge doctor` |
| `not an Action` | query 工具必须走 endpoint 路由；用 `forge call` 统一入口 |
| 启动后无响应 | `forge call --status`；避免重复提交；必要时 `--cancel` |
| 残留进程 | 新版 run 模式会按 flow 标记清理；仍残留时 `forge stop --force` |

`forge doctor --report` 可导出完整 JSON 报告。

## 9. CLI 与 MCP

- CLI：`forge <command> --json`，适合脚本和 agent shell；
- MCP：`forge-mcp`（stdio JSON-RPC），把 27 个工具暴露给 Claude Code / opencode 等宿主；
- DSH 内：直接用 `forge_*` 工具，无需 CLI。

## 10. 安全

- skill 会执行 registry 下发的二进制；安装时校验 sha256/size，但信任边界仍是 registry；
- 不要在不可信 registry 上安装来源不明的 skill；
- 配置与日志可能包含环境变量名；密钥优先走宿主环境或 `run` 模式。
