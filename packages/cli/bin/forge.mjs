#!/usr/bin/env node
/**
 * forge — manage Forge skills from a shell.
 *
 * Shares the same home and state file as the DSH host; mutating operations take
 * the same cross-process lock, so the two can run side by side.
 */
import { join } from 'node:path'

import { ForgeOperations, resolveForgeHome } from '@x-era/forge-core'

const argv = process.argv.slice(2)
const command = argv.shift()
const json = (value, code = 0) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  process.exitCode = code
}
const fail = error => {
  const code = error?.code ?? 'FORGE_ERROR'
  json({ ok: false, code, message: error instanceof Error ? error.message : String(error) }, 1)
}

const home = resolveForgeHome(process.env.DSH_FORGE_HOME)
const operations = new ForgeOperations({
  home,
})
await operations.runtime.load()

try {
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
      json({
        ok: true,
        usage: [
          'forge list',
          'forge status [name]',
          'forge search [query]',
          'forge inspect <name>',
          'forge read <name>',
          'forge install <name> [--no-nodes] [--version x] [--wait]',
          'forge versions <name>',
          'forge update <name> [--apply] [--version x]',
          'forge remove <name>',
          'forge start <name> <profile>          start via coordinator (default)',
          'forge start <name> <profile> --run    start as an isolated dora run process',
          'forge stop <name> [--force]',
          'forge logs <name> [lines]',
          'forge call <name> <tool_id> [json]',
          'forge repos [query] [--category adapter]',
          'forge repo <id_or_node>',
          'forge docs <name> [file]',
          'forge source <artifact_id> [file]',
          'forge node-info <artifact_id>',
          'forge validate <path>',
          'forge node-info <artifact_id>',
          'forge files <name> [profile]',
          'forge file-read <name> <profile> <file>',
          'forge file-write <name> <profile> <file>   (content on stdin)',
          'forge doctor <name> [--profile <id>]',
          'forge env [--offline]                check dora/node/python/data root/registry/ports',
          'forge report [name]',
          'forge export <name> [--out <dir>]',
          'forge jobs [limit]',
          'forge job <id>',
          'forge cancel <id>',
          'forge cache summary|gc [--dry-run]',
        ],
        home,
        modes: {
          start: 'default; dora up + dora start --detach; flow registered in the coordinator; stopped by name',
          run: 'dora run; no coordinator; forge tracks the pid and stops the process group',
        },
        binaries: {
          dora: 'Forge 1 dora CLI (runtime.dora / DSH_FORGE_DORA / dora)',
          dora1: 'Forge 2 dora CLI (runtime.dora1 / DSH_FORGE_DORA1 / dora1)',
        },
      })
      break
    case 'list': {
      const listing = await operations.list()
      json({ ok: true, home, ...listing })
      break
    }
    case 'status': {
      if (argv[0] !== undefined) {
        json({ ok: true, name: argv[0], runtime: await operations.runtimeStatus(argv[0]) })
      } else {
        const listing = await operations.list()
        json({ ok: true, runtimes: listing.skills.map(skill => ({ name: skill.name, runtime: skill.runtime })) })
      }
      break
    }
    case 'search': {
      json({ ok: true, registry: operations.registry.baseUrl, skills: await operations.search(argv[0] ?? '') })
      break
    }
    case 'inspect': {
      json(await operations.inspect(requireArg(argv[0], 'inspect <name>')))
      break
    }
    case 'read': {
      json({ ok: true, ...await operations.read(requireArg(argv[0], 'read <name>')) })
      break
    }
    case 'install': {
      const name = requireArg(argv[0], 'install <name>')
      const withNodes = !argv.includes('--no-nodes')
      const versionIndex = argv.indexOf('--version')
      const version = versionIndex >= 0 ? argv[versionIndex + 1] : undefined
      const record = operations.install(name, withNodes, version)
      if (argv.includes('--wait')) {
        json({ ok: true, job: await operations.jobs.wait(record.id) })
      } else {
        json({ ok: true, jobId: record.id, state: record.state, hint: 'forge job <id>' })
      }
      break
    }
    case 'versions': {
      json({ ok: true, ...await operations.listSkillVersions(requireArg(argv[0], 'versions <name>')) })
      break
    }
    case 'update': {
      const versionIndex = argv.indexOf('--version')
      const version = versionIndex >= 0 ? argv[versionIndex + 1] : undefined
      json({ ok: true, ...await operations.update(requireArg(argv[0], 'update <name>'), argv.includes('--apply'), version) })
      break
    }
    case 'remove': {
      json({ ok: true, ...await operations.remove(requireArg(argv[0], 'remove <name>')) })
      break
    }
    case 'start': {
      const positional = argv.filter(value => !value.startsWith('--'))
      const [name, profile] = positional
      const launch = argv.includes('--run') ? 'run' : 'start'
      json({ ok: true, runtime: await operations.runtimeStart(requireArg(name, 'start <name> <profile>'), requireArg(profile, 'start <name> <profile>'), launch) })
      break
    }
    case 'stop': {
      json({ ok: true, runtime: await operations.runtimeStop(requireArg(argv[0], 'stop <name>'), argv.includes('--force')) })
      break
    }
    case 'logs': {
      const name = requireArg(argv[0], 'logs <name> [lines]')
      json({ ok: true, log: await operations.runtimeLogs(name, Number(argv[1] ?? 120)) })
      break
    }
    case 'call': {
      const [name, toolId, raw] = argv
      json(await operations.toolCall(requireArg(name, 'call <name> <tool_id> [json]'), requireArg(toolId, 'call <name> <tool_id> [json]'), raw === undefined ? {} : JSON.parse(raw)))
      break
    }
    case 'repos': {
      const index = argv.indexOf('--category')
      const category = index >= 0 ? argv[index + 1] : undefined
      const query = index >= 0 ? argv.slice(0, index).join(' ') : argv.join(' ')
      const entries = operations.listRepositories(query.trim() === '' ? undefined : query.trim(), category)
      json({ ok: true, count: entries.length, repositories: entries })
      break
    }
    case 'repo': {
      const entry = operations.repository(requireArg(argv[0], 'repo <id_or_node>'))
      json(entry === undefined ? { ok: false, code: 'FORGE_REPO_NOT_FOUND' } : { ok: true, ...entry })
      break
    }
    case 'docs': {
      const name = requireArg(argv[0], 'docs <name> [file]')
      if (argv[1] === undefined) json({ ok: true, ...await operations.skillDocs(name) })
      else json({ ok: true, ...await operations.readSkillDoc(name, argv[1]) })
      break
    }
    case 'validate': {
      json({ ok: true, ...await operations.validateLocalBundle(requireArg(argv[0], 'validate <path>')) })
      break
    }
    case 'source': {
      const id = requireArg(argv[0], 'source <artifact_id> [file]')
      json({ ok: true, ...await operations.nodeSource(id, argv[1] ?? 'README.md', argv.includes('--refresh')) })
      break
    }
    case 'node-info': {
      json({ ok: true, ...await operations.nodeInfo(requireArg(argv[0], 'node-info <artifact_id>')) })
      break
    }
    case 'files': {
      const name = requireArg(argv[0], 'files <name> [profile]')
      const tree = await operations.profileTree()
      const skill = tree.find(item => item.name === name)
      if (skill === undefined) throw Object.assign(new Error(`skill "${name}" is not installed`), { code: 'FORGE_SKILL_NOT_FOUND' })
      const profiles = argv[1] === undefined ? skill.profiles : skill.profiles.filter(item => item.id === argv[1])
      json({ ok: true, skill: name, profiles })
      break
    }
    case 'file-read': {
      const [name, profile, file] = argv
      json({ ok: true, ...await operations.profileRead(requireArg(name, 'file-read <name> <profile> <file>'), requireArg(profile, 'file-read <name> <profile> <file>'), requireArg(file, 'file-read <name> <profile> <file>')) })
      break
    }
    case 'file-write': {
      const [name, profile, file] = argv
      const content = await new Promise((resolveRead, rejectRead) => {
        let buffer = ''
        process.stdin.setEncoding('utf8')
        process.stdin.on('data', chunk => { buffer += chunk })
        process.stdin.on('end', () => resolveRead(buffer))
        process.stdin.on('error', rejectRead)
      })
      json({ ok: true, ...await operations.profileWrite(requireArg(name, 'file-write <name> <profile> <file>'), requireArg(profile, 'file-write <name> <profile> <file>'), requireArg(file, 'file-write <name> <profile> <file>'), String(content)) })
      break
    }
    case 'doctor': {
      const index = argv.indexOf('--profile')
      const profile = index >= 0 ? argv[index + 1] : undefined
      json(await operations.doctor(requireArg(argv[0], 'doctor <name>'), profile))
      break
    }
    case 'report': {
      json({ ok: true, ...await operations.doctorReport(argv[0]) })
      break
    }
    case 'env': {
      json(await operations.environmentCheck({ offline: argv.includes('--offline') }))
      break
    }
    case 'export': {
      const index = argv.indexOf('--out')
      const out = index >= 0 ? argv[index + 1] : join(home, 'portable')
      json({ ok: true, ...await operations.exportPortable(requireArg(argv[0], 'export <name>'), out) })
      break
    }
    case 'jobs': {
      json({ ok: true, jobs: await operations.jobList(Number(argv[0] ?? 10)) })
      break
    }
    case 'job': {
      json({ ok: true, job: await operations.jobStatus(requireArg(argv[0], 'job <id>')) })
      break
    }
    case 'cancel': {
      json({ ok: operations.cancelJob(requireArg(argv[0], 'cancel <id>')) })
      break
    }
    case 'cache': {
      if (argv[0] === 'gc') {
        json({ ok: true, dryRun: argv.includes('--dry-run'), ...await operations.cacheGc(argv.includes('--dry-run')) })
      } else {
        json({ ok: true, ...await operations.cacheSummary() })
      }
      break
    }
    default:
      json({ ok: false, code: 'FORGE_USAGE', message: `unknown command ${command}` }, 1)
  }
} catch (error) {
  fail(error)
}

function requireArg(value, usage) {
  if (value === undefined) {
    const error = new Error(`usage: forge ${usage}`)
    error.code = 'FORGE_USAGE'
    throw error
  }
  return value
}
