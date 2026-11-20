/**
 * Stable error codes shared by every forge surface (DSH plugin, MCP, CLI).
 *
 * The code is the contract: logs, doctor output and tests key off it, while the
 * message stays human-facing and may change.
 */

/** Error carrying a stable `FORGE_*` code and an optional manifest path. */
export class ForgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'ForgeError'
  }
}

export const ErrorCode = {
  manifestInvalid: 'FORGE_MANIFEST_INVALID',
  skillDocMissing: 'FORGE_SKILL_DOC_MISSING',
  profileUnknown: 'FORGE_PROFILE_UNKNOWN',
  dataflowMissing: 'FORGE_DATAFLOW_MISSING',
  assetMissing: 'FORGE_ASSET_MISSING',
  nodeMissing: 'FORGE_NODE_MISSING',
  modelMissing: 'FORGE_MODEL_MISSING',
  forgeVersion: 'FORGE_FORGE_VERSION',
  registryUnavailable: 'FORGE_REGISTRY_UNAVAILABLE',
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]
