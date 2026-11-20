import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

register('../scripts/support/stub-loader.mjs', import.meta.url)

const {
  bootstrapEnvironment,
  ForgeOperations,
} = await import('../packages/core/lib/index.js')
const { apply } = await import('../packages/skill/lib/index.js')

async function tempWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'forge-bootstrap-'))
  const home = join(root, 'forge')
  const profilesRoot = join(root, 'profiles')
  await mkdir(join(profilesRoot, 'web'), { recursive: true })
  await writeFile(join(profilesRoot, 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }))
  await writeFile(
    join(profilesRoot, 'web', 'cordis.patch.yml'),
    [
      '# User comment preserved',
      '- id: other-plugin',
      '  config:',
      '    enabled: true',
      '- id: forge-skill',
      '  config:',
      '    registry:',
      '      url: https://registry.example.com',
      '',
    ].join('\n'),
  )
  return { root, home, profilesRoot }
}

/**
 * Fake exec runner that simulates `uv` or `python3` installing `dora-rs-cli==<ver>`
 * into the target venv directory by writing a real runnable `bin/dora` script.
 */
function makeFakeExec({ hasUv = true } = {}) {
  const calls = []
  const exec = async (file, args) => {
    calls.push([file, ...args])
    if (file === 'uv') {
      if (!hasUv) throw new Error('ENOENT: uv not found')
      if (args[0] === '--version') return { stdout: 'uv 0.13.8\n' }
      if (args[0] === 'venv') {
        const venvDir = args.at(-1)
        await mkdir(join(venvDir, 'bin'), { recursive: true })
        await writeFile(join(venvDir, 'bin', 'python'), '#!/bin/sh\necho "Python 3.12.3"\n', { mode: 0o755 })
        return { stdout: '' }
      }
      if (args[0] === 'pip' && args[1] === 'install') {
        const pyIdx = args.indexOf('--python')
        const venvBin = join(args[pyIdx + 1], '..')
        const spec = args.at(-1)
        const version = spec.split('==')[1] ?? '1.0.1'
        await writeFile(join(venvBin, 'dora'), `#!/bin/sh\necho "dora-cli ${version}"\n`, { mode: 0o755 })
        return { stdout: `Installed ${spec}\n` }
      }
    }
    if (file === 'python3.12' || file === 'python3') {
      if (args[0] === '--version') return { stdout: 'Python 3.12.3\n' }
      if (args[0] === '-m' && args[1] === 'venv') {
        const venvDir = args.at(-1)
        await mkdir(join(venvDir, 'bin'), { recursive: true })
        await writeFile(join(venvDir, 'bin', 'python'), '#!/bin/sh\necho "Python 3.12.3"\n', { mode: 0o755 })
        return { stdout: '' }
      }
    }
    if (file.endsWith('/bin/python') && args[0] === '-m' && args[1] === 'pip' && args[2] === 'install') {
      const venvBin = join(file, '..')
      const spec = args.at(-1)
      const version = spec.split('==')[1] ?? '1.0.1'
      await writeFile(join(venvBin, 'dora'), `#!/bin/sh\necho "dora-cli ${version}"\n`, { mode: 0o755 })
      return { stdout: `Installed ${spec}\n` }
    }
    // Delegate actual `--version` probes of created fake scripts to node child execution via sh.
    if (args[0] === '--version' && existsSync(file)) {
      const { stdout, stderr } = await execFileAsync(file, [...args])
      return { stdout, stderr }
    }
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`)
  }
  return { exec, calls }
}

test('bootstrapEnvironment dryRun plans uv install without mutating disk', async () => {
  const { home, profilesRoot } = await tempWorkspace()
  const { exec, calls } = makeFakeExec({ hasUv: true })

  const result = await bootstrapEnvironment({
    home,
    profilesRoot,
    dryRun: true,
    writeProfileConfig: true,
    indexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    exec,
  })

  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.installer, 'uv')
  assert.equal(result.dora.status, 'planned')
  assert.equal(result.dora1.status, 'planned')
  assert.equal(existsSync(home), false)
  assert.match(result.steps.find(step => step.id === 'dora')?.command ?? '', /--index-url https:\/\/pypi\.tuna\.tsinghua\.edu\.cn\/simple/)
  assert.equal(calls.length, 1) // only `uv --version` probe
})

test('bootstrapEnvironment installs dora 0.4.1 & dora1 1.0.1, updates cordis.patch.yml, verifies, and keeps on second run', async () => {
  const { home, profilesRoot } = await tempWorkspace()
  const { exec } = makeFakeExec({ hasUv: true })

  const first = await bootstrapEnvironment({
    home,
    profilesRoot,
    writeProfileConfig: true,
    profile: 'web',
    offline: true,
    exec,
  })

  assert.equal(first.ok, true)
  assert.equal(first.installer, 'uv')
  assert.equal(first.dora.status, 'installed')
  assert.equal(first.dora.version, '0.4.1')
  assert.equal(first.dora1.status, 'installed')
  assert.equal(first.dora1.version, '1.0.1')
  assert.equal(existsSync(join(home, 'support', 'bin', 'dora')), true)
  assert.equal(existsSync(join(home, 'support', 'bin', 'dora1')), true)
  assert.equal(existsSync(join(home, 'models', 'cache')), true)
  assert.equal(first.environment?.ok, true)

  // Verify cordis.patch.yml kept comment & sibling registry config while adding runtime.dora/dora1.
  const patchRaw = await readFile(join(profilesRoot, 'web', 'cordis.patch.yml'), 'utf8')
  assert.match(patchRaw, /# User comment preserved/)
  assert.match(patchRaw, /https:\/\/registry\.example\.com/)
  assert.match(patchRaw, /support\/bin\/dora1/)

  // Second run without force keeps healthy binaries untouched.
  const second = await bootstrapEnvironment({
    home,
    profilesRoot,
    offline: true,
    exec,
  })
  assert.equal(second.ok, true)
  assert.equal(second.dora.status, 'kept')
  assert.equal(second.dora1.status, 'kept')
})

test('bootstrapEnvironment falls back to python -m venv when uv is unavailable', async () => {
  const { home } = await tempWorkspace()
  const { exec } = makeFakeExec({ hasUv: false })

  const result = await bootstrapEnvironment({
    home,
    components: ['directories', 'dora1'],
    indexUrl: 'https://mirrors.aliyun.com/pypi/simple',
    offline: true,
    verify: false,
    exec,
  })

  assert.equal(result.ok, true)
  assert.equal(result.installer, 'python')
  assert.equal(result.dora.status, 'skipped')
  assert.equal(result.dora1.status, 'installed')
  assert.equal(result.dora1.version, '1.0.1')
  assert.match(result.steps.find(step => step.id === 'dora1')?.command ?? '', /-m venv/)
  assert.match(result.steps.find(step => step.id === 'dora1')?.command ?? '', /--index-url https:\/\/mirrors\.aliyun\.com\/pypi\/simple/)
})

test('bootstrapEnvironment supports local binary installation and rejects mismatched generation', async () => {
  const { root, home } = await tempWorkspace()
  const goodDora = join(root, 'good-dora')
  const badDora1 = join(root, 'bad-dora1')
  await writeFile(goodDora, '#!/bin/sh\necho "dora-cli 0.4.1"\n', { mode: 0o755 })
  await writeFile(badDora1, '#!/bin/sh\necho "dora-cli 0.4.1"\n', { mode: 0o755 })

  const result = await bootstrapEnvironment({
    home,
    doraBinaryPath: goodDora,
    dora1BinaryPath: badDora1,
    verify: false,
  })

  assert.equal(result.ok, false)
  assert.equal(result.dora.status, 'installed')
  assert.equal(result.dora.version, '0.4.1')
  assert.equal(result.dora1.status, 'failed')
})

test('ForgeOperations configRead, configWrite (merge & replace) and configRestore preserve backups and diffs', async () => {
  const { home, profilesRoot } = await tempWorkspace()
  const ops = new ForgeOperations({ home, profilesRoot, profile: 'web' })

  const initial = await ops.configRead()
  assert.equal(initial.profile, 'web')
  assert.deepEqual(initial.profiles, ['web'])
  assert.equal(initial.config.registry?.url, 'https://registry.example.com')

  // Merge update adds models.root without wiping registry.url.
  const merged = await ops.configWrite('web', { models: { root: '/data/forge-models' } })
  assert.ok(merged.backup !== undefined)
  assert.equal(merged.config.registry?.url, 'https://registry.example.com')
  assert.equal(merged.config.models?.root, '/data/forge-models')
  assert.ok(merged.changed >= 1)

  // Restore previous backup brings config back to initial state.
  const backupName = merged.backup.slice(merged.backup.lastIndexOf('/') + 1)
  const restored = await ops.configRestore('web', backupName)
  assert.equal(restored.restored, backupName)
  const afterRestore = await ops.configRead('web')
  assert.equal(afterRestore.config.models, undefined)
  assert.equal(afterRestore.config.registry?.url, 'https://registry.example.com')
})

test('DSH plugin registers environment setup, config and model tools plus bootstrap SOP in forge-usage', () => {
  const registeredTools = []
  const registeredSkills = []
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined },
    effect: fn => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => undefined },
    inject: (_keys, callback) => callback(ctx),
    skills: {
      registerProvider: () => () => undefined,
      register: skill => { registeredSkills.push(skill); return () => undefined },
    },
    tools: {
      register: tool => { registeredTools.push(tool.name); return () => undefined },
    },
    systemPrompt: { section: () => () => undefined },
  }
  apply(ctx, { home: '/tmp/forge-bootstrap-tools-test' })

  for (const expected of [
    'forge_environment_check',
    'forge_environment_setup',
    'forge_config_read',
    'forge_config_write',
    'forge_config_restore',
    'forge_model_search',
    'forge_model_info',
    'forge_model_verify',
  ]) {
    assert.ok(registeredTools.includes(expected), `missing DSH tool ${expected}`)
  }

  const usage = registeredSkills.find(skill => skill.name === 'forge-usage')
  assert.ok(usage !== undefined)
  assert.match(usage.content, /Bootstrap a new machine/)
  assert.match(usage.content, /forge_environment_setup/)
  assert.match(usage.content, /forge_config_write/)
})

test('CLI supports forge setup --dry-run and forge config / config-set / config-restore', async () => {
  const { root, home, profilesRoot } = await tempWorkspace()
  const cli = resolve('packages/cli/bin/forge.mjs')
  const env = { ...process.env, DSH_HOME: root, DSH_FORGE_HOME: home }

  const plan = JSON.parse((await execFileAsync(process.execPath, [cli, 'setup', '--dry-run'], { env })).stdout)
  assert.equal(plan.ok, true)
  assert.equal(plan.dryRun, true)

  const readBefore = JSON.parse((await execFileAsync(process.execPath, [cli, 'config', 'web'], { env })).stdout)
  assert.equal(readBefore.ok, true)
  assert.equal(readBefore.config.registry.url, 'https://registry.example.com')

  const written = JSON.parse((await execFileAsync(
    process.execPath,
    [cli, 'config-set', JSON.stringify({ models: { root: join(home, 'models') } }), '--profile', 'web'],
    { env },
  )).stdout)
  assert.equal(written.ok, true)
  assert.equal(written.config.models.root, join(home, 'models'))
  assert.equal(written.config.registry.url, 'https://registry.example.com')
  assert.ok(existsSync(written.backup))
  // Verify profilesRoot was honored via DSH_HOME
  assert.equal(written.path, join(profilesRoot, 'web', 'cordis.patch.yml'))
})
