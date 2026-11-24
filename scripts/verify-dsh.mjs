#!/usr/bin/env node
/**
 * Re-check the web_fetch time limit raise (ADR 0003) against the installed DSH runtime.
 *
 * Boots the `headless` profile twice with a `--patch` overlay that adds an agent preset holding
 * `tool-web`, this bundle, and a probe plugin. The probe creates a preset-bound agent the way the
 * Web session controller does, switches presets, closes the agent, and reports what the agent and
 * its preset see. Nothing is installed; the overlay lives in a temporary directory, and the
 * Sessions the runs create are deleted afterwards. Model requests go to a closed local port with
 * a fake key, so no credits are spent.
 *
 * Usage: node scripts/verify-dsh.mjs [--runtime <dir containing @deepseek-ai>] [--keep]
 * Exit code 0 when every check passes, 1 otherwise.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const keep = args.includes('--keep')
const runtimeArg = args.includes('--runtime') ? args[args.indexOf('--runtime') + 1] : undefined

/** The `when` that dsh-tool-web registers web_fetch with, copied in index.js. */
const EXPECTED_WHEN = /when:\s*\(\s*\{\s*modelSelection\s*\}\s*\)\s*=>\s*ctx\.web\.fetchReady\(\s*modelSelection\.provider\s*\)/
const EXPECTED_BUDGET = 135_000
const PRESET_DEFAULT = 30_000

function fail(message) {
  console.error(`verify-dsh: ${message}`)
  process.exit(1)
}

/** The `node_modules/@deepseek-ai` directory of the DSH runtime that `dsh` launches. */
function findRuntime() {
  if (runtimeArg !== undefined) return resolve(runtimeArg)
  const which = spawnSync('bash', ['-lc', 'command -v dsh'], { encoding: 'utf8' })
  const bin = which.stdout.trim()
  if (bin === '') fail('`dsh` is not on PATH; pass --runtime <node_modules/@deepseek-ai>')
  // .../node_modules/@deepseek-ai/dsh/lib/bin.js → .../node_modules/@deepseek-ai
  return dirname(dirname(dirname(realpathSync(bin))))
}

const runtime = findRuntime()
for (const pkg of ['dsh-tools', 'dsh-tool-web', 'dsh-scope', 'dsh-agent-preset-registry']) {
  if (!existsSync(join(runtime, pkg, 'package.json'))) fail(`${pkg} not found under ${runtime}`)
}
const version = JSON.parse(readFileSync(join(runtime, 'dsh', 'package.json'), 'utf8')).version

// index.js imports DSH packages by name; outside an install they resolve through this link.
const linkDir = join(REPO, 'node_modules')
const link = join(linkDir, '@deepseek-ai')
let createdLink = false
if (!existsSync(link)) {
  mkdirSync(linkDir, { recursive: true })
  symlinkSync(runtime, link, 'dir')
  createdLink = true
}

const work = mkdtempSync(join(tmpdir(), 'dsh-web-fetch-chain-verify-'))
const token = basename(work)

writeFileSync(join(work, 'probe.mjs'), `
import { randomUUID } from 'node:crypto'
import { scopeOf, scopeParentOf } from ${JSON.stringify(pathToFileURL(join(runtime, 'dsh-scope', 'lib', 'index.js')).href)}
export const name = 'verify-probe'
export const inject = ['tools', 'agents', 'agentPresets']
export function apply(ctx) {
  const report = (step, data) => process.stderr.write('[verify] ' + JSON.stringify({ step, ...data }) + '\\n')
  return (async () => {
    await new Promise(r => setTimeout(r, 500))
    try {
      const handle = await ctx.agents.create({
        sessionId: 'verify-' + randomUUID(),
        meta: { cwd: process.cwd(), agentPreset: 'probe' },
        setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'probe') },
      })
      const agent = handle.agent
      const show = (step) => {
        const own = ctx.tools.get('web_fetch', agent)
        const key = scopeOf(agent.ctx)
        const parent = ctx.tools.get('web_fetch', key === undefined ? undefined : scopeParentOf(key))
        report(step, { agent: own?.timeoutMs ?? null, preset: parent?.timeoutMs ?? null, sameExecute: own !== undefined && own.execute === parent?.execute })
      }
      show('create')
      await ctx.agentPresets.select(agent, 'probe2')
      show('switch-probe2')
      await ctx.agentPresets.select(agent, 'empty')
      show('switch-empty')
      await ctx.agentPresets.select(agent, 'probe')
      show('switch-back')
      await handle.dispose()
      report('closed', {})
    } catch (error) {
      report('error', { message: String(error?.stack ?? error) })
    }
  })()
}
`)

const presetWithToolWeb = (id, order) => `    - id: preset-${id}
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ${id}
        order: ${order}
        plugins:
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
            config:
              fetch: true
`
const overlay = (pluginConfig) => `- id: tool-web
  disabled: true
- insert:
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: probe
${presetWithToolWeb('probe', 1)}${presetWithToolWeb('probe2', 2)}    - id: preset-empty
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: empty
        order: 3
        plugins: []
    - id: web-fetch-chain
      name: ${JSON.stringify(join(REPO, 'index.js'))}
      config: ${pluginConfig}
    - id: verify-probe
      name: ./probe.mjs
`

/** Boot headless with one overlay and collect the probe's reports and plugin warnings. */
function run(label, pluginConfig) {
  const file = join(work, `${label}.yml`)
  writeFileSync(file, overlay(pluginConfig))
  const result = spawnSync(process.execPath, [join(runtime, 'dsh', 'lib', 'bin.js'), '--profile', 'headless', '--patch', file, 'verify'], {
    cwd: work,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, DEEPSEEK_API_KEY: 'sk-verify-fake', DEEPSEEK_BASE_URL: 'http://127.0.0.1:9' },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const reports = Object.fromEntries(output.split('\n')
    .filter(line => line.startsWith('[verify] '))
    .map(line => JSON.parse(line.slice('[verify] '.length)))
    .map(report => [report.step, report]))
  const warnings = output.split('\n').filter(line => line.includes('web-fetch-chain:'))
  return { reports, warnings, output }
}

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }) }

try {
  const sourceFile = ['src/fetch.ts', 'lib/index.js'].map(file => join(runtime, 'dsh-tool-web', file)).find(existsSync)
  const sameWhen = sourceFile !== undefined && EXPECTED_WHEN.test(readFileSync(sourceFile, 'utf8'))
  check('tool-web registers web_fetch with the admission condition index.js copies', sameWhen,
    sourceFile === undefined ? 'dsh-tool-web source not found' : `compare ${sourceFile} with the \`when\` in index.js`)

  const on = run('on', '{}')
  const off = run('off', '{ raiseWebFetchTimeout: false }')
  const r = on.reports
  const o = off.reports
  if (r.error || o.error) check('probe ran without errors', false, (r.error ?? o.error).message.split('\n')[0])
  const shows = (report, agent, preset, sameExecute) => report !== undefined
    && report.agent === agent && report.preset === preset && (sameExecute === undefined || report.sameExecute === sameExecute)
  const describe = report => (report === undefined ? 'no report' : `agent ${report.agent}, preset ${report.preset}, same execute ${report.sameExecute}`)

  check('new agent sees the Chain Budget; the preset keeps its own limit', shows(r.create, EXPECTED_BUDGET, PRESET_DEFAULT, true), describe(r.create))
  check('switching to another preset re-copies its web_fetch', shows(r['switch-probe2'], EXPECTED_BUDGET, PRESET_DEFAULT, true), describe(r['switch-probe2']))
  check('switching to a preset without web_fetch removes the copy', shows(r['switch-empty'], null, null), describe(r['switch-empty']))
  check('switching back copies again', shows(r['switch-back'], EXPECTED_BUDGET, PRESET_DEFAULT, true), describe(r['switch-back']))
  check('closing the agent logs no plugin warnings', r.closed !== undefined && on.warnings.length === 0, on.warnings.join(' | '))
  check('raiseWebFetchTimeout: false keeps the preset limit', shows(o.create, PRESET_DEFAULT, PRESET_DEFAULT), describe(o.create))
  if (Object.keys(r).length === 0) check('probe produced reports', false, on.output.trim().split('\n').slice(-3).join(' | '))
} finally {
  // Delete the Sessions the runs created: their directory names carry the unique work token.
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const sessions = join(dshHome, 'sessions')
  const cache = join(dshHome, 'storages', 'session_projcache', 'sessions')
  if (existsSync(sessions)) {
    for (const dir of readdirSync(sessions)) {
      if (!dir.includes(token)) continue
      const path = join(sessions, dir)
      for (const id of readdirSync(path)) rmSync(join(cache, `${id}.json`), { force: true })
      rmSync(path, { recursive: true, force: true })
    }
  }
  if (!keep) rmSync(work, { recursive: true, force: true })
  if (createdLink && lstatSync(link).isSymbolicLink()) {
    rmSync(link)
    if (readdirSync(linkDir).length === 0) rmSync(linkDir, { recursive: true })
  }
}

console.log(`DSH ${version} (${runtime})`)
for (const { name, ok, detail } of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      ${detail}` : ''}`)
if (keep) console.log(`kept ${work}`)
process.exit(checks.every(c => c.ok) ? 0 : 1)
