#!/usr/bin/env node
/**
 * Compare the DSH host type surface our shims target against a DSH checkout.
 *
 *   node scripts/check-dsh-surface.mjs --checkout /path/to/deepseek-harness [--update]
 *
 * The hash covers the declaration files (lib/types, lib, or src) of the host
 * packages we import. It does not require the packages to exist on npm.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const MODULES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-client-ui-primitives',
]
const BASELINE = 'compat/dsh-baseline.json'

const argv = process.argv.slice(2)
const update = argv.includes('--update')
const checkoutFlag = argv.indexOf('--checkout')
const checkout = checkoutFlag >= 0 ? argv[checkoutFlag + 1] : process.env['DSH_CHECKOUT']
if (!checkout) {
  console.error('usage: check-dsh-surface.mjs --checkout <dsh-checkout> [--update]')
  process.exit(2)
}

function walk(dir, depth = 0) {
  const out = []
  if (depth > 6) return out
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path, depth + 1))
    else if (entry.name === 'package.json') out.push(path)
  }
  return out
}

function findPackages(root) {
  const found = new Map()
  for (const manifest of walk(root)) {
    let data
    try { data = JSON.parse(readFileSync(manifest, 'utf8')) } catch { continue }
    if (typeof data.name !== 'string' || !MODULES.includes(data.name) || found.has(data.name)) continue
    found.set(data.name, { dir: join(manifest, '..'), version: data.version ?? '0.0.0' })
  }
  return found
}

function typeFiles(dir) {
  for (const candidate of ['lib/types', 'lib', 'src']) {
    const root = join(dir, candidate)
    if (!existsSync(root)) continue
    const files = []
    const visit = (current) => {
      let entries
      try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const path = join(current, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (/\.(d\.ts|ts|tsx)$/.test(entry.name)) files.push(path)
      }
    }
    visit(root)
    if (files.length > 0) return files.sort()
  }
  return []
}

function normalize(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function hashSurface(dir) {
  const hash = createHash('sha256')
  const files = typeFiles(dir)
  for (const file of files) {
    hash.update(relative(dir, file))
    hash.update('\0')
    hash.update(normalize(readFileSync(file, 'utf8')))
    hash.update('\0')
  }
  return { hash: `sha256:${hash.digest('hex')}`, files: files.length }
}

const dshVersion = (() => {
  try { return JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).version ?? 'unknown' } catch { return 'unknown' }
})()

const found = findPackages(checkout)
const current = { dsh: dshVersion, modules: {} }
for (const name of MODULES) {
  const pkg = found.get(name)
  if (!pkg) { console.error(`missing package: ${name}`); process.exit(2) }
  const { hash, files } = hashSurface(pkg.dir)
  current.modules[name] = { version: pkg.version, hash, files }
}

if (update) {
  mkdirSync('compat', { recursive: true })
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`)
  console.log(`updated ${BASELINE} (dsh ${dshVersion})`)
  process.exit(0)
}

if (!existsSync(BASELINE)) {
  console.error(`${BASELINE} is missing; run with --update first`)
  process.exit(2)
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
let drift = 0
if (baseline.dsh !== current.dsh) {
  console.log(`dsh version: ${baseline.dsh} -> ${current.dsh}`)
  drift += 1
}
for (const name of MODULES) {
  const before = baseline.modules?.[name]
  const after = current.modules[name]
  if (!before) { console.log(`+ ${name} (new)`); drift += 1; continue }
  if (before.hash !== after.hash) {
    console.log(`~ ${name}: ${before.version} -> ${after.version} (${before.hash.slice(0, 19)}… -> ${after.hash.slice(0, 19)}…)`)
    drift += 1
  }
}
if (drift === 0) {
  console.log(`ok: type surface matches ${BASELINE} (dsh ${current.dsh})`)
} else {
  console.error(`drift detected (${drift}); update shims, then run --update`)
  process.exit(1)
}
