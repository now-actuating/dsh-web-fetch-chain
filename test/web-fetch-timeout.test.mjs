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
  const ctx = {
    tools,
    on,
    effect: (fn) => { effects.push(fn()) },
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
  }
}

function webFetch(timeoutMs = 30_000) {
  return { name: 'web_fetch', description: 'Fetch a URL', timeoutMs, execute: async () => 'page', output: { render: () => '' } }
}

const when = () => true

test('a new agent sees web_fetch with the raised timeout and the original behavior', () => {
  const host = fakeHost()
  raiseWebFetchTimeout(host.ctx, { timeoutMs: 135_000, when })
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
  raiseWebFetchTimeout(host.ctx, { timeoutMs: 135_000, when })
  const agent = host.makeAgent({})
  host.create(agent)
  assert.equal(host.ctx.tools.get('web_fetch', agent), undefined)
})

test('a web_fetch that already allows at least as long is left alone', () => {
  const host = fakeHost()
  raiseWebFetchTimeout(host.ctx, { timeoutMs: 135_000, when })
  const base = webFetch(200_000)
  const agent = host.makeAgent({ web_fetch: base })
  host.create(agent)
  assert.equal(host.ctx.tools.get('web_fetch', agent), base)
})

test('switching the preset re-copies the new preset web_fetch, or removes the copy when it has none', () => {
  const host = fakeHost()
  raiseWebFetchTimeout(host.ctx, { timeoutMs: 135_000, when })
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
  raiseWebFetchTimeout(host.ctx, { timeoutMs: 135_000, when })
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
  raiseWebFetchTimeout(host.ctx, { timeoutMs: 135_000, when })
  host.switchPreset(agent, { web_fetch: base })
  assert.equal(host.ctx.tools.get('web_fetch', agent), base)
})

test('a disposed agent is forgotten', () => {
  const host = fakeHost()
  raiseWebFetchTimeout(host.ctx, { timeoutMs: 135_000, when })
  const agent = host.makeAgent({ web_fetch: webFetch() })
  host.create(agent)
  host.dispose(agent)
  host.switchPreset(agent, { web_fetch: webFetch() })
  assert.equal(host.ctx.tools.get('web_fetch', agent).timeoutMs, 30_000)
})
