/**
 * Raise the `web_fetch` tool's time limit to the Chain Budget without editing agent preset
 * declarations (ADR 0003). The `tool-web` row lives inside each preset, where profile patches
 * cannot reach it, and DSH's timeout policy reads the definition the agent sees. So, for every
 * agent created while this plugin runs, the definition the agent sees is copied with only
 * `timeoutMs` changed and registered in the agent's own scope, which shadows the preset's.
 * @module dsh-web-fetch-chain/web-fetch-timeout
 */

export const WEB_FETCH = 'web_fetch'

/**
 * @param {object} ctx - host plugin context with `tools`, `on`, and `effect`.
 * @param {object} options
 * @param {number} options.timeoutMs - the raised limit (the Chain Budget).
 * @param {(state: any) => boolean | Promise<boolean>} options.when - the step admission condition
 *   `tool-web` registers `web_fetch` with, which a definition lookup does not return.
 */
export function raiseWebFetchTimeout(ctx, { timeoutMs, when }) {
  /** Agents created while this plugin runs, mapped to the disposer of their copy, if any. */
  const agents = new Map()
  let syncing = false

  /** Replace the agent's copy with one of the definition its preset currently provides. */
  function sync(agent) {
    syncing = true
    try {
      agents.get(agent)?.()
      agents.set(agent, undefined)
      const base = ctx.tools.get(WEB_FETCH, agent)
      if (base === undefined || (typeof base.timeoutMs === 'number' && base.timeoutMs >= timeoutMs)) return
      const tools = agent.ctx.get('tools')
      if (tools === undefined) return
      agents.set(agent, tools.register({ ...base, timeoutMs }, { when }))
    } finally {
      syncing = false
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    sync(agent)
  })
  // A preset switch on a blank agent recomposes its tools and emits tools/change; our own
  // register/dispose calls emit it too, synchronously, which `syncing` ignores.
  ctx.on('tools/change', () => {
    if (syncing) return
    for (const agent of [...agents.keys()]) sync(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = agents.get(agent)
    agents.delete(agent)
    if (dispose === undefined) return
    syncing = true
    try { dispose() } finally { syncing = false }
  })
  ctx.effect(() => () => {
    syncing = true
    try {
      for (const dispose of agents.values()) dispose?.()
      agents.clear()
    } finally {
      syncing = false
    }
  })
}
