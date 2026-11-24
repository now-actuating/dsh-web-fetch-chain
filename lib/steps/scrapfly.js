/**
 * Scrapfly Step adapter: GET scrape API authenticated with the `key` query parameter.
 * https://scrapfly.io/docs/scrape-api/getting-started
 * @module dsh-web-fetch-chain/steps/scrapfly
 */

import { StepFailure, snippet } from '../step-failure.js'
import { assertMarkdown } from './markdown.js'

export const SCRAPFLY_ENDPOINT = 'https://api.scrapfly.io/scrape'

/** Scrapfly's maximum server-side timeout with `retry=false`. */
const MAX_SERVER_TIMEOUT_MS = 150_000
/** Scrapfly asks clients to wait this much longer than the server-side timeout. */
const CLIENT_OVERHEAD_MS = 5_000

/**
 * The server-side timeout that fits inside this Step's budget, within Scrapfly's limits:
 * at least 15 s for plain scrapes and 30 s with JS rendering or the Unblocker.
 */
export function scrapflyServerTimeout(timeoutMs, { renderJs, asp }) {
  const min = renderJs || asp ? 30_000 : 15_000
  return Math.min(MAX_SERVER_TIMEOUT_MS, Math.max(min, timeoutMs - CLIENT_OVERHEAD_MS))
}

/**
 * @param {object} args
 * @param {string} args.url
 * @param {string} args.apiKey
 * @param {{ renderJs: boolean, asp: boolean }} args.options
 * @param {number} args.timeoutMs
 * @param {typeof fetch} args.transport
 * @param {AbortSignal} args.signal
 */
export async function scrapfly({ url, apiKey, options, timeoutMs, transport, signal }) {
  const endpoint = new URL(SCRAPFLY_ENDPOINT)
  endpoint.searchParams.set('key', apiKey)
  endpoint.searchParams.set('url', url)
  endpoint.searchParams.set('format', 'markdown')
  endpoint.searchParams.set('render_js', String(options.renderJs))
  endpoint.searchParams.set('asp', String(options.asp))
  // Without retries the client timeout, not Scrapfly's retry loop, decides how long we wait.
  endpoint.searchParams.set('retry', 'false')
  endpoint.searchParams.set('timeout', String(scrapflyServerTimeout(timeoutMs, options)))

  const response = await transport(endpoint, { method: 'GET', headers: { accept: 'application/json' }, signal })
  const text = await response.text()
  if (response.status < 200 || response.status > 299) {
    const code = response.headers.get('x-scrapfly-reject-code') ?? errorCode(text)
    throw new StepFailure(`API HTTP ${response.status}${code ? ` ${code}` : ''}`)
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new StepFailure(`invalid API response: ${snippet(text, 80)}`)
  }
  const result = payload?.result
  if (result === undefined || result === null) throw new StepFailure('API response has no result')
  if (result.success === false) {
    throw new StepFailure(`scrape failed${result.error?.code ? ` ${result.error.code}` : ''}`)
  }
  if (result.format === 'clob' || result.format === 'blob') {
    throw new StepFailure(`large object (${result.format}) responses are not supported`)
  }
  if (typeof result.content !== 'string') throw new StepFailure('API response has no content')

  return {
    url: typeof result.url === 'string' && result.url !== '' ? result.url : url,
    statusCode: Number.isInteger(result.status_code) ? result.status_code : 200,
    body: { kind: 'text', content: assertMarkdown(result.content) },
    truncated: false,
  }
}

function errorCode(text) {
  try {
    const payload = JSON.parse(text)
    return payload?.code ?? payload?.error_id ?? payload?.result?.error?.code
  } catch {
    return snippet(text, 80)
  }
}
