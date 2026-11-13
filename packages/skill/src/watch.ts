import { mkdirSync, watch } from 'node:fs'

/** Handle over every watcher opened for a set of roots. */
export interface ForgeWatcher {
  close(): void
}

/**
 * Watch skill roots and call `onChange` once per settled burst of filesystem events.
 *
 * `recursive` keeps nested bundle files (SKILL.md, profiles/, assets/) in view;
 * Node supports it on Linux and macOS. Failures degrade to "no live updates"
 * rather than breaking provider registration.
 */
export function watchRoots(roots: readonly string[], onChange: () => void, debounceMs = 150): ForgeWatcher {
  const watchers: Array<ReturnType<typeof watch>> = []
  let timer: NodeJS.Timeout | undefined
  let closed = false

  const fire = (): void => {
    if (closed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (!closed) onChange()
    }, debounceMs)
    timer.unref?.()
  }

  for (const root of roots) {
    try {
      mkdirSync(root, { recursive: true })
      const watcher = watch(root, { recursive: true }, fire)
      watcher.on('error', () => { /* keep the previous subscription alive */ })
      watchers.push(watcher)
    } catch {
      // A root that cannot be watched still serves reads; skip live updates.
    }
  }

  return {
    close(): void {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
    },
  }
}
