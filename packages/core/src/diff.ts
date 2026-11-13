/**
 * Field-level diff for structured configuration files.
 *
 * Used by `forge_profile_write` so the model (and the review UI) sees exactly
 * which keys changed instead of a whole-file replacement.
 */
export function diffValues(before: unknown, after: unknown, prefix = ''): string[] {
  const left = flatten(before, prefix)
  const right = flatten(after, prefix)
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
  const lines: string[] = []
  for (const key of keys) {
    if (left[key] === right[key]) continue
    lines.push(`${key}: ${left[key] ?? '(unset)'} → ${right[key] ?? '(unset)'}`)
  }
  return lines
}

function flatten(value: unknown, prefix: string): Record<string, string> {
  const result: Record<string, string> = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    result[prefix] = JSON.stringify(value)
    return result
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      Object.assign(result, flatten(item, path))
    } else {
      result[path] = JSON.stringify(item)
    }
  }
  return result
}
