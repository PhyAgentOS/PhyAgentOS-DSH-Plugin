/**
 * The bundled `forge-usage` skill and the short system-prompt convention.
 *
 * Both are explanatory only: they never grant capability, they just tell the
 * model which existing forge tool fits a request and which safety rules apply.
 */

export const USAGE_SKILL_NAME = 'forge-usage'

export const USAGE_SKILL_DESCRIPTION =
  'How to manage Forge skills with the forge_* tools: install, inspect, run, call gateway tools, edit profiles and diagnose failures.'

export const USAGE_SKILL_CONTENT = `# forge-usage

Forge manages *skills* (versioned bundles: SKILL.md + skill.yaml + profiles/) and runs one
gateway per active skill. Use the forge_* tools instead of editing files by hand.

## Pick the tool by intent

| The user wants to… | Use |
|---|---|
| see what is installed | \`forge_skill_list\` |
| find something to install | \`forge_skill_search\` |
| understand one skill (profiles, deps, checks) | \`forge_skill_inspect\` |
| read the skill's instructions | \`forge_skill_read\` |
| install / update a skill | \`forge_skill_install\` (background job) |
| watch an install | \`forge_install_status\`; cancel with \`forge_install_cancel\` |
| check for a newer version | \`forge_skill_update\` |
| start a deployment | \`forge_runtime_start\` (name + profile) |
| see if it is running | \`forge_runtime_status\` |
| stop it | \`forge_runtime_stop\` |
| read startup problems | \`forge_runtime_logs\` |
| see what a running skill can do | \`forge_tool_context\` (readiness, frames, units) |
| command the robot / run a query | \`forge_tool_call\` |
| read an async result | \`forge_invocation_read\` |
| change tuning (control_hz, poses, frames…) | \`forge_profile_files\` → \`forge_profile_read\` → \`forge_profile_write\` |
| diagnose why it will not run | \`forge_skill_doctor\`; full report with \`forge_doctor_report\` |
| verify the machine can run Forge at all (right after installing the plugin) | \`forge_environment_check\` |
| reclaim disk | \`forge_cache_summary\` then \`forge_cache_gc\` |
| remove an installed skill | \`forge_skill_remove\` (stop the runtime first) |

## Rules

1. **Look before acting.** Call \`forge_skill_list\` / \`forge_skill_inspect\` instead of
   guessing a skill name or profile. Profiles are deployment choices (e.g. \`mujoco-piper\`),
   not DSH profiles.
2. **Installs are jobs.** \`forge_skill_install\` returns a job id; poll \`forge_install_status\`
   and only then claim success. A cancelled job keeps a partial file for resume.
3. **Read before writing a profile.** \`forge_profile_write\` replaces the whole file: pass
   complete content, expect a field-level \`diff\` and \`restartRequired: true\`.
4. **Restart to apply.** After a profile change: \`forge_runtime_stop\` then
   \`forge_runtime_start\` with the same profile. Never restart silently while the user is
   mid-task without saying so.
5. **One runtime per gateway.** Starting a second profile on a busy gateway fails; stop the
   current one first.
6. **Actions are asynchronous and physical.** \`forge_tool_call\` on an action/session returns
   an invocation id; read it with \`forge_invocation_read\`. A timeout or \`unknown\` outcome is
   **not** permission to retry — inspect first. Real (non-simulation) skills can move hardware.
7. **Diagnose with codes.** On failure run \`forge_skill_doctor\` and report the \`FORGE_*\`
   code plus its fix hint, instead of retrying the same call.

## Typical sequences

**Run a simulation**

\`\`\`
forge_skill_list → forge_skill_inspect(robot-control-sim)
→ forge_runtime_start(robot-control-sim, mujoco-piper)
→ forge_tool_context(sim.get_robot_info)
→ forge_tool_call(sim.get_robot_info, {})
→ forge_runtime_stop(robot-control-sim)
\`\`\`

**Tune a profile**

\`\`\`
forge_profile_files(robot-control-sim, mujoco-piper)
→ forge_profile_read(robot-control-sim, mujoco-piper, simulator.yaml)
→ forge_profile_write(…, content)   # returns diff + restartRequired
→ forge_runtime_stop → forge_runtime_start (same profile)
\`\`\`

**Install from the registry**

\`\`\`
forge_skill_search(robot)
→ forge_skill_install(robot-control-sim)   # job id
→ forge_install_status(job_id) until state != running
→ forge_skill_doctor(robot-control-sim)
\`\`\`

**Verify the machine right after installing the plugin**

\`\`\`
forge_environment_check
→ ok: report the pass/warn lines the user cares about (dora, node, disk, registry)
→ fail: report the FORGE_ENV_* code and hint verbatim, fix it, then re-run once
\`\`\`
`

export const USAGE_SYSTEM_SECTION = `Forge skills: use the forge_* tools rather than editing installed files. Call forge_skill_list/inspect before assuming a skill name or profile. profile files are changed only through forge_profile_read + forge_profile_write (full content; returns a diff and restartRequired), then restart the runtime. Installs are background jobs: poll forge_install_status. Action results are asynchronous: read forge_invocation_read and never retry an unknown outcome; real skills may move hardware. On failure report the FORGE_* code from forge_skill_doctor instead of retrying blindly. For creating, modifying, packaging or debugging a skill bundle, load the forge-skill-development skill; look up node repositories with forge_repo_search / forge_repo_info. After the plugin is installed, or when the user asks whether this machine is ready, run forge_environment_check and report failing FORGE_ENV_* codes with their hints.`


/**
 * Runtime rules shipped with the plugin itself (not a workspace file, not a skill):
 * they must travel with any dsh-forge installation.
 */
export const RUNTIME_RULES_SECTION = `Forge runtime rules — these override the urge to "fix" something:
- A failed forge call or a failed instruction is FINAL for the turn. Report it and stop: what failed (skill/profile/tool), the FORGE_* code and the raw message, when it happened, the live process/port state, and what is now blocked.
- Never repair a failure: do not stop or start a skill, restart a runtime, kill processes, edit gateway/profile/port config, delete runtime directories, or re-run the same call with adjusted parameters.
- Starting or stopping a skill requires an explicit user instruction; never do it to verify or unblock something.
- An Action with an unknown outcome is evidence, not permission: read forge_invocation_read, report, do not resend.
- A skill with forge_version "2" is launched with dora run, never forge_runtime_start.
- Offer recovery suggestions only when clearly marked as not executed.`
