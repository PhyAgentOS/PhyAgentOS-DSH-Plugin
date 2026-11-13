# M6 验收报告 · 可移植层

日期：2026-11-12。按约定**不做外部 agent 的导入实测**，MCP 用原始 JSON-RPC 在本地验证协议与工具映射。

## 1. 交付

| 部分 | 位置 | 说明 |
|---|---|---|
| 能力层 | `packages/core/src/operations.ts` | `ForgeOperations`：DSH 工具、CLI、MCP 共用的唯一实现；写操作共用跨进程锁 |
| 跨进程锁 | `packages/core/src/lock.ts` | `withLock`：排他、超时、陈旧锁回收（PID 存活判断 + mtime） |
| portable 导出 | `packages/core/src/portable.ts` | 合成 frontmatter、调用约定、复制 profile 配置 |
| CLI | `packages/cli/bin/forge.mjs` | 15+ 命令、`--json`、与宿主共享 home/state |
| MCP | `packages/mcp/bin/forge-mcp.mjs` | stdio JSON-RPC，21 个工具 |
| DSH 适配 | `packages/skill/src/tools.ts` | 重写为 `ForgeOperations` 的薄封装（schema/描述层） |

## 2. 验证

**CLI（真实 home）**

```text
$ node packages/cli/bin/forge.mjs list
{"ok":true,"home":"$DSH_HOME/forge","skills":[
  {"name":"local-grasp-slow","version":"0.1.6",...},
  {"name":"robot-control-sim","version":"0.1.3",...}, ... 5 skills ]}
```

**MCP（stdio）**

```text
initialize → {"name":"forge-mcp","version":"0.1.0"}
tools/list → 21 tools
tools/call forge_skill_list → 5 skills
```

**portable 导出**

```text
$ forge export control-unitree-go2 --out …
---
name: control-unitree-go2
description: Control built-in Go2 postures and timed body-frame velocity.
whenToUse: …
metadata:
  forge: { version: 1.0.1, profiles: [go2_real], gatewayUrl: … }
---
（原始正文，含 forge_tool_call 约定）
```

**锁**

- 同进程二次获取 → `FORGE_BUSY`（200 ms 超时）；
- 陈旧锁（PID 不存在）→ 自动回收并成功获取。

**回归**

- `pnpm test` → **31 passed / 0 failed**
- `release:prepare` → 5 个包staged；`release:verify` → passed

## 3. 说明

- MCP 工具只做“管理 + 转发”，物理执行仍由各 skill 的 Gateway 承担。
- 未验证 Claude Code 等宿主的实际接入（按约定跳过）；协议层已用本地 JSON-RPC 客户端验证。
- CLI 与宿主并发时，写操作串行；读操作不加锁。
