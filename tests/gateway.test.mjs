import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'

import { ForgeCatalog, ForgeToolClient, diagnoseSkill } from '../packages/core/lib/index.js'

const fixtures = fileURLToPath(new URL('../fixtures/skills', import.meta.url))

test('doctor reports static structure for a complete bundle', async () => {
  const catalog = new ForgeCatalog(fixtures)
  const diagnosis = await diagnoseSkill({ catalog, skill: 'minimal-grasp' })
  assert.equal(diagnosis.ok, true)
  assert.equal(diagnosis.profile, 'mujoco-piper')
  assert.ok(diagnosis.checks.every(check => check.status !== 'fail'))
})

test('doctor reports a missing instruction document as a failure', async () => {
  const catalog = new ForgeCatalog(fixtures)
  const diagnosis = await diagnoseSkill({ catalog, skill: 'broken-doc' })
  assert.equal(diagnosis.ok, false)
  assert.ok(diagnosis.checks.some(check => check.id === 'skill_document' && check.status === 'fail'))
})

test('gateway client routes query tools through their endpoint operation', async () => {
  const seen = []
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`)
    if (request.url === '/tools') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true, data: { tools: [
        { tool_id: 'sim.get_robot_info', semantics: 'query', endpoint_id: 'sim.control', operation: 'get_robot_info' },
        { tool_id: 'sim.reset', semantics: 'action' },
      ] } }))
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, data: { endpoint_id: 'sim.control', response: { outcome: 'completed' } } }))
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  try {
    const client = new ForgeToolClient(`http://127.0.0.1:${port}`)
    const tools = await client.tools()
    assert.deepEqual(tools.map(tool => tool.toolId), ['sim.get_robot_info', 'sim.reset'])

    const query = await client.invoke('sim.get_robot_info', {})
    assert.equal(query.httpStatus, 200)
    assert.ok(seen.includes('POST /tools/sim.control/get_robot_info:invoke'))

    await client.invoke('sim.reset', {})
    assert.ok(seen.includes('POST /tools/sim.reset:invoke'))
  } finally {
    server.close()
  }
})
