# 运行耗时分析（agent 层 / skill 层）

数据来源：本次会话日志 `~/.dsh/sessions/.../session.v4.jsonl.zstd`、forge 事件日志 `~/.dsh/forge/runtime/logs/events.jsonl`、dora 节点日志、以及各次工具调用的返回体。

---

## 1. 实测汇总

### 1.1 端到端回合（wall clock，含模型推理）

| 回合 | 内容 | 总耗时 | 模型推理 | 工具/等待 |
|---|---|---|---|---|
| 79 | 小幅关节运动（一次 action） | **86.7 s** | **74.3 s** | 12.4 s（其中 12 s 是我 `sleep`） |
| 76 | 启动 `robot-control-sim-fx2` | 53.3 s | 50.3 s | 3.0 s（`runtime_start` 本身约 3 s） |
| 80 | 分析耗时 | 121.8 s | 120.4 s | 1.3 s |
| 81 | 查 reasoningEffort 配置 | 68.8 s | 66.9 s | 1.8 s |
| 82 | 关闭 skill | 27.6 s | 25.6 s | 2.0 s |

**结论：回合耗时中模型推理占 86%–99%。**

### 1.2 单次模型调用

| 指标 | 实测 |
|---|---|
| 每次推理耗时 | 9.2 s / 13.1 s / 13.9 s / 12.5 s / **25.5 s**（turn 79） |
| 单次请求输入 token | 最高 **568,952**（turn 83）；近期稳定在 55 万–57 万 |
| 输出 token | 几百（每次工具轮通常 200–700） |

输入上下文 56 万 token、输出几百 token —— **时间几乎全花在重发与预填充上下文上**，而不是生成。

### 1.3 skill 运行时（与模型无关的真实执行）

| 操作 | 耗时 | 说明 |
|---|---|---|
| `robot-control-sim` 安装 | **501 s（8m21s）** | bundle 14 MB + 9 个节点制品约 1.1 GB，sha256/size 校验 |
| `robot-control-sim-fx2` 启动 | **≈3 s** | Forge 2，9 节点，源码运行 |
| `vlm-grasp-autoloop-fx2` 启动 | 网关就绪 <5 s；**端点注册滞后** | 20 节点 + SAM3；启动后立即提交会命中竞态 |
| 单关节 2.62 rad 运动（vs=0.2） | **24.58 s**（规划值 24.54 s） | 与公式吻合 |
| 全关节到极限（vs=0.2） | 规划 29.08 s，**24.44 s 中止** | `PATH_TOLERANCE_VIOLATED`（joint2 偏差 0.5 rad） |
| 直接回初始位（vs=0.3） | **16.19 s** | 残差 ≤0.008 rad |
| `grasp.pick_place` 完整抓放 | **21.01 s** | 11 次运动 15.67 s、VLM 5 次 2.06 s、SAM3 ≈1.5 s |
| 小幅关节运动 | **1.22 s** | 6 关节 ≤0.1 rad 增量 |
| 夹爪收 0（未达标） | 8.0 s 超时 | `EXECUTION_TIMED_OUT`，`reached_goal=false` |
| 失败路径（定位失败/规划失败/不可达） | 0.01–4.7 s | 快速失败，无运动 |

---

## 2. 耗时构成

```text
一次"让机械臂动一下"的端到端 86.7 s：
  模型推理  ████████████████████████████████████████  74.3 s  (86%)
  我主动 sleep ███████                              12.0 s  (14%)
  网关 RPC + 运动   ▏                                1.3 s  (1.5%)
```

```text
一次完整抓放 21.0 s（skill 层，不含模型）：
  运动会话  ███████████████████████  15.7 s  (75%)
  VLM 规划  ███                       2.1 s  (10%)
  SAM3 分割 ██                        1.5 s   (7%)
  网关/调度 █                         1.7 s   (8%)
```

---

## 3. Agent 层优化方向

> 目标：把"下发动作 + 读结果"从 ~86 s 压到 ~20 s。

| # | 问题（证据） | 优化 | 预期收益 |
|---|---|---|---|
| A1 | 单次输入 56 万 token（turn 83），推理 9–25 s | **每个任务开新会话**，或让上下文压缩（compaction）及时触发；长会话只用于连续任务 | 单次推理可降到数秒 |
| A2 | `reasoningEffort = max`（会话级 `model/selection` 实测） | 动作类轮次用 `medium`（GUI 模型选择器改本会话；默认行 `agent-default-model` 改新会话） | 推理时间 −30%~50% |
| A3 | 一次动作拆成 4–5 个模型轮（读状态→下发→等待→读结果→总结） | **合并独立调用**：同一 step 内并发查询；动作下发前不必重复读状态 | 减少 2–3 次推理，省 20–40 s |
| A4 | 固定 `sleep 12/30/45/60 s` | 改为：提交后按预期时长等待（1–3 s），再用 `forge_invocation_read` 轮询；RPC 本身只有 10–60 ms | 每次省 8–70 s |
| A5 | `forge_invocation_read` 同时返回 `status.result` 与 `result.result`（同一内容两份） | 插件侧去重，只回一份 | 上下文少约 1/2 的结果体积 |
| A6 | `grasp.pick_place` 结果含 46 个 step（数万 token） | 插件侧默认回摘要（`ok/verified/mode/arm/error/timing` + 失败步骤），细节按需再取 | 单次结果 token −80% |
| A7 | 启动后立即提交 → `no active provider instance`（0.01 s 失败） | 启动流程加一步：先用只读 query（如 `get_frame`）确认端点已注册，再提交会话 | 消除一类无效回合（约 30 s） |
| A8 | 模型花时间读 bundle 内部文件（turn 81 大量 bash 读文件） | 用 `forge_skill_read` / `forge_skill_docs` 一次取回，避免多轮 grep | 每任务省 1–3 次推理 |

---

## 4. Skill 层优化方向

> 目标：把真实执行时间降到接近物理极限，并消除"晚失败"。

| # | 问题（证据） | 优化 | 预期收益 |
|---|---|---|---|
| S1 | 轨迹时长受 quintic 峰值系数 1.875 与 `velocity_scale` 双重放大：2.62 rad @vs0.2 = 24.5 s | 提高默认 `velocity_scale`（0.2→0.5），或暴露 `requested_duration_ms`；给"快速/安全"两套 profile | 同一动作 **24.5 s → 9.8 s**（vs0.5） |
| S2 | 全关节极限位在 24.4 s 中止（joint2 偏差 0.5 rad） | 极限姿态自动降速（按关节余量算 vs），或放宽 `path_position_tolerance`（当前 0.15 rad） | 避免"跑到一半失败"的 25 s 浪费 |
| S3 | 复位：`settle_ms=500` 后立即回位，撞上控制器保持目标 → `PLANNING_FAILED`（两次） | 把 `settle_ms` 提到 1.5–2 s，或等实测速度 < `start_velocity_tolerance` 再规划 | 复位一次成功率↑，避免两次 8–16 s 失败 |
| S4 | 启动就绪判定不含 provider 注册（`gateway /tools` ready 但 `vision.vlm` 未注册） | 健康判定加入"每个 required endpoint 有活动 provider" | 消除启动竞态 |
| S5 | 浅盘/小容器拒绝桌面释放；`container` 只支持"放入"，不支持"叠放" | 增加 `target_kind: container \| surface \| stack`；浅盘自动走 `release_z_m` 而非报错 | 减少无效规划（4.7 s/次）与人工参数试错 |
| S6 | 可达域边界不透明：抓取点 `y=-0.449` 超左臂 `reach_bounds`，右臂无连续路径（4.05 s 失败） | 在 `locate_grasp` 返回"可达余量"，或视觉层对失败点换 yaw/tilt 重试一次 | 把"边缘物体"变成可诊断提示 |
| S7 | 夹爪收 0 超时 8 s（限位在 −0.009） | 目标先做限位夹紧（`clamp(target, limits)`），或在容差内提前判定完成 | 每次省 8 s |
| S8 | 便携性缺陷：帧目录写死 `~/.PhyAgentOS/skill-frames`；`vlm_vision` 曾写死 `nodes/motion_server/.venv`（已修） | 帧目录进 profile 配置；解释器解析统一为 `support/venv` 优先 | 换机器/换用户不再失败 |
| S9 | 20 节点全量启动 + SAM3 常驻 HTTP | 按 profile 懒启动未用节点（单臂 profile 不启另一侧）；SAM3 预热复用 | 启动与空闲资源下降 |
| S10 | 安装 8m21s（1.1 GB 节点） | 节点下载并发 + 断点续传 + 复用 `artifact_id` 缓存（已有缓存键，缺并发） | 首次安装可缩短 30%–50% |

---

## 5. 优先级建议

| 优先级 | 动作 | 负责层 | 预期总收益 |
|---|---|---|---|
| P0 | 动作轮用 `medium` reasoning；任务开新会话 | agent | 单轮 −30%~60% |
| P0 | 去掉固定 sleep，改短轮询；合并查询 | agent | 每轮 −10~70 s |
| P0 | `invocation_read` 去重、会话结果摘要化 | agent（插件） | 上下文 −50%~80% |
| P1 | 轨迹默认速度提升 / 暴露时长参数 | skill | 运动 **−60%** |
| P1 | 启动就绪判定加入 provider 注册 | skill | 消除启动竞态失败 |
| P1 | 复位 settle 与夹爪限位处理 | skill | 消除 8–16 s 失败 |
| P2 | 容器语义扩展（stack/surface） | skill | 支持新任务类型 |
| P2 | 帧目录/解释器等便携性清理 | skill | 换机可用 |
| P3 | 节点下载并发、按 profile 懒启动 | skill | 安装/启动更快 |

---

## 6. 复现方法

```bash
# 回合与推理耗时（agent 层）
F=~/.dsh/sessions/<session>/session.v4.jsonl.zstd
zstd -dc "$F" | python3 - <<'PY'
import sys, json, collections
by=collections.defaultdict(list)
for line in sys.stdin:
    e=json.loads(line); t=e.get('data',{}).get('turn')
    if t is not None: by[t].append(e)
for t, ev in sorted(by.items()):
    model=tools=0.0; n=0; prev=None
    for e in ev:
        ts=e.get('time'); ty=e.get('type'); d=(ts-prev)/1000 if prev else 0
        if ty=='assistant/message': model+=d
        if ty=='tool/result': tools+=d; n+=1
        prev=ts
    print(t, round((ev[-1]['time']-ev[0]['time'])/1000,1), round(model,1), round(tools,1), n)
PY

# 真实执行耗时（skill 层）
~/.dsh/forge/support/bin/dora1 logs <flow> | grep -E "motion|elapsed|stage"
```

> 注：本文所有"agent 层"数字来自同一会话的日志实测；"skill 层"数字来自各次 `forge_tool_call` / `forge_invocation_read` 的返回体（`motion_result.elapsed_ns`、`timing` 等）。未标注的均为估计值，已在文中写明。