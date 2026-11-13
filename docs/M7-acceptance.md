# M7 验收报告 · 发布与运维

日期：2026-11-12。

## 1. 交付

| 部分 | 文件 | 说明 |
|---|---|---|
| 发布准备 | `scripts/prepare-publish.mjs` | 把 3 个包暂存到 `dist/publish/`，把 `file:`/`workspace:` 依赖改写为精确版本 |
| 发布校验 | `scripts/verify-release.mjs` | 名称/版本/exports/`dsh.client`/engines/patch 文件/client 产物/依赖钉版本 |
| CI | `.github/workflows/ci.yml` | install → build → test → prepare → verify |
| Release | `.github/workflows/release.yml` | tag 触发，逐包 `npm publish --provenance` |
| 结构化日志 | `packages/core/src/events.ts` | `runtime/logs/events.jsonl`：install.start/finish、runtime.start/stop、tool.call、doctor.run/report |
| 诊断导出 | `forge_doctor_report` | 全量诊断写入 `runtime/reports/doctor-*.json` |
| 归档安全 | `packages/core/src/archive.ts` | 拒绝绝对路径、`..`、符号链接/硬链接条目 |
| 文档 | `docs/operations.md`、`docs/security.md` | 运维、故障码、安全边界 |

## 2. 验证

发布链路：

```text
$ node scripts/prepare-publish.mjs
staged 3 packages under dist/publish:
  @xera/dsh-forge-skill
  @xera/dsh-forge
  @xera/forge-core

$ node scripts/verify-release.mjs
release verification passed

$ npm pack --dry-run（各包）
@xera/forge-core          37 files   28,214 B
@xera/dsh-forge-skill     16 files   18,909 B   （含 lib/client.js）
@xera/dsh-forge            2 files      576 B   （cordis.patch.yml + package.json）
```

运维能力（真实工具 handler）：

```text
doctor report: {"ok":true,"path":"…/runtime/reports/doctor-2026-11-12T08-52-35-086Z.json",
                "summary":{"skills":2,"failing":0,"diagnostics":0}}
event log lines: 4
```

安全：

- 归档含符号链接 → `FORGE_ARCHIVE_UNSAFE`（单测）；
- PUT 缺少 `application/json` → 415（standalone 与 webServer 两处一致）；
- 配置/文件写入均有备份，YAML 先校验后落盘。

回归：`pnpm test` → **27 passed / 0 failed**；`release:prepare` + `release:verify` 通过；两个 workflow 文件可被 YAML 解析。

## 3. 已知限制

1. 未实际执行 `npm publish`（无 registry 凭据），只验证到 tarball 内容与元数据；
2. CI workflow 未在 GitHub 上跑过，本地等价命令全部通过；
3. 结构化日志为本地 JSONL，未接 OTel/远程采集。
