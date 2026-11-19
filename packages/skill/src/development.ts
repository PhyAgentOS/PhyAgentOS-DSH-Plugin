/**
 * Bundled development guide: architecture, repository map and troubleshooting.
 *
 * Organized from the PhyAgentOS TrackB manuals (SKILL_DEVELOPMENT, REPOSITORIES,
 * PROTOCOLS, RUNTIME) with concrete repository paths, narrowed to what this
 * forge implementation actually does; upstream-only features are called out.
 */

export const DEVELOPMENT_SKILL_NAME = 'forge-skill-development'

export const DEVELOPMENT_SKILL_DESCRIPTION =
  'Develop and debug Forge skills: architecture (agent → skill runtime → gateway → providers → data plane), repository/path map, bundle and dataflow/gateway wiring, node protocols, packaging, runtime startup and a troubleshooting matrix.'

export const DEVELOPMENT_SKILL_CONTENT = `# forge-skill-development

Use this when creating, modifying, packaging or debugging a forge skill bundle, or when a forge
runtime/tool call fails and you need to know which layer owns the failure. It follows the PhyAgentOS
TrackB manuals and states where this forge implementation differs.

## 0. Architecture

    DSH agent (model)
      │ calls forge_tool_call / forge_runtime_*
      ▼
    forge manager (this plugin)              home: ~/.dsh/forge
      │ install: registry (GET /v1/skills, /v1/forge-nodes)
      │ runtime: dora up / dora start <dataflow> --name <flow>
      ▼
    Skill Runtime (one per skill+profile)    runtime/env/<skill>/<profile>/<hash>/
      │ Preflight → NodeStore → materialize → dora flow → gateway readiness
      ▼
    Gateway node (HTTP Tool API)             e.g. 127.0.0.1:19002
      │ POST /tools/{tool_id}:invoke | /tools/{endpoint}/{operation}:invoke
      │ GET  /tools, /tools/{id}/context, /invocations/{id}[/result|/cancel|/stop]
      ▼
    Provider nodes (Endpoint + operation)    motion_action_policy, sim_control_policy, …
      │ Endpoint Wire: forge.tool.endpoint/v1alpha1 JSON in Arrow ToolMessage
      ▼
    Data plane (Dora + Arrow RecordBatch)    JointCommand / JointState / Image / trajectories
      ▼
    Hardware adapters or MuJoCo simulator

Four identities must not be conflated: skill (bundle), profile (deployment choice), flow (one Dora
run), gateway (HTTP endpoint). One skill+profile = one flow = one gateway address.

## 1. Repository and path map (upstream)

Framework: github.com/PhyAgentOS/forge

| Area | Paths |
|---|---|
| Message schemas | interfaces/forge_msgs/{SCHEMA.md, common.v1.yaml, control.v1.yaml, sensor.v1.yaml, motion.v1.yaml, tool.v1.yaml} |
| Tool contract | interfaces/forge_tool/PROTOCOL.md (Endpoint Wire) |
| Endpoint SPI | packages/tool/src/forge_tool/endpoint/protocol.py |
| Tool handler | packages/tool/src/forge_tool/handler.py (query / action / session dispatch) |
| Robot driver protocol | packages/robot/src/forge_robot/robot_protocol.py |
| Policy plugin protocol | packages/policy/src/forge_policy/{policy_protocol.py, node_runner.py} |

Adapters

| Repository | Key paths |
|---|---|
| adapter-forge-gateway | src/forge_gateway/controllers/tool_controller.py (HTTP routes), src/forge_gateway/services/tool_gateway_service.py, tests/test_tool_session.py |
| adapter-camera-orbbec | README.md (depth = Image 32FC1 metres, zero invalid) |
| adapter-camera-realsense | README.md (same depth convention) |
| adapter-camera-usb | Rust/V4L2 camera, raw/compressed images |
| adapter-robot-piper | AgileX Piper driver + models |
| adapter-franka-fr3 | Franka FR3v2 + Franka Hand |
| adapter-robot-so101 | SO101 serial/Feetech driver |
| adapter-robot-xlerobot | dual-arm mobile robot |
| adapter-robot-zerith_h1_pro | H1 Pro joint/base SDK |
| adapter-viewer-image | consumes Forge image messages |

Operators

| Repository | Key paths |
|---|---|
| operator-motion | packages/motion_server (server.py, policy_nodes.py), motion_action_policy |
| operator-controls | packages/joint_trajectory_controller, packages/gripper_action_controller, scripts/build_pyinstaller.sh |
| operator-sim-control-policy | src/sim_control_policy_node/runner.py, TOOL_CONTRACTS.md |
| operator-simulator-mujoco | src/mujoco_sim/runtime.py |
| operator-gripper-action-policy | src/gripper_action_policy_node/runner.py |
| operator-relative-pose-policy | motion.relative_pose / resolve (Query) |
| operator-kai0, operator-lerobot-runner | policy.runner / serve (Session), alternative deployments |
| benchmark-libero | main.py, bench_tool/descriptor.py |

robot-control-sim locks 9 nodes from 7 repositories:

| Node | Repository |
|---|---|
| gateway | adapter-forge-gateway |
| sim_control_policy | operator-sim-control-policy |
| motion_server, motion_action_policy | operator-motion |
| joint_trajectory_controller, gripper_action_controller | operator-controls |
| gripper_action_policy | operator-gripper-action-policy |
| mujoco_sim | operator-simulator-mujoco |
| image_viewer | adapter-viewer-image |

Repository count is not process count; the installed skill.yaml is the authority for version and
digest. A rebuilt binary needs a new artifact id and validation.

Repository lookup:

- forge_repo_search {query?, category?} — search by repository, node id, endpoint or keyword;
- forge_repo_info {id_or_node} — full entry with key source paths, endpoints/operations and snapshot;
- forge_node_source {artifact_id, file?, refresh?} — read a file from the registry-pinned revision
  (default README.md). The updated registry returns source_status, forge_version and a source object
  with repository_url, ref, ref_type, commit_sha, path, raw_base_url, browse_url and archive_url.
  Files are cached under runtime/sources/<artifact_id>/<commit>/; refresh bypasses the cache.

The skill detail endpoint does NOT carry source pinning; only /v1/forge-nodes/{artifact_id} does.
Older artifacts may have no source object, in which case forge_node_source reports
FORGE_SOURCE_UNAVAILABLE — fall back to github_url + tag from forge_node_info.

## 2. Bundle anatomy and skill.yaml

    <name>/
      SKILL.md                  # workflow text (no frontmatter)
      skill.yaml                # manifest v2
      profiles/<id>/            # dataflow.yaml, gateway.yaml, node configs
      assets/                   # URDF/MJCF/models
      docs/                     # optional authoring docs (forge_skill_docs reads them)
      archive-manifest.json     # optional packaging metadata

Rules: name is kebab-case and matches the directory; skill_document defaults to SKILL.md;
gateway_url is skill-level (one runtime per address); profile required_tools overrides the top-level
list;
\`forge_version: "1" | "2"\` declares the Forge platform generation the bundle targets (default
"1"); the catalog exposes it as \`forge.forgeVersion\`; platform/arch use x86_64 / aarch64 (not Node's x64); artifacts.nodes.<id> pins artifact_id,
version, platform, arch, artifact_type, entrypoint, sha256.

### Portability rules (mandatory)

A bundle is a distribution unit, not one machine's run directory. These must not appear in
\`skill.yaml\`, \`dataflow.yaml\`, profile configs, scripts or \`SKILL.md\`:

- host absolute paths (\`/home/...\`, \`/tmp/...\`): use \`\${FORGE_RUNTIME_BIN}\` or \`\${PAOS_SKILL_ROOT}\`,
  and \`\${PAOS_SKILL_ROOT}/profiles/<id>/x.yaml\` for configs;
- machine-specific interpreters, venvs or model directories: ship \`support/setup.sh\` that builds a
  bundle-local venv, and declare external resources in \`profile.required_assets\`;
- display/device run facts (\`DISPLAY=:1\`, window counts, serial numbers): the host or the profile's
  \`required_environment\` owns them; documentation only states that a display is required;
- one run's observations (measured durations, residuals, current port): ports live in
  \`skill.yaml gateway_url\`; measurements belong in acceptance notes, not the bundle;
- case patches (hard-coded values, temporary skips, debug switches): parameters belong in the profile
  with defaults, and debug edits are reverted before packaging.

Test: copy the bundle to another clean host of the same arch; validate, install and start must need no
file edits. \`SKILL.md\` documents the contract (tools, routes, startup semantics, environment
requirements, differences from upstream) and nothing about one machine's setup.

## 3. dataflow.yaml and gateway.yaml

    nodes:
      - id: gateway
        path: \${FORGE_RUNTIME_BIN}/gateway
        args: --config gateway.yaml
        inputs: { sim_tool_in: sim_control_policy/tool_out, tick: dora/timer/millis/50 }
        outputs: [sim_tool_out]
      - id: sim_control_policy
        path: \${FORGE_RUNTIME_BIN}/sim_control_policy
        inputs: { tool_in: gateway/sim_tool_out, tick: dora/timer/millis/50 }
        outputs: [tool_out]

\${FORGE_RUNTIME_BIN} becomes the materialized bin directory; relative paths (configs, assets) resolve
against the dataflow's directory; dora/timer/millis/N is a built-in tick. Port names are yours, but
gateway providers must match them.

robot-control-sim tools and routes (mujoco-piper):

| tool_id | semantics | endpoint / operation | provider node |
|---|---|---|---|
| sim.get_robot_info | query | sim.control / get_robot_info | sim_control_policy |
| sim.set_joint_positions | action | motion.server / move_joints | motion_action_policy |
| sim.move_eef | action | motion.server / move_pose | motion_action_policy |
| sim.set_gripper_opening | action | gripper.controller / set_opening | gripper_action_policy |
| sim.reset | action | sim.control / reset | sim_control_policy |

## 4. Data-plane contracts

- Single-row Arrow RecordBatch; semantics in real columns, not schema metadata; no universal ROS header.
- Robot adapter: connect / disconnect / get_state / set_command; optional set_locomotion_command.
  Runner ports: tick, action or action/<source>, state. joint_order may be fixed.
- JointState: names nonempty and unique; position/velocity/effort empty or same length.
  JointCommand adds mode (position/velocity/effort/hybrid) and kp/kd; missing mode means position.
  Revolute joints rad, rad/s, Nm; prismatic m, m/s, N.
- Cameras: Image has height/width/encoding/step/data with len(data)=step*height; CompressedImage is
  JPEG/PNG/WebP, never raw. Orbbec/RealSense depth is Image 32FC1 metres with zero invalid.
- Policy: PolicyAdapter needs is_observation_needed and generate_action; the runner owns tick,
  proprio_state, image caches and internal PolicyCommand messages (not a Tool API).
- Motion families: MoveJoints (group, joint_names, positions, velocity/acceleration scales), MovePose
  (group, reference_frame, target_frame, position m + quaternion qx/qy/qz/qw, tolerances),
  FollowJointTrajectory, GripperCommand. Goal/Feedback/Result per family; durations are nonnegative
  int64 nanoseconds relative to start. Gripper units come from controller config, not metres.
- Simulator: JointCommand on action/action/<source>, publishes proprio_state and image/*;
  joint_to_actuator, actuator_order and logical gripper mapping must match the MJCF;
  sim_command / reset_scene is a simulator-control extension.

## 5. Control plane

    Caller → Gateway:  POST /tools/{tool_id}:invoke             (action/session → 202 + invocation_id)
                       POST /tools/{endpoint}/{operation}:invoke (query → 200)
                       GET  /tools, /tools/{id}/context
                       GET  /invocations/{id}, /result; POST /cancel, /stop
    Gateway → provider: forge.tool.endpoint/v1alpha1 JSON envelopes in Arrow ToolMessage
    Provider SPI:       query | start,cancel,status,result | start,stop,status,result

Identities: request_id (exchange), invocation_id (logical invocation), attempt_id (execution attempt),
endpoint instance. JSON integers stay within ±(2^53−1). HTTP 202, Action terminal state and any task
verdict are different stages; accepted cancellation is not physical stop. Check model capability,
handler capability and deployed chain separately — a library feature does not mean every node exposes it.

## 6. Runtime startup order (this forge)

1. read manifest, choose profile; 2. preflight (dora, binaries, assets, env, gateway port);
3. ensure nodes into runtime/nodes/<artifact_id> (download, sha256/size verify, extract, .artifact.json);
4. materialize runtime/env/<skill>/<profile>/<hash>/ (bin symlinks, launch copy, placeholder rewrite,
artifacts recorded in runtime-lock.json); 5. dora up if the coordinator is down; 6. dora start
launch/<profile>/dataflow.yaml --name <flow> --detach; 7. poll gateway_url/tools until healthy.

Stop: dora stop --name <flow>. State lives in runtime/state.json; on load, flows missing from
dora list are reconciled to stopped.

## 6.5 Versions and pins

    GET /v1/skills/{name}            → current artifact (version, sha256, size, download_url)
    GET /v1/skills/{name}/versions   → { current_version, items: [{version, sha256, state, profiles, tags}] }
    GET /v1/skills/{name}?version=X  → the pinned revision (different sha256/size/download_url); unknown → 404

Tools: forge_skill_versions lists every published version plus the current one; forge_skill_install
{name, version?} pins a revision; forge_skill_update {name, apply?, version?} reports installed,
latest, updateAvailable and the available list, and applies the target version. forge verifies the
downloaded manifest version equals the requested one and rejects a mismatch (FORGE_MANIFEST_INVALID).
Version rows do not carry size; the pinned detail does.

## 6.6 Deployment environment

Coordinator mode spawns nodes from the daemon, so a CLI environment never reaches them. During
materialization forge merges the deployment environment into the copied dataflow as **node-level env** (dora 0.4.x rejects a dataflow-level env block):

- A: profile.environment (fixed values such as MODEL_SERVER_URL);
- B: required_environment names present in the manager process environment (e.g. API keys, device URLs);
- runtime vars: FORGE_RUNTIME_BIN, PAOS_SKILL_ROOT/NAME/VERSION/INSTANCE_ID and FORGE_FLOW_ID.

Node-level env wins over inherited env, and the file is written 0600 inside runtime/env (the installed
skill is never modified). FORGE_FLOW_ID is the cleanup marker: on stop forge scans /proc for processes
carrying it, so orphan nodes left by a failed flow are still reaped. Values injected into the dataflow
(including secrets) live in runtime/env; prefer run mode or daemon-level env for secrets you do not want
on disk. The dataflow env block is per node, so data-plane/daemon-level variables such as DISPLAY still
depend on how the daemon was started.

Sample: fixtures/skills/env-probe prints the six injected keys to stdout and /tmp/forge-env-probe.json.

## 7. Packaging and locks

| artifact_type | archive shape |
|---|---|
| executable_tar_gz | root is the executable named entrypoint |
| directory_tar_gz | root is a directory named entrypoint with the executable and runtime tree |

Record sha256 and byte size in the lock; archive type, entrypoint, platform and arch must match.
Forge rejects absolute paths, .., and symlink/hardlink entries; the entrypoint must be executable;
digest and size are verified on download. Dora compatibility baseline for Forge 1 skills:
dora-cli 0.4.1 with dora-message 0.7.0. Forge 2 skills require dora-cli >=1.0.1,<2 with forge-tool
2.x; every node in the flow must be rebuilt for that generation (see section 8). Node repository
READMEs should state production node count, direct tool role, endpoints/operations, HTTP API,
binding and compatibility.

## 8. Dependency policy: forge core packages come from PyPI

The Forge libraries a node imports (\`forge-msgs\`, \`forge-common\`, \`forge-tool\`,
\`forge-robot\`, \`forge-kinematics\`) are published on PyPI. A source-run bundle must
**not** vendor the forge repository; let the package manager resolve them.

Generation rule: **1.x serves Forge 1** (dora 0.4, forge-tool 1.x) and **2.x serves
Forge 2** (dora 1.x, forge-tool 2.x). Which concrete version gets installed is
whatever pip resolves from the nodes' declared ranges, not a number hard-coded in
docs or scripts:

- each node's \`pyproject.toml\` already declares its range (e.g. \`forge-msgs>=2.1,<3\`),
  so installing the node editable pulls the matching generation;
- only packages a node imports without declaring need an explicit line in
  \`support/setup.sh\` (\`forge-kinematics\` is the common example for motion nodes);
- clone the \`forge\` repository only to read or change framework code, never as a
  dependency source; copying \`packages/*\` into a bundle duplicates upstream and
  drifts silently;
- \`dora-rs\` and \`dora-rs-cli\` are on PyPI too (\`dora-rs-cli\` provides the CLI,
  \`dora-rs\` only the node API);
- the venv stays outside the archive (\`support/setup.sh\` rebuilds it), so the first
  build on a target machine needs PyPI access; an offline machine should mirror the
  packages into an internal index rather than re-introduce a vendored copy.

## 9. Local development and install (no upload channel)

This forge has no publishing path: the client only reads the registry (\`GET /v1/skills\`,
\`/v1/forge-nodes\`). Local bundles are distributed by copying them into the managed tree, and local
nodes by materializing them under \`runtime/nodes\`.

    # 1. validate before the bundle touches the managed tree
    forge_skill_validate {path}

    # 2. install = copy; the catalog rescans on directory change
    cp -r <bundle> \$DSH_FORGE_HOME/skills/<name>/     # default ~/.dsh/forge/skills
    forge_skill_inspect {name}
    forge_skill_doctor {name}

    # 3. run and exercise
    forge_runtime_start {name} {profile}
    forge_tool_context -> forge_tool_call -> forge_invocation_read
    forge_runtime_stop {name}

Node artifacts of a local bundle are not downloadable: expand each archive into
\`runtime/nodes/<artifact_id>/\` next to a \`.artifact.json\` holding \`artifactId\`, \`version\`, \`sha256\` and
\`verifiedAt\`. Without that file the loader reports \`FORGE_NODE_MISSING\`; a wrong digest is
\`FORGE_NODE_INTEGRITY\`.

Isolated instances: \`DSH_FORGE_HOME\` selects the whole data root (skills, runtime, logs) and
\`DSH_FORGE_DORA\` selects the dora CLI. Two instances may coexist; never point two hosts at one home,
and never start two runtimes on the same gateway_url.

### Dora generations (never mix inside one flow)

| Generation | dora CLI | forge-tool | gateway | notes |
|---|---|---|---|---|
| Forge 1.x | 0.4.1 (dora-message 0.7.0) | 1.x | 1.x | baseline of the currently installed bundles |
| Forge 2.x | >=1.0.1,<2 | 2.x | 2.x | every node artifact must be rebuilt for dora 1.x |

\`pip install "dora-rs-cli==1.0.1"\` provides the Forge 2 CLI (\`dora-cli 1.0.1\`); \`dora-rs\` alone is only
the Python node API and ships no CLI. Swapping generations inside one instance requires all nodes
rebuilt, then start a separate instance:

    DSH_FORGE_HOME=~/.dsh/forge2 DSH_FORGE_DORA=/path/to/dora1/bin/dora <host>

Declare the generation in \`skill.yaml\` via \`forge_version\` so a caller can refuse a mismatch.

### Derived-skill workflow (upstream PIPER_X_DEMO pattern)

1. Pin upstream: bundle version, all node locks (artifact_id/version/sha256) and the dora generation.
2. Copy the bundle and rename skill + profile; keep the node locks unless a node really changes.
3. Edit assets and profile configs together: \`robot.yaml\` (joint names/order/limits, initial_qpos,
   eef_site), \`simulator.yaml\` (model path, initial_state, logical joints, actuator_order,
   joint_to_actuator), \`motion_server.yaml\` (group, URDF, base/tip, tolerances), \`controller.yaml\`
   (joint order), \`gateway.yaml\` (ToolSpec group/frame/joint order/ports), \`dataflow.yaml\` (ports).
4. Validate the model independently before any Action: FK of the URDF against the MuJoCo site, initial
   pose servo stability. A passing FK check is not pipeline acceptance.
5. \`forge_skill_validate\` -> copy into \`skills/\` -> inspect/doctor -> start one profile.
6. Accept one joint Action and one Cartesian Action per fresh run id; then gripper and reset.
   - \`phase=completed\` is terminal, not success: read \`data.result.status\` / \`error_code\`.
   - Success needs residual within tolerance; gripper needs \`reached_goal\`; reset needs \`rehomed\`.
   - An \`unknown\` outcome is diagnostic evidence only: never auto-resend it.

Port and display discipline: one skill+profile owns its gateway port. A second instance or a headless
profile must change the gateway port and DISPLAY, and \`dataflow.yaml\` gateway providers must agree with
\`gateway.yaml\`.

## 10. End-to-end verification goes through the DSH conversation

Verify a skill **from the conversation with the forge tools**, not by handing the
user a shell script. The tools are the same path a caller takes, they record
invocation ids, and they keep the verification reproducible.

    forge_runtime_start   {name, profile}          # expect status=healthy
    forge_skill_doctor    {name, profile}          # dora + readiness + tool coverage
    forge_tool_context    {name, tool_id}          # frames/units, readiness
    forge_tool_call       {name, tool_id, arguments}   # query answers inline
    forge_invocation_read {name, invocation_id}    # action status and result
    forge_runtime_logs    {name, lines}
    forge_runtime_stop    {name}

Rules for an end-to-end run:

- one Action at a time; read the terminal state with \`forge_invocation_read\`
  before issuing the next call, never fire a batch and hope;
- an Action's HTTP 202 / \`accepted\` is admission, not execution: only a terminal
  phase plus the result body proves success;
- record for every step: tool_id, arguments, error_code, message, elapsed, and
  any \`final_*\` values, so a later comparison is factual;
- a failed or \`unknown\` outcome is reported, not retried (see the runtime rules
  shipped with this plugin);
- when the operator prefers to drive the run themselves, deliver the sequence as
  conversation content (user turn + the exact forge_* call + expected result) and
  let them execute it: the verification is still expressed as forge tool calls,
  never as a shell script;
- \`curl\` against the gateway is a fallback for machines without DSH, not the
  primary procedure: it duplicates the tool path and silently diverges from it.

A representative sweep for a motion skill: describe the robot (\`get_robot_info\`),
read the current observation (\`get_joint_state\` when the skill exposes it), issue
theextreme target, then confirm the terminal judgement and re-read the observation to
show the arm was left holding its measured pose.

## 11. Troubleshooting matrix

| Symptom | Layer | Evidence / action |
|---|---|---|
| skill not listed | catalog | forge_skill_list; check ~/.dsh/forge/skills/<name>/skill.yaml parses |
| tool missing from GET /tools | gateway config | compare skill.yaml required_tools with gateway.yaml tools.specs/providers |
| /tools unreachable after start | dataflow / nodes | runtime/logs/<flow>.log, dora list; check node exit codes and gateway port |
| preflight fails with FORGE_NODE_MISSING | node store | forge_skill_install (installs nodes), check platform/arch |
| FORGE_NODE_INTEGRITY | artifact | digest mismatch; remove runtime/nodes/<artifact_id> and reinstall |
| FORGE_PORT_CONFLICT | gateway | old flow still running or another skill uses that gateway_url |
| HTTP 400 "not an Action" | routing | query tool called on the tool_id route; use endpoint/operation (forge_tool_call does this) |
| HTTP 400 "timeout_ms must not exceed …" | gateway config | gateway.yaml tools.invoke_timeout_ms; forge clamps to 20000 |
| readiness false in /tools/{id}/context | provider / device | check gateway_readiness fields (proprio_state, images, clients) and node logs |
| MOTION_INVALID_GOAL / INVALID_JOINTS | tool arguments | compare with get_robot_info group/joint order; positions must match the configured group |
| action stays pending / unknown | invocation | forge_invocation_read; never blind-retry, inspect gateway state first |
| no images | camera node / ports | image_forward config vs dataflow ports; viewer node logs |
| FORGE_ARCHIVE_UNSAFE | packaging | archive contains absolute paths or links; rebuild the archive |
| runtime state says healthy but tools fail | gateway vs provider | restart the runtime; if repeated, run forge_skill_doctor and export forge_doctor_report |

Logs and reports: runtime/logs/events.jsonl (install/runtime/tool/doctor events), runtime/jobs/<id>.json,
runtime/reports/doctor-*.json, runtime/logs/<flow>.log and dora-coordinator.log.

## 12. Launch mode and Forge generation

Two independent axes:

| Axis | Values | Decided by |
|---|---|---|
| forge generation | 1 / 2 | skill.yaml forge_version: chooses the dora binary (runtime.dora / runtime.dora1) and contracts |
| launch mode | start / run | chosen at start time (forge_runtime_start mode, CLI --run); default start |
| node form | compiled artifacts / source interpreter | dataflow paths: placeholders vs absolute venv paths |

dora run exists in both generations and never uses a coordinator. start (default) uses the coordinator:
dora up + dora start --detach, flow is registered and stopped by name. run is process-owned: forge
records the pid and stops the process group instead.

Source-run is not a Forge 2 feature: a Forge 1 bundle can point dataflow nodes at a virtualenv too, and
a Forge 2 bundle can still ship compiled artifacts. The first Forge 2 example merely happens to run
from source locally.

If a Forge 2 skill fails with "spawn dora1 ENOENT", configure runtime.dora1 or DSH_FORGE_DORA1.

## 13. Where this forge differs from PhyAgentOS

- no publishing/upload: the client only reads GET /v1/skills, /v1/skills/{name}, /v1/forge-nodes/{id};
  upstream external submissions are not open. Internal distribution: implement those GETs privately or
  copy bundles into the managed skills/ directory.
- start.sh hooks are NOT executed; do not rely on them.
- no AgentTask, verification, evidence or evolution layers; tools are the execution boundary.
- locks do not record source commits; use forge_node_info for the registry's github_url.
- one runtime per gateway address; stop before switching profiles.
- state.json is single-writer; do not run two hosts against one forge home.
- Forge 2 support is version-scoped: dora 1.x CLI, process-owned flows, no coordinator; the manifest
  still pins gateway_url and profiles the same way.

## 14. References

Upstream: PhyAgentOS-core docs/user_development_guide/track_b/{SKILL_DEVELOPMENT, REPOSITORIES,
PROTOCOLS, RUNTIME}.md. In forge: docs/skill-development.md, forge_skill_docs for bundle docs,
forge_node_info for node provenance (now including source pinning), forge_node_source for pinned files,
forge_repo_search / forge_repo_info for the repository catalog.
`
