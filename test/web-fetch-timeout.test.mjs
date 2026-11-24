import { test } from 'node:test'
import assert from 'node:assert/strict'
import { raiseWebFetchTimeout } from '../lib/web-fetch-timeout.js'

/**
 * A fake of the DSH tools registry seam: a parent (preset) layer per agent and an agent layer,
 * where the agent layer shadows the parent. Every change emits `tools/change` synchronously.
 */
function fakeHost() {
  const listeners = new Map()
  const effects = []
  const parent = new Map() // agent -> Map<name, definition>
  const own = new Map() // agent -> Map<name, { definition, when }>
  const on = (event, listener) => {
    const list = listeners.get(event) ?? []
    list.push(listener)
    listeners.set(event, list)
  }
  const emit = (event, payload) => {
    for (const listener of listeners.get(event) ?? []) listener(payload)
  }
  const ownLayer = agent => own.get(agent) ?? own.set(agent, new Map()).get(agent)
  const tools = {
    get(name, agent) {
      return own.get(agent)?.get(name)?.definition ?? parent.get(agent)?.get(name)
    },
  }
  function makeAgent(presetTools = {}) {
    const agent = { id: Math.random().toString(16).slice(2) }
    parent.set(agent, new Map(Object.entries(presetTools)))
    agent.ctx = {
      get: name => (name === 'tools' ? {
        register(definition, options = {}) {
          const layer = ownLayer(agent)
          if (layer.has(definition.name)) throw new Error(`duplicate ${definition.name}`)
          const registration = { definition, when: options.when }
          layer.set(definition.name, registration)
          emit('tools/change')
          let disposed = false
          return () => {
            if (disposed) return
            disposed = true
            if (layer.get(definition.name) === registration) layer.delete(definition.name)
            emit('tools/change')
          }
        },
      } : undefined),
    }
    return agent
  }
  const warnings = []
  const ctx = {
    tools,
    on,
    effect: (fn) => { effects.push(fn()) },
    logger: { warn: (message) => { warnings.push(message) } },
  }
  return {
    ctx,
    makeAgent,
    create: agent => emit('agent/created', { agent }),
    dispose: agent => { own.delete(agent); emit('agent/disposed', { agent }) },
    switchPreset(agent, presetTools) {
      parent.set(agent, new Map(Object.entries(presetTools)))
      emit('tools/change')
    },
    unload: () => { for (const cleanup of effects) cleanup() },
    when: (agent, name) => own.get(agent)?.get(name)?.when,
    /** What the agent's preset (parent scope) provides, ignoring the agent's own layer. */
    inherited: agent => parent.get(agent)?.get('web_fetch'),
    /** Register a tool in the agent's own layer, as another plugin would. */
    registerOwn: (agent, definition) => agent.ctx.get('tools').register(definition),
    /** Remove the agent's own registrations without notifying, as scope teardown does first. */
    teardown: agent => { own.delete(agent); emit('tools/change') },
    warnings,
  }
}

function raise(host, timeoutMs = 135_000) {
  raiseWebFetchTimeout(host.ctx, { timeoutMs, when, inherited: host.inherited })
}

function webFetch(timeoutMs = 30_000) {
  return { name: 'web_fetch', description: 'Fetch a URL', timeoutMs, execute: async () => 'page', output: { render: () => '' } }
}

const when = () => true

test('a new agent sees web_fetch with the raised timeout and the original behavior', () => {
  const host = fakeHost()
  raise(host)
  const base = webFetch()
  const agent = host.makeAgent({ web_fetch: base })
  host.create(agent)

  const seen = host.ctx.tools.get('web_fetch', agent)
  assert.equal(seen.timeoutMs, 135_000)
  assert.equal(seen.execute, base.execute)
  assert.equal(seen.description, base.description)
  assert.equal(base.timeoutMs, 30_000, 'the shared preset definition is not mutated')
  assert.equal(host.when(agent, 'web_fetch'), when)
})

test('an agent without web_fetch gets nothing', () => {
  const host = fakeHost()
  raise(host)
  const agent = host.makeAgent({})
  host.create(agent)
  assert.equal(host.ctx.tools.get('web_fetch', agent), undefined)
})

test('a web_fetch that already allows at least as long is left alone', () => {
  const host = fakeHost()
  raise(host)
  const base = webFetch(200_000)
  const agent = host.makeAgent({ web_fetch: base })
  host.create(agent)
  assert.equal(host.ctx.tools.get('web_fetch', agent), base)
})

test('switching the preset re-copies the new preset web_fetch, or removes the copy when it has none', () => {
  const host = fakeHost()
  raise(host)
  const agent = host.makeAgent({ web_fetch: webFetch() })
  host.create(agent)

  const next = webFetch()
  host.switchPreset(agent, { web_fetch: next })
  const seen = host.ctx.tools.get('web_fetch', agent)
  assert.equal(seen.execute, next.execute)
  assert.equal(seen.timeoutMs, 135_000)

  host.switchPreset(agent, {})
  assert.equal(host.ctx.tools.get('web_fetch', agent), undefined)

  host.switchPreset(agent, { web_fetch: webFetch() })
  assert.equal(host.ctx.tools.get('web_fetch', agent).timeoutMs, 135_000)
})

test('unloading the plugin restores the preset web_fetch', () => {
  const host = fakeHost()
  raise(host)
  const base = webFetch()
  const agent = host.makeAgent({ web_fetch: base })
  host.create(agent)
  host.unload()
  assert.equal(host.ctx.tools.get('web_fetch', agent), base)
})

test('agents created before the plugin loads are left alone', () => {
  const host = fakeHost()
  const base = webFetch()
  const agent = host.makeAgent({ web_fetch: base })
  host.create(agent)
  raise(host)
  host.switchPreset(agent, { web_fetch: base })
  assert.equal(host.ctx.tools.get('web_fetch', agent), base)
})

test('a disposed agent is forgotten', () => {
  const host = fakeHost()
  raise(host)
  const agent = host.makeAgent({ web_fetch: webFetch() })
  host.create(agent)
  host.dispose(agent)
  host.switchPreset(agent, { web_fetch: webFetch() })
  assert.equal(host.ctx.tools.get('web_fetch', agent).timeoutMs, 30_000)
})

test('an agent closing does not re-register web_fetch while its scope tears down', () => {
  const host = fakeHost()
  raise(host)
  const base = webFetch()
  const agent = host.makeAgent({ web_fetch: base })
  host.create(agent)
  let registrations = 0
  const tools = agent.ctx.get('tools')
  agent.ctx.get = () => ({ register: (...args) => { registrations++; return tools.register(...args) } })
  host.teardown(agent)
  host.dispose(agent)
  assert.equal(registrations, 0)
})

test('an unrelated tool change leaves the copy in place', () => {
  const host = fakeHost()
  raise(host)
  const agent = host.makeAgent({ web_fetch: webFetch() })
  host.create(agent)
  const copy = host.ctx.tools.get('web_fetch', agent)
  host.registerOwn(agent, { name: 'other_tool', output: {} })
  assert.equal(host.ctx.tools.get('web_fetch', agent), copy)
})

test('a web_fetch another plugin registered for the agent is left alone', () => {
  const host = fakeHost()
  raise(host)
  const agent = host.makeAgent({ web_fetch: webFetch() })
  const theirs = webFetch(20_000)
  host.registerOwn(agent, theirs)
  host.create(agent)
  assert.equal(host.ctx.tools.get('web_fetch', agent), theirs)
  assert.deepEqual(host.warnings, [])
})

test('a failing registration is logged and does not fail agent creation', () => {
  const host = fakeHost()
  raise(host)
  const agent = host.makeAgent({ web_fetch: webFetch() })
  agent.ctx.get = () => ({ register: () => { throw new Error('inactive effect') } })
  assert.doesNotThrow(() => host.create(agent))
  assert.match(host.warnings.join('\n'), /inactive effect/)
})
