import { isAbsolute, posix } from 'node:path'
import { x as untar } from 'tar'

import { ForgeError } from './errors.js'

/**
 * Extract a gzipped tar into `cwd`, rejecting entries that could escape it.
 *
 * The archive is third-party input: absolute paths, `..` traversal, symlinks and
 * hard links are refused instead of silently skipped, so a hostile bundle fails
 * the install rather than leaving partial state.
 */
export async function extractArchive(file: string, cwd: string): Promise<void> {
  const violations: string[] = []
  await untar({
    file,
    cwd,
    strict: true,
    filter: (path, entry) => {
      const normalized = posix.normalize(path.replace(/^\.\//, ''))
      if (isAbsolute(normalized) || normalized.startsWith('../') || normalized === '..') {
        violations.push(`path escapes archive root: ${path}`)
        return false
      }
      const type = (entry as { type?: string }).type
      if (type === 'SymbolicLink' || type === 'Link') {
        violations.push(`link entries are not allowed: ${path}`)
        return false
      }
      return true
    },
  })
  if (violations.length > 0) {
    throw new ForgeError('FORGE_ARCHIVE_UNSAFE', violations.slice(0, 3).join('; '))
  }
}
