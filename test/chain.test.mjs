import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FetchChainProvider, chainBudgetMs } from '../lib/chain.js'

/** A fake Http Step answering with a fixed result or throwing a fixed error. */
function fakeHttp(outcome) {
  return {
    id: 'http',
    available: () => true,
    async fetch(request, signal) {
      if (typeof outcome === 'function') return await outcome(request, signal)
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  }
}

function httpResult(overrides = {}) {
  return {
    url: 'https://example.com/',
    statusCode: 200,
    body: { kind: 'html', content: '<html><head><title>Example</title></head><body>Hi</body></html>' },
    truncated: false,
    ...overrides,
  }
}

/** A fake transport answering per backend host; records every request it receives. */
function fakeTransport(routes) {
  const calls = []
  const transport = async (input, init = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    const route = routes[url.host]
    if (route === undefined) throw new Error(`unexpected request to ${url.host}`)
    return await route(url, init)
  }
  transport.calls = calls
  return transport
}

function chain({ http = fakeHttp(httpResult()), transport = fakeTransport({}), steps, apiKeys = {}, timeouts, options } = {}) {
  return new FetchChainProvider({ http, transport, settings: { steps, apiKeys, timeouts, options } })
}

test('the Http Step answers first and its result carries the Http Attribution', async () => {
  const result = await chain().fetch({ url: 'https://example.com/' })
  assert.equal(result.url, 'https://example.com/')
  assert.equal(result.statusCode, 200)
  assert.equal(result.body.kind, 'html')
  assert.equal(result.body.content, 'Http:<html><head><title>Example</title></head><body>Hi</body></html>')
  assert.equal(result.truncated, false)
})

function markdownResponse(markdown, { status = 200, headers = {} } = {}) {
  return new Response(markdown, { status, headers: { 'content-type': 'text/markdown; charset=utf-8', ...headers } })
}

test('a 403 from the Http Step falls back to Scrape.do, which returns its Markdown as text', async () => {
  const transport = fakeTransport({
    'api.scrape.do': () => markdownResponse('# Title\n\nBody', {
      headers: { 'scrape.do-resolved-url': 'https://example.com/final', 'scrape.do-initial-status-code': '301' },
    }),
  })
  const result = await chain({
    http: fakeHttp(httpResult({ statusCode: 403 })),
    transport,
    apiKeys: { scrapedo: 'sd-token' },
  }).fetch({ url: 'https://example.com/' })

  assert.equal(result.url, 'https://example.com/final')
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.body, { kind: 'text', content: 'Scrape.do:# Title\n\nBody' })
  assert.equal(result.truncated, false)

  const [call] = transport.calls
  assert.equal(call.url.origin + call.url.pathname, 'https://api.scrape.do/')
  assert.equal(call.url.searchParams.get('token'), 'sd-token')
  assert.equal(call.url.searchParams.get('url'), 'https://example.com/')
  assert.equal(call.url.searchParams.get('output'), 'markdown')
  assert.equal(call.url.searchParams.get('render'), 'true')
  assert.equal(call.url.searchParams.get('super'), 'true')
  assert.equal(call.url.searchParams.get('transparentResponse'), 'true')
})

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } })
}

const scrapflyOk = (content, extra = {}) => () => jsonResponse({
  result: { success: true, format: 'text', content, status_code: 200, url: 'https://example.com/after', ...extra },
})

const firecrawlOk = (markdown, metadata = {}) => () => jsonResponse({
  success: true,
  data: { markdown, metadata: { statusCode: 200, url: 'https://example.com/fc', title: 'Example', ...metadata } },
})

test('Scrapfly answers after Scrape.do fails, reporting the target status and final URL from its result', async () => {
  const transport = fakeTransport({
    'api.scrape.do': () => new Response('no credits', { status: 401 }),
    'api.scrapfly.io': scrapflyOk('# From Scrapfly'),
  })
  const result = await chain({
    http: fakeHttp(httpResult({ statusCode: 503 })),
    transport,
    apiKeys: { scrapedo: 'sd', scrapfly: 'sf-key' },
  }).fetch({ url: 'https://example.com/' })

  assert.equal(result.url, 'https://example.com/after')
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.body, { kind: 'text', content: 'Scrapfly:# From Scrapfly' })

  const call = transport.calls.find(c => c.url.host === 'api.scrapfly.io')
  assert.equal(call.url.pathname, '/scrape')
  assert.equal(call.url.searchParams.get('key'), 'sf-key')
  assert.equal(call.url.searchParams.get('url'), 'https://example.com/')
  assert.equal(call.url.searchParams.get('format'), 'markdown')
  assert.equal(call.url.searchParams.get('render_js'), 'true')
  assert.equal(call.url.searchParams.get('asp'), 'true')
  assert.equal(call.url.searchParams.get('retry'), 'false')
})

test('Firecrawl is the last Step and sends a Bearer-authenticated v2 scrape for the whole page', async () => {
  const transport = fakeTransport({
    'api.scrape.do': () => new Response('busy', { status: 429 }),
    'api.scrapfly.io': () => jsonResponse({ result: { success: false, error: { code: 'ERR::ASP::SHIELD_ERROR' } } }),
    'api.firecrawl.dev': firecrawlOk('# From Firecrawl'),
  })
  const result = await chain({
    http: fakeHttp(httpResult({ statusCode: 429 })),
    transport,
    apiKeys: { scrapedo: 'sd', scrapfly: 'sf', firecrawl: 'fc-key' },
  }).fetch({ url: 'https://example.com/' })

  assert.equal(result.url, 'https://example.com/fc')
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.body, { kind: 'text', content: 'Firecrawl:# From Firecrawl' })

  const call = transport.calls.find(c => c.url.host === 'api.firecrawl.dev')
  assert.equal(call.url.pathname, '/v2/scrape')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.authorization, 'Bearer fc-key')
  const body = JSON.parse(call.init.body)
  assert.equal(body.url, 'https://example.com/')
  assert.deepEqual(body.formats, ['markdown'])
  assert.equal(body.onlyMainContent, false)
  assert.equal(typeof body.timeout, 'number')
})

test('a paid Step without an API key is skipped without any request', async () => {
  const transport = fakeTransport({ 'api.scrapfly.io': scrapflyOk('# Scrapfly') })
  const result = await chain({
    http: fakeHttp(httpResult({ statusCode: 403 })),
    transport,
    apiKeys: { scrapedo: '', scrapfly: async () => 'sf' },
  }).fetch({ url: 'https://example.com/' })
  assert.equal(result.body.content, 'Scrapfly:# Scrapfly')
  assert.deepEqual(transport.calls.map(c => c.url.host), ['api.scrapfly.io'])
})

test('disabled Steps are left out and the configured order is followed', async () => {
  let httpCalled = false
  const transport = fakeTransport({
    'api.firecrawl.dev': () => new Response('down', { status: 500 }),
    'api.scrape.do': () => markdownResponse('# Scrape.do'),
  })
  const result = await chain({
    http: fakeHttp(() => { httpCalled = true; return httpResult() }),
    transport,
    steps: [
      { step: 'firecrawl', enabled: true },
      { step: 'http', enabled: false },
      { step: 'scrapedo', enabled: true },
      { step: 'scrapfly', enabled: true },
    ],
    apiKeys: { scrapedo: 'sd', scrapfly: 'sf', firecrawl: 'fc' },
  }).fetch({ url: 'https://example.com/' })
  assert.equal(result.body.content, 'Scrape.do:# Scrape.do')
  assert.equal(httpCalled, false)
  assert.deepEqual(transport.calls.map(c => c.url.host), ['api.firecrawl.dev', 'api.scrape.do'])
})

test('a Chain Failure lists every Step with its reason or skip', async () => {
  const transport = fakeTransport({
    'api.scrape.do': () => new Response('Your token is invalid', { status: 401 }),
    'api.scrapfly.io': () => jsonResponse({ code: 'ERR::THROTTLE::MAX_CONCURRENT_REQUEST_EXCEEDED' }, { status: 429 }),
  })
  await assert.rejects(
    chain({
      http: fakeHttp(httpResult({ statusCode: 403 })),
      transport,
      apiKeys: { scrapedo: 'sd', scrapfly: 'sf' },
    }).fetch({ url: 'https://example.com/' }),
    (error) => {
      assert.equal(error.code, 'WEB_FETCH_CHAIN_FAILED')
      assert.match(error.message, /- Http: target HTTP 403/)
      assert.match(error.message, /- Scrape\.do: API HTTP 401 Your token is invalid/)
      assert.match(error.message, /- Scrapfly: API HTTP 429 ERR::THROTTLE::MAX_CONCURRENT_REQUEST_EXCEEDED/)
      assert.match(error.message, /- Firecrawl: skipped \(no API key\)/)
      return true
    },
  )
})

test('a 404 from the Http Step is returned without Fallback', async () => {
  const transport = fakeTransport({})
  const result = await chain({
    http: fakeHttp(httpResult({ statusCode: 404, body: { kind: 'html', content: '<p>Not found</p>' } })),
    transport,
    apiKeys: { scrapedo: 'sd', scrapfly: 'sf', firecrawl: 'fc' },
  }).fetch({ url: 'https://example.com/missing' })
  assert.equal(result.statusCode, 404)
  assert.equal(result.body.content, 'Http:<p>Not found</p>')
  assert.equal(transport.calls.length, 0)
})

test('a 410 reported by a paid Step is returned as its result', async () => {
  const transport = fakeTransport({ 'api.firecrawl.dev': firecrawlOk('Gone', { statusCode: 410 }) })
  const result = await chain({
    http: fakeHttp(httpResult({ statusCode: 500 })),
    transport,
    apiKeys: { firecrawl: 'fc' },
  }).fetch({ url: 'https://example.com/old' })
  assert.equal(result.statusCode, 410)
  assert.equal(result.body.content, 'Firecrawl:Gone')
})

test('a malformed URL fails the whole request before any Step runs', async () => {
  let httpCalled = false
  const transport = fakeTransport({})
  const provider = chain({ http: fakeHttp(() => { httpCalled = true }), transport, apiKeys: { scrapedo: 'sd' } })
  for (const url of ['not a url', 'ftp://example.com/file']) {
    await assert.rejects(provider.fetch({ url }), { code: 'WEB_INVALID_URL' })
  }
  assert.equal(httpCalled, false)
  assert.equal(transport.calls.length, 0)
})

function webError(message, code) {
  return Object.assign(new Error(message), { code })
}

test('Http Step Failures for network, content type, size, and redirects fall back to the next Step', async () => {
  const errors = [
    webError('web fetch failed: ECONNRESET', 'WEB_PROVIDER_ERROR'),
    webError('unsupported content type "application/pdf"', 'WEB_UNSUPPORTED_CONTENT_TYPE'),
    webError('response exceeds the maximum of 5000000 bytes', 'WEB_FETCH_TOO_LARGE'),
    webError('exceeded the maximum of 5 redirects', 'WEB_REDIRECT_BLOCKED'),
  ]
  for (const error of errors) {
    const transport = fakeTransport({ 'api.scrape.do': () => markdownResponse('# Rescued') })
    const result = await chain({ http: fakeHttp(error), transport, apiKeys: { scrapedo: 'sd' } })
      .fetch({ url: 'https://example.com/doc.pdf' })
    assert.equal(result.body.content, 'Scrape.do:# Rescued', error.code)
  }
})

test('the Chain Failure names the Http Step error code', async () => {
  await assert.rejects(
    chain({ http: fakeHttp(webError('unsupported content type "application/pdf"', 'WEB_UNSUPPORTED_CONTENT_TYPE')) })
      .fetch({ url: 'https://example.com/doc.pdf' }),
    (error) => {
      assert.match(error.message, /- Http: WEB_UNSUPPORTED_CONTENT_TYPE: unsupported content type "application\/pdf"/)
      return true
    },
  )
})

test('a transport error from a paid Step is a Step Failure', async () => {
  const transport = fakeTransport({
    'api.scrape.do': () => { throw new TypeError('fetch failed') },
    'api.scrapfly.io': scrapflyOk('# Scrapfly'),
  })
  const result = await chain({ http: fakeHttp(httpResult({ statusCode: 403 })), transport, apiKeys: { scrapedo: 'sd', scrapfly: 'sf' } })
    .fetch({ url: 'https://example.com/' })
  assert.equal(result.body.content, 'Scrapfly:# Scrapfly')
})

test('a 200 Cloudflare challenge page from the Http Step falls back', async () => {
  const challenge = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>'
  const transport = fakeTransport({ 'api.scrape.do': () => markdownResponse('# Real page') })
  const result = await chain({
    http: fakeHttp(httpResult({ body: { kind: 'html', content: challenge } })),
    transport,
    apiKeys: { scrapedo: 'sd' },
  }).fetch({ url: 'https://example.com/' })
  assert.equal(result.body.content, 'Scrape.do:# Real page')
})

test('challenge markers in paid Step Markdown are Step Failures', async () => {
  const transport = fakeTransport({
    'api.scrape.do': () => markdownResponse('Just a moment...\n\nEnable JavaScript and cookies to continue'),
    'api.scrapfly.io': scrapflyOk('# Attention Required! | Cloudflare\n\nSorry, you have been blocked'),
    'api.firecrawl.dev': firecrawlOk('Checking your browser before accessing example.com', { title: 'Example' }),
  })
  await assert.rejects(
    chain({ http: fakeHttp(httpResult({ statusCode: 403 })), transport, apiKeys: { scrapedo: 'a', scrapfly: 'b', firecrawl: 'c' } })
      .fetch({ url: 'https://example.com/' }),
    (error) => {
      assert.match(error.message, /- Scrape\.do: challenge page detected/)
      assert.match(error.message, /- Scrapfly: challenge page detected/)
      assert.match(error.message, /- Firecrawl: challenge page detected/)
      return true
    },
  )
})

test('an ordinary page that merely mentions Cloudflare is not a challenge', async () => {
  const page = '<html><head><title>How Cloudflare works</title></head><body>Cloudflare shows "Just a moment..." while it checks visitors.</body></html>'
  const result = await chain({ http: fakeHttp(httpResult({ body: { kind: 'html', content: page } })) })
    .fetch({ url: 'https://example.com/' })
  assert.equal(result.body.content, `Http:${page}`)
})

test('a paid API success that reports a blocked target is a Step Failure', async () => {
  const transport = fakeTransport({
    'api.scrape.do': () => markdownResponse('Forbidden', { status: 403, headers: { 'scrape.do-target-url': 'https://example.com/' } }),
    'api.scrapfly.io': scrapflyOk('Too many requests', { status_code: 429 }),
    'api.firecrawl.dev': firecrawlOk('Bad gateway', { statusCode: 502 }),
  })
  await assert.rejects(
    chain({ http: fakeHttp(httpResult({ statusCode: 403 })), transport, apiKeys: { scrapedo: 'a', scrapfly: 'b', firecrawl: 'c' } })
      .fetch({ url: 'https://example.com/' }),
    (error) => {
      assert.match(error.message, /- Scrape\.do: target HTTP 403/)
      assert.match(error.message, /- Scrapfly: target HTTP 429/)
      assert.match(error.message, /- Firecrawl: target HTTP 502/)
      return true
    },
  )
})

test('a paid Step never returns raw HTML or binary content as text', async () => {
  const transport = fakeTransport({
    'api.scrape.do': () => new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } }),
    'api.scrapfly.io': scrapflyOk('<!DOCTYPE html><html><body>raw</body></html>'),
    'api.firecrawl.dev': firecrawlOk('<html><body>raw</body></html>'),
  })
  await assert.rejects(
    chain({ http: fakeHttp(httpResult({ statusCode: 403 })), transport, apiKeys: { scrapedo: 'a', scrapfly: 'b', firecrawl: 'c' } })
      .fetch({ url: 'https://example.com/' }),
    (error) => {
      assert.match(error.message, /- Scrape\.do: unsupported content type "application\/pdf"/)
      assert.match(error.message, /- Scrapfly: backend returned raw HTML/)
      assert.match(error.message, /- Firecrawl: backend returned raw HTML/)
      return true
    },
  )
})

test('Firecrawl API rejections are Step Failures', async () => {
  for (const status of [401, 402, 403, 408, 429, 500]) {
    const transport = fakeTransport({ 'api.firecrawl.dev': () => jsonResponse({ success: false, error: 'nope' }, { status }) })
    await assert.rejects(
      chain({ http: fakeHttp(httpResult({ statusCode: 403 })), transport, apiKeys: { firecrawl: 'c' } })
        .fetch({ url: 'https://example.com/' }),
      new RegExp(`- Firecrawl: API HTTP ${status} nope`),
    )
  }
})

test('Scrapfly API rejections are Step Failures', async () => {
  for (const status of [401, 402, 403, 422, 429, 500]) {
    const transport = fakeTransport({
      'api.scrapfly.io': () => jsonResponse({}, { status, headers: { 'x-scrapfly-reject-code': 'ERR::X' } }),
    })
    await assert.rejects(
      chain({ http: fakeHttp(httpResult({ statusCode: 403 })), transport, apiKeys: { scrapfly: 'b' } })
        .fetch({ url: 'https://example.com/' }),
      new RegExp(`- Scrapfly: API HTTP ${status} ERR::X`),
    )
  }
})

/** A Step that never answers on its own and rejects when its signal aborts. */
function hang(_request, signal) {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
  })
}

test('a Step that exceeds its own timeout is a Step Failure and the Chain moves on', async () => {
  const transport = fakeTransport({ 'api.scrape.do': () => markdownResponse('# Fast enough') })
  const started = Date.now()
  const result = await chain({
    http: fakeHttp(hang),
    transport,
    apiKeys: { scrapedo: 'sd' },
    timeouts: { http: 30 },
  }).fetch({ url: 'https://example.com/' })
  assert.equal(result.body.content, 'Scrape.do:# Fast enough')
  assert.ok(Date.now() - started < 1_000)
})

test('the timeout reason names the Step budget', async () => {
  const transport = fakeTransport({ 'api.scrape.do': (_url, init) => hang(undefined, init.signal) })
  await assert.rejects(
    chain({ http: fakeHttp(hang), transport, apiKeys: { scrapedo: 'sd' }, timeouts: { http: 20, scrapedo: 25 } })
      .fetch({ url: 'https://example.com/' }),
    (error) => {
      assert.match(error.message, /- Http: timed out after 20ms/)
      assert.match(error.message, /- Scrape\.do: timed out after 25ms/)
      return true
    },
  )
})

test('a Step waits only for the remaining tool time and the Chain then stops as cancelled', async () => {
  const transport = fakeTransport({ 'api.scrape.do': () => markdownResponse('# never reached') })
  const started = Date.now()
  await assert.rejects(
    chain({ http: fakeHttp(hang), transport, apiKeys: { scrapedo: 'sd' }, timeouts: { http: 10_000 } })
      .fetch({ url: 'https://example.com/' }, AbortSignal.timeout(40)),
    { code: 'WEB_ABORTED' },
  )
  assert.ok(Date.now() - started < 1_000)
  assert.equal(transport.calls.length, 0)
})

test('cancelling the call aborts the running paid Step and stops the Chain', async () => {
  const controller = new AbortController()
  let stepSignal
  const transport = fakeTransport({
    'api.scrape.do': (_url, init) => { stepSignal = init.signal; setTimeout(() => controller.abort(), 10); return hang(undefined, init.signal) },
    'api.scrapfly.io': scrapflyOk('# never reached'),
  })
  await assert.rejects(
    chain({ http: fakeHttp(httpResult({ statusCode: 403 })), transport, apiKeys: { scrapedo: 'sd', scrapfly: 'sf' } })
      .fetch({ url: 'https://example.com/' }, controller.signal),
    { code: 'WEB_ABORTED' },
  )
  assert.equal(stepSignal.aborted, true)
  assert.deepEqual(transport.calls.map(c => c.url.host), ['api.scrape.do'])
})

test('an already cancelled call runs no Step', async () => {
  let httpCalled = false
  await assert.rejects(
    chain({ http: fakeHttp(() => { httpCalled = true }) }).fetch({ url: 'https://example.com/' }, AbortSignal.abort()),
    { code: 'WEB_ABORTED' },
  )
  assert.equal(httpCalled, false)
})

test('Step options reach the backend requests', async () => {
  const transport = fakeTransport({
    'api.scrape.do': () => new Response('', { status: 502 }),
    'api.scrapfly.io': () => new Response('', { status: 503 }),
    'api.firecrawl.dev': firecrawlOk('# Main only'),
  })
  await chain({
    http: fakeHttp(httpResult({ statusCode: 403 })),
    transport,
    apiKeys: { scrapedo: 'a', scrapfly: 'b', firecrawl: 'c' },
    timeouts: { scrapedo: 3_000, scrapfly: 20_000, firecrawl: 45_000 },
    options: { scrapedoRender: false, scrapedoSuper: false, scrapflyRenderJs: false, scrapflyAsp: false, firecrawlOnlyMainContent: true },
  }).fetch({ url: 'https://example.com/' })

  const [sd, sf, fc] = transport.calls
  assert.equal(sd.url.searchParams.get('render'), 'false')
  assert.equal(sd.url.searchParams.get('super'), 'false')
  assert.equal(sd.url.searchParams.get('timeout'), '5000', 'scrape.do accepts at least 5 s')
  assert.equal(sf.url.searchParams.get('render_js'), 'false')
  assert.equal(sf.url.searchParams.get('asp'), 'false')
  assert.equal(sf.url.searchParams.get('timeout'), '15000')
  const body = JSON.parse(fc.init.body)
  assert.equal(body.onlyMainContent, true)
  assert.equal(body.timeout, 40_000)
})

test('the Http Step truncation flag and text body pass through with Attribution', async () => {
  const result = await chain({
    http: fakeHttp(httpResult({ body: { kind: 'text', content: '{"a":1}' }, truncated: true })),
  }).fetch({ url: 'https://example.com/data.json' })
  assert.deepEqual(result.body, { kind: 'text', content: 'Http:{"a":1}' })
  assert.equal(result.truncated, true)
})

test('requests are independent: an earlier Step Failure does not change the next request', async () => {
  let calls = 0
  const http = fakeHttp(() => (++calls === 1 ? httpResult({ statusCode: 503 }) : httpResult()))
  const transport = fakeTransport({ 'api.scrape.do': () => markdownResponse('# Rescued') })
  const provider = chain({ http, transport, apiKeys: { scrapedo: 'sd' } })
  assert.equal((await provider.fetch({ url: 'https://example.com/' })).body.content, 'Scrape.do:# Rescued')
  assert.match((await provider.fetch({ url: 'https://example.com/' })).body.content, /^Http:/)
})

test('the provider is available without any paid API key', () => {
  assert.equal(chain().available(), true)
})

test('a failing API key lookup is a Step Failure, not a crash', async () => {
  await assert.rejects(
    chain({
      http: fakeHttp(httpResult({ statusCode: 403 })),
      apiKeys: { scrapedo: async () => { throw new Error('store unreadable') } },
    }).fetch({ url: 'https://example.com/' }),
    /- Scrape\.do: API key lookup failed: store unreadable/,
  )
})

test('a 404 is definitive even when its page looks like a challenge', async () => {
  const page = '<html><head><title>Just a moment...</title></head><body>Not here</body></html>'
  const transport = fakeTransport({})
  const result = await chain({
    http: fakeHttp(httpResult({ statusCode: 404, body: { kind: 'html', content: page } })),
    transport,
    apiKeys: { scrapedo: 'sd' },
  }).fetch({ url: 'https://example.com/missing' })
  assert.equal(result.statusCode, 404)
  assert.equal(transport.calls.length, 0)
})

test('raw HTML behind a leading comment is still rejected from a paid Step', async () => {
  const transport = fakeTransport({
    'api.firecrawl.dev': firecrawlOk('<!-- generated -->\n<!DOCTYPE html><html><body>raw</body></html>'),
  })
  await assert.rejects(
    chain({ http: fakeHttp(httpResult({ statusCode: 403 })), transport, apiKeys: { firecrawl: 'c' } })
      .fetch({ url: 'https://example.com/' }),
    /- Firecrawl: backend returned raw HTML/,
  )
})

test('Markdown that only contains inline HTML is kept', async () => {
  const transport = fakeTransport({ 'api.firecrawl.dev': firecrawlOk('# Title\n\n<br>\n\nText') })
  const result = await chain({ http: fakeHttp(httpResult({ statusCode: 403 })), transport, apiKeys: { firecrawl: 'c' } })
    .fetch({ url: 'https://example.com/' })
  assert.equal(result.body.content, 'Firecrawl:# Title\n\n<br>\n\nText')
})

test('a stalled API key lookup counts against the Step timeout', async () => {
  const transport = fakeTransport({ 'api.scrapfly.io': scrapflyOk('# Scrapfly') })
  const result = await chain({
    http: fakeHttp(httpResult({ statusCode: 403 })),
    transport,
    apiKeys: { scrapedo: () => new Promise(() => {}), scrapfly: 'sf' },
    timeouts: { scrapedo: 30 },
  }).fetch({ url: 'https://example.com/' })
  assert.equal(result.body.content, 'Scrapfly:# Scrapfly')
})

test('Scrape.do passes the target status through, and a target 400 is a result, not a Step Failure', async () => {
  const transport = fakeTransport({
    'api.scrape.do': () => markdownResponse('# Bad request', { status: 400, headers: { 'scrape.do-target-url': 'https://example.com/' } }),
  })
  const result = await chain({ http: fakeHttp(httpResult({ statusCode: 403 })), transport, apiKeys: { scrapedo: 'sd' } })
    .fetch({ url: 'https://example.com/' })
  assert.equal(result.statusCode, 400)
  assert.equal(result.body.content, 'Scrape.do:# Bad request')
})

test('the Chain Budget is the enabled Step timeouts plus five seconds', () => {
  assert.equal(chainBudgetMs({}), 135_000)
  assert.equal(chainBudgetMs({
    steps: [{ step: 'http' }, { step: 'scrapedo', enabled: false }, { step: 'firecrawl' }],
    timeouts: { http: 5_000, firecrawl: 20_000 },
  }), 30_000)
})

test('paid Steps ask their backends to finish five seconds before the Step timeout', async () => {
  const transport = fakeTransport({
    'api.scrape.do': () => new Response('', { status: 502 }),
    'api.firecrawl.dev': firecrawlOk('# ok'),
  })
  await chain({
    http: fakeHttp(httpResult({ statusCode: 403 })),
    transport,
    apiKeys: { scrapedo: 'a', firecrawl: 'c' },
  }).fetch({ url: 'https://example.com/' })
  const [sd, fc] = transport.calls
  assert.equal(sd.url.searchParams.get('timeout'), '30000')
  assert.equal(JSON.parse(fc.init.body).timeout, 40_000)
})
