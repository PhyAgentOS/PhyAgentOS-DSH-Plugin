# M4 验收报告 · DSH 原生配置界面

日期：2026-11-12。

## 1. 交付

| 部分 | 文件 | 说明 |
|---|---|---|
| 客户端插件 | `packages/skill/client/index.tsx` | 注册到插件页 `plugins.item`，条目「Forge 配置」；两个视图 |
| 客户端构建 | `scripts/build-client.mjs` | esbuild → `window.__ModuleLoader__.load({id, factory})`，不依赖 DSH 构建脚本 |
| 同源 API | `packages/skill/src/ui/api.ts` | `handleApi` 由两种传输共用 |
| Web 路由 | `packages/skill/src/index.ts` | `ctx.inject(['webServer'], …)` + `webServer.register({kind:'prefix', path:'/forge/api'})` |
| 独立控制台 | `packages/skill/src/ui/server.ts` | 改为 `ui.standalone: true` 才启动，默认关闭 |

客户端 externals 仅使用平台模块表（`react`、`react/jsx-runtime` 等），样式为内联，不引入 CSS/资源管线。

## 2. 验证

| 项 | 结果 |
|---|---|
| 客户端产物 | `lib/client.js` 17.7 KB，加载后注册 `@xera/dsh-forge-skill` factory |
| 插件页条目 | 单测：`apply(ctx)` 依次调用 `slots.inject('plugins.item')` → `slots.register({id:'forge-config'})` |
| 宿主启动 | `dsh --profile m0test --port 3091` 启动无激活错误 |
| 客户端图 | 启动载荷包含 `"id":"@xera/dsh-forge-skill","url":"plugins/??@xera/dsh-forge-skill/client.js&rev=cc25e44d9163"` |
| bundle 可取 | `GET /plugins/??@xera/dsh-forge-skill/client.js&rev=…` → 200，17,784 字节 |
| 同源 API | `GET /forge/api/profiles` → `{"profiles":["m0test","web"],"current":"m0test"}`；`/forge/api/skills` 返回 5 个 skill |
| 回归 | `pnpm test` → **16 passed / 0 failed** |

## 3. 未自动验证

浏览器实际渲染。当前环境没有可用的无头浏览器，已验证到"图里有条目、bundle 可取、factory 注册正确、API 同源可用"。人工验收：

1. `pnpm dsh web --patch ./scratch-plugin/cordis.yml`（加载新构建）；
2. 打开插件页，应出现「Forge 配置」条目；
3. 两个视图分别读写配置与 profile 文件，保存后显示备份路径。

## 4. 行为说明

- API 挂在 DSH 自带 web server 上，鉴权/远程访问由宿主承担；不再需要 19080。
- 独立控制台保留为 `ui.standalone: true`（调试用），默认关闭。
- 配置保存后插件按新配置重挂，页面需要重新读取；写入失败/校验失败在卡片内提示。
