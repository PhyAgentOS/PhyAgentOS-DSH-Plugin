# 开发路线图（剩余工作）

更新：2026-11-12（v2）。M0–M3 已完成并通过验收（[M0](M0-acceptance.md) · [M1–M3](M1-M3-acceptance.md)）。

## 已完成

| 里程碑 | 内容 |
|---|---|
| M0 | 仓库骨架、manifest 解析、catalog、Skill provider、热更新 |
| M1 | 平台搜索、事务安装（sha256/size 校验）、卸载、NodeStore |
| M2 | preflight、环境物化、Dora 起停、状态持久化与对账、日志 |
| M3 | Tool API（query/action 路由）、doctor、13 个 DSH 工具、`robot-control-sim` 仿真闭环 |
| 附加 | 独立配置台（19080）、配置回写与 YAML 编辑后端、15 个测试 |

## M4 · DSH 原生配置界面 ✅ 已完成（见 [M4 验收](M4-acceptance.md)）

范围已收敛：**插件配置 + skill profile 文件编辑**，并在页面上给出配置说明；管理动作（安装/启停/调用）仍走对话框工具，不做第二套状态机。

### M4.1 客户端 bundle

采用**手写最小封装**，不搬运 DSH 的 `tsdown.client.ts`：

- 该 preset 不是单文件，它依赖 6 个仓库内模块（assets、manifest 助手、`platform.ts` 的共享模块表、构建 defines、实验包策略、bundle 隔离）；
- 我们的页面只用 React + `@deepseek-ai/dsh-client-ui-slots`，用 esbuild 打成 `window.__ModuleLoader__.load({ id, factory })` 形式的闭包工厂即可；
- externals 固定为平台模块表：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`；
- 样式用内联/注入 `<style>`，不引入 CSS Modules 与资源 revision 管线；
- `package.json` 增加 `dsh.client.platform = "web"`、`exports["./client"] = "./lib/client.js"`；
- CI 检查：client 产物存在、能被解析、externals 全部在平台表内。

若将来需要 CSS Modules、图片资源或 HMR，再考虑 vendoring DSH 的完整 preset，届时需同步 `platform.ts`、构建 defines 与实验策略。

### M4.2 服务端同源 API

- `ctx.webServer.register({ kind: 'prefix', path: '/forge/api' })` 注册同源路由；
- 复用 `DshProfileStore` / `SkillFileStore`，路由：`GET/PUT /forge/api/config`、`GET /forge/api/skills`、`GET/PUT /forge/api/skill-file`、`GET /forge/api/meta`（说明文案与默认值）；
- 鉴权、Host/Origin、远程访问由 webServer 承担；19080 保留为 `ui.standalone` 调试开关，默认关闭。

### M4.3 页面

- 注册到插件页 `plugins.item`，条目「Forge 配置」；
- 视图一：插件配置表单，每个字段带一句说明（作用、默认值、改动是否需重启），保存后提示备份路径与“插件已重载”；
- 视图二：skill → profile → 文件树 → YAML 编辑器，保存前做语法检查，展示备份位置；
- 空态与错误态：未安装任何 skill、profile 无文件、校验失败、写入失败都要有明确文案。

### M4.4 验收

- 3080 与 `--public-url` 两种访问方式都可用；关闭 19080 不影响；
- 配置保存触发插件重挂，页面自动重连并回显新值；
- 文件保存有备份、校验失败不落盘；
- CI 缺 client 产物时失败。

预计 4–6 天。

## M5 · 安装与资源治理（GB 级节点）✅ 已完成（见 [M5 验收](M5-acceptance.md)）

不设单节点大小上限，按“可能到 GB”设计：

- **异步安装**：GB 下载不能阻塞一次模型回合。`forge_skill_install` 立即返回 job id，`forge_install_status` 轮询进度（阶段、已下载字节、总字节、速度、错误），`forge_install_cancel` 中止；
- **下载**：流式写盘 + 边下边算 sha256；用 `Content-Length` 显示总量；支持 `Range` 续传（注册表/CDN 支持时）；超时按空闲时间而不是总时长；磁盘空间预检查（`statfs`，需要 2× 制品大小）；
- **解包**：流式解包、校验 entrypoint、失败回滚；记录每个节点的解包耗时；
- **进度持久化**：`runtime/jobs/<id>.json`，宿主重启后可查询结果；
- **更新**：`forge_skill_update` 对比已装版本与注册表；
- **缓存治理**：`runtime/nodes`、`cache` 的 GC（按最后使用时间/保留最近 N/总量上限），导出摘要清单；
- **注册表鉴权**：预留 `registry.token` / `registry.tokenEnv`。

预计 4–5 天。

## M6 · 可移植层 ✅ 已完成（见 [M6 验收](M6-acceptance.md)，未做外部宿主实测）

### CLI（`@xera/forge-cli`）

- `bin/forge.mjs` 直接调用 core，命令：`list / install / update / remove / start / stop / status / call / doctor / export`；
- 与 DSH 宿主共享同一 `home` 与 `state.json`；引入跨进程文件锁（写操作互斥），避免 CLI 与宿主同时写；
- 输出支持 `--json`，便于脚本和其他 agent 的 shell 工具消费。

### MCP（`@xera/forge-mcp`）

- 独立进程的 stdio MCP server（`initialize` / `tools/list` / `tools/call`），把 13 个 forge 工具映射成 MCP tools；
- 可选暴露 `prompts`（每个 skill 一个 `skill__<name>`）与 `resources`（`skill://<name>`）；
- 宿主侧配置示例：Claude Code 的 `.mcp.json`、opencode 的 MCP 配置，命令即 `npx @xera/forge-mcp`。

### MCP 与 Forge Tool API 的区别

| | Forge Tool API | MCP |
|---|---|---|
| 层级 | 每个 skill 运行时暴露的**执行边界** | 面向 agent 宿主的**工具协议** |
| 传输 | HTTP（`/tools`、`:invoke`、`/invocations`） | JSON-RPC over stdio（或 HTTP/SSE） |
| 语义 | query / action / session、readiness、物理执行 | tools/list、tools/call（无运行时语义） |
| 谁用 | 我们的 manager、CLI、任何直连客户端 | Claude Code / opencode / pi-agent 等宿主 |
| 关系 | 被调用方 | 包装层：MCP 工具 → core → Forge Tool API |

MCP 不替代 Tool API，它只是把"管理 + 转发调用"这套工具换个协议host 一遍。

### portable 导出

- `forge skill export --format portable`：把 `skill.yaml` 合成 SKILL.md frontmatter，正文前加 `forge_tool_call` 调用约定，供 Claude Code / DSH skill-filesystem 使用。

预计 4–5 天。

## M7 · 发布与运维 ✅ 已完成（见 [M7 验收](M7-acceptance.md)）

- changesets、npm 发布顺序、bundle 精确依赖、`engines.dsh` 门禁；
- 结构化日志（安装/启动/调用事件）与 doctor 报告导出；
- 部署手册、排障手册、升级与回滚；
- 安全审计：路径与符号链接、脚本钩子、UI 路由鉴权、远程访问边界。

预计 2–3 天。

## M8 · 可选增强 ✅ 已完成（见 [M8 验收](M8-acceptance.md)）

- **按 ToolSpec 动态注册工具**（当前统一 `forge_tool_call`）：
  - 动态：每个 ToolSpec 变成带 schema 的独立工具，模型可直接校验参数；代价是工具表随运行时增长、名称需清洗（`sim.move_eef` → `forge_sim_move_eef`）、启动/停止时增删、跨会话全局可见、可移植性变差；
  - 统一：一个入口 + 自由参数，工具表稳定、跨宿主可移植，但参数错误只能由网关注回。
  - 建议：保留统一入口，后续只对“高频且 schema 简单”的 skill 开白名单式动态工具。
- UI 增强：配置 diff、历史版本回滚、YAML 高亮。

明确不做：多实例 / 多租户。

## 依赖与风险

| 项 | 影响 | 缓解 |
|---|---|---|
| 客户端 bundle 与宿主版本 | M4 的兼容性 | externals 固定平台表；CI 检查；`engines.dsh` |
| GB 级节点 | 安装时长、磁盘 | 异步 job + 进度 + 续传 + 空间预检 + GC |
| 注册表鉴权未知 | 内网部署 | 预留 token 配置，先匿名 |
| CLI/宿主并发写 | 状态互相覆盖 | 跨进程文件锁 |

## 顺序

M4 → M5 → M7 → M6 → M8（全部完成）。
