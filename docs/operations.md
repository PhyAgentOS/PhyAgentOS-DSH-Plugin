# 运维手册

## 1. 日常检查

```sh
node scripts/forge.mjs list          # 已安装 skill 与运行时状态
node scripts/forge.mjs status        # 每个 skill 的运行状态
```

在 DSH 里对应 `forge_skill_list` / `forge_runtime_status`。配置台见 [deployment.md](deployment.md#6-配置界面ui)。

## 2. 日志与报告

| 位置 | 内容 |
|---|---|
| `<home>/runtime/logs/events.jsonl` | 结构化事件：install.start/finish、runtime.start/stop、tool.call、doctor.run/report |
| `<home>/runtime/jobs/<id>.json` | 安装/节点 job 的完整状态（phase、字节数、错误） |
| `<home>/runtime/reports/doctor-*.json` | `forge_doctor_report` 导出的全量诊断 |
| `<home>/runtime/logs/<flow>.log` / `dora-coordinator.log` | Dora 与节点输出 |
| `~/.dsh/profiles/<profile>/cordis.patch.yml.bak-*` | 配置台写回的备份 |
| `<home>/runtime/backups/<ts>/` | skill profile 文件编辑的备份 |

事件行示例：

```json
{"ts":"2026-11-12T08:49:21.096Z","event":"install.finish","name":"robot-control-sim","version":"0.1.3","bytes":14013938}
```

## 3. 升级与回滚

**升级插件**

```sh
dsh plugin --profile web remove @x-era/dsh-forge
dsh plugin --profile web add @x-era/dsh-forge@0.2.0
# 重启该 profile（bundle 成员是启动边界）
```

**回滚**：安装上一个版本号即可；已安装的 skill 是数据，不受插件版本影响。配置文件有备份，运行 `node scripts/forge.mjs list` 确认状态。

**升级 skill**：`forge_skill_update {name, apply: true}`，或先查 `updateAvailable` 再决定。旧版本由安装器的 staging 机制替换，失败会回滚到原目录。

## 4. agent 引导

插件随包注册两样东西，让模型知道什么时候用哪个工具：

- **`forge-usage` skill**：场景 → 工具对照表、安全规则、三条典型序列。模型按需加载，用户也可以 `/forge-usage` 直接调；
- **`forge-skill-development` skill**：bundle 组成、dataflow/gateway 组织、节点打包、运行时启动顺序、本地迭代；开发/改包时加载；
- **系统提示约定**（`forge-tools` section）：Look before acting、安装是 job、profile 先读后写、改完重启、未知结果不重试、失败先 doctor。

两者都可用配置关闭：

```yaml
- id: forge-skill
  config:
    prompt:
      usageSkill: false
      developmentSkill: false
      section: false
```

内容位于 `packages/skill/src/usage.ts`，与工具描述同源维护。

## 5. profile 调参

调参走 agent 工具（或 CLI），不要手改已安装目录：

| 动作 | DSH 工具 | CLI |
|---|---|---|
| 列出 profile 文件 | `forge_profile_files` | `forge files <name> [profile]` |
| 读取文件 | `forge_profile_read` | `forge file-read <name> <profile> <file>` |
| 写入文件 | `forge_profile_write` | `forge file-write <name> <profile> <file>`（stdin 传内容） |

写入会：校验 YAML/JSON → 备份到 `<home>/runtime/backups/<ts>/` → 返回字段级 diff → 标记 `restartRequired`。

改完重启运行时生效：

```sh
forge stop <name>
forge start <name> <profile>
```

## 6. 缓存与磁盘

```sh
forge_cache_summary           # 每个节点的体积与总量
forge_cache_gc {dry_run:true} # 先看会删什么
forge_cache_gc                # 删除所有已安装 skill 不再引用的节点
```

- 节点按 `artifact_id` 缓存，多个 skill 复用；
- 被取消的下载保留 `.part` 供续传，暂不自动清理；
- 磁盘不足会返回 `FORGE_DISK_FULL`，安装前按制品大小预检。

## 7. 故障排查

| 现象 / 错误码 | 含义 | 处理 |
|---|---|---|
| `FORGE_MANIFEST_INVALID` | bundle 的 `skill.yaml` 不合法 | 重新安装；仍失败联系 skill 作者 |
| `FORGE_PROFILE_UNKNOWN` | 请求的 profile 不存在 | `forge_skill_inspect` 看可用 profile |
| `FORGE_DORA_MISSING` / `_VERSION` | dora 不在 PATH 或版本不符 | 安装 dora 0.4.1，或在配置里指定绝对路径 |
| `FORGE_NODE_MISSING` | 节点未安装 | `forge_skill_install {name}` 重新装节点 |
| `FORGE_NODE_PLATFORM` | 节点与本机平台不符 | 换 profile 或让作者发布对应平台 |
| `FORGE_NODE_INTEGRITY` | 摘要/大小不符 | 删除该节点目录后重装 |
| `FORGE_DISK_FULL` | 空间不足 | 清理缓存或扩盘 |
| `FORGE_PORT_CONFLICT` | gateway 端口被占 | 停掉占用者；同一地址只能跑一个运行时 |
| `FORGE_GATEWAY_UNREACHABLE` | 网关没起来 | 看 `<flow>.log` 与节点日志 |
| `FORGE_TOOL_MISSING` / `_NOT_READY` | 网关缺工具或未就绪 | 检查 `required_tools` 与设备状态 |
| `FORGE_RUNTIME_STALE` | 状态指向已消失的流程 | 重启插件会自动对账；仍异常则 `forge_runtime_stop` |
| `FORGE_ARCHIVE_UNSAFE` | 归档含绝对路径/符号链接 | 该制品不可信，拒绝安装并上报来源 |

## 8. 恢复流程

1. `forge_doctor_report` 导出当前状态；
2. `forge_skill_doctor` 对单个 skill 定位断点；
3. 节点类问题优先重装节点，状态类问题停运行时；
4. **不要**在结果未知时盲目重试 action（可能重复物理动作），先 `forge_invocation_read`。

## 9. 卸载

```sh
dsh plugin --profile web remove @x-era/dsh-forge
```

`<home>` 不会被删除：skill、节点缓存与日志都保留，便于重装复用；确认不再需要时手动删除。
