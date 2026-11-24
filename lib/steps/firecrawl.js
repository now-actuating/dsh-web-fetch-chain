/**
 * Firecrawl Step adapter: POST v2 scrape with Bearer authentication.
 * https://docs.firecrawl.dev/api-reference/endpoint/scrape
 * @module dsh-web-fetch-chain/steps/firecrawl
 */

import { StepFailure, snippet } from '../step-failure.js'
import { assertMarkdown } from './markdown.js'

export const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v2/scrape'

/** Firecrawl accepts timeouts between 1 s and 300 s. */
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 300_000

/**
 * @param {object} args
 * @param {string} args.url
 * @param {string} args.apiKey
 * @param {{ onlyMainContent: boolean }} args.options
 * @param {number} args.timeoutMs
 * @param {typeof fetch} args.transport
 * @param {AbortSignal} args.signal
 */
export async function firecrawl({ url, apiKey, options, timeoutMs, transport, signal }) {
  const response = await transport(FIRECRAWL_ENDPOINT, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: options.onlyMainContent,
      timeout: Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, timeoutMs)),
    }),
    signal,
  })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = undefined
  }
  if (response.status < 200 || response.status > 299) {
    const detail = payload?.code ?? payload?.error ?? snippet(text, 80)
    throw new StepFailure(`API HTTP ${response.status}${detail ? ` ${snippet(detail, 120)}` : ''}`)
  }
  if (payload === undefined) throw new StepFailure(`invalid API response: ${snippet(text, 80)}`)
  if (payload.success === false) {
    throw new StepFailure(`scrape failed${payload.error ? ` ${snippet(payload.error, 120)}` : ''}`)
  }
  const data = payload.data
  if (typeof data?.markdown !== 'string') throw new StepFailure('API response has no markdown')
  const metadata = data.metadata ?? {}

  return {
    url: firstString(metadata.url, metadata.sourceURL) ?? url,
    statusCode: Number.isInteger(metadata.statusCode) ? metadata.statusCode : 200,
    body: { kind: 'text', content: assertMarkdown(data.markdown) },
    truncated: false,
    title: typeof metadata.title === 'string' ? metadata.title : undefined,
  }
}

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value !== '')
}
