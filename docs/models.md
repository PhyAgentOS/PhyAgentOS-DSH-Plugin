# Forge 共享模型目录设计（`<FORGE_HOME>/models`）

[运维手册](operations.md) · [使用手册](usage.md) · [Usage (EN)](usage_en.md)

本文档定义 `PhyAgentOS-DSH-Plugin` 中本地模型权重目录（默认 `~/.dsh/forge/models`）的布局规范、路径解析、Skill 声明式依赖、运行时注入以及插件内模型检索接口。

## 1. 设计目标与目录定位

`<FORGE_HOME>` 下各顶层目录按生命周期和变更频率职责分离：

```text
~/.dsh/forge/
├── skills/          # 版本化 Skill 包（轻量，支持打包、备份与回滚）
├── support/         # 跨 Skill 工具链与运行时（dora、dora1-venv 等）
├── runtime/         # 运行态与可重建产物（state.json、env/、nodes/、cache/、logs/、reports/）
└── models/          # 跨 Skill 共享的模型权重与元数据（高下载成本、纯数据、显式校验）
```

将 `models/` 独立为与 `skills/`、`support/`、`runtime/` 并列的顶层目录，基于三条边界原则：

1. **与 Skill 包解耦**：模型权重动辄数 GiB（如 `sam3.pt` 3.45 GiB 或 VLA/Depth 模型），不随 Skill 打包或 `.backups` 备份，允许多个 Skill（如 `vlm-grasp-autoloop` 与 `vlm-grasp-autoloop-fx2`）复用同一份本地权重。
2. **与运行态解耦**：`runtime/` 语义为运行态与可重建缓存；`models/` 为高成本持久资产，不会被常规节点 cache GC 误删。
3. **权重与 Python 环境解耦**：`models/` 只保存纯权重文件和 JSON 元数据，不包含带绝对路径的 Python venv，因此可直接挂载或迁移到独立大容量磁盘/NAS；推理 venv 仍留在 `<skill>/support/venv` 或 `support/`。

## 2. 目录布局规范

```text
<modelsRoot>/
├── registry.json                  # （可选）本地模型汇总索引
├── cache/                         # 未完成下载（.part 断点续传）与临时校验区
└── <model-id>/
    └── <revision>/                # 版本或镜像修订，如 pinned_mirror、v1
        ├── receipt.json           # 元数据：filename、sha256、size、source、tags、description、license、installedAt
        ├── sam3.pt                # 主权重文件（单文件或多文件目录）
        └── ...                    # 附属配置/词表/处理器文件（如 config.json）
```

### 保留名与兼容布局

- 顶层保留名：`cache`、`blobs`、`registry.json` 以及以 `.` 开头的隐藏条目，检索时自动跳过。
- 兼容平铺目录：如果用户手工将权重文件直接放到 `<modelsRoot>/<model-id>/<weight-file>`（未建 `<revision>/` 子目录），`ModelStore` 仍会以 `revision: "default"` 识别并纳入检索。

### `receipt.json` 字段约定

```json
{
  "id": "sam3",
  "revision": "pinned_mirror",
  "filename": "sam3.pt",
  "sha256": "<64-hex-sha256>",
  "size": 3450062241,
  "source": "squarefk/sam3-mirror",
  "description": "SAM3 vision grounding checkpoint for grasp segmentation",
  "tags": ["vision", "segmentation", "sam3"],
  "license": "SAM-License",
  "installedAt": "2026-11-06T11:21:00.000Z"
}
```

- 缺少 `receipt.json` 不会阻断扫描与检索；`ModelStore` 会按常见权重后缀（`.safetensors`、`.pt`、`.pth`、`.ckpt`、`.onnx`、`.gguf`、`.bin`、`.engine`、`.trt`、`.weights`）自动推断主权重文件，并在 `forge_model_verify` 中标记 `status: "unverified"`。
- `receipt.json` 格式损坏时不会导致整体检索失败，而是输出 `FORGE_MODEL_RECEIPT_INVALID` 诊断条目。

## 3. 路径解析与配置

模型根目录按以下优先级解析（实现见 `packages/core/src/paths.ts`）：

1. DSH profile 行配置 `models.root`（相对路径基于 `<FORGE_HOME>` 解析，支持 `~`）
2. 环境变量 `DSH_FORGE_MODELS`
3. 默认值 `<FORGE_HOME>/models`（通常为 `~/.dsh/forge/models`）

在 `~/.dsh/profiles/web/cordis.patch.yml` 中的配置示例：

```yaml
- id: forge-skill
  config:
    models:
      root: ~/.dsh/forge/models   # 可改为独立数据盘，如 /data/forge-models
      mirror: https://hf-mirror.com  # 可选，公共 Hub 镜像端点（供准备脚本参考，非内网托管）
```

## 4. `skill.yaml` 声明式模型依赖与运行时注入

Skill 可在 `skill.yaml` 顶层或具体 `profiles.<id>` 下声明可选字段 `required_models`（profile 级同 `id` 条目覆盖顶层声明，完全向后兼容既有 manifest）：

```yaml
required_models:
  - id: sam3
    revision: pinned_mirror
    filename: sam3.pt
    sha256: "..."
    env: SAM3_CHECKPOINT_PATH
    optional: false
```

### 运行时行为

1. **启动前检查（`preflight`）**：
   - 检查每个声明的模型是否存在、指定 `filename` 是否就绪、以及（若声明了 `sha256`）`receipt.json` 记录的摘要是否匹配。
   - 非 `optional` 模型缺失或摘要不匹配会阻断启动；`optional: true` 或缺少 `receipt.json` 仅产生 `warn`。
   - 若某模型声明了 `env` 且本地已解析成功，该变量同时视为满足 `required_environment`。
2. **环境变量注入（`materialize` / `flowEnv`）**：
   - 统一注入 `FORGE_MODELS_DIR=<modelsRoot>`（同时替换物化 dataflow 中的 `${FORGE_MODELS_DIR}` 占位符）。
   - 对每个已解析且声明了 `env` 的模型，自动注入 `<env>=<resolvedPath>`；优先级为 `profile.environment` / 宿主 `process.env` 覆盖自动解析值，保留用户手工覆盖能力。
   - `runtime-lock.json` 同步记录 `modelsRoot` 与 `modelEnv` 快照。
3. **兼容既有 Skill（以 SAM3 为例）**：
   - 既有 `deploy/sam3/runtime.py` 本身优先读取 `SAM3_CHECKPOINT_PATH`，未设置时才回退到 `~/.local/share/vlm-grasp-autoloop/sam3/models/sam3.pt`。
   - 因此将权重迁入 `~/.dsh/forge/models/sam3/pinned_mirror/sam3.pt` 并在 `skill.yaml` 声明 `env: SAM3_CHECKPOINT_PATH` 后，现有推理脚本无需改动即可无缝切换。

## 5. 插件内模型检索与校验接口

核心能力统一实现于 `packages/core/src/models.ts`（`ModelStore`）与 `ForgeOperations`，DSH 插件、CLI 和 MCP 共享同一层：

| 能力 | DSH / MCP 工具 | CLI 命令 | 说明 |
| --- | --- | --- | --- |
| 搜索 / 列出本地模型 | `forge_model_search` | `forge models [query] [--id <id>] [--tag <tag>] [--skill <name>]` | 支持按自由文本（id/revision/描述/标签/文件名/来源/引用 skill）、精确 `id`、`tag`、`skill` 过滤；只读 |
| 查看单个模型详情 | `forge_model_info` | `forge model <id> [revision]` | 返回主权重路径、全部文件及体积、`receipt.json`、可用修订列表、引用该模型的已安装 skill；只读 |
| 校验权重完整性 | `forge_model_verify` | `forge model-verify <id> [revision]` | 流式计算主权重文件 SHA256 并与 `receipt.json` 比对，返回 `verified` / `unverified` / `mismatch` / `missing`；只读 |

同时，`forge_environment_check`（`forge env`）也会检查并汇报：

- `models` 项：模型根目录路径、已安装模型数与总占用体积（及 `receipt.json` 异常诊断）；
- `variables` 项：检测 `DSH_FORGE_MODELS` 是否设置；
- `runtime.isolation.injected`：记录 `FORGE_MODELS_DIR`。

## 6. Skill 准备脚本下载与接入规范

### 架构边界：不通过内网 Registry 托管模型权重

- **Forge Resource Registry 只分发轻量的 Skill 包与节点制品，不托管、不中转大模型权重**（单模型通常 3 GiB ~ 数十 GiB，内网存储与带宽成本过高）。
- 模型权重统一在 Skill 准备阶段由 **Skill 自带的下载脚本**（或离线介质拷贝）直接从公共源/公共镜像（如 HuggingFace、HF Mirror、ModelScope）拉取；DSH 插件保持纯 Node.js、零 Python/Hub 依赖，仅负责 **目录契约、跨 Skill 检索、SHA256 验签、启动前门禁与环境变量注入**。

### 下载脚本接入 4 条约定

Skill 准备脚本（如 `deploy/<model>/download.sh`）遵守以下约定，即可与插件无缝衔接：

1. **先查后下（跨 Skill 复用）**：
   - 下载前先检查目标路径是否存在且 SHA256 与预期一致（Agent 侧也可先调用 `forge_model_search` / `forge_model_verify`）；若其它 Skill 已下载同版本权重，直接复用，跳过重复拉取。
2. **统一落盘到 `$FORGE_MODELS_DIR/<id>/<revision>/`**：
   - 优先读取 `FORGE_MODELS_DIR`（未设置时回退到 `$HOME/.dsh/forge/models`），将权重写入：
     ```text
     ${FORGE_MODELS_DIR:-$HOME/.dsh/forge/models}/<model-id>/<revision>/<filename>
     ```
   - 兼容老路径覆盖（如 `SAM3_CHECKPOINT_PATH`）：显式指定时尊重用户路径，未指定时默认指向上述共享目录。
3. **断点续传与原子落盘**：
   - 未完成下载写入 `${FORGE_MODELS_DIR}/cache/<model-id>-<revision>-<filename>.part`（或同目录临时 `.part` 文件），切勿直接写入最终文件名；
   - 下载完成并校验 SHA256 通过后，再原子 `mv` 到 `<model-id>/<revision>/<filename>`，避免损坏文件被误识别为有效模型。
4. **写入标准 `receipt.json`**：
   - 原子落盘后在同一目录生成 `receipt.json`（至少包含 `id`、`revision`、`filename`、`sha256`、`size`、`source`、`tags`、`installedAt`），必要时一并保存 `LICENSE` 文件。
   - 落盘完成后可通过 `forge model-verify <id> [revision]`（或 `forge_model_verify`）独立复核。

### 脚本接入示例（Shell）

```bash
#!/usr/bin/env bash
set -euo pipefail

MODELS_ROOT="${FORGE_MODELS_DIR:-$HOME/.dsh/forge/models}"
MODEL_ID="sam3"
REVISION="pinned_mirror"
FILENAME="sam3.pt"
TARGET_DIR="${MODELS_ROOT}/${MODEL_ID}/${REVISION}"
CACHE_DIR="${MODELS_ROOT}/cache"
TARGET_FILE="${SAM3_CHECKPOINT_PATH:-${TARGET_DIR}/${FILENAME}}"
PART_FILE="${CACHE_DIR}/${MODEL_ID}-${REVISION}-${FILENAME}.part"

mkdir -p "$(dirname "$TARGET_FILE")" "$CACHE_DIR"

# 1. 若目标已存在且 SHA256 校验通过，直接复用
# 2. 否则从公共 Hub / Mirror 下载到 "$PART_FILE"，校验 SHA256 后原子 mv 到 "$TARGET_FILE"
# 3. 在 "$TARGET_DIR/receipt.json" 写入标准元数据（id/revision/filename/sha256/size/source/tags/installedAt）
```

### 后续演进方向（可选）

如果后续希望由 Agent 在对话中受控触发模型下载，可在 `skill.yaml` 增加声明式准备脚本钩子（例如指向包内 `deploy/download.sh`），由插件通过 `JobRunner` 注入 `FORGE_MODELS_DIR` 执行脚本、记录日志到 `runtime/logs/`，并在脚本结束后由插件调用 `ModelStore.verify()` 做独立验签——同样无需任何内网权重存储。

