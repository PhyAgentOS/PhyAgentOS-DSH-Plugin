# 部署与配置

## 1. 配置在哪一层

DSH 的"插件配置"不是插件目录里的配置文件，也不是设置界面，而是**配置树里那一行的 `config`**。forge 的行由组合包 `@xera/dsh-forge` 插入，默认不带 config：

```yaml
# forge/bundle/cordis.patch.yml
- insert:
    - id: forge-skill
      name: '@xera/dsh-forge-skill'
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
| `home` | `''` → `$DSH_HOME/forge` | 数据根：`skills/`、`runtime/{nodes,env,cache,logs}`、`state.json` |
| `skills.roots` | `[]` → `[<home>/skills]` | skill 目录，按顺序取第一个同名；相对路径相对 `home` |
| `skills.watch` | `true` | 递归监视 roots 并 `invalidate()` |
| `registry.url` | 平台地址 | 资源注册表根地址 |
| `registry.timeoutMs` | `20000` | 注册表请求超时 |
| `runtime.dora` | `''` → `$DSH_FORGE_DORA` → `dora` | Forge 1 的 Dora CLI（0.4.1） |
| `runtime.dora1` | `''` → `$DSH_FORGE_DORA1` → `dora1` | Forge 2 的 Dora CLI（1.0.1，`dora run`） |
| `runtime.startTimeoutMs` | `120000` | 等 Gateway 就绪的上限 |
| `gateway.callTimeoutMs` | `15000` | Tool API 调用超时，会被网关上限截到 20000 |
| `gateway.dynamic` | `off` | `off`/`whitelist`/`all`：按 ToolSpec 注册类型化工具 |
| `gateway.dynamicSkills` | `[]` | 白名单模式下的 skill 列表 |
| `prompt.usageSkill` | `true` | 注册内置 `forge-usage` skill（也可 `/forge-usage` 调用） |
| `prompt.developmentSkill` | `true` | 注册内置 `forge-skill-development` skill（skill 开发指南） |
| `prompt.section` | `true` | 注入 forge 工具使用约定到系统提示 |

环境变量（优先级高于默认值，低于行配置）：`DSH_FORGE_HOME`、`DSH_FORGE_REGISTRY_URL`、`DSH_FORGE_DORA`。

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

- `registry.url` 指向内网镜像（当前客户端匿名访问，没有 token 支持）。
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

插件默认在 `http://127.0.0.1:19080/` 起一个只监听回环的配置台，随插件启停：

```yaml
- id: forge-skill
  config:
    ui:
      port: 19080      # 改端口需要重启进程
      enabled: true    # false 关闭界面
```

**标签一：插件配置（只读审阅）** —— 显示 DSH profile 的 `cordis.patch.yml` 里 `forge-skill` 那一行的当前值：

- 字段只读展示，对应 §2 的配置项；
- 修改由 agent 通过配置回写能力或人工编辑 YAML 完成；页面负责审阅与回滚；
- "历史备份"列出 `cordis.patch.yml.bak-*`，点击即恢复（恢复前会把当前文件再备份一次）。

**标签二：Skill Profile 预览（只读）** —— 查看已安装 skill 的 `profiles/<id>/` 下的 YAML/JSON/Markdown：

- 只能访问 `profiles/<id>/` 内的文件，`skill.yaml`、`SKILL.md` 只读；
- 修改由 agent 调用 `forge_profile_write` 完成（校验、备份、返回 diff、提示重启运行时）。

安全边界：只监听 `127.0.0.1`，没有身份认证，等同于本机文件写权限；不要把端口转发到公网。

## 7. 生产注意事项

1. **一个 forge home 只给一个宿主进程写**。`state.json` 是原子写但没有跨进程锁，两个宿主共用同一 home 会互相覆盖运行时状态。多实例请一实例一 home。
2. **和 GUI 的关系**：插件页可以启停组合包行，但 forge 还没有配置界面；改配置目前只能编辑 `cordis.patch.yml`。要图形化需要单独做一个设置页。
3. **磁盘**：skill 副本 + node 制品可达数 GB（本机实测 3.5 GB），`home` 要留足空间。
4. **权限**：`home` 必须可写；只读挂载的 skills root 无法安装。
5. **Gateway 端口**：Gateway 地址来自 manifest，不提供配置覆盖。多个 skill 共用同一端口时必须串行启动，doctor 会报 `gateway_url is already in use`。
6. **物理安全**：真实 skill 的 `runtime.start` 可能让机械臂移动到初始位；上线前确认 `required_environment`、标定和急停流程。
