/** Resolve harness-only packages to local stubs so tool handlers can run outside DSH. */
export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: new URL('./stub-dsh-tools.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/schemastery') {
    return { url: new URL('./stub-schemastery.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
