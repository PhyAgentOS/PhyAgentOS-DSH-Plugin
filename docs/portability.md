# 可移植层：导出、CLI、MCP

forge 的能力层（`@xera/forge-core` 的 `ForgeOperations`）与宿主无关；DSH 插件、CLI、MCP 都是它的薄适配器。

## 1. portable skill 导出

```sh
forge export <name> --out ./portable
```

产物：

```
portable/<name>/
├── SKILL.md          # 合成 frontmatter + 调用约定 + 原始正文
├── skill.yaml        # 原样副本
└── profiles/<id>/    # 各 profile 的 YAML 配置
```

`SKILL.md` 头部示例：

```yaml
---
name: control-unitree-go2
description: Control built-in Go2 postures and timed body-frame velocity.
whenToUse: Use when the task needs the control-unitree-go2 capability.
metadata:
  forge:
    version: 1.0.1
    profiles: [go2_real]
    gatewayUrl: http://127.0.0.1:19002
---
```

正文前会加三行说明：工具通过 `forge_tool_call(tool_id, arguments)` 调用、可用 profile、来源。**不改写作者正文**，便于同一份内容喂给 DSH 的 skill 目录或 Claude Code 的 skills。

## 2. CLI

```sh
forge list                       # 已安装与运行时状态
forge search robot               # 注册表搜索
forge install robot-control-sim  # 后台 job，--wait 等待完成
forge start robot-control-sim mujoco-piper
forge call robot-control-sim sim.get_robot_info
forge stop robot-control-sim
forge doctor robot-control-sim
forge report                     # 全量诊断报告
forge export robot-control-sim --out ./portable
forge cache summary | forge cache gc [--dry-run]
forge jobs | forge job <id> | forge cancel <id>
```

所有命令输出 JSON（便于脚本和 agent 消费）。`DSH_FORGE_HOME` 指定数据根，默认 `$DSH_HOME/forge`。

与 DSH 宿主**共享同一份状态**：`state.json`、skills、节点缓存。写操作走同一个跨进程锁（`runtime/forge.lock`），同时运行不会互相覆盖。

## 3. MCP

```jsonc
// Claude Code (.mcp.json) / 其他 MCP 宿主
{
  "mcpServers": {
    "forge": { "command": "npx", "args": ["-y", "@xera/forge-mcp"] }
  }
}
```

stdio、按行 JSON-RPC（`initialize` / `tools/list` / `tools/call` / `ping`），暴露 21 个工具：skill 列表/搜索/检查/读取/安装/更新/删除、job 状态与取消、doctor 与报告、运行时启停/状态/日志、`forge_tool_context`、`forge_tool_call`、`forge_invocation_read`、缓存摘要/GC、portable 导出。

**MCP 与 Forge Tool API 的关系**：MCP 是面向宿主的工具协议；真正驱动物理执行的是每个 skill 的 Gateway（HTTP `/tools`、`:invoke`、`/invocations`）。MCP 工具只是把管理动作和 `forge_tool_call` 转发到那一层。

## 4. 选择建议

| 场景 | 用哪个 |
|---|---|
| 在 DSH 里日常使用 | DSH 插件（原生 skill 目录 + 自动热更新） |
| 运维/脚本/CI | CLI |
| Claude Code、其他 MCP 宿主 | MCP + portable 导出 |
| 只用 shell 的 agent | CLI（`--json`） |
