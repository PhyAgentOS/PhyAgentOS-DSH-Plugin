# 部署与配置

[安装与使用](usage.md) · [发布手册](releasing_zh.md) · [README](../README_zh.md)

先把组合包安装到实际启动的 DSH profile：Web 使用 `dsh plugin --profile web add @x-era/dsh-forge`，源码宿主在 deepseek-harness 仓库执行 `pnpm dsh plugin --profile web add @x-era/dsh-forge`。安装到 dev 不会启用在 web；新增组合包后重启对应宿主。

## 1. 配置在哪一层

DSH 的"插件配置"不是插件目录里的配置文件，也不是设置界面，而是**配置树里那一行的 `config`**。forge 的行由组合包 `@x-era/dsh-forge` 插入，默认不带 config：

```yaml
# forge/bundle/cordis.patch.yml
- insert:
    - id: forge-skill
      name: '@x-era/dsh-forge-skill'
```

生效值按层叠加，后者覆盖前者：

| 层 | 位置 | 用途 |
|---|---|---|
| 1 | 代码里的 schema 默认值 | 兜底 |
| 2 | 组合包的 `cordis.patch.yml` | 发行默认值（当前为空） |
| 3 | profile 的 `cordis.patch.yml` | **用户/部署配置写这里** |
| 4 | `$DSH_HOME/cordis.patch.yml` | 本机所有 profile 共享的偏好 |
| 5 | `--patch <file>` | 临时覆盖 |

关键规则：**patch 替换目标行的整个 `config`，不是深合并**。所以覆盖时只要写你想改的键即可 —— 未写的键会回落到 schema 默认值，不会继承第 2 层里同名的键（当前第 2 层为空，所以没有差别）。

## 2. 配置项

| 键 | 默认 | 含义 |
|---|---|---|
| `home` | `''` → `DSH_FORGE_HOME` → `$DSH_HOME/forge` → `~/.dsh/forge` | 数据根：`skills/`、`runtime/{nodes,env,cache,logs,state.json}` |
| `skills.roots` | `[]` → `[<home>/skills]` | skill 目录，按顺序取第一个同名；相对路径相对 `home` |
| `skills.watch` | `true` | 递归监视 roots 并 `invalidate()` |
| `registry.url` | 平台地址 | 资源注册表根地址 |
| `registry.timeoutMs` | `20000` | 注册表请求超时 |
| `registry.token` | `''` | 显式 Bearer token；优先使用环境变量，避免把真实密钥写入配置仓库 |
| `registry.tokenEnv` | `''` → `DSH_FORGE_REGISTRY_TOKEN` | 读取 token 的宿主环境变量名 |
| `runtime.dora` | `''` → `$DSH_FORGE_DORA` → `dora` | Forge 1 的 Dora CLI（0.4.1） |
| `runtime.dora1` | `''` → `$DSH_FORGE_DORA1` → `dora1` | Forge 2 的 Dora CLI（1.0.1，`dora run`） |
| `runtime.startTimeoutMs` | `120000` | 等 Gateway 就绪的上限 |
| `gateway.callTimeoutMs` | `15000` | Tool API 调用超时，会被网关上限截到 20000 |
| `gateway.dynamic` | `off` | `off`/`whitelist`/`all`：按 ToolSpec 注册类型化工具 |
| `gateway.dynamicSkills` | `[]` | 白名单模式下的 skill 列表 |
| `prompt.usageSkill` | `true` | 注册内置 `forge-usage` skill（也可 `/forge-usage` 调用） |
| `prompt.developmentSkill` | `true` | 注册内置 `forge-skill-development` skill（skill 开发指南） |
| `prompt.section` | `true` | 注入 forge 工具使用约定到系统提示 |
| `prompt.runtimeRules` | `true` | 注入运行时安全与调用约定 |
| `ui.enabled` | `true` | 有 Web 服务时注册同源配置 API |
| `ui.standalone` | `false` | 是否额外启动本机独立配置台 |
| `ui.port` | `19080` | 独立配置台端口，不是 DSH Web 的端口 |

环境变量（优先级高于默认值，低于有效行配置）：`DSH_FORGE_HOME`、`DSH_FORGE_REGISTRY_URL`、`DSH_FORGE_REGISTRY_TOKEN`、`DSH_FORGE_DORA`、`DSH_FORGE_DORA1`。CLI/MCP 不读取 DSH 行配置，需用环境变量对齐自定义数据根、registry 和可执行文件。

## 3. 服务器部署示例

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: forge-skill
  config:
    home: /srv/dsh/forge
    skills:
      roots: [/srv/dsh/forge/skills]
      watch: true
    registry:
      url: https://paos-resource-platform.x-era.com
    runtime:
      dora: /usr/local/bin/dora
      startTimeoutMs: 180000
    gateway:
      callTimeoutMs: 15000
```

也支持 `!!js` 表达式：

```yaml
- id: forge-skill
  config:
    home: !!js process.env.FORGE_HOME ?? '/srv/dsh/forge'
```

改 profile 的 `cordis.patch.yml` 会触发 HMR 重新组合，插件以新配置重挂，不需要重启进程；**增删 bundle 仍然要重启**。

## 4. 三种配方

**A. 桌面单用户（默认）**

什么都不配。`~/.dsh/forge`，注册表用平台地址，节点制品按需下载并缓存。

**B. 服务器 / 多人共用一台**

- `home` 放到 `/srv/dsh/forge`，属主机账户可写（安装要写盘）。
- `skills.watch: false` 可选：`forge_skill_install` 完成后插件自己会 `invalidate()`，热生效不依赖 watcher；关掉可以省掉对多 GB 目录的 inotify。
- 固定 dora 版本（0.4.1 baseline），用绝对路径。

**C. 内网 / 离线**

- `registry.url` 指向内网镜像；需要鉴权时通过 `registry.tokenEnv` 引用 Bearer token 环境变量。
- 没有可用注册表时，直接把 bundle 放到 `home/skills`；`forge_skill_install` 会失败并返回 `FORGE_REGISTRY_UNAVAILABLE`。

## 5. 节点管理（NodeStore）

节点制品由 forge 自己管理，不读取任何外部 PhyAgentOS 目录。

- **布局**：`<home>/runtime/nodes/<artifact_id>/<entrypoint>`，旁边 `.artifact.json` 记录 `sha256`、`version`、`verifiedAt`。
- **键**：缓存按 `artifact_id`（含版本/平台/架构）寻址。同一个节点被多个 skill 锁定时只下载一次，后续直接复用。
- **校验**：下载后与 skill 锁里的 `sha256` 比对（锁与注册表不一致也拒绝）；解包后检查 entrypoint 可执行；校验通过才写元数据并原子替换目录。
- **安装时预装**：`forge_skill_install` 默认连节点一起装（`nodes: true`），对应 PhyAgentOS "install 拉取 locked nodes" 的语义；`nodes: false` 只装 bundle。
- **启动前只读检查**：`preflight` 不下载，只报告 `ready / unverified / missing / mismatch`；`runtime.start` 只补缺失项。
- **状态含义**：`ready`=有摘要记录且与锁一致；`unverified`=文件在但没有摘要记录（例如旧版本留下的），下次安装/启动会被重新下载覆盖。

## 6. 配置界面（UI）

默认 `ui.enabled: true` 会在有 `webServer` 服务的 DSH Web 宿主中注册同源 `/forge/api`。该 API 支持 profile 配置读取/写回、备份恢复和 skill profile 文件访问；插件工具与内置 skill 的注册不依赖独立配置台，也不保证 Web 主界面新增独立 Forge 菜单。

独立配置台默认关闭，需要调试时显式开启：

```yaml
- id: forge-skill
  config:
    ui:
      enabled: true
      standalone: true
      port: 19080
```

随后访问 `http://127.0.0.1:19080/`。`ui.port` 只控制独立配置台，不改变 DSH Web 的端口。

配置台提供插件配置的只读审阅与备份恢复、已安装 skill profile 文件的预览。配置写回与 profile 编辑由相应 API、Agent 工具或人工编辑完成；profile 文件写入会校验、备份并提示运行时重启。

独立配置台只监听 `127.0.0.1`，没有独立身份认证；恢复/写回具备本机文件写权限，不要转发到公网。同源 API 的访问控制由 DSH Web 宿主承担。

## 7. 生产注意事项

1. **明确数据根和运行时归属**。管理层在安装、启停、profile 写入和 GC 等操作中使用跨进程锁；CLI/MCP 可对齐同一 `DSH_FORGE_HOME`。多宿主隔离部署时仍建议使用不同 home，避免并行控制同一个 skill runtime；这不是分布式调度系统。
2. **和 GUI 的关系**：工具、skill、同源配置 API 与独立配置台是不同入口。默认不启动 19080 端口；需要独立配置台时开启 `ui.standalone`，不要将“没有额外菜单”直接判断为工具未注册。
3. **磁盘**：skill 副本 + node 制品可达数 GB（本机实测 3.5 GB），`home` 要留足空间。
4. **权限**：`home` 必须可写；只读挂载的 skills root 无法安装。
5. **Gateway 端口**：Gateway 地址来自 manifest，不提供配置覆盖。多个 skill 共用同一端口时必须串行启动，doctor 会报 `gateway_url is already in use`。
6. **物理安全**：真实 skill 的 `runtime.start` 可能让机械臂移动到初始位；上线前确认 `required_environment`、标定和急停流程。
