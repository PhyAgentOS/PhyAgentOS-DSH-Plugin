import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'

import { ForgeError } from './errors.js'
import { parseManifest, type ForgeManifest } from './manifest.js'

export interface BundleIssue {
  readonly path: string
  readonly code: string
  readonly message: string
  readonly severity: 'error' | 'warn'
}

export interface BundleValidation {
  readonly ok: boolean
  readonly root: string
  readonly name?: string
  readonly version?: string
  readonly issues: readonly BundleIssue[]
  readonly summary: {
    readonly profiles: number
    readonly artifacts: number
    readonly assets: number
  }
}

/**
 * Validate a bundle directory before installing it.
 *
 * Designed for local development: it reads `skill.yaml`, checks that the
 * instruction document, profile dataflows and assets exist, and reports
 * artifact-lock problems (platform/arch/entrypoint) as warnings so a bundle
 * built for another machine still validates.
 */
export async function validateBundle(root: string): Promise<BundleValidation> {
  const dir = resolve(root)
  const issues: BundleIssue[] = []
  const add = (path: string, code: string, message: string, severity: 'error' | 'warn' = 'error'): void => {
    issues.push({ path, code, message, severity })
  }

  let text: string
  try {
    text = await readFile(join(dir, 'skill.yaml'), 'utf8')
  } catch {
    return {
      ok: false,
      root: dir,
      issues: [{ path: 'skill.yaml', code: 'FORGE_MANIFEST_INVALID', message: 'skill.yaml is missing', severity: 'error' }],
      summary: { profiles: 0, artifacts: 0, assets: 0 },
    }
  }
  const parsed = parseManifest(text, 'skill.yaml')
  if (parsed.manifest === undefined) {
    return {
      ok: false,
      root: dir,
      issues: parsed.issues.map(issue => ({ path: issue.path, code: issue.code, message: issue.message, severity: 'error' as const })),
      summary: { profiles: 0, artifacts: 0, assets: 0 },
    }
  }
  const manifest: ForgeManifest = parsed.manifest

  if (!(await exists(join(dir, manifest.skillDocument)))) {
    add(manifest.skillDocument, 'FORGE_SKILL_DOC_MISSING', `${manifest.skillDocument} is missing`)
  }
  const archiveManifest = join(dir, 'archive-manifest.json')
  if (await exists(archiveManifest)) {
    try {
      JSON.parse(await readFile(archiveManifest, 'utf8'))
    } catch {
      add('archive-manifest.json', 'FORGE_FILE_INVALID', 'archive-manifest.json is not valid JSON', 'warn')
    }
  }

  let assets = 0
  for (const profile of Object.values(manifest.profiles)) {
    if (!(await exists(join(dir, profile.dataflow)))) {
      add(profile.dataflow, 'FORGE_DATAFLOW_MISSING', `dataflow for profile ${profile.id} is missing`)
    }
    for (const asset of profile.requiredAssets) {
      assets += 1
      if (!(await exists(join(dir, asset)))) add(asset, 'FORGE_ASSET_MISSING', `asset for profile ${profile.id} is missing`)
    }
    if (profile.requiredBinaries.length === 0) {
      add(`profiles.${profile.id}.required_binaries`, 'FORGE_MANIFEST_INVALID', 'profile declares no required binaries', 'warn')
    }
    for (const binary of profile.requiredBinaries) {
      const lock = manifest.artifacts[binary]
      if (lock === undefined) {
        add(`artifacts.nodes.${binary}`, 'FORGE_NODE_MISSING', `no artifact lock for required binary ${binary}`)
        continue
      }
      if (lock.platform !== process.platform || lock.arch !== archName()) {
        add(`artifacts.nodes.${binary}`, 'FORGE_NODE_PLATFORM', `locked for ${lock.platform}/${lock.arch}, host is ${process.platform}/${archName()}`, 'warn')
      }
      if (lock.sha256 === undefined) {
        add(`artifacts.nodes.${binary}.sha256`, 'FORGE_NODE_INTEGRITY', 'artifact lock has no sha256', 'warn')
      }
      if (lock.artifactType === 'executable_tar_gz' && lock.entrypoint.trim().length === 0) {
        add(`artifacts.nodes.${binary}.entrypoint`, 'FORGE_NODE_ENTRYPOINT', 'executable archives need an entrypoint')
      }
    }
  }

  // Keep the resolver honest: a relative path that escapes the bundle is a bug.
  for (const profile of Object.values(manifest.profiles)) {
    for (const relative of [profile.dataflow, ...profile.requiredAssets]) {
      const target = resolve(dir, relative)
      if (isAbsolute(relative) || !target.startsWith(dir + sep)) {
        add(relative, 'FORGE_MANIFEST_INVALID', 'path escapes the bundle root')
      }
    }
  }

  const errors = issues.filter(issue => issue.severity === 'error')
  return {
    ok: errors.length === 0,
    root: dir,
    name: manifest.name,
    version: manifest.version,
    issues,
    summary: { profiles: Object.keys(manifest.profiles).length, artifacts: Object.keys(manifest.artifacts).length, assets },
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function archName(): string {
  if (process.arch === 'x64') return 'x86_64'
  if (process.arch === 'arm64') return 'aarch64'
  if (process.arch === 'ia32') return 'x86'
  return process.arch
}

export class BundleValidationError extends ForgeError {}
