/**
 * scrape.do Step adapter: GET API authenticated with the `token` query parameter.
 * https://scrape.do/documentation/
 * @module dsh-web-fetch-chain/steps/scrapedo
 */

import { StepFailure, isDefinitiveStatus, isFailureStatus, snippet } from '../step-failure.js'
import { readMarkdown } from './markdown.js'

export const SCRAPEDO_ENDPOINT = 'https://api.scrape.do/'

/**
 * @param {object} args
 * @param {string} args.url - target URL.
 * @param {string} args.apiKey - scrape.do token.
 * @param {{ render: boolean, super: boolean }} args.options
 * @param {number} args.timeoutMs - this Step's budget.
 * @param {typeof fetch} args.transport
 * @param {AbortSignal} args.signal
 */
export async function scrapedo({ url, apiKey, options, timeoutMs, transport, signal }) {
  const endpoint = new URL(SCRAPEDO_ENDPOINT)
  endpoint.searchParams.set('token', apiKey)
  endpoint.searchParams.set('url', url)
  endpoint.searchParams.set('output', 'markdown')
  endpoint.searchParams.set('render', String(options.render))
  endpoint.searchParams.set('super', String(options.super))
  endpoint.searchParams.set('timeout', String(timeoutMs))
  // Pass the target's own status through instead of scrape.do's status vocabulary.
  endpoint.searchParams.set('transparentResponse', 'true')

  const response = await transport(endpoint, { method: 'GET', signal })

  // scrape.do adds its Scrape.do-* headers to responses it proxied from the target. A non-2xx
  // without them is scrape.do's own rejection (401 no credits, 429 concurrency, 502 failed);
  // 404 and 410 stay definitive either way.
  const status = response.status
  const fromTarget = response.headers.has('scrape.do-target-url') || response.headers.has('scrape.do-resolved-url')
  if (!fromTarget && !isDefinitiveStatus(status) && (status < 200 || status > 299)) {
    const detail = snippet(await response.text().catch(() => ''))
    throw new StepFailure(`API HTTP ${status}${detail ? ` ${detail}` : ''}`)
  }
  // The Chain decides whether a target status is a Step Failure; skip reading a body it discards.
  if (isFailureStatus(status)) {
    await response.body?.cancel().catch(() => {})
    return { url: response.headers.get('scrape.do-resolved-url') || url, statusCode: status, body: { kind: 'text', content: '' }, truncated: false }
  }

  const content = await readMarkdown(response)
  return {
    url: response.headers.get('scrape.do-resolved-url') || url,
    statusCode: status,
    body: { kind: 'text', content },
    truncated: false,
  }
}
