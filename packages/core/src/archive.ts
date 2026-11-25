import { mkdir, realpath, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, sep, win32 } from 'node:path'
import { x as untar } from 'tar'

import { ForgeError } from './errors.js'

/**
 * Extract a gzipped tar into `cwd`, rejecting entries that could escape it.
 *
 * Directory nodes opt in to internal symlinks in a fresh staging directory.
 * Hard links and paths outside the archive are always rejected.
 */
export async function extractArchive(
  file: string,
  cwd: string,
  { allowInternalLinks = false } = {},
): Promise<void> {
  const violations: string[] = []
  const links = new Map<string, string>()
  await untar({
    file,
    cwd,
    strict: true,
    filter: (path, entry) => {
      if (posix.isAbsolute(path) || win32.parse(path).root !== '' || path.includes('\\')
        || path.includes('\0') || path.split('/').includes('..')) {
        violations.push(`path escapes archive root: ${path}`)
        return false
      }
      if (!('type' in entry)) return true
      if (entry.type === 'SymbolicLink' && allowInternalLinks) {
        const target = entry.linkpath
        const name = posix.normalize(path)
        const resolved = target === undefined ? '..' : posix.join(posix.dirname(name), target)
        // A parent step after a named component could traverse a directory link.
        // Leading parent steps are relative to the link's real parent directory.
        if (!target || win32.parse(target).root !== '' || target.includes('\\') || target.includes('\0')
          || target.replace(/^(?:\.{1,2}\/|\/)+/, '').split('/').includes('..')
          || resolved === '..' || resolved.startsWith('../') || links.has(name)) {
          violations.push(`unsafe symbolic link: ${path}`)
        } else {
          links.set(name, target)
        }
        return false
      }
      if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
        violations.push(`link entries are not allowed: ${path}`)
        return false
      }
      return true
    },
  })
  if (violations.length > 0) {
    throw new ForgeError('FORGE_ARCHIVE_UNSAFE', violations.slice(0, 3).join('; '))
  }
  if (links.size === 0) return

  const root = await realpath(cwd)
  try {
    // Create all parents before any symlink. A link cannot then replace a parent
    // directory or be used to write another archive member.
    for (const path of links.keys()) await mkdir(dirname(join(root, path)), { recursive: true })
    for (const [path, target] of links) await symlink(target, join(root, path))
    for (const path of links.keys()) {
      const resolved = relative(root, await realpath(join(root, path)))
      if (resolved === '' || resolved === '..' || resolved.startsWith(`..${sep}`) || isAbsolute(resolved)) {
        throw new Error(`symbolic link resolves outside the archive payload: ${path}`)
      }
    }
  } catch (error) {
    throw new ForgeError('FORGE_ARCHIVE_UNSAFE', `invalid archive symbolic link: ${(error as Error).message}`)
  }
}
