/**
 * Integration check against a real DSH runtime (ADR 0003): runs scripts/verify-dsh.mjs.
 *
 * Maintenance testbeds (dsh-plugin-update-flow, Type 2) pass the target runtime as
 * DSH_INSTALL_ANCHOR to the source `test` script, so the check runs there automatically and an
 * update that breaks the web_fetch limit raise fails the install. Elsewhere it is skipped unless
 * VERIFY_DSH=1; `npm run verify:dsh` runs it directly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRuntime, verifyDsh } from '../scripts/verify-dsh.mjs'

const enabled = Boolean(process.env.DSH_INSTALL_ANCHOR) || process.env.VERIFY_DSH === '1'

test('the web_fetch limit raise works on the target DSH runtime', {
  skip: enabled ? false : 'set by maintenance testbeds (DSH_INSTALL_ANCHOR) or VERIFY_DSH=1',
  // Two headless boots of about 17 s each; maintenance stops a test command after 120 s.
  timeout: 110_000,
}, async () => {
  const { version, checks } = await verifyDsh({ runtime: resolveRuntime() })
  const failed = checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`)
  assert.deepEqual(failed, [], `DSH ${version}`)
})
