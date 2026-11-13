# M0 验收报告

日期：2026-11-11。范围：仓库骨架、core 的 manifest/paths/errors、DSH provider + 热更新、`forge_skill_list` / `forge_skill_inspect` / `forge_skill_read`。

## 1. 交付物

```text
forge/
├── packages/core/        @xera/forge-core       manifest 解析、目录扫描、静态检查、路径
├── packages/skill/       @xera/dsh-forge-skill  插件：provider + 三个只读工具
├── bundle/               @xera/dsh-forge        组合包（一行）
├── fixtures/skills/      minimal-grasp / broken-manifest / broken-doc
└── tests/                node:test，8 个用例
```

## 2. 验证结果

### 2.1 单元与集成测试

`pnpm test` → **8 passed / 0 failed**：

| 用例 | 覆盖点 |
|---|---|
| parses a valid manifest-v2 bundle | 正常 manifest 的字段映射 |
| rejects a broken manifest and reports stable codes | `manifest_version` / `version` / `gateway_url` 三类错误 |
| profile required_tools overrides the manifest list instead of appending | 官方那条"覆盖不是追加"的规则 |
| catalog lists valid bundles and keeps broken ones as diagnostics | 坏 bundle 不阻塞好 bundle，且保留诊断 |
| inspect reports a missing instruction document | 缺 `SKILL.md` → `skill_document: fail` |
| inspect passes for a complete bundle | 完整 bundle 无 fail 项 |
| provider lists bundles and loads a body without frontmatter | provider 用 `skill.yaml` 合成摘要、正文来自 `SKILL.md` |
| watcher invalidates on add and remove so the next list is fresh | 增/删 bundle 触发 invalidate，下一次 list 立即反映 |

最后一条就是"热生效"的核心断言：watcher 回调触发 → list 重新读盘 → 目录变化可见。

### 2.2 真实宿主：组合包能挂上

```sh
dsh --profile m0test --from-default-profile web --dump-config
dsh plugin --profile m0test add .../forge/bundle
dsh --profile m0test --dump-config | grep -A2 '@xera/dsh-forge'
```

结果：

```yaml
# == @xera/dsh-forge
- id: forge-skill
  name: '@xera/dsh-forge-skill'
```

profile manifest 里 `dsh.profile.bundles` 为 `[base, web-app, @xera/dsh-forge]`，层顺序正确。

### 2.3 真实宿主：插件能启动

```sh
dsh --profile m0test --port 3091 --no-open
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3091/   # 401
```

启动成功即意味着：provider 注册通过、三个工具的 schema 通过 `defineTool` 校验（否则 `apply` 抛错、启动失败）。

### 2.4 真实宿主：watcher 确实监视着 skill 根

在 `/proc/<pid>/fdinfo` 里数 inotify watch 数量：

| 动作 | watch 数 |
|---|---|
| 基线（已拷入 minimal-grasp） | 9 |
| 新建 `skills/probe-dir/sub` | **11** |
| 删除 `skills/probe-dir` | 9 |

递归监视会自动为新子目录加 watch，数量变化证明递归 watcher 挂在 `$DSH_HOME/forge/skills` 上，且嵌套 bundle 文件的变化可见。

## 3. 未能自动验证的一项

**"模型目录里出现新 skill"** 需要一次真实模型 turn：

- 当前 3080 是正在进行本对话的宿主，不能重启；
- `m0test` 是从 web 模板新建的空 profile，没有模型配置，跑 headless 会因缺 provider 失败。

已验证到链条的前两段（invalidate 被调用 → provider 下次读取立即反映），最后一段（tool-skill 把目录写进 prompt）由 DSH 自身保证。人工复验方式：

```sh
# 1. 把模型配置放进 m0test（复制 web 的 llm 两行），或在真实 profile 上装 bundle
# 2. 启动后问模型：列一下当前可用的 forge skill
# 3. 拷入 fixtures/skills/minimal-grasp 到 ~/.dsh/forge/skills
# 4. 同一会话再问一次
```

## 4. 已知限制（M0 范围）

1. `types/shims.d.ts` 是本地类型桩，运行时模块由宿主解析；M1 起换真实包版本并加 lint 规则禁止 core 依赖 DSH。
2. `bundle/package.json` 用 `file:` 依赖，便于本地 link；发布前必须改成精确版本号。
3. `m0test` profile 与 `~/.dsh/forge/skills/minimal-grasp` 是验收留下的，可随时删除。
4. 只读工具；安装、运行时、Tool API、迁移、doctor 运行时检查都在 M1–M3。

## 5. 下一步（M1）

- 平台客户端（`/v1/skills`、`/v1/skills/{name}`、presigned 下载、sha256/size 校验）
- 事务安装器（staging → 原子替换 → 回滚）
- `forge_skill_install` / `forge_skill_remove` / `forge_skill_search`
- `forge skill migrate --from ~/.PhyAgentOS`
- 安装完成后 `invalidate()`，复用本阶段已验证的热链路
