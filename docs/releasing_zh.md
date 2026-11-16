[English](releasing.md) | 中文

# npm 独立发版

每个包独立版本、独立 tag；根目录保持 `private: true`。一个 tag 只发布一个包，
不会批量发布五包。手动重试也必须指定已存在的 tag。

| npm 包 | 源码目录 | tag 示例 |
| --- | --- | --- |
| `@x-era/forge-core` | `packages/core` | `forge-core/v0.1.0` |
| `@x-era/dsh-forge-skill` | `packages/skill` | `dsh-forge-skill/v0.1.0` |
| `@x-era/forge-cli` | `packages/cli` | `forge-cli/v0.1.0` |
| `@x-era/forge-mcp` | `packages/mcp` | `forge-mcp/v0.1.0` |
| `@x-era/dsh-forge` | `bundle` | `dsh-forge/v0.1.0` |

## 首次准备

使用 Node.js 24.22.3、npm 11.19.1、pnpm 11.28.5、Git 和 `gh`。npm 账号需验证邮箱、启用 2FA，
并有 npm `x-era` 组织的发布权限。npm 与 GitHub 的账号和组织互相独立。

```sh
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm org ls x-era --registry=https://registry.npmjs.org
```

发布代码先通过个人 fork 的 PR 合入上游 `main`。推送源分支和创建 PR 前分别
执行 `gh api user --jq .login`，核实为 `mrgh97`。不要向上游推送开发分支。

## 一个包的首次发布

新包可能需要先交互式发布一次，才能在 npm 包设置中配置 OIDC。先创建本地 tag，
在该 tag 的提交上执行发布；命令只处理 tag 指定的一个包：

```sh
git fetch origin main
git switch main
git merge --ff-only origin/main
pnpm install --frozen-lockfile
pnpm test

git tag forge-core/v0.1.0
pnpm release:publish forge-core/v0.1.0
```

按 npm 提示在浏览器/终端完成验证。成功后推送同一个 tag，不移动、不重建：

```sh
git push origin refs/tags/forge-core/v0.1.0
```

tag 工作流重新打包，与 npm 记录的源码提交和 tarball SHA512 比对。完全一致时
跳过重复发布，再创建或完成 GitHub Release 并附上该 tarball。不一致直接失败，
不会覆盖已存在版本。

首次五包按依赖顺序执行，每包分别创建 tag、`release:publish`、推送 tag：

1. `forge-core`
2. `dsh-forge-skill`
3. `forge-cli`、`forge-mcp`（两者顺序不限）
4. `dsh-forge`

开发依赖使用 `file:` 链接；`release:prepare` 生成五包发布目录，将内部依赖
改为精确版本，带上源码仓库信息、README 和 LICENSE。最终只打包/发布 tag
指定的包。若对应内部依赖版本尚未在 npm 发布，先发布依赖包；无需联动升级所有包。

## 每包配置 OIDC

分别进入五个 npm 包的 Settings → Trusted publishing，添加 GitHub Actions：

- Organization/user：`PhyAgentOS`
- Repository：`dsh-PhyAgentOS`
- Workflow filename：`publish.yml`
- Environment：留空（当前工作流没有使用 GitHub Environment）
- 允许直接执行 `npm publish`

工作流使用 GitHub 托管 runner、Node.js 24.22.3、npm 11.19.1 和 `id-token: write`，
不需要 `NPM_TOKEN`。新建配置后须在 npm 要求的期限内完成首次 OIDC 发布验证
（目前为两天），因此可在下一次发版前配置。跳过已发布版本的核验不算 OIDC
首次发布验证。官方说明：https://docs.npmjs.com/trusted-publishers/。

## 后续独立发版

例如只升级 core：在个人 fork 的新 PR 分支执行：

```sh
npm pkg set version=0.1.1 --prefix packages/core
pnpm install --lockfile-only
pnpm test
pnpm release:prepare
pnpm release:verify
```

提交并按正常审查流程合入主分支后，给合并后的提交打 tag，不给未合并开发分支打 tag：

```sh
git fetch origin main
git switch main
git merge --ff-only origin/main
node -p "require('./packages/core/package.json').version"
git tag forge-core/v0.1.1
git push origin refs/tags/forge-core/v0.1.1
```

工作流只发布 `@x-era/forge-core@0.1.1`，其余四包版本不变。如果要发布使用新版
core 的消费包，再单独升级并发布那个包。发布依赖版本由 tag 提交中的源码 manifest
决定，打 tag 前通过 `release:prepare` 检查；依赖的精确版本必须先发布到 npm。

正式版本自动使用 `latest`；如 `forge-core/v0.2.0-rc.1` 的预发布自动使用 `next`。
不接受带 build metadata 的 tag，正式版本也不能将 `latest` 降级。

## 验证安装

```sh
npm view @x-era/dsh-forge version dependencies --registry=https://registry.npmjs.org
dsh plugin --profile release-check add @x-era/dsh-forge
dsh --profile release-check --dump-config
dsh --profile release-check
```

确认 `forge-skill` 行、两个内置 skill（`forge-usage`、`forge-skill-development`）
和 `forge_*` 工具出现。插件安装不等于安装 Dora 或真机/仿真依赖。
发布 CLI、MCP 时还需分别验证，例如：

```sh
npm exec --yes --package=@x-era/forge-cli -- forge --help
```

## 失败重试

```sh
gh run list --repo PhyAgentOS/dsh-PhyAgentOS --workflow publish.yml --limit 10
gh workflow run publish.yml --repo PhyAgentOS/dsh-PhyAgentOS --ref forge-core/v0.1.1
```

手动选择 `main` 不会发布。已存在版本仅在源码提交和 tarball 校验均相同时视为成功。
网络、认证和非 404 错误不会被当成“包不存在”。错误内容已经发布时，修代码后增加
版本号；不要强推 release tag，不要重用 npm 已发布版本。
