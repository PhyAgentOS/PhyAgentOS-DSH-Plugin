import assert from 'node:assert/strict'
import { register } from 'node:module'
import { test } from 'node:test'

register('../scripts/support/stub-loader.mjs', import.meta.url)
const { jsonSchemaToParameters, toolNameFor, DynamicToolRegistry } = await import('../packages/skill/lib/dynamic.js')

test('maps common JSON Schema nodes onto the tool parameter DSL', () => {
  const parameters = jsonSchemaToParameters({
    type: 'object',
    required: ['group_name', 'positions'],
    properties: {
      group_name: { type: 'string', description: 'joint group' },
      positions: { type: 'array', items: { type: 'number' } },
      pose: {
        type: 'object',
        properties: { x: { type: 'number' }, frame: { enum: ['tcp', 'base'] } },
        required: ['x'],
        additionalProperties: false,
      },
      weird: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      anything: {},
    },
  })
  assert.deepEqual(parameters.group_name, { type: 'string', description: 'joint group', required: true })
  assert.deepEqual(parameters.positions, { type: 'array', items: { type: 'number' }, required: true })
  assert.equal(parameters.pose.type, 'object')
  assert.equal(parameters.pose.properties.x.required, true)
  assert.equal(parameters.pose.additionalProperties, false)
  assert.equal(parameters.weird.oneOf.length, 2)
  assert.deepEqual(parameters.anything, { type: 'json' })
})

test('tool names are sanitized and bounded', () => {
  assert.equal(toolNameFor('robot-control-sim', 'sim.move_eef'), 'forge_robot_control_sim_sim_move_eef')
  const long = toolNameFor('a'.repeat(40), 'b'.repeat(40))
  assert.ok(long.length <= 64)
  assert.match(long, /^[a-z0-9_]+$/)
})

test('dynamic registry registers, replaces and disposes typed tools', async () => {
  const registered = []
  const disposed = []
  const ctx = {
    tools: {
      registered: [],
      register: definition => {
        registered.push(definition.name)
        ctx.tools.registered.push(definition)
        return () => disposed.push(definition.name)
      },
    },
  }
  const specs = [
    { toolId: 'sim.get_robot_info', semantics: 'query', raw: { description: 'read robot', input_schema: { type: 'object', properties: {} } } },
    { toolId: 'sim.move_eef', semantics: 'action', raw: { input_schema: { type: 'object', properties: { pose: { type: 'object' } } } } },
  ]
  const operations = {
    runtimeStatus: async () => ({ status: 'healthy', gatewayUrl: 'http://127.0.0.1:1' }),
    gatewayTools: async () => specs,
    toolCall: async () => ({ ok: true }),
  }

  const off = new DynamicToolRegistry(ctx, operations, { mode: 'off', skills: [] })
  assert.deepEqual(await off.refresh('robot-control-sim'), { registered: [], skipped: 'disabled' })

  const registry = new DynamicToolRegistry(ctx, operations, { mode: 'whitelist', skills: ['robot-control-sim'] })
  const first = await registry.refresh('robot-control-sim')
  assert.deepEqual(first.registered, ['forge_robot_control_sim_sim_get_robot_info', 'forge_robot_control_sim_sim_move_eef'])
  assert.equal(registered.length, 2)

  const typed = ctx.tools.registered
  assert.equal(typed.length, 2)

  const second = await registry.refresh('robot-control-sim')
  assert.equal(second.registered.length, 2)
  assert.deepEqual(disposed, first.registered, 'refresh disposes the previous generation')

  const executed = []
  const original = operations.toolCall
  operations.toolCall = async (skill, toolId, args) => { executed.push({ skill, toolId, args }); return { ok: true, outputs: { name: 'piper' } } }
  const value = await ctx.tools.registered[0].execute({ frame: 'tcp' }, {})
  operations.toolCall = original
  assert.deepEqual(executed, [{ skill: 'robot-control-sim', toolId: 'sim.get_robot_info', args: { frame: 'tcp' } }])
  assert.equal(value.outputs.name, 'piper')

  registry.dispose('robot-control-sim')
  assert.equal(disposed.length, 4)
})
