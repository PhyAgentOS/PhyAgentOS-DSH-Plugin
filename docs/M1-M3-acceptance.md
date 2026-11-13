# M1–M3 验收报告

> 后续变更：`forge_skill_migrate` 与 legacy 节点复用已按上线要求移除；节点统一走 NodeStore，配置台见 `docs/deployment.md#6-配置界面ui`。

日期：2026-11-11。范围：平台安装、迁移、Skill Runtime、Forge Tool API、doctor，以及 `robot-control-sim` 的仿真闭环。

## 1. 实现范围

| 模块 | 文件 | 能力 |
|---|---|---|
| 注册表 | `packages/core/src/registry.ts` | `/v1/skills` 搜索、`/v1/skills/{name}` 与 `/v1/forge-nodes/{id}` 解析 |
| 安装器 | `packages/core/src/install.ts` | 下载、sha256/大小校验、安全解包、manifest 校验、staging + 原子替换 |
| 迁移 | `packages/core/src/migrate.ts` | 从 `~/.PhyAgentOS` 复制 skills 与 node 制品（只复制） |
| 运行时 | `packages/core/src/runtime.ts` | preflight、环境物化、Dora 启动/停止、状态持久化、状态对账、日志 |
| Tool API | `packages/core/src/tool-client.ts` | `/tools`、context、query/action 路由、invocation/result |
| 诊断 | `packages/core/src/doctor.ts` | 静态 + 运行时 + 网关工具覆盖 |
| DSH 工具面 | `packages/skill/src/tools.ts` | 14 个工具：list/inspect/read/search/install/remove/migrate/doctor、runtime start/status/stop/logs、tool context/call、invocation read |

## 2. 安装验收

```text
registry: https://paos-resource-platform.dev.x-era.com
installed: robot-control-sim 0.1.3
  bytes: 14013938   sha256 校验通过
  path: ~/.dsh/forge/skills/robot-control-sim
catalog: local-grasp-slow, robot-control-sim, vlm-grasp-autoloop,
         vlm-grasp-worldcamera, vlm-grasp-worldcamera-singlearm
diagnostics: 0
```

安装完成后 `robot-control-sim` 出现在**当前会话**的可用 skill 列表里（无需重启），这是安装 → `invalidate()` → `skills/change` 的端到端证据。

## 3. 运行时验收（mujoco-piper）

preflight：13 项通过、8 项 warn（复用 `~/.PhyAgentOS/forge_runtime/nodes` 的既有二进制，未做 sha 校验），`sim_control_policy` 缺失，按 Registry 自动下载 102.6 MB。

```text
flow: forge-robot-control-sim-mujoco-piper-mwc0j3ar
env:  ~/.dsh/forge/runtime/env/robot-control-sim/mujoco-piper/290c2dece48ee73d
gateway: http://127.0.0.1:19002
status: healthy
```

环境物化 = bin 符号链接 + bundle 副本（排除 nodes/）+ `${FORGE_RUNTIME_BIN}` 替换 + `runtime-lock.json`。

## 4. Tool API 验收

`GET /tools` 暴露 5 个工具：

```
sim.get_robot_info:query
sim.move_eef:action
sim.reset:action
sim.set_gripper_opening:action
sim.set_joint_positions:action
```

Query（走 endpoint operation 路由 `POST /tools/sim.control/get_robot_info:invoke`）：

```json
{ "name": "piper", "dof": 7, "has_gripper": true,
  "joints": ["joint1","joint2","joint3","joint4","joint5","joint6","gripper"] }
```

Action（`POST /tools/sim.set_joint_positions:invoke` → 202 + invocation id）：

```json
{ "status": "succeeded", "error_code": "SUCCESS",
  "final_positions": [0.2983, 0.4981, -0.8969, 0.1496, ...],
  "final_position_errors": [0.0017, 0.0019, -0.0031, 0.0004, 0.0103, -0.0034] }
```

A 组关节目标 `[0.3, 0.5, -0.9, 0.15, 0.25, -0.1]`，耗时约 7.8 s，残差均在 1cm / 0.01rad 量级。

错误路径也验证过：错误参数（`targets` 而非 `positions`）返回 `MOTION_INVALID_GOAL`；关节数与 group 不匹配返回 `INVALID_JOINTS`，均未被重试。

停止：`dora stop --name forge-...-mwc0j3ar` 成功，19002 端口释放，flow 状态 `Succeeded`。

## 5. 测试

`pnpm test` → **11 passed / 0 failed**（新增 doctor 两项、gateway 路由一项）。

## 6. 已知限制

1. ~~legacy 复用未校验 sha256~~：该机制已在后续版本移除，节点统一走 `NodeStore`（下载校验 + 摘要记录），另有 `docs/deployment.md#5-节点管理nodestore`。
2. **动态分工具未做**：按决策只提供通用 `forge_tool_call`；M4 再接动态工具与 MCP。
3. **单进程状态**：`state.json` 原子写但没有跨进程锁；同一 forge home 被两个宿主同时写会互相覆盖。
4. **正在运行的 3080 宿主仍是旧构建**：它只加载了 M0 的工具面；重启后才有 install/runtime/tool 工具。
5. **节点制品仓库体积**：`~/.dsh/forge` 目前 3.5 GB（3.2 GB 是四个真实 skill 的副本）。
