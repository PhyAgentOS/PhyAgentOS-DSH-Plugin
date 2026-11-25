# 安全模型

## 1. 信任边界

forge 会下载并执行第三方制品，信任模型必须显式：

| 输入 | 风险 | 控制 |
|---|---|---|
| skill bundle（tar.gz） | 解包越界、覆盖文件 | 拒绝绝对路径与 `..`；拒绝符号链接/硬链接条目（`FORGE_ARCHIVE_UNSAFE`）；staging + 原子替换 |
| 节点制品（tar.gz） | 解包越界、覆盖文件及不可信可执行文件 | 禁止绝对成员路径、路径遍历与硬链接。仅目录型节点接受留在包内的相对软链接，解包不经由软链接写入。继续核对锁定摘要并检查入口是否为可执行的普通文件。 |
| 注册表（HTTP） | 中间人替换制品 | 只信任 `https:`；presigned URL 自带摘要；构建 `sha256` 与大小双校验 |
| skill 文档（SKILL.md） | 提示注入 | 文档是指令不是权限；动作必须经过工具与用户意图 |

## 2. 摘要与来源

- 安装先 `GET /v1/skills/{name}` 拿 `sha256` + `size`，下载后校验；续传完成后整文件重新计算摘要。
- 节点以 skill 锁为摘要权威：锁与注册表不一致时拒绝安装（`FORGE_NODE_INTEGRITY`）。
- 缓存目录记录 `.artifact.json`（artifactId/sha256/version/verifiedAt）；没有记录或摘要不符的目录不会被当作已安装。

## 3. 执行

- 只启动 manifest 声明的 dataflow；`start.sh` 钩子当前未实现（M2 显式不做）。
- 运行时环境变量来自 `profile.environment` 与宿主环境；日志与事件不含凭据。
- 物理动作：`forge_tool_call` 可能让真机运动。工具描述已声明；超时/未知结果禁止自动重试。

## 4. 配置台

| 面 | 边界 |
|---|---|
| API 路由 | 注册在 DSH 自带 web server 上，走它的会话鉴权；prefix `/forge/api`，仅同源可用 |
| 独立控制台 | 仅 `ui.standalone: true` 时启动，绑定 `127.0.0.1`，**无身份认证**，等价于本机文件写权限 |
| 写操作 | 只接受 `application/json`（跨站表单无法伪造该 content-type 而不触发预检） |
| 配置写入 | 只写 profile 的 `cordis.patch.yml` 用户层；校验键与类型；写前备份 |
| 文件编辑 | 只能访问 `profiles/<id>/` 内的 YAML/JSON/Markdown；路径必须落在该目录内；写前做 YAML 解析校验；备份到 `<home>/runtime/backups` |

远程访问（`--public-url`、Liveshare）下，API 走宿主同源路由，不需要把 19080 暴露出去；**不要**把独立控制台端口映射到公网。

## 5. 凭据

- `registry.token` 可写在 profile 配置里（文件权限由 DSH 管理），或使用 `DSH_FORGE_REGISTRY_TOKEN` / `tokenEnv` 指向环境变量。
- token 只用于注册表请求；不写入日志、事件与 doctor 报告。
- 下载使用 presigned URL，不携带 token。

## 6. 文件系统

- `<home>` 必须由宿主账户可写；skill 根只读时安装会失败并给出明确错误。
- 迁移/复制类操作已移除；skill 只来自注册表或手动放入 `skills/`。
- 缓存 GC 只删除 `runtime/nodes` 下未被引用目录，不触碰 skills 与运行中的流程。

## 7. 依赖与供应链

- 运行时依赖只有 `yaml` 与 `tar`，无构建脚本；发布预构建 `lib/`，安装不执行包脚本。
- 客户端 bundle 只从平台模块表解析 externals，不引入额外来源。
- CI 校验 `release:verify`：导出、`dsh.client`、engines、依赖钉版本、client 产物存在。
