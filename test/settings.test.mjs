import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KEY_REFS, maskKey, rawConfig, settingsView } from '../lib/settings.js'
import { checkKey } from '../lib/key-check.js'
import { createHandlers, dispatch } from '../lib/management.js'

/** A fake DSH credential store: a managed file layer over fixed fallback layers. */
function fakeCredentials({ file = {}, fallback = {} } = {}) {
  const values = { ...file }
  const calls = []
  return {
    values,
    calls,
    async describe(ref) {
      if (values[ref] !== undefined) return { configured: true, source: 'file', writable: true, masked: `file-mask-${ref}` }
      if (fallback[ref] !== undefined) return { configured: true, source: fallback[ref].source, writable: true }
      return { configured: false, writable: true }
    },
    async resolve(ref) {
      if (values[ref] !== undefined) return { value: values[ref], source: 'file' }
      if (fallback[ref] !== undefined) return { value: fallback[ref].value, source: fallback[ref].source }
      return undefined
    },
    async set(ref, value) { calls.push(['set', ref, value]); values[ref] = value },
    async unset(ref) { calls.push(['unset', ref]); delete values[ref] },
  }
}

/** A fake transport answering with a fixed status and JSON body; records each request. */
function fakeTransport(status, body) {
  const calls = []
  const transport = async (url, init) => {
    calls.push({ url, init })
    if (status instanceof Error) throw status
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }
  transport.calls = calls
  return transport
}

function handlers(overrides = {}) {
  const writes = []
  const credentials = overrides.credentials ?? fakeCredentials()
  const h = createHandlers({
    config: overrides.config ?? {},
    editor: overrides.editor ?? (() => async (next) => { writes.push(next) }),
    credentials: () => credentials,
    transport: overrides.transport ?? fakeTransport(200, {}),
  })
  return { h, writes, credentials }
}

test('the view fills defaults and keeps a Step left out of the config, switched off', () => {
  const view = settingsView({ steps: [{ step: 'firecrawl', enabled: true }, { step: 'http', enabled: false }], scrapflyTimeoutMs: 60_000 })
  assert.deepEqual(view.steps, [
    { step: 'firecrawl', enabled: true },
    { step: 'http', enabled: false },
    { step: 'scrapedo', enabled: false },
    { step: 'scrapfly', enabled: false },
  ])
  assert.equal(view.timeouts.scrapfly, 60_000)
  assert.equal(view.timeouts.http, 10_000)
  assert.equal(view.options.scrapedoRender, true)
  assert.equal(view.raiseWebFetchTimeout, true)
})

test('a page left at the defaults writes an empty config', () => {
  assert.deepEqual(rawConfig(settingsView({})), {})
})

test('only changed values are written, and unknown fields such as the old key names are dropped', () => {
  const form = settingsView({ scrapedoApiKeyRef: 'OLD' })
  form.steps.reverse()
  form.timeouts.firecrawl = 60_000
  form.options.scrapflyAsp = false
  form.raiseWebFetchTimeout = false
  assert.deepEqual(rawConfig(form), {
    steps: [
      { step: 'firecrawl', enabled: true },
      { step: 'scrapfly', enabled: true },
      { step: 'scrapedo', enabled: true },
      { step: 'http', enabled: true },
    ],
    firecrawlTimeoutMs: 60_000,
    scrapflyAsp: false,
    raiseWebFetchTimeout: false,
  })
})

test('a switched-off Step in the default order is written', () => {
  const form = settingsView({})
  form.steps[1].enabled = false
  assert.equal(rawConfig(form).steps[1].enabled, false)
})

test('malformed settings are refused', () => {
  const base = () => settingsView({})
  const bad = [
    (f) => { f.steps.pop() },
    (f) => { f.steps[1] = { step: 'http', enabled: true } },
    (f) => { f.steps[0].enabled = 'yes' },
    (f) => { f.timeouts.http = 500 },
    (f) => { f.timeouts.http = 301_000 },
    (f) => { f.timeouts.http = 1_500 },
    (f) => { f.options.scrapedoRender = 1 },
    (f) => { delete f.raiseWebFetchTimeout },
  ]
  for (const change of bad) {
    const form = base()
    change(form)
    assert.throws(() => rawConfig(form), { name: 'Error' })
  }
  assert.throws(() => rawConfig(null))
})

test('a mask never shows the whole key', () => {
  assert.equal(maskKey('abcdefghijklmnop'), 'abc••••mnop')
  assert.equal(maskKey('short'), '••••••••')
})

test('Key Check calls each account lookup with the key where the service expects it', async () => {
  const scrapedo = fakeTransport(200, { IsActive: true, RemainingMonthlyRequest: 10 })
  assert.deepEqual(await checkKey({ step: 'scrapedo', apiKey: 'k1', transport: scrapedo }), { ok: true })
  assert.equal(scrapedo.calls[0].url, 'https://api.scrape.do/info?token=k1')

  const scrapfly = fakeTransport(200, { account: {} })
  assert.deepEqual(await checkKey({ step: 'scrapfly', apiKey: 'k2', transport: scrapfly }), { ok: true })
  assert.equal(scrapfly.calls[0].url, 'https://api.scrapfly.io/account?key=k2')

  const firecrawl = fakeTransport(200, { success: true, data: { remainingCredits: 5 } })
  assert.deepEqual(await checkKey({ step: 'firecrawl', apiKey: 'k3', transport: firecrawl }), { ok: true })
  assert.equal(firecrawl.calls[0].url, 'https://api.firecrawl.dev/v2/team/credit-usage')
  assert.equal(firecrawl.calls[0].init.headers.authorization, 'Bearer k3')
})

test('Key Check reports why a key is not valid, without the account details', async () => {
  assert.deepEqual(await checkKey({ step: 'scrapfly', apiKey: 'k', transport: fakeTransport(401, { message: 'Invalid API key' }) }),
    { ok: false, reason: 'invalid-key', status: 401 })
  assert.deepEqual(await checkKey({ step: 'scrapedo', apiKey: 'k', transport: fakeTransport(200, { IsActive: false }) }),
    { ok: false, reason: 'inactive' })
  assert.deepEqual(await checkKey({ step: 'firecrawl', apiKey: 'k', transport: fakeTransport(200, { success: false }) }),
    { ok: false, reason: 'invalid-key', status: 200 })
  assert.deepEqual(await checkKey({ step: 'scrapedo', apiKey: 'k', transport: fakeTransport(502, {}) }),
    { ok: false, reason: 'http-status', status: 502 })
  assert.deepEqual(await checkKey({ step: 'scrapedo', apiKey: 'k', transport: fakeTransport(200, '<html>') }),
    { ok: false, reason: 'bad-response' })
})

test('a transport error message never carries the key', async () => {
  const result = await checkKey({ step: 'scrapedo', apiKey: 's3cret/key', transport: fakeTransport(new Error('fetch failed for https://api.scrape.do/info?token=s3cret%2Fkey (s3cret/key)')) })
  assert.equal(result.reason, 'network')
  assert.ok(!result.message.includes('s3cret'), result.message)
})

test('Key Check times out', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
  assert.deepEqual(await checkKey({ step: 'scrapfly', apiKey: 'k', transport: hang, timeoutMs: 20 }), { ok: false, reason: 'timeout' })
})

test('state reports settings and each key without the key itself', async () => {
  const credentials = fakeCredentials({
    file: { [KEY_REFS.scrapedo]: 'file-key-123456' },
    fallback: { [KEY_REFS.scrapfly]: { value: 'env-key-abcdefgh', source: 'env' } },
  })
  const { h } = handlers({ credentials, config: { httpTimeoutMs: 20_000 } })
  const state = await h.state()
  assert.equal(state.settings.timeouts.http, 20_000)
  assert.equal(state.editable, true)
  assert.equal(state.keysEditable, true)
  assert.deepEqual(state.keys.scrapedo, { configured: true, source: 'file', masked: `file-mask-${KEY_REFS.scrapedo}`, deletable: true })
  assert.deepEqual(state.keys.scrapfly, { configured: true, source: 'env', masked: maskKey('env-key-abcdefgh'), deletable: false })
  assert.deepEqual(state.keys.firecrawl, { configured: false, deletable: false })
  assert.ok(!JSON.stringify(state).includes('file-key-123456'))
  assert.ok(!JSON.stringify(state).includes('env-key-abcdefgh'))
})

test('save writes the raw config; a profile without a config editor refuses', async () => {
  const { h, writes } = handlers()
  const form = settingsView({})
  form.options.firecrawlOnlyMainContent = true
  await h.save({ settings: form })
  assert.deepEqual(writes, [{ firecrawlOnlyMainContent: true }])

  const readOnly = handlers({ editor: () => undefined })
  assert.equal((await readOnly.h.state()).editable, false)
  const result = await dispatch(readOnly.h, 'save', { settings: form })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /cannot be saved/)
})

test('setKey stores a trimmed key under the fixed name and refuses an empty one', async () => {
  const { h, credentials } = handlers()
  const { key } = await h.setKey({ step: 'firecrawl', value: '  fc-123456789  ' })
  assert.deepEqual(credentials.calls, [['set', 'FIRECRAWL_API_KEY', 'fc-123456789']])
  assert.equal(key.configured, true)
  assert.equal(key.deletable, true)
  assert.equal((await dispatch(h, 'setKey', { step: 'firecrawl', value: '  ' })).ok, false)
  assert.equal((await dispatch(h, 'setKey', { step: 'http', value: 'x' })).ok, false)
})

test('deleteKey removes only a key stored in the credentials file', async () => {
  const credentials = fakeCredentials({
    file: { SCRAPEDO_API_KEY: 'a-123456789012' },
    fallback: { SCRAPFLY_API_KEY: { value: 'b-123456789012', source: 'env' } },
  })
  const { h } = handlers({ credentials })
  const { key } = await h.deleteKey({ step: 'scrapedo' })
  assert.deepEqual(credentials.calls, [['unset', 'SCRAPEDO_API_KEY']])
  assert.equal(key.configured, false)
  const refused = await dispatch(h, 'deleteKey', { step: 'scrapfly' })
  assert.equal(refused.ok, false)
  assert.equal(credentials.calls.length, 1)
})

test('checkKey uses the typed key, else the stored key, and never stores it', async () => {
  const transport = fakeTransport(200, { IsActive: true })
  const credentials = fakeCredentials({ file: { SCRAPEDO_API_KEY: 'stored-key' } })
  const { h } = handlers({ credentials, transport })
  assert.deepEqual(await h.checkKey({ step: 'scrapedo', value: ' typed-key ' }), { ok: true })
  assert.equal(transport.calls[0].url, 'https://api.scrape.do/info?token=typed-key')
  assert.deepEqual(await h.checkKey({ step: 'scrapedo', value: '' }), { ok: true })
  assert.equal(transport.calls[1].url, 'https://api.scrape.do/info?token=stored-key')
  assert.deepEqual(credentials.calls, [])
  assert.deepEqual(await h.checkKey({ step: 'firecrawl' }), { ok: false, reason: 'no-key' })
})

test('an unknown endpoint and an unexpected error are reported as Gateway errors', async () => {
  const { h } = handlers()
  assert.equal((await dispatch(h, 'nope', {})).error.code, 'web-fetch-chain/unknown-endpoint')
  assert.equal((await dispatch(h, 'toString', {})).error.code, 'web-fetch-chain/unknown-endpoint')
  const warnings = []
  const broken = { boom: async () => { throw new Error('kaboom') } }
  const result = await dispatch(broken, 'boom', {}, { warn: (m) => warnings.push(m) })
  assert.equal(result.error.message, 'kaboom')
  assert.equal(warnings.length, 1)
})
