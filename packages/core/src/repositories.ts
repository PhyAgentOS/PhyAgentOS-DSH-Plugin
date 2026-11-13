/**
 * Node repository catalog.
 *
 * Derived from the PhyAgentOS TrackB REPOSITORIES/PROTOCOLS/RUNTIME manuals:
 * which repository produces which node, its key source paths, the endpoints it
 * implements, and the inspected source snapshot. Shipped with the plugin so the
 * agent can resolve "where does this node come from" without network access.
 */

export interface RepositoryEndpoint {
  readonly id: string
  readonly operations: ReadonlyArray<{ readonly name: string; readonly semantics: 'query' | 'action' | 'session' }>
}

export interface RepositoryEntry {
  readonly id: string
  readonly url: string
  readonly category: 'framework' | 'adapter' | 'operator' | 'benchmark'
  readonly role: string
  readonly description: string
  readonly keyPaths: readonly string[]
  /** Node ids this repository produces (as used in skill.yaml artifacts.nodes). */
  readonly nodes: readonly string[]
  readonly endpoints: readonly RepositoryEndpoint[]
  /** Full commit of the inspected upstream snapshot. */
  readonly snapshot?: string
}

export const REPOSITORY_CATALOG: readonly RepositoryEntry[] = [
  {
    id: 'forge',
    url: 'https://github.com/PhyAgentOS/forge',
    category: 'framework',
    role: 'library',
    description: 'Shared framework: common, msgs, robot, policy, kinematics, tool; Endpoint SPI and Wire models',
    keyPaths: [
      'interfaces/forge_msgs/{SCHEMA.md,common.v1.yaml,control.v1.yaml,sensor.v1.yaml,motion.v1.yaml,tool.v1.yaml}',
      'interfaces/forge_tool/PROTOCOL.md',
      'packages/tool/src/forge_tool/endpoint/protocol.py',
      'packages/tool/src/forge_tool/handler.py',
      'packages/robot/src/forge_robot/robot_protocol.py',
      'packages/policy/src/forge_policy/policy_protocol.py',
    ],
    nodes: [],
    endpoints: [],
    snapshot: 'e59693910bb5f9572cf39c5a59475c0747ba76e8',
  },
  {
    id: 'adapter-forge-gateway',
    url: 'https://github.com/PhyAgentOS/adapter-forge-gateway',
    category: 'adapter',
    role: 'gateway',
    description: 'HTTP/WebSocket Tool API, Tool routing, registry and readiness gate',
    keyPaths: [
      'src/forge_gateway/controllers/tool_controller.py',
      'src/forge_gateway/services/tool_gateway_service.py',
      'tests/test_tool_session.py',
    ],
    nodes: ['gateway'],
    endpoints: [],
    snapshot: '5aaa9d16aff1c1b689dbb53acbcdef406dcb8d97',
  },
  {
    id: 'adapter-camera-orbbec',
    url: 'https://github.com/PhyAgentOS/adapter-camera-orbbec',
    category: 'adapter',
    role: 'sensor',
    description: 'Orbbec color/depth/IR; depth is Image 32FC1 metres, zero invalid',
    keyPaths: ['README.md'],
    nodes: [],
    endpoints: [],
    snapshot: 'de3cbc5361533d8799f586939266289d7527b203',
  },
  {
    id: 'adapter-camera-realsense',
    url: 'https://github.com/PhyAgentOS/adapter-camera-realsense',
    category: 'adapter',
    role: 'sensor',
    description: 'RealSense D400 color/depth/IR; depth is Image 32FC1 metres, zero invalid',
    keyPaths: ['README.md'],
    nodes: [],
    endpoints: [],
    snapshot: '77627b4d8e3977aabf016af6846e9f6857cfcde6',
  },
  {
    id: 'adapter-camera-usb',
    url: 'https://github.com/PhyAgentOS/adapter-camera-usb',
    category: 'adapter',
    role: 'sensor',
    description: 'Rust/V4L2 USB camera; raw and compressed images',
    keyPaths: ['README.md'],
    nodes: [],
    endpoints: [],
    snapshot: 'bdbe5ebb016da299ff1e0b461260ce1ddd52d234',
  },
  {
    id: 'adapter-franka-fr3',
    url: 'https://github.com/PhyAgentOS/adapter-franka-fr3',
    category: 'adapter',
    role: 'robot',
    description: 'Franka FR3v2 and Franka Hand driver/models',
    keyPaths: ['README.md'],
    nodes: [],
    endpoints: [],
    snapshot: 'efd7a6bd019c7135ae506274ca73ef5879f4a384',
  },
  {
    id: 'adapter-robot-piper',
    url: 'https://github.com/PhyAgentOS/adapter-robot-piper',
    category: 'adapter',
    role: 'robot',
    description: 'AgileX Piper driver, Dora examples and multi-format models',
    keyPaths: ['README.md'],
    nodes: [],
    endpoints: [],
    snapshot: '3ea5156cb369c302bb2e3ff6f1ebfb6af90a08d8',
  },
  {
    id: 'adapter-robot-so101',
    url: 'https://github.com/PhyAgentOS/adapter-robot-so101',
    category: 'adapter',
    role: 'robot',
    description: 'SO101 serial/Feetech driver and MJCF model',
    keyPaths: ['README.md'],
    nodes: [],
    endpoints: [],
    snapshot: 'fb6b59292366059acd10cb2439d155c4c8015cfc',
  },
  {
    id: 'adapter-robot-xlerobot',
    url: 'https://github.com/PhyAgentOS/adapter-robot-xlerobot',
    category: 'adapter',
    role: 'robot',
    description: 'XLeRobot dual-arm mobile robot integration',
    keyPaths: ['README.md'],
    nodes: [],
    endpoints: [],
    snapshot: '5ceb37fdea4d6c7e454914b1b5e180b4728ef0fa',
  },
  {
    id: 'adapter-robot-zerith_h1_pro',
    url: 'https://github.com/PhyAgentOS/adapter-robot-zerith_h1_pro',
    category: 'adapter',
    role: 'robot',
    description: 'Zerith H1 Pro joint/base integration and SDK',
    keyPaths: ['README.md'],
    nodes: [],
    endpoints: [],
    snapshot: 'e36dc9b0bdfd68342d55180485b561c73162cfc3',
  },
  {
    id: 'adapter-viewer-image',
    url: 'https://github.com/PhyAgentOS/adapter-viewer-image',
    category: 'adapter',
    role: 'viewer',
    description: 'Image viewer consuming Forge image messages',
    keyPaths: ['README.md'],
    nodes: ['image_viewer'],
    endpoints: [],
    snapshot: 'ea5900a7225c2bfadd89bbfe23c023ec9fbe1bb6',
  },
  {
    id: 'operator-controls',
    url: 'https://github.com/PhyAgentOS/operator-controls',
    category: 'operator',
    role: 'control',
    description: 'joint_trajectory_controller, gripper_action_controller and fake plant',
    keyPaths: [
      'packages/joint_trajectory_controller',
      'packages/gripper_action_controller',
      'scripts/build_pyinstaller.sh',
    ],
    nodes: ['joint_trajectory_controller', 'gripper_action_controller'],
    endpoints: [],
    snapshot: 'cde73dc2a6222d81b01ffc32f69f12cb12e42760',
  },
  {
    id: 'operator-gripper-action-policy',
    url: 'https://github.com/PhyAgentOS/operator-gripper-action-policy',
    category: 'operator',
    role: 'provider',
    description: 'Gripper Tool opening requests to gripper Actions and execution results',
    keyPaths: ['src/gripper_action_policy_node/runner.py'],
    nodes: ['gripper_action_policy'],
    endpoints: [{ id: 'gripper.controller', operations: [{ name: 'set_opening', semantics: 'action' }] }],
    snapshot: 'bb69223497b944dd1a0f6fe9ecb36486168a8cc4',
  },
  {
    id: 'operator-motion',
    url: 'https://github.com/PhyAgentOS/operator-motion',
    category: 'operator',
    role: 'provider',
    description: 'motion_server and motion_action_policy: goals, IK, trajectories',
    keyPaths: ['packages/motion_server/server.py', 'packages/motion_server/policy_nodes.py'],
    nodes: ['motion_server', 'motion_action_policy'],
    endpoints: [{
      id: 'motion.server',
      operations: [
        { name: 'move_joints', semantics: 'action' },
        { name: 'move_pose', semantics: 'action' },
      ],
    }],
    snapshot: '24c8a430715f697eea8431bf169c21b8cbb5eb92',
  },
  {
    id: 'operator-sim-control-policy',
    url: 'https://github.com/PhyAgentOS/operator-sim-control-policy',
    category: 'operator',
    role: 'provider',
    description: 'Robot descriptor queries, simulation reset and deferred re-home',
    keyPaths: ['src/sim_control_policy_node/runner.py', 'TOOL_CONTRACTS.md'],
    nodes: ['sim_control_policy'],
    endpoints: [{
      id: 'sim.control',
      operations: [
        { name: 'get_robot_info', semantics: 'query' },
        { name: 'reset', semantics: 'action' },
      ],
    }],
    snapshot: '85679a4be8953e9071de426c7c0973155121d96f',
  },
  {
    id: 'operator-simulator-mujoco',
    url: 'https://github.com/PhyAgentOS/operator-simulator-mujoco',
    category: 'operator',
    role: 'simulator',
    description: 'MuJoCo stepping, joint commands, images and proprio state',
    keyPaths: ['src/mujoco_sim/runtime.py'],
    nodes: ['mujoco_sim'],
    endpoints: [],
    snapshot: '0a84a1a81807b467338e696032a38b084cb35747',
  },
  {
    id: 'operator-relative-pose-policy',
    url: 'https://github.com/PhyAgentOS/operator-relative-pose-policy',
    category: 'operator',
    role: 'provider',
    description: 'Relative end-effector pose resolution (motion.relative_pose)',
    keyPaths: ['README.md'],
    nodes: [],
    endpoints: [{ id: 'motion.relative_pose', operations: [{ name: 'resolve', semantics: 'query' }] }],
    snapshot: '4749b696a8b3210e193860d6aeed92382fbad113',
  },
  {
    id: 'operator-kai0',
    url: 'https://github.com/PhyAgentOS/operator-kai0',
    category: 'operator',
    role: 'policy',
    description: 'Kai0 policy source and inference node',
    keyPaths: ['README.md'],
    nodes: [],
    endpoints: [{ id: 'policy.runner', operations: [{ name: 'serve', semantics: 'session' }] }],
    snapshot: '94baa639fe6d36bb5d41d214923108993aa002cc',
  },
  {
    id: 'operator-lerobot-runner',
    url: 'https://github.com/PhyAgentOS/operator-lerobot-runner',
    category: 'operator',
    role: 'policy',
    description: 'LeRobot policy execution, observations and control',
    keyPaths: ['README.md'],
    nodes: [],
    endpoints: [{ id: 'policy.runner', operations: [{ name: 'serve', semantics: 'session' }] }],
    snapshot: 'f6b26f4f89bbd9831f64e3fc43d36499d6c86a92',
  },
  {
    id: 'benchmark-libero',
    url: 'https://github.com/PhyAgentOS/benchmark-libero',
    category: 'benchmark',
    role: 'benchmark',
    description: 'LIBERO simulation/evaluation and node packaging',
    keyPaths: ['main.py', 'bench_tool/descriptor.py'],
    nodes: [],
    endpoints: [{
      id: 'benchmark.controller',
      operations: [
        { name: 'describe', semantics: 'query' },
        { name: 'run', semantics: 'session' },
      ],
    }],
    snapshot: 'e01cd66167b85522afe427c5b85da8af30c00c97',
  },
]

export interface RepositoryQuery {
  /** Matches id, description, category, role, node ids, key paths and endpoints. */
  readonly query?: string | undefined
  readonly category?: string | undefined
}

/** Search the catalog by free text and/or category. */
export function searchRepositories(options: RepositoryQuery = {}): RepositoryEntry[] {
  const query = (options.query ?? '').trim().toLowerCase()
  return REPOSITORY_CATALOG.filter(entry => {
    if (options.category !== undefined && entry.category !== options.category) return false
    if (query.length === 0) return true
    const haystack = [
      entry.id,
      entry.description,
      entry.category,
      entry.role,
      entry.url,
      ...entry.nodes,
      ...entry.keyPaths,
      ...entry.endpoints.flatMap(endpoint => [endpoint.id, ...endpoint.operations.map(operation => operation.name)]),
    ].join(' ').toLowerCase()
    return haystack.includes(query)
  })
}

/** Look up one repository by id or by a node id it produces. */
export function findRepository(idOrNode: string): RepositoryEntry | undefined {
  const needle = idOrNode.trim().toLowerCase()
  return REPOSITORY_CATALOG.find(entry => entry.id.toLowerCase() === needle)
    ?? REPOSITORY_CATALOG.find(entry => entry.nodes.some(node => node.toLowerCase() === needle))
}
