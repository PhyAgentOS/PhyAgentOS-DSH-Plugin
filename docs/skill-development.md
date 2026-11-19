# Skill 开发指南

本页说明一个 forge skill bundle 由什么组成、节点如何组织、运行时如何启动，以及本地怎么迭代。
发布（上传到资源平台）目前**不支持**，见文末。

## 1. bundle 结构

```text
<name>/
├── SKILL.md                  # 给 agent 的工作流说明（正文）
├── skill.yaml                # manifest v2：profile、依赖、制品锁
├── profiles/<profile>/
│   ├── dataflow.yaml         # Dora 图：节点、入口、端口连线
│   ├── gateway.yaml          # ToolSpec 目录与 provider 路由
│   └── *.yaml                # 各节点自己的配置（simulator/motion/controller…）
├── assets/                   # URDF/MJCF/模型等随包资产
├── docs/                     # 可选：开发文档（如 adding-a-robot.md）
├── scripts/                  # 可选：打包辅助脚本
└── archive-manifest.json     # 可选：打包元数据
```

`SKILL.md` 没有 frontmatter；catalog 的 `name`/`description` 来自 `skill.yaml`。

## 2. skill.yaml

```yaml
manifest_version: 2
name: robot-control-sim          # kebab-case，必须与目录名一致
version: "0.1.3"
description: >-                  # 模型目录里展示的一句话
  ...
skill_document: SKILL.md
gateway_url: http://127.0.0.1:19002   # Skill 级，所有 profile 共用
required_tools: [sim.get_robot_info]  # 顶层默认值
profiles:
  mujoco-piper:
    dataflow: profiles/mujoco-piper/dataflow.yaml
    required_binaries: [gateway, mujoco_sim, ...]   # node id，对应 artifacts.nodes
    required_assets: [assets/robots/piper/robot.yaml, ...]
    required_environment: []        # 必须由外部提供的变量名
    environment: { }                # 固定值
    required_tools: [...]           # 覆盖顶层，而不是追加
artifacts:
  nodes:
    gateway:
      artifact_id: gateway-1.0.2-linux-x86_64-tar-gz
      version: 1.0.2
      platform: linux
      arch: x86_64
      artifact_type: executable_tar_gz   # 或 directory_tar_gz
      entrypoint: gateway
      sha256: <64 位十六进制>
```

规则：

- `required_tools` 在 profile 里是**覆盖**；
- `gateway_url` 是 Skill 级字段，profile 不能各自不同；
- 同一 gateway 地址一次只能跑一个运行时；
- `platform/arch` 用 `x86_64`/`aarch64`（不是 Node 的 `x64`）。

## 3. dataflow.yaml

```yaml
nodes:
  - id: gateway
    path: ${FORGE_RUNTIME_BIN}/gateway     # 由运行时替换为本次物化的 bin 目录
    args: --config gateway.yaml            # 相对 dataflow 所在目录
    inputs:
      sim_tool_in: sim_control_policy/tool_out
      tick: dora/timer/millis/50
    outputs: [sim_tool_out, action_tool_out]
  - id: sim_control_policy
    path: ${FORGE_RUNTIME_BIN}/sim_control_policy
    ...
```

- `${FORGE_RUNTIME_BIN}` 在环境物化时替换成绝对路径；其他相对路径（配置、资产）以 dataflow 所在目录为基准；
- 端口名由你自己定义，但 `gateway.yaml` 的 `providers` 路由必须与 dataflow 的连线一致；
- `dora/timer/millis/N` 是内置节拍源。

## 4. gateway.yaml

```yaml
host: 127.0.0.1
port: 19002
tools:
  enabled: true
  invoke_timeout_ms: 60000
  specs:
    - tool_id: sim.get_robot_info
      endpoint_id: sim.control
      operation: get_robot_info
      semantics: query        # query | action | session
      input_schema: { type: object, properties: {}, additionalProperties: false }
  providers:
    - endpoint_id: sim.control
      input_id: sim_tool_in
      output_id: sim_tool_out
```

`tool_id` 是模型看到的稳定名字；`endpoint_id/operation` 决定调用路由；`semantics` 决定同步还是 202 + invocation。

## 5. 节点制品

| 类型 | 归档结构 |
|---|---|
| `executable_tar_gz` | 根目录直接是名为 `entrypoint` 的可执行文件 |
| `directory_tar_gz` | 根目录是名为 `entrypoint` 的目录，内含可执行文件与运行时依赖树 |

打包后计算 `sha256sum` 与字节数写入 `skill.yaml` 的锁；注册表 `/v1/forge-nodes/{artifact_id}` 提供下载地址、大小、摘要，以及 `github_url`（节点源码仓库）。

```sh
tar -C dist -czf gateway-1.0.2-linux-x86_64.tar.gz gateway
sha256sum gateway-1.0.2-linux-x86_64.tar.gz
```

安全约束：解包拒绝绝对路径、`..`、符号链接/硬链接；entrypoint 必须可执行；摘要与大小强校验。

## 6. 运行时如何启动（forge 内部顺序）

1. 读 manifest，选择 profile；
2. preflight：dora 可用、所需二进制、资产、环境变量、gateway 端口；
3. `NodeStore` 补齐节点：按 `artifact_id` 缓存，下载 → 校验 → 解包 → 写 `.artifact.json`；
4. 物化环境 `runtime/env/<skill>/<profile>/<hash>/`：`bin/` 软链到节点、`launch/` 复制 bundle（排除 nodes）、替换 `${FORGE_RUNTIME_BIN}`、写 `runtime-lock.json`；
5. `dora up`（必要时）→ `dora start <launch>/<profile>/dataflow.yaml --name <flow> --detach`；
6. 轮询 `GET {gateway_url}/tools` 直到就绪，状态置 `healthy`；
7. 停止：`dora stop --name <flow>`。

`start.sh` 钩子**未实现**：不要在 bundle 里依赖它。

## 7. 本地开发闭环

```sh
# 1. 放到受管目录（或任意路径用 validate 检查）
cp -r my-skill ~/.dsh/forge/skills/

# 2. 结构校验（不安装）
forge validate ~/.dsh/forge/skills/my-skill
#    DSH 里：forge_skill_validate {path}

# 3. 看依赖与缺口
forge inspect my-skill
forge doctor my-skill --profile <id>

# 4. 启动并调用
forge start my-skill <profile>
forge call my-skill <tool_id> '{"...":1}'

# 5. 改 profile → 重启 → 再看日志
forge stop my-skill
forge logs my-skill
```

改 `SKILL.md` / `skill.yaml` 后目录会热更新；改 profile YAML 用 `forge_profile_write`（会校验+备份+diff），然后重启运行时。

## 7.5 可移植性规则（强制）

bundle 是分发单元，不是某台机器的运行现场。以下内容**不得**出现在 `skill.yaml`、`dataflow.yaml`、
profile 配置、脚本或 `SKILL.md` 中：

| 禁止 | 正确做法 |
|---|---|
| 主机绝对路径（`/home/...`、`/tmp/...`、某用户的仓库路径） | 节点 `path` 用 `${FORGE_RUNTIME_BIN}` / `${PAOS_SKILL_ROOT}`；配置用 `${PAOS_SKILL_ROOT}/profiles/<id>/x.yaml` |
| 机器特有的解释器、venv、模型目录 | 由 `support/setup.sh` 在 bundle 内构建 `support/venv`；外部资源走 profile 的 `required_assets` |
| 显示/设备相关的运行现场（`DISPLAY=:1`、窗口数量、某台相机序列号） | 由宿主环境或 profile 的 `required_environment` 提供，文档只写“需要图形显示” |
| 本次运行观测数据（实测耗时、某次残差、当前网关端口） | 端口写在 `skill.yaml` 的 `gateway_url`；实测数据只进验收记录，不进 bundle |
| 为特定 case 打的补丁（改死的参数、临时跳过、调试开关） | 参数进 profile 配置并提供默认值；调试改动在打包前回退 |

判断标准：把 bundle 拷到另一台同架构、干净环境的机器上，`forge_skill_validate` → 安装 → 启动
应当不需要改任何文件。做不到就说明有机器泄漏。

`SKILL.md` 只描述契约：工具与路由、启动语义、环境要求、与上游版本的差异。它不描述某台机器的
安装步骤，也不复述端口（端口是 `gateway_url` 的事实）。

## 8. 节点源码仓库从哪看

- 注册表节点元数据里的 `github_url` → `forge_node_info {artifact_id}`（CLI：`forge node-info <artifact_id>`）；
- bundle 自带的 `docs/` → `forge_skill_docs {name}` / `forge skill docs`；
- `skill.yaml` 的锁只记录 artifact 身份与摘要，不记录源码 commit。

## 9. 发布（当前不支持）

- 客户端只实现只读注册表（`GET /v1/skills`、`/v1/skills/{name}`、`/v1/forge-nodes/{id}`），**没有上传接口**；
- 上游平台的外部提交按官方说明尚未开放；
- 需要内部分发时，可以自建一个只实现上述 GET 契约的注册表，或在开发机/CI 里直接把 bundle 放进 `~/.dsh/forge/skills/`；
- 一旦有了上传服务，补一个 `registry.publish` 即可，manifest 与摘要格式已经固定。

## 10. 上游仓库目录（参考）

来源：PhyAgentOS-core `docs/user_development_guide/track_b/REPOSITORIES.md`。

| 类别 | 仓库 |
|---|---|
| 框架 | `forge`（common / msgs / robot / policy / kinematics / tool；接口 `forge_tool`、`forge_msgs`） |
| Adapter · Gateway | `adapter-forge-gateway`（HTTP、Tool 路由、readiness） |
| Adapter · 相机 | `adapter-camera-orbbec`、`adapter-camera-realsense`、`adapter-camera-usb` |
| Adapter · 机器人 | `adapter-robot-piper`、`adapter-franka-fr3`、`adapter-robot-so101`、`adapter-robot-xlerobot`、`adapter-robot-zerith_h1_pro` |
| Adapter · Viewer | `adapter-viewer-image` |
| Operator · 控制 | `operator-controls`（joint_trajectory_controller、gripper_action_controller） |
| Operator · 运动 | `operator-motion`（motion_server、motion_action_policy） |
| Operator · 策略 | `operator-gripper-action-policy`、`operator-relative-pose-policy`、`operator-kai0`、`operator-lerobot-runner` |
| Operator · 仿真 | `operator-sim-control-policy`、`operator-simulator-mujoco` |
| Benchmark | `benchmark-libero` |

`robot-control-sim` 的 9 个节点来自 7 个仓库：

| 节点 | 仓库 |
|---|---|
| gateway | adapter-forge-gateway |
| sim_control_policy | operator-sim-control-policy |
| motion_server、motion_action_policy | operator-motion |
| joint_trajectory_controller、gripper_action_controller | operator-controls |
| gripper_action_policy | operator-gripper-action-policy |
| mujoco_sim | operator-simulator-mujoco |
| image_viewer | adapter-viewer-image |

仓库数不等于进程数；**权威版本与摘要始终以 `skill.yaml` 的锁为准**。重建的二进制需要新的 artifact id 与摘要。

## 11. 节点协议要点（参考）

来源：`PROTOCOLS.md`、`RUNTIME.md`。

**数据平面**

- 单行 Arrow `RecordBatch`；语义放列里，不放 schema metadata；没有统一 ROS Header。
- Robot Adapter：`connect / disconnect / get_state / set_command`（可选 `set_locomotion_command`），标准 runner 端口 `tick`、`action`/`action/<source>`、`state`。
- `JointState` 名称非空且唯一；`JointCommand` 带 `mode`（position/velocity/effort/hybrid）与 `kp/kd`；转动关节 rad，移动关节 m。
- 相机：`Image` 满足 `len(data)=step*height`；`CompressedImage` 不得伪装成原始图；Orbbec/RealSense 的深度是 `Image(32FC1)` 米制、0 无效（适配器约定）。
- Policy：`PolicyAdapter` 至少 `is_observation_needed`、`generate_action`；内部 `PolicyCommand` 不是 Tool API。
- Motion Action 家族：`MoveJoints`、`MovePose`、`FollowJointTrajectory`、`GripperCommand`；时长是非负 int64 纳秒、相对起点；`MovePose` 用米 + `qx/qy/qz/qw`。
- 仿真：`action` 收 `JointCommand`，发 `proprio_state`、`image/*`；`joint_to_actuator`、`actuator_order` 必须与 MJCF 一致。

**控制平面（三层，别混）**

```
Caller → Gateway:  POST /tools/{tool_id}:invoke（action/session，202）
                   POST /tools/{endpoint}/{operation}:invoke（query，200）
Gateway → provider: forge.tool.endpoint/v1alpha1，ToolMessage（Arrow）
Provider SPI:       query | start,cancel,status,result | start,stop,status,result
```

身份要区分：`request_id`（一次交换）、`invocation_id`（逻辑调用）、`attempt_id`（执行尝试）。HTTP 202、Action 终态与任务判定是不同阶段；取消被接受不等于已物理停止。

## 12. 与 PhyAgentOS 的差异

| 项 | PhyAgentOS | 本 forge |
|---|---|---|
| 发布/上传 | 平台登记流程（当前外部未开放） | 不支持；只读注册表 |
| `start.sh` 钩子 | 启动前执行 | **不执行** |
| AgentTask / 验证 / 进化 | 有 | 无，工具即执行边界 |
| 源码 commit | 由发布流程记录 | 锁里没有；用 `forge_node_info` 查 `github_url` |
| 并发 | 每 skill 单 runtime | 每 gateway 地址单 runtime |

## 13. 仓库路径速查

框架 `forge`：

| 位置 | 内容 |
|---|---|
| `interfaces/forge_msgs/{SCHEMA.md, common, control, sensor, motion, tool}.v1.yaml` | 消息 schema |
| `interfaces/forge_tool/PROTOCOL.md` | Endpoint Wire 契约 |
| `packages/tool/src/forge_tool/endpoint/protocol.py` | provider SPI |
| `packages/tool/src/forge_tool/handler.py` | query/action/session 分发 |
| `packages/robot/src/forge_robot/robot_protocol.py` | RobotDriver 协议 |
| `packages/policy/src/forge_policy/{policy_protocol.py, node_runner.py}` | PolicyAdapter 与 runner |

Adapter / Operator：

| 仓库 | 关键路径 |
|---|---|
| adapter-forge-gateway | `src/forge_gateway/controllers/tool_controller.py`（HTTP 路由）、`src/forge_gateway/services/tool_gateway_service.py`、`tests/test_tool_session.py` |
| operator-motion | `packages/motion_server/{server.py, policy_nodes.py}` |
| operator-controls | `packages/joint_trajectory_controller/`、`packages/gripper_action_controller/`、`scripts/build_pyinstaller.sh` |
| operator-sim-control-policy | `src/sim_control_policy_node/runner.py`、`TOOL_CONTRACTS.md` |
| operator-simulator-mujoco | `src/mujoco_sim/runtime.py` |
| operator-gripper-action-policy | `src/gripper_action_policy_node/runner.py` |
| benchmark-libero | `main.py`、`bench_tool/descriptor.py` |

`robot-control-sim` 的 tool → endpoint/operation → provider 对应：

| tool_id | endpoint / operation | provider node |
|---|---|---|
| `sim.get_robot_info` | `sim.control / get_robot_info` | `sim_control_policy` |
| `sim.set_joint_positions` | `motion.server / move_joints` | `motion_action_policy` |
| `sim.move_eef` | `motion.server / move_pose` | `motion_action_policy` |
| `sim.set_gripper_opening` | `gripper.controller / set_opening` | `gripper_action_policy` |
| `sim.reset` | `sim.control / reset` | `sim_control_policy` |

排障入口：`runtime/logs/events.jsonl`（事件）、`runtime/jobs/<id>.json`（安装）、`runtime/reports/doctor-*.json`（全量诊断）、`runtime/logs/<flow>.log` 与 `dora-coordinator.log`（节点输出）。


## 14. 仓库查询（离线目录）

插件内置了 TrackB 仓库目录（20 个仓库），不需要联网：

| 入口 | 用法 |
|---|---|
| DSH 工具 | `forge_repo_search {query?, category?}`、`forge_repo_info {id_or_node}` |
| CLI | `forge repos [query] [--category adapter]`、`forge repo <id_or_node>` |
| MCP | 同名工具 |

字段：`id`、`url`、`category`、`role`、`description`、`keyPaths`、`nodes`（该仓库产出的节点）、`endpoints/operations`、`snapshot`（TrackB 检查时的完整 commit）。

注意：

- `snapshot` 是**文档撰写时**的源码快照，不是当前安装制品的保证；安装制品的权威身份在 `skill.yaml` 的锁里；
- 目录可离线查询，但**不能取源码内容**；需要看具体文件时用 `github_url` + tag/commit 通过 web 工具或本地 clone；
- 注册表 `GET /v1/forge-nodes/{id}` 只给 `github_url`（仓库级），没有 tag/commit，因此“版本 → 源码”仍需人工确认。


## 15. 版本与锁定

平台新增了版本接口：

```text
GET /v1/skills/{name}            → 当前版本（version/sha256/size/download_url）
GET /v1/skills/{name}/versions   → { current_version, items: [{version, sha256, state, profiles, tags}] }
GET /v1/skills/{name}?version=X  → 指定版本（sha256/size/download_url 均不同）；不存在返回 404
```

对应能力：

| 入口 | 用法 |
|---|---|
| DSH 工具 | `forge_skill_versions {name}`、`forge_skill_install {name, version?}`、`forge_skill_update {name, version?}` |
| CLI | `forge versions <name>`、`forge install <name> --version x`、`forge update <name> --version x` |
| MCP | 同名工具 |

安装后会校验 manifest 里的 `version` 与请求版本一致，不一致直接 `FORGE_MANIFEST_INVALID`。
版本行不含 `size`，只有指定版本的单条详情里有。

## 16. 启动模式与 Forge 世代

三个互相独立的维度：

| 维度 | 取值 | 由什么决定 |
|---|---|---|
| Forge 世代 | 1 / 2 | `skill.yaml` 的 `forge_version`，决定 dora 二进制（`runtime.dora` / `runtime.dora1`）与契约 |
| 启动模式 | `start` / `run` | **启动时选择**：`forge_runtime_start {mode}`、CLI `forge start … --run`；默认 `start` |
| 节点形态 | 编译制品 / 源码解释器 | dataflow 的 `path`：占位符 vs venv 绝对路径 |

- `dora run` 两代都有，都不使用 coordinator；`start` 用 `dora up` + `dora start --detach`，flow 注册在 coordinator，按名字停止；
- `run` 生命周期归进程：forge 记录 pid，停止时杀进程组；
- 源码直跑不是 Forge 2 的特性：Forge 1 的 dataflow 同样可以指向 venv；Forge 2 也可以使用编译制品。

实测（`robot-control-sim-fx2`）：

```text
forge start robot-control-sim-fx2 mujoco-piper-fx2 --run   → launch=run, pid 记录, 19102 healthy
forge start robot-control-sim-fx2 mujoco-piper-fx2         → launch=start, dora1 coordinator 6013
```


## 17. 部署参数注入

coordinator 模式下节点由 daemon 启动，CLI 的环境传不到节点。forge 在物化时把部署环境合并进**节点级 `env`**（dora 0.4.x 不支持 dataflow 顶层 `env`，会报 unknown field）：

| 来源 | 例子 |
|---|---|
| A. `profile.environment` | `PROBE_FIXED: fixed-from-skill` |
| B. `required_environment`（manager 进程里有值） | `PROBE_REQUIRED=from-host` |
| forge 运行时变量 | `FORGE_RUNTIME_BIN`、`PAOS_SKILL_*`、`PAOS_RUNTIME_INSTANCE_ID`、`FORGE_FLOW_ID` |

要点：

- 节点级 env 优先于继承环境；写入 `runtime/env/.../launch/.../dataflow.yaml` 时权限 0600，**不改已安装的 skill**；
- `FORGE_FLOW_ID` 是清理标记：stop 时扫描 `/proc/*/environ`，能回收 flow 失败后残留、已被 reparent 的节点进程；
- 密钥类变量会落到 `runtime/env` 下的副本里，敏感场景优先用 `run` 模式或 daemon 环境；
- `DISPLAY` 等机器级变量仍取决于 daemon 如何启动（共享 daemon 会带進來旧的 PAOS 变量，节点级注入只覆盖同名键）。

验证样本：`fixtures/skills/env-probe`（已安装到 `~/.dsh/forge/skills/env-probe`），节点打印六个注入变量并写 `/tmp/forge-env-probe.json`；`start` 与 `run` 两种模式都能看到 A/B 注入值：

```sh
PROBE_REQUIRED=from-host forge start env-probe default        # coordinator
PROBE_REQUIRED=from-host forge start env-probe default --run  # isolated
cat /tmp/forge-env-probe.json
forge stop env-probe
```
