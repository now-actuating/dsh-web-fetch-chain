/**
 * Shared guards for paid Steps, which return backend Markdown as a `text` body (ADR 0002).
 * @module dsh-web-fetch-chain/steps/markdown
 */

import { StepFailure } from '../step-failure.js'

/** Content types a paid Step may return verbatim as Markdown text. */
function isTextual(contentType) {
  if (contentType === null || contentType === '') return true
  const type = contentType.split(';')[0].trim().toLowerCase()
  return type.startsWith('text/') || type.endsWith('+json') || type.endsWith('+xml')
    || type === 'application/json' || type === 'application/xml'
}

/** Whether the content is a raw HTML document rather than Markdown. */
export function looksLikeHtml(content) {
  return /^\s*(<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(content)
}

/**
 * Reject Markdown that the plugin must not pass on under the `text` kind (raw HTML).
 * @param {string} content
 * @returns {string}
 */
export function assertMarkdown(content) {
  if (looksLikeHtml(content)) throw new StepFailure('backend returned raw HTML instead of Markdown')
  return content
}

/**
 * Read a raw Markdown response body, rejecting binary content and raw HTML.
 * @param {Response} response
 * @returns {Promise<string>}
 */
export async function readMarkdown(response) {
  const contentType = response.headers.get('content-type')
  if (!isTextual(contentType)) {
    await response.body?.cancel().catch(() => {})
    throw new StepFailure(`unsupported content type "${contentType}"`)
  }
  return assertMarkdown(await response.text())
}
