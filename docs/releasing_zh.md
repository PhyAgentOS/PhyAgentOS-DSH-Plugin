[English](releasing.md) | 中文 · [README](../README_zh.md) · [使用手册](usage.md)

# npm 独立发布手册

[发布工作流](../.github/workflows/publish.yml) · [Actions](https://github.com/PhyAgentOS/dsh-PhyAgentOS/actions/workflows/publish.yml) · [GitHub Releases](https://github.com/PhyAgentOS/dsh-PhyAgentOS/releases) · [npm 包管理](https://www.npmjs.com/settings/x-era/packages)

## 当前发布方式与版本文件

五个公共 npm 包均已完成实际的 GitHub Actions OIDC 发布验证。日常发版使用 trusted publishing，不需要本地 npm 登录或 `NPM_TOKEN`。新增包、修改 npm 信任配置时再进行对应授权。

一个 tag 只发布一个包。根目录 `package.json` 保持私有；`dist/publish` 是生成目录，不是版本号的修改入口。

| npm 包 | 修改版本的位置 | 发布 tag |
| --- | --- | --- |
| [`@x-era/forge-core`](https://www.npmjs.com/package/@x-era/forge-core) | [packages/core/package.json](../packages/core/package.json) | `forge-core/v<version>` |
| [`@x-era/dsh-forge-skill`](https://www.npmjs.com/package/@x-era/dsh-forge-skill) | [packages/skill/package.json](../packages/skill/package.json) | `dsh-forge-skill/v<version>` |
| [`@x-era/forge-cli`](https://www.npmjs.com/package/@x-era/forge-cli) | [packages/cli/package.json](../packages/cli/package.json) | `forge-cli/v<version>` |
| [`@x-era/forge-mcp`](https://www.npmjs.com/package/@x-era/forge-mcp) | [packages/mcp/package.json](../packages/mcp/package.json) | `forge-mcp/v<version>` |
| [`@x-era/dsh-forge`](https://www.npmjs.com/package/@x-era/dsh-forge) | [bundle/package.json](../bundle/package.json) | `dsh-forge/v<version>` |

npm 包管理页需要具备组织权限的账号；普通用户使用各包的公共页面即可。

## 日常独立发版

使用工作流对应的工具链：Node.js 24.22.3、npm 11.19.1、pnpm 11.28.5。

### 1. 只修改目标包

以下以未来 CLI 的 `0.1.2` 为例；选定版本前确认 npm 上尚未发布该版本。

```sh
git switch -c fix/release-forge-cli-0.1.2
npm pkg set version=0.1.2 --prefix packages/cli
pnpm install --lockfile-only
pnpm test
pnpm release:prepare
pnpm release:verify
```

检查 `dist/publish/@x-era/forge-cli/package.json`。源码里的 `file:` 依赖会被替换为当前源码 manifest 中的精确版本，这些依赖版本必须已经在 npm 公开。

依赖顺序为 core → skill 插件 → 组合包；CLI 和 MCP 只依赖 core，可彼此独立发布。升级一个包不要求其他包一起改版本。

### 2. 通过个人 fork PR 合入 main

发布源分支前、创建 PR 前分别执行：

```sh
gh api user --jq .login
```

核对实际登录身份（当前维护者默认 `mrgh97`），Git 作者和提交者保持一致。开发分支使用个人 fork 下的 `feature/`、`fix/` 或 `docs/`，不要向上游仓库推送开发分支。检查通过后合并到 `main`。

### 3. 在合并后的 main 上创建对应 tag

```sh
git fetch origin main
git switch main
git merge --ff-only origin/main
node -p "require('./packages/cli/package.json').version"
git tag forge-cli/v0.1.2
git push origin refs/tags/forge-cli/v0.1.2
```

确认打印的版本确实为 `0.1.2` 后再打 tag。这里 `origin` 指向上游 `PhyAgentOS/dsh-PhyAgentOS`。只有本地 tag 不会触发流水线；新 tag 到达远端后才触发。合并 PR 或普通 main 推送不发布 npm。

工作流校验当前提交就是 tag 提交、工作区干净、包版本和仓库元数据匹配，并确认提交属于 `origin/main`，随后测试并仅发布该包。正式版本用 `latest`；如 `forge-cli/v0.2.0-rc.1` 的预发布用 `next`。不接受 build metadata，也不允许将正式版 `latest` 降级。

### 也可以在 GitHub 页面创建

在上游仓库依次选择 Releases → Draft a new release → Choose a tag → Create new tag，填写完整 tag（例如 `forge-cli/v0.1.2`），Target 选择已合并的 `main`，然后发布 Release。

新建 tag 会触发同一条 push 工作流。给已经存在的 tag 添加 Release 不会重新产生 tag push；仅保存草稿也不等于完成发布。

### 4. 检查结果

先看 [Actions](https://github.com/PhyAgentOS/dsh-PhyAgentOS/actions/workflows/publish.yml)，再查 npm 精确版本：

```sh
npm view @x-era/forge-cli@0.1.2 version gitHead dist.integrity _npmUser --json --prefer-online --registry=https://registry.npmjs.org
gh release view forge-cli/v0.1.2 --repo PhyAgentOS/dsh-PhyAgentOS
```

成功后 GitHub Release 会附带实际发布的 npm tarball。OIDC 发布在 npm 中记录的发布者为 GitHub Actions。使用真实 npm 安装验证消费者入口，详见 [使用手册](usage.md)。

## npm 自动发布授权

逐个打开 npm 包的 Settings → Trusted publishing → GitHub Actions：

| 字段 | 值 |
| --- | --- |
| Organization or user | `PhyAgentOS` |
| Repository | `dsh-PhyAgentOS` |
| Workflow filename | `publish.yml`，仅文件名 |
| Environment | 留空；当前工作流未声明 environment |
| Allow direct npm publish | 开启 |

工作流使用 GitHub 托管 runner 和 `id-token: write`，不需要长期发布 token。新配置必须在两天内完成一次真正的自动发布；跳过已发布版本的校验不算验证。npm 保存设置时不会核验字段是否正确，应以实际发布结果为准。[npm 官方说明](https://docs.npmjs.com/trusted-publishers/)。

批量配置多个包时，npm 验证页可能提供五分钟内跳过重复 2FA 的选项。应及时完成每条新生成的验证链接；npm 后台处理可能超过这个验证窗口。

## 新包的首次发布

已有五个包的日常发版不需要重复此步骤。引入新包时，先把新包映射和 tag 触发规则加入发布脚本/工作流，并通过 PR 合并。

包尚未存在时，可能需要先交互式发布一次，才能进入 npm 包设置：

1. 选定未发布版本，在已合并提交上创建本地 tag。
2. 切换到该精确 tag，保持工作区干净。
3. 执行 `pnpm release:publish <package-id>/v<version>`。
4. 用已登录正确 npm 账号的浏览器打开本次新生成的验证链接；CLI 登录与浏览器登录相互独立。
5. 等待脚本核对公开元数据和完整性，再配置该包的 trusted publisher。
6. 用后续新版本的 tag 完成实际 OIDC 发布验证，方式与本仓库已有包相同。

首次上传就绑定了该版本的源码提交和包字节，不要重新指向它的 tag。不同环境重新打包可能产生不同压缩字节；重试已发布版本时必须通过精确 SHA512 比较，不能绕过不一致。

## 自动等待、重试与排障

npm 接收上传后，脚本每 15 秒查询一次精确版本，最多等待约 15 分钟。临时 404 只显示进度，不会立即失败；等待过程不会再次上传。公开后仍会核对源码提交和 tarball SHA512。

只有 404 会重试。认证、网络、其他 registry 错误、内容不符和等待超时仍会失败。超时后检查 npm 服务状态及通知邮件；不能仅凭 404 判断是在扫描还是已被拒绝。

```sh
gh run list --repo PhyAgentOS/dsh-PhyAgentOS --workflow publish.yml --limit 10
gh workflow run publish.yml --repo PhyAgentOS/dsh-PhyAgentOS --ref forge-cli/v0.1.2
```

手动启动必须选择已有发布 tag，不能选择 `main`。已发布版本仅在源码和 tarball 字节都一致时跳过上传；旧 tag 重跑仍使用旧脚本，不会自动获得之后的修复。

| 失败提示 | 处理 |
| --- | --- |
| `Check out the exact release tag` | 比较 `git rev-parse HEAD` 与 `git rev-parse '<tag>^{commit}'`；重试时切换到该 tag |
| tag 与 manifest 不符 | 先通过 PR 修改包版本，再创建匹配的新 tag |
| `Publish dependency first` | 先发布生成 manifest 中的精确依赖版本，并等其公开 |
| npm 的 `Pending validation` | 在截止时间前用一个新版本完成实际 OIDC 发布 |
| npm 授权失败 | 检查 owner、仓库、工作流文件名、environment 及直接发布权限 |
| `different source or bytes` | 核对源码、工具链和打包环境；不要覆盖已存在版本 |
| npm CLI 链接过期 | 重新发起对应操作，使用新生成的验证链接 |

不要强推已发布 tag，也不要重用已发布 npm 版本。已发布内容需要修改时，在 main 修复源码后通过 CI 发布新版本。
