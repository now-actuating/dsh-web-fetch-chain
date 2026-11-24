/**
 * scrape.do Step adapter: GET API authenticated with the `token` query parameter.
 * https://scrape.do/documentation/
 * @module dsh-web-fetch-chain/steps/scrapedo
 */

import { StepFailure, snippet } from '../step-failure.js'
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

  const response = await transport(endpoint, { method: 'GET', signal })

  // scrape.do reports its own rejections (401 no credits, 429 concurrency, 502 failed,
  // 510 cancelled) as the API status. 404/410 are the target's definitive answers.
  const status = response.status
  if (status !== 404 && status !== 410 && (status < 200 || status > 299)) {
    const detail = snippet(await response.text().catch(() => ''))
    throw new StepFailure(`API HTTP ${status}${detail ? ` ${detail}` : ''}`)
  }

  const initial = Number(response.headers.get('scrape.do-initial-status-code'))
  const statusCode = Number.isInteger(initial) && initial >= 100 && (initial < 300 || initial > 399) ? initial : status
  const content = await readMarkdown(response)
  return {
    url: response.headers.get('scrape.do-resolved-url') || url,
    statusCode,
    body: { kind: 'text', content },
    truncated: false,
  }
}
