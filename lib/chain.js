/**
 * The Chain provider: one `WebFetchProvider` that walks the enabled Steps in order until one
 * succeeds. See GLOSSARY.md for Chain, Step, Fallback, Step Failure, Skipped Step, Chain Failure,
 * and Attribution.
 * @module dsh-web-fetch-chain/chain
 */

import { detectChallenge } from './challenge.js'
import { StepFailure, isDefinitiveStatus, isFailureStatus } from './step-failure.js'
import { scrapedo } from './steps/scrapedo.js'
import { scrapfly } from './steps/scrapfly.js'
import { firecrawl } from './steps/firecrawl.js'

/** Step ids in the default Chain order. */
export const STEP_IDS = Object.freeze(['http', 'scrapedo', 'scrapfly', 'firecrawl'])

/** Attribution names, keyed by Step id. */
export const STEP_NAMES = Object.freeze({
  http: 'Http',
  scrapedo: 'Scrape.do',
  scrapfly: 'Scrapfly',
  firecrawl: 'Firecrawl',
})

/** Default per-Step timeouts in milliseconds. */
export const DEFAULT_TIMEOUTS = Object.freeze({ http: 10_000, scrapedo: 35_000, scrapfly: 40_000, firecrawl: 45_000 })

/** Margin the Chain Budget adds to the Step timeouts so the Chain can report its own outcome. */
export const CHAIN_BUDGET_MARGIN_MS = 5_000

/**
 * The Chain Budget: the enabled Steps' timeouts plus a fixed margin. It becomes the `web_fetch`
 * time limit, so every Step can use its whole timeout.
 * @param {{ steps?: { step: string, enabled?: boolean }[], timeouts?: Partial<typeof DEFAULT_TIMEOUTS> }} settings
 */
export function chainBudgetMs({ steps, timeouts } = {}) {
  const resolved = { ...DEFAULT_TIMEOUTS, ...stripUndefined(timeouts) }
  return normalizeSteps(steps).reduce((total, step) => total + resolved[step], CHAIN_BUDGET_MARGIN_MS)
}

/** Default per-Step backend options. */
export const DEFAULT_OPTIONS = Object.freeze({
  scrapedoRender: true,
  scrapedoSuper: true,
  scrapflyRenderJs: true,
  scrapflyAsp: true,
  firecrawlOnlyMainContent: false,
})

/** Error code of a Chain Failure. */
export const CHAIN_FAILED_CODE = 'WEB_FETCH_CHAIN_FAILED'

/** Http Step error codes that are definitive answers about the request, not Step Failures. */
const DEFINITIVE_HTTP_CODES = new Set(['WEB_INVALID_URL', 'WEB_BLOCKED_URL'])

const PAID_STEPS = { scrapedo, scrapfly, firecrawl }

/** Stand-in for DSH `WebError` when none is injected (tests); carries the same `code`. */
export class ChainError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.name = 'WebError'
    this.code = code
  }
}

/** Raised internally when the caller cancels; never a Step Failure. */
class Cancelled extends Error {}

export class FetchChainProvider {
  /**
   * @param {object} deps
   * @param {{ fetch(request: { url: string }, signal?: AbortSignal): Promise<any> }} deps.http - the Http Step.
   * @param {typeof fetch} deps.transport - fetch-compatible transport for paid Steps.
   * @param {object} [deps.settings] - order, enablement, API keys, timeouts, and options.
   * @param {{ step: string, enabled?: boolean }[]} [deps.settings.steps]
   * @param {Record<string, string | undefined | (() => Promise<string | undefined> | string | undefined)>} [deps.settings.apiKeys]
   *   - a key, or a resolver called once per request; empty means the Step is skipped.
   * @param {Partial<typeof DEFAULT_TIMEOUTS>} [deps.settings.timeouts]
   * @param {Partial<typeof DEFAULT_OPTIONS>} [deps.settings.options]
   * @param {new (message: string, code: string, options?: object) => Error} [deps.WebError]
   */
  constructor({ http, transport, settings = {}, WebError = ChainError }) {
    this.http = http
    this.transport = transport
    this.WebError = WebError
    this.steps = normalizeSteps(settings.steps)
    this.apiKeys = settings.apiKeys ?? {}
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...stripUndefined(settings.timeouts) }
    this.options = { ...DEFAULT_OPTIONS, ...stripUndefined(settings.options) }
  }

  /** Usable even without paid keys: the Http Step alone is a valid Chain. */
  available() {
    return true
  }

  /**
   * Walk the Chain for one request. Each request is independent of earlier ones.
   * @param {{ url: string }} request
   * @param {AbortSignal} [signal] - caller cancellation, including the tool-call deadline.
   */
  async fetch(request, signal) {
    const url = this.validateUrl(request.url)
    const outcomes = []
    try {
      throwIfCancelled(signal)
      for (const step of this.steps) {
        const outcome = await this.runStep(step, url, signal)
        if (outcome.result !== undefined) return attribute(step, outcome.result)
        outcomes.push({ step, name: STEP_NAMES[step], ...outcome })
      }
    } catch (error) {
      if (error instanceof Cancelled) throw new this.WebError('web fetch aborted', 'WEB_ABORTED', { cause: signal?.reason })
      throw error
    }
    throw this.chainFailure(url, outcomes)
  }

  validateUrl(input) {
    let url
    try {
      url = new URL(input)
    } catch (error) {
      throw new this.WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new this.WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
    }
    return url.toString()
  }

  /** @returns {Promise<{ result?: object, reason?: string, skipped?: boolean }>} */
  async runStep(step, url, signal) {
    const timeoutMs = this.timeouts[step]
    const timer = new AbortController()
    const id = setTimeout(() => timer.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
    const stepSignal = signal === undefined ? timer.signal : AbortSignal.any([signal, timer.signal])
    try {
      let apiKey
      if (step !== 'http') {
        try {
          apiKey = await untilAborted(resolveKey(this.apiKeys[step]), stepSignal)
        } catch (error) {
          throwIfCancelled(signal)
          if (timer.signal.aborted) return { reason: `timed out after ${timeoutMs}ms` }
          return { reason: `API key lookup failed: ${describeError(error)}` }
        }
        if (apiKey === undefined) return { skipped: true, reason: 'skipped (no API key)' }
      }

      const result = step === 'http'
        ? await this.http.fetch({ url }, stepSignal)
        : await PAID_STEPS[step]({
            url, apiKey, timeoutMs, transport: this.transport, signal: stepSignal, options: this.stepOptions(step),
          })
      throwIfCancelled(signal)
      // 404 and 410 are definitive answers: returned without challenge detection or Fallback.
      if (isDefinitiveStatus(result.statusCode)) return { result }
      if (isFailureStatus(result.statusCode)) return { reason: `target HTTP ${result.statusCode}` }
      const challenge = detectChallenge(result)
      if (challenge !== undefined) return { reason: `challenge page detected (${challenge})` }
      return { result }
    } catch (error) {
      throwIfCancelled(signal)
      if (timer.signal.aborted) return { reason: `timed out after ${timeoutMs}ms` }
      if (error instanceof StepFailure) return { reason: error.reason }
      if (step === 'http' && DEFINITIVE_HTTP_CODES.has(error?.code)) throw error
      return { reason: describeError(error) }
    } finally {
      clearTimeout(id)
    }
  }

  stepOptions(step) {
    const options = this.options
    if (step === 'scrapedo') return { render: options.scrapedoRender, super: options.scrapedoSuper }
    if (step === 'scrapfly') return { renderJs: options.scrapflyRenderJs, asp: options.scrapflyAsp }
    return { onlyMainContent: options.firecrawlOnlyMainContent }
  }

  chainFailure(url, outcomes) {
    const lines = outcomes.length === 0
      ? ['- no Steps are enabled']
      : outcomes.map(o => `- ${o.name}: ${o.reason}`)
    const error = new this.WebError(`Fetch chain failed for ${url}:\n${lines.join('\n')}`, CHAIN_FAILED_CODE)
    error.steps = outcomes.map(({ step, name, reason, skipped }) => ({ step, name, reason, skipped: skipped === true }))
    return error
  }
}

/** Order the configured Steps, dropping disabled, unknown, and duplicate entries. */
function normalizeSteps(steps) {
  if (steps === undefined) return [...STEP_IDS]
  const seen = new Set()
  const order = []
  for (const entry of steps) {
    const step = entry?.step
    if (!STEP_IDS.includes(step) || seen.has(step)) continue
    seen.add(step)
    if (entry.enabled !== false) order.push(step)
  }
  return order
}

async function resolveKey(source) {
  const value = typeof source === 'function' ? await source() : source
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Settle with the promise, or reject as soon as the signal aborts. */
function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new Cancelled()
}

function describeError(error) {
  const code = typeof error?.code === 'string' ? `${error.code}: ` : ''
  const message = error instanceof Error ? error.message : String(error)
  return `${code}${message}`.replace(/\s+/g, ' ').trim()
}

function stripUndefined(object = {}) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))
}

/** Prefix the Step's Attribution to the content, on the same line, keeping the body kind. */
function attribute(step, result) {
  const content = `${STEP_NAMES[step]}:${result.body.content}`
  const body = result.body.kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }
  return { url: result.url, statusCode: result.statusCode, body, truncated: result.truncated === true }
}
