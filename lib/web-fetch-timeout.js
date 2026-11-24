/**
 * Raise the `web_fetch` tool's time limit to the Chain Budget without editing agent preset
 * declarations (ADR 0003). The `tool-web` row lives inside each preset, where profile patches
 * cannot reach it, and DSH's timeout policy reads the definition the agent sees. So, for every
 * agent created while this plugin runs, the definition the agent inherits from its preset is
 * copied with only `timeoutMs` changed and registered in the agent's own scope, which shadows it.
 * @module dsh-web-fetch-chain/web-fetch-timeout
 */

export const WEB_FETCH = 'web_fetch'

/**
 * @param {object} ctx - host plugin context with `tools`, `on`, `effect`, and `logger`.
 * @param {object} options
 * @param {number} options.timeoutMs - the raised limit (the Chain Budget).
 * @param {(state: any) => boolean | Promise<boolean>} options.when - the step admission condition
 *   `tool-web` registers `web_fetch` with, which a definition lookup does not return.
 * @param {(agent: any) => object | undefined} options.inherited - the `web_fetch` definition the
 *   agent inherits from its enclosing (preset) scope, which the agent's own copy does not hide.
 */
export function raiseWebFetchTimeout(ctx, { timeoutMs, when, inherited }) {
  /** Agents created while this plugin runs → the inherited definition last seen and our copy. */
  const agents = new Map()

  const warn = (message, error) => {
    ctx.logger?.warn?.(`web-fetch-chain: ${message}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const release = (entry) => {
    const dispose = entry?.dispose
    if (entry !== undefined) entry.dispose = undefined
    try { dispose?.() } catch (error) { warn('could not remove the web_fetch copy', error) }
  }

  /** Re-copy only when the inherited definition changed (a preset switch on a blank agent). */
  function sync(agent) {
    const base = inherited(agent)
    const previous = agents.get(agent)
    if (previous !== undefined && previous.base === base) return
    // Record the new state before touching the registry: register and dispose emit
    // tools/change synchronously, and the re-entrant sync must see it as current.
    const entry = { base, dispose: undefined }
    agents.set(agent, entry)
    release(previous)
    if (base === undefined || (typeof base.timeoutMs === 'number' && base.timeoutMs >= timeoutMs)) return
    // Another plugin's agent-local web_fetch already wins; leave it alone.
    if (ctx.tools.get(WEB_FETCH, agent) !== base) return
    const tools = agent.ctx.get('tools')
    if (tools === undefined) return
    try {
      entry.dispose = tools.register({ ...base, timeoutMs }, { when })
    } catch (error) {
      warn('could not raise the web_fetch time limit for an agent', error)
    }
  }

  const guarded = (listener) => (payload) => {
    try { listener(payload) } catch (error) { warn('web_fetch time limit update failed', error) }
  }

  ctx.on('agent/created', guarded(({ agent }) => { sync(agent) }))
  ctx.on('tools/change', guarded(() => {
    for (const agent of [...agents.keys()]) sync(agent)
  }))
  ctx.on('agent/disposed', guarded(({ agent }) => {
    const entry = agents.get(agent)
    agents.delete(agent)
    release(entry)
  }))
  ctx.effect(() => () => {
    const entries = [...agents.values()]
    agents.clear()
    for (const entry of entries) release(entry)
  })
}
