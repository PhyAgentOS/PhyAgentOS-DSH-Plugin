# M8 验收报告 · 可选增强

日期：2026-11-12。

## 1. 动态按 ToolSpec 注册工具

配置（默认关闭，保持既有 `forge_tool_call` 行为）：

```yaml
- id: forge-skill
  config:
    gateway:
      dynamic: whitelist          # off | whitelist | all
      dynamicSkills: [robot-control-sim]
```

- 运行时健康后从 `GET /tools` 拉 ToolSpec，把每个工具注册成 DSH 工具：`forge_<skill>_<tool>`，非字母数字转 `_`，超过 64 字符时截断并加 6 位哈希；
- `input_schema` 映射到工具参数 DSL：object/string/number/integer/boolean/array/enum/oneOf，未知构造退化为 `{ type: 'json' }`；
- 生命周期：`runtime_start` 后 reconcile，`runtime_stop` 后 dispose，重载时替换上一代（避免残留）；
- 执行仍走 `ForgeOperations.toolCall`，错误以 `FORGE_*` 结构化返回。

验证（单测）：参数映射、名称清洗与长度约束、注册/替换/释放、执行转发。

## 2. UI 增强

| 能力 | 实现 |
|---|---|
| 配置 diff | 表单「对比修改」按字段列出 `旧值 → 新值` |
| 历史备份 | 列出 `cordis.patch.yml.bak-*`，可一键恢复 |
| 恢复安全 | 恢复前把当前文件另存为新的 `.bak`，恢复后刷新表单 |
| API | `GET /forge/api/backups`、`POST /forge/api/restore-backup` |

验证：`handleApi` 单测覆盖列表、恢复、缺参、非法配置；存储层单测覆盖备份命名唯一性与恢复内容。

## 3. 回归

- `pnpm test` → **36 passed / 0 failed**，连续 3 次运行稳定；
- `release:prepare` 5 包 + `release:verify` 通过；
- 客户端 bundle 重建（23,224 B），factory 注册测试通过。

## 4. 说明与限制

1. 动态工具默认关闭；按白名单开启，避免工具表随运行时膨胀。
2. 真实仿真器上的动态工具端到端未在本轮重跑：M3 验收时的节点来自已移除的 legacy 目录，现在启动 `robot-control-sim` 需要按设计下载约 920 MB 节点制品；动态注册与执行逻辑已由单测（含执行转发）覆盖。
3. YAML 语法高亮未做，改为字段级 diff + 备份恢复（实用价值更高）。


## 5. 后续调整（同日）

- 新增 agent 侧 profile 工具：`forge_profile_files` / `forge_profile_read` / `forge_profile_write`（校验、备份、字段级 diff、`restartRequired`），CLI 增加 `files` / `file-read` / `file-write`；
- 配置页收敛为只读审阅：插件配置展示 + 备份回滚，skill profile 只读预览，修改统一走 agent 工具；
- 回归：`pnpm test` → 38 passed。
