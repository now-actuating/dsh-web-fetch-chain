/**
 * Host half of the settings page on this bundle's Plugins screen: RPC handlers that read the
 * effective settings and key status, save settings through the config editor, store and delete
 * API keys in DSH credentials, and run a Key Check. No handler ever returns a key.
 * @module dsh-web-fetch-chain/management
 */

import { checkKey } from './key-check.js'
import { KEY_REFS, PAID_STEPS, SettingsError, maskKey, rawConfig, settingsView } from './settings.js'

/** Route prefix: each handler is served at `/api/web-fetch-chain.<endpoint>`. */
export const ROUTE_PREFIX = 'web-fetch-chain.'

/**
 * @param {object} deps
 * @param {Record<string, unknown>} deps.config the row's effective config.
 * @param {(() => ((next: Record<string, unknown>) => Promise<void>) | undefined)} deps.editor
 *   returns a writer for the row's raw config, or undefined when this profile cannot save.
 * @param {() => ({ describe(ref: any): Promise<any>, resolve(ref: any): Promise<any>, set(ref: any, value: string): Promise<void>, unset(ref: any): Promise<void> } | undefined)} deps.credentials
 * @param {(name: string) => any} [deps.brand] turns a credential name into a credential ref.
 * @param {typeof fetch} deps.transport
 */
export function createHandlers({ config, editor, credentials, brand = name => name, transport }) {
  let saves = Promise.resolve()

  const provider = () => {
    const service = credentials()
    if (service === undefined) throw new SettingsError('No credential store is available in this profile.')
    return service
  }

  const paidStep = (payload) => {
    const step = payload?.step
    if (!PAID_STEPS.includes(step)) throw new SettingsError(`step must be one of ${PAID_STEPS.join(', ')}.`)
    return step
  }

  /** Status of one key: configured, where it comes from, a mask, and whether Delete can remove it. */
  const keyStatus = async (service, step) => {
    const ref = brand(KEY_REFS[step])
    const info = await service.describe(ref)
    if (!info?.configured) return { configured: false, deletable: false }
    let masked = typeof info.masked === 'string' ? info.masked : undefined
    if (masked === undefined) {
      const hit = await service.resolve(ref)
      if (typeof hit?.value === 'string' && hit.value !== '') masked = maskKey(hit.value)
    }
    return {
      configured: true,
      ...(typeof info.source === 'string' ? { source: info.source } : {}),
      ...(masked === undefined ? {} : { masked }),
      // Only the managed credentials file can be edited here; deleting it exposes any fallback again.
      deletable: info.source === 'file' && info.writable !== false,
    }
  }

  const keys = async () => {
    const service = credentials()
    const result = {}
    for (const step of PAID_STEPS) {
      result[step] = service === undefined
        ? { configured: false, deletable: false, unavailable: true }
        : await keyStatus(service, step)
    }
    return result
  }

  return {
    state: async () => ({
      settings: settingsView(config),
      keys: await keys(),
      editable: editor() !== undefined,
      keysEditable: credentials() !== undefined,
    }),

    save: async (payload) => {
      const next = rawConfig(payload?.settings)
      const write = editor()
      if (write === undefined) throw new SettingsError('Settings cannot be saved in this profile.')
      const saved = saves.then(() => write(next))
      saves = saved.catch(() => {})
      await saved
      return {}
    },

    setKey: async (payload) => {
      const step = paidStep(payload)
      const value = typeof payload?.value === 'string' ? payload.value.trim() : ''
      if (value === '') throw new SettingsError('Enter an API key.')
      const service = provider()
      await service.set(brand(KEY_REFS[step]), value)
      return { key: await keyStatus(service, step) }
    },

    deleteKey: async (payload) => {
      const step = paidStep(payload)
      const service = provider()
      const ref = brand(KEY_REFS[step])
      const info = await service.describe(ref)
      if (info?.source !== 'file') throw new SettingsError('Only a key stored in the DSH credentials file can be deleted here.')
      await service.unset(ref)
      return { key: await keyStatus(service, step) }
    },

    checkKey: async (payload) => {
      const step = paidStep(payload)
      let apiKey = typeof payload?.value === 'string' ? payload.value.trim() : ''
      if (apiKey === '') {
        const hit = await provider().resolve(brand(KEY_REFS[step]))
        apiKey = typeof hit?.value === 'string' ? hit.value.trim() : ''
      }
      if (apiKey === '') return { ok: false, reason: 'no-key' }
      return await checkKey({ step, apiKey, transport })
    },
  }
}

/**
 * Run one handler and shape its outcome as a Gateway result. A {@link SettingsError} carries a
 * message meant for the page; anything else is logged and reported generically.
 */
export async function dispatch(handlers, endpoint, payload, logger) {
  const handler = Object.hasOwn(handlers, endpoint) ? handlers[endpoint] : undefined
  if (handler === undefined) {
    return { ok: false, error: { code: 'web-fetch-chain/unknown-endpoint', message: `unknown endpoint ${endpoint}`, details: {} } }
  }
  try {
    return { ok: true, value: await handler(payload && typeof payload === 'object' ? payload : {}) }
  } catch (error) {
    if (!(error instanceof SettingsError)) logger?.warn?.(`dsh-web-fetch-chain: ${endpoint} failed: ${error?.stack ?? error}`)
    return { ok: false, error: { code: 'web-fetch-chain/error', message: error?.message ?? String(error), details: {} } }
  }
}

/** Serve every handler at `/api/web-fetch-chain.<endpoint>`; a no-op without `connection`. */
export function registerRoutes(ctx, handlers) {
  const respond = (rpcId, result) =>
    new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  ctx.inject(['connection'], (rpcCtx) => {
    for (const endpoint of Object.keys(handlers)) {
      const method = `${ROUTE_PREFIX}${endpoint}`
      rpcCtx.effect(
        () =>
          rpcCtx.connection.fetch.register({
            path: `/api/${method}`,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: async (request) => {
              const type = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
              if (type !== 'application/json') return new Response('content type must be application/json', { status: 415 })
              let body
              try {
                body = await request.json()
              } catch {
                return new Response('body is not JSON', { status: 400 })
              }
              const rpcId = typeof body?.rpcId === 'string' && body.rpcId ? body.rpcId : 'invalid-request'
              if (body?.type !== 'client-request' || body.method !== method) {
                return respond(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } } })
              }
              return respond(rpcId, await dispatch(handlers, endpoint, body.payload, ctx.logger))
            },
          }),
        `dsh-web-fetch-chain: /api/${method} route`,
      )
    }
  })
}
