/**
 * The settings page's model: the view of the effective config it edits, the raw row config a
 * Save writes, and the fixed credential names of the paid Steps.
 * @module dsh-web-fetch-chain/settings
 */

import { DEFAULT_OPTIONS, DEFAULT_TIMEOUTS, STEP_IDS } from './chain.js'

/** Paid Steps, the only ones with an API key. */
export const PAID_STEPS = Object.freeze(['scrapedo', 'scrapfly', 'firecrawl'])

/** Credential names the paid Steps read their API keys from; fixed, not configurable. */
export const KEY_REFS = Object.freeze({
  scrapedo: 'SCRAPEDO_API_KEY',
  scrapfly: 'SCRAPFLY_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
})

/** Config field holding each Step's timeout. */
export const TIMEOUT_FIELDS = Object.freeze({
  http: 'httpTimeoutMs',
  scrapedo: 'scrapedoTimeoutMs',
  scrapfly: 'scrapflyTimeoutMs',
  firecrawl: 'firecrawlTimeoutMs',
})

/** Backend options, keyed by config field, with the Step each belongs to. */
export const OPTION_STEPS = Object.freeze({
  scrapedoRender: 'scrapedo',
  scrapedoSuper: 'scrapedo',
  scrapflyRenderJs: 'scrapfly',
  scrapflyAsp: 'scrapfly',
  firecrawlOnlyMainContent: 'firecrawl',
})

/** Timeout bounds, matching the Config schema. */
export const TIMEOUT_MIN_MS = 1_000
export const TIMEOUT_MAX_MS = 300_000

const DEFAULT_STEPS = STEP_IDS.map(step => ({ step, enabled: true }))

export class SettingsError extends Error {}

/**
 * What the page shows: every Step in Chain order, each Step timeout in ms, the backend options,
 * and the limit-raise switch, filled from the effective config with defaults for anything absent.
 * @param {Record<string, unknown>} config the row's effective config.
 */
export function settingsView(config = {}) {
  const listed = Array.isArray(config.steps) ? config.steps : DEFAULT_STEPS
  const steps = []
  for (const row of listed) {
    if (!STEP_IDS.includes(row?.step) || steps.some(s => s.step === row.step)) continue
    steps.push({ step: row.step, enabled: row.enabled !== false })
  }
  // A Step left out of the config is still shown, switched off, so the page can turn it back on.
  for (const step of STEP_IDS) if (!steps.some(s => s.step === step)) steps.push({ step, enabled: false })
  const timeouts = {}
  for (const step of STEP_IDS) {
    const value = config[TIMEOUT_FIELDS[step]]
    timeouts[step] = Number.isInteger(value) ? value : DEFAULT_TIMEOUTS[step]
  }
  const options = {}
  for (const field of Object.keys(OPTION_STEPS)) {
    options[field] = typeof config[field] === 'boolean' ? config[field] : DEFAULT_OPTIONS[field]
  }
  return {
    steps,
    timeouts,
    options,
    raiseWebFetchTimeout: typeof config.raiseWebFetchTimeout === 'boolean' ? config.raiseWebFetchTimeout : true,
  }
}

/**
 * The raw row config a Save writes: only values that differ from the defaults, so a page left at
 * the defaults writes `{}` and the profile patch loses its config. Fields this page does not
 * know, such as the removed `*ApiKeyRef` names, are dropped.
 * @param {unknown} form a view as {@link settingsView} returns it, edited by the page.
 * @throws {SettingsError} when the form is malformed.
 */
export function rawConfig(form) {
  if (form === null || typeof form !== 'object') throw new SettingsError('Settings are missing.')
  const { steps, timeouts, options, raiseWebFetchTimeout } = form
  if (!Array.isArray(steps) || steps.length !== STEP_IDS.length) {
    throw new SettingsError(`Steps must list each of ${STEP_IDS.join(', ')} once.`)
  }
  const seen = new Set()
  for (const row of steps) {
    if (!STEP_IDS.includes(row?.step) || seen.has(row.step) || typeof row.enabled !== 'boolean') {
      throw new SettingsError(`Steps must list each of ${STEP_IDS.join(', ')} once, with enabled true or false.`)
    }
    seen.add(row.step)
  }
  const raw = {}
  const ordered = steps.map(({ step, enabled }) => ({ step, enabled }))
  const isDefaultOrder = ordered.every((row, i) => row.step === DEFAULT_STEPS[i].step && row.enabled)
  if (!isDefaultOrder) raw.steps = ordered
  for (const step of STEP_IDS) {
    const value = timeouts?.[step]
    if (!Number.isInteger(value) || value < TIMEOUT_MIN_MS || value > TIMEOUT_MAX_MS || value % 1_000 !== 0) {
      throw new SettingsError(`The ${step} timeout must be a whole number of seconds from ${TIMEOUT_MIN_MS / 1_000} to ${TIMEOUT_MAX_MS / 1_000}.`)
    }
    if (value !== DEFAULT_TIMEOUTS[step]) raw[TIMEOUT_FIELDS[step]] = value
  }
  for (const field of Object.keys(OPTION_STEPS)) {
    const value = options?.[field]
    if (typeof value !== 'boolean') throw new SettingsError(`${field} must be true or false.`)
    if (value !== DEFAULT_OPTIONS[field]) raw[field] = value
  }
  if (typeof raiseWebFetchTimeout !== 'boolean') throw new SettingsError('raiseWebFetchTimeout must be true or false.')
  if (!raiseWebFetchTimeout) raw.raiseWebFetchTimeout = false
  return raw
}

/**
 * A preview that never shows the whole key: the first 3 and last 4 characters, or only dots when
 * the key is too short to hide anything.
 * @param {string} value
 */
export function maskKey(value) {
  const chars = Array.from(value)
  if (chars.length < 12) return '••••••••'
  return `${chars.slice(0, 3).join('')}••••${chars.slice(-4).join('')}`
}
