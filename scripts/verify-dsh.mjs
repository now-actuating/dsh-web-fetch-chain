#!/usr/bin/env node
/**
 * Re-check the web_fetch time limit raise (ADR 0003) against a DSH runtime.
 *
 * Boots the shipped `headless` profile twice, in a throwaway DSH_HOME, with a `--patch` overlay
 * that adds agent presets holding `tool-web`, a staged copy of this bundle, and a probe plugin.
 * The probe creates a preset-bound agent the way the Web session controller does, switches
 * presets, closes the agent, and reports what the agent and its preset see.
 *
 * Nothing outside a temporary directory is written: no profile, no Session in the real DSH_HOME,
 * no link inside the source tree. Model and telemetry requests go to a closed local port with a
 * fake key, so no credits are spent and nothing leaves the machine.
 *
 * The runtime is, in order: `--runtime <node_modules/@deepseek-ai>`, the maintenance testbed's
 * `DSH_INSTALL_ANCHOR` (the target `@deepseek-ai/dsh/package.json`), or the `dsh` on PATH.
 * `test/dsh-integration.test.mjs` runs this inside maintenance testbeds.
 *
 * Usage: node scripts/verify-dsh.mjs [--runtime <dir>] [--keep]; exit code 1 on any failure.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Files the bundle needs at runtime, staged into the throwaway work directory. */
const PLUGIN_FILES = ['index.js', 'lib', 'locale', 'package.json', 'cordis.patch.yml']

/** The `when` that dsh-tool-web registers web_fetch with, copied in index.js. */
const EXPECTED_WHEN = /when:\s*\(\s*\{\s*modelSelection\s*\}\s*\)\s*=>\s*ctx\.web\.fetchReady\(\s*modelSelection\.provider\s*\)/
const EXPECTED_BUDGET = 135_000
const PRESET_DEFAULT = 30_000
const CLOSED_PORT = 'http://127.0.0.1:9'

/**
 * Find the runtime's `node_modules/@deepseek-ai` directory.
 * @param {{ runtime?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string}
 */
export function resolveRuntime({ runtime, env = process.env } = {}) {
  if (runtime !== undefined) return resolve(runtime)
  // .../node_modules/@deepseek-ai/dsh/package.json → .../node_modules/@deepseek-ai
  if (env.DSH_INSTALL_ANCHOR) return dirname(dirname(realpathSync(env.DSH_INSTALL_ANCHOR)))
  const which = spawnSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8', env })
  const bin = which.stdout.trim()
  if (bin === '') throw new Error('no DSH runtime: pass --runtime <node_modules/@deepseek-ai>, set DSH_INSTALL_ANCHOR, or put dsh on PATH')
  // .../node_modules/@deepseek-ai/dsh/lib/bin.js → .../node_modules/@deepseek-ai
  return dirname(dirname(dirname(realpathSync(bin))))
}

const probeSource = (runtime) => `
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
`

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

const overlaySource = (pluginEntry, pluginConfig) => `- id: tool-web
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
      name: ${JSON.stringify(pluginEntry)}
      config: ${pluginConfig}
    - id: verify-probe
      name: ./probe.mjs
`

/**
 * Run every check against one runtime.
 * @param {{ runtime: string, keep?: boolean, bootTimeoutMs?: number }} options
 * @returns {Promise<{ version: string, runtime: string, work?: string, checks: { name: string, ok: boolean, detail: string }[] }>}
 */
export async function verifyDsh({ runtime, keep = false, bootTimeoutMs = 50_000 }) {
  for (const pkg of ['dsh', 'dsh-tools', 'dsh-tool-web', 'dsh-scope', 'dsh-agent-preset-registry']) {
    if (!existsSync(join(runtime, pkg, 'package.json'))) throw new Error(`${pkg} not found under ${runtime}`)
  }
  const version = JSON.parse(readFileSync(join(runtime, 'dsh', 'package.json'), 'utf8')).version
  const bin = join(runtime, 'dsh', 'lib', 'bin.js')

  const work = mkdtempSync(join(tmpdir(), 'dsh-web-fetch-chain-verify-'))
  const checks = []
  const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }) }
  try {
    // Stage the bundle so its DSH imports resolve to this runtime without touching the source tree.
    const plugin = join(work, 'plugin')
    for (const file of PLUGIN_FILES) cpSync(join(REPO, file), join(plugin, file), { recursive: true })
    mkdirSync(join(plugin, 'node_modules'))
    symlinkSync(runtime, join(plugin, 'node_modules', '@deepseek-ai'), 'dir')
    writeFileSync(join(work, 'probe.mjs'), probeSource(runtime))
    const home = join(work, 'home')
    const temp = join(work, 'tmp')
    mkdirSync(home)
    mkdirSync(temp)

    /** Boot headless once with one plugin config; collect probe reports and plugin warnings. */
    const run = (label, pluginConfig) => {
      const file = join(work, `${label}.yml`)
      writeFileSync(file, overlaySource(join(plugin, 'index.js'), pluginConfig))
      const result = spawnSync(process.execPath, [bin, '--profile', 'headless', '--patch', file, 'verify'], {
        cwd: work,
        encoding: 'utf8',
        timeout: bootTimeoutMs,
        killSignal: 'SIGKILL',
        env: {
          ...process.env,
          DSH_HOME: home,
          // DSH writes spill and native-loader files to the temp directory; keep them in `work`.
          TMPDIR: temp,
          TEMP: temp,
          TMP: temp,
          DEEPSEEK_API_KEY: 'sk-verify-fake',
          DEEPSEEK_BASE_URL: CLOSED_PORT,
          DSH_TELEMETRY_OTLP_URL: CLOSED_PORT,
        },
      })
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      const reports = Object.fromEntries(output.split('\n')
        .filter(line => line.startsWith('[verify] '))
        .map(line => JSON.parse(line.slice('[verify] '.length)))
        .map(report => [report.step, report]))
      const warnings = output.split('\n').filter(line => line.includes('web-fetch-chain:'))
      const failure = result.error ? String(result.error.message) : undefined
      return { reports, warnings, output, failure }
    }

    const sourceFile = ['src/fetch.ts', 'lib/index.js'].map(file => join(runtime, 'dsh-tool-web', file)).find(existsSync)
    const sameWhen = sourceFile !== undefined && EXPECTED_WHEN.test(readFileSync(sourceFile, 'utf8'))
    check('tool-web registers web_fetch with the admission condition index.js copies', sameWhen,
      sourceFile === undefined ? 'dsh-tool-web source not found' : `compare ${sourceFile} with the \`when\` in index.js`)

    const on = run('on', '{}')
    const off = run('off', '{ raiseWebFetchTimeout: false }')
    const r = on.reports
    const o = off.reports
    const tail = (outcome) => outcome.output.trim().split('\n').slice(-3).join(' | ')
    for (const [label, outcome] of [['plugin on', on], ['plugin off', off]]) {
      if (outcome.failure !== undefined) check(`headless boot (${label}) finished`, false, outcome.failure)
      if (outcome.reports.error) check(`probe (${label}) ran without errors`, false, outcome.reports.error.message.split('\n')[0])
      if (Object.keys(outcome.reports).length === 0) check(`probe (${label}) produced reports`, false, tail(outcome))
    }
    const shows = (report, agent, preset, sameExecute) => report !== undefined
      && report.agent === agent && report.preset === preset && (sameExecute === undefined || report.sameExecute === sameExecute)
    const describe = report => (report === undefined ? 'no report' : `agent ${report.agent}, preset ${report.preset}, same execute ${report.sameExecute}`)

    check('new agent sees the Chain Budget; the preset keeps its own limit', shows(r.create, EXPECTED_BUDGET, PRESET_DEFAULT, true), describe(r.create))
    check('switching to another preset re-copies its web_fetch', shows(r['switch-probe2'], EXPECTED_BUDGET, PRESET_DEFAULT, true), describe(r['switch-probe2']))
    check('switching to a preset without web_fetch removes the copy', shows(r['switch-empty'], null, null), describe(r['switch-empty']))
    check('switching back copies again', shows(r['switch-back'], EXPECTED_BUDGET, PRESET_DEFAULT, true), describe(r['switch-back']))
    check('closing the agent logs no plugin warnings', r.closed !== undefined && on.warnings.length === 0, on.warnings.join(' | ') || 'no close report')
    check('raiseWebFetchTimeout: false keeps the preset limit', shows(o.create, PRESET_DEFAULT, PRESET_DEFAULT), describe(o.create))
  } finally {
    if (!keep) rmSync(work, { recursive: true, force: true })
  }
  return { version, runtime, ...(keep ? { work } : {}), checks }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const args = process.argv.slice(2)
  const runtimeArg = args.includes('--runtime') ? args[args.indexOf('--runtime') + 1] : undefined
  try {
    const { version, runtime, work, checks } = await verifyDsh({ runtime: resolveRuntime({ runtime: runtimeArg }), keep: args.includes('--keep') })
    console.log(`DSH ${version} (${runtime})`)
    for (const { name, ok, detail } of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      ${detail}` : ''}`)
    if (work) console.log(`kept ${work}`)
    process.exit(checks.every(c => c.ok) ? 0 : 1)
  } catch (error) {
    console.error(`verify-dsh: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
