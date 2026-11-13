# M5 验收报告 · 安装与资源治理（GB 级）

日期：2026-11-12。

## 1. 交付

| 能力 | 实现 |
|---|---|
| 异步安装 | `JobRunner` + `runtime/jobs/<id>.json`；`forge_skill_install` 立即返回 job id |
| 进度与取消 | `forge_install_status` 轮询（phase / downloadedBytes / totalBytes）、`forge_install_cancel` |
| 可续传下载 | `download.ts`：`.part` + `Range` 续传、边下边算/流式校验、空闲超时、磁盘预检 |
| 更新检查 | `forge_skill_update`（对比注册表版本，`apply: true` 启动更新 job） |
| 缓存治理 | `forge_cache_summary`、`forge_cache_gc`（基于所有已安装 skill 的 artifact 引用） |
| 注册表鉴权 | `registry.token` / `registry.tokenEnv` / `DSH_FORGE_REGISTRY_TOKEN` |

## 2. 验证（真实工具 handler，临时 home）

```text
install start: {"ok":true,"jobId":"install-16b1d7e0","state":"running"}
install end:   {"state":"succeeded","result":{"name":"control-unitree-go2","version":"1.0.1","bytes":14636}}
invalidations: 1
catalog:       control-unitree-go2
update:        {"installed":"1.0.1","latest":"1.0.1","updateAvailable":false}
cache summary: {"artifacts":[],"totalBytes":0}
cache gc dry:  {"removed":[],"freedBytes":0,"referenced":["gateway-1.0.2-…","robots_unitree_go2-…"]}
cancel:        {"requested":true,"state":"cancelled"}
jobs:          2 most recent: cancelled
```

单元测试覆盖：

- 下载校验（sha256/大小）、进度回调；
- `Range` 续传（服务端 206，且最终摘要正确）；
- 摘要不匹配时删除文件；
- 空闲超时中止（`FORGE_TIMEOUT`）；
- 磁盘空间预检（`FORGE_DISK_FULL`，1 PiB 请求直接拒绝，未发起网络请求）；
- Job 进度/结果/重启后读取、取消；
- NodeStore GC（dry-run 与真实删除，只删未引用项）。

`pnpm test` → **24 passed / 0 failed**。

## 3. 已知限制

1. 取消后保留 `.part` 供下次续传；不自动清理陈旧分片（后续可并入 GC）。
2. `cache/` 里的 skill 归档不参与 GC；目前只在成功解包后删除节点归档。
3. 下载完成后会完整读一遍文件算摘要（GB 级约数秒），换取续传场景下的强校验。
4. 未实现自动重试：失败由 job 记录，由用户或模型显式重试。
