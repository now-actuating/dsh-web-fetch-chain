/**
 * Key Check: ask a paid Step's backend whether an API key is valid through its account lookup,
 * which reads usage and spends no scrape credits. See GLOSSARY.md.
 * @module dsh-web-fetch-chain/key-check
 */

/** Account lookups, keyed by paid Step id. */
export const KEY_CHECK_ENDPOINTS = Object.freeze({
  scrapedo: 'https://api.scrape.do/info',
  scrapfly: 'https://api.scrapfly.io/account',
  firecrawl: 'https://api.firecrawl.dev/v2/team/credit-usage',
})

/** How long one Key Check may take. */
export const KEY_CHECK_TIMEOUT_MS = 15_000

/**
 * @typedef {{ ok: true }
 *   | { ok: false, reason: 'invalid-key', status: number }
 *   | { ok: false, reason: 'inactive' }
 *   | { ok: false, reason: 'http-status', status: number }
 *   | { ok: false, reason: 'bad-response' }
 *   | { ok: false, reason: 'timeout' }
 *   | { ok: false, reason: 'network', message: string }} KeyCheckResult
 * The outcome; it never carries the key or the backend's account details.
 */

/**
 * @param {object} input
 * @param {'scrapedo' | 'scrapfly' | 'firecrawl'} input.step
 * @param {string} input.apiKey
 * @param {typeof fetch} input.transport
 * @param {number} [input.timeoutMs]
 * @returns {Promise<KeyCheckResult>}
 */
export async function checkKey({ step, apiKey, transport, timeoutMs = KEY_CHECK_TIMEOUT_MS }) {
  const endpoint = KEY_CHECK_ENDPOINTS[step]
  if (endpoint === undefined) throw new TypeError(`no Key Check for Step "${step}"`)
  const url = new URL(endpoint)
  const headers = { accept: 'application/json' }
  if (step === 'scrapedo') url.searchParams.set('token', apiKey)
  else if (step === 'scrapfly') url.searchParams.set('key', apiKey)
  else headers.authorization = `Bearer ${apiKey}`

  const signal = AbortSignal.timeout(timeoutMs)
  let response
  try {
    response = await transport(url.toString(), { method: 'GET', headers, signal })
  } catch (error) {
    if (signal.aborted) return { ok: false, reason: 'timeout' }
    // The message of a transport error can name the URL, which carries the key for two backends.
    return { ok: false, reason: 'network', message: redact(String(error?.message ?? error), apiKey) }
  }
  const status = response.status
  if (status === 401 || status === 403) return { ok: false, reason: 'invalid-key', status }
  if (status < 200 || status > 299) return { ok: false, reason: 'http-status', status }

  let body
  try {
    body = await response.json()
  } catch {
    return { ok: false, reason: 'bad-response' }
  }
  if (body === null || typeof body !== 'object') return { ok: false, reason: 'bad-response' }
  if (step === 'scrapedo' && body.IsActive === false) return { ok: false, reason: 'inactive' }
  if (step === 'firecrawl' && body.success === false) return { ok: false, reason: 'invalid-key', status }
  return { ok: true }
}

function redact(text, secret) {
  if (!secret) return text
  for (const form of [secret, encodeURIComponent(secret)]) text = text.split(form).join('••••')
  return text
}
