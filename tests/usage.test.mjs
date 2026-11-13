import assert from 'node:assert/strict'
import { register } from 'node:module'
import { test } from 'node:test'

register('../scripts/support/stub-loader.mjs', import.meta.url)
const { apply } = await import('../packages/skill/lib/index.js')

function harness() {
  const skills = []
  const sections = []
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined },
    effect: fn => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => undefined },
    inject: (_keys, callback) => callback(ctx),
    skills: {
      registerProvider: () => () => undefined,
      register: skill => { skills.push(skill); return () => undefined },
    },
    tools: { register: () => () => undefined },
    systemPrompt: { section: options => { sections.push(options); return () => undefined } },
  }
  return { ctx, skills, sections }
}

test('registers the forge-usage skill and the system prompt section', () => {
  const { ctx, skills, sections } = harness()
  apply(ctx, { home: '/tmp/forge-usage-test' })

  assert.equal(skills.length, 2)
  assert.deepEqual(skills.map(skill => skill.name), ['forge-usage', 'forge-skill-development'])
  assert.equal(skills[0].name, 'forge-usage')
  assert.equal(skills[0].source, 'runtime')
  assert.match(skills[1].content, /dataflow/)
  assert.match(skills[1].content, /operator-motion/)
  assert.match(skills[1].content, /TrackB|PhyAgentOS/)
  assert.match(skills[0].content, /forge_profile_write/)
  assert.match(skills[0].content, /permission to retry/i)

  assert.equal(sections.length, 2)
  const tools = sections.find(section => section.name === 'forge-tools')
  const rules = sections.find(section => section.name === 'forge-runtime-rules')
  assert.ok(tools, 'forge-tools section must be registered')
  assert.ok(rules, 'forge-runtime-rules section must be registered')
  assert.match(tools.text, /forge_install_status/)
  assert.match(tools.text, /restart the runtime/)
  assert.match(rules.text, /FINAL for the turn/)
  assert.match(rules.text, /never do it to verify or unblock/)
})

test('prompt flags can turn both off', () => {
  const { ctx, skills, sections } = harness()
  apply(ctx, { home: '/tmp/forge-usage-test', prompt: { usageSkill: false, developmentSkill: false, section: false, runtimeRules: false } })
  assert.equal(skills.length, 0)
  assert.equal(sections.length, 0)
})
