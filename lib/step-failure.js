/**
 * Step Failure: a Step outcome that triggers Fallback to the next Step.
 * @module dsh-web-fetch-chain/step-failure
 */

export class StepFailure extends Error {
  /** @param {string} reason - short, single-line reason shown in a Chain Failure. */
  constructor(reason, options) {
    super(reason, options)
    this.name = 'StepFailure'
    this.reason = reason
  }
}

/** Target statuses that are Step Failures; 404/410 and other statuses are definitive answers. */
export function isFailureStatus(status) {
  return status === 403 || status === 429 || status >= 500
}

/** Target statuses that are definitive answers: returned as they are, never a Step Failure. */
export function isDefinitiveStatus(status) {
  return status === 404 || status === 410
}

/** Shorten a backend error body to one line for a Step Failure reason. */
export function snippet(text, max = 160) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}
