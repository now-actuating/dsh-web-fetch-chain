/**
 * dsh-web-fetch-chain: registers the "Fetch chain" web fetch provider, which walks
 * Http -> Scrape.do -> Scrapfly -> Firecrawl until one Step succeeds.
 * @module dsh-web-fetch-chain
 */

import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import { DEFAULT_USER_AGENT, HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { DEFAULT_OPTIONS, DEFAULT_TIMEOUTS, FetchChainProvider, STEP_IDS } from './lib/chain.js'

/** Provider id the Web fetch provider menu pins. */
export const PROVIDER_ID = 'web-fetch-chain'

export const name = 'web-fetch-chain'
export const inject = ['web']

/** DSH's own `dsh-web-fetch-http` defaults, except the timeout, which is the Http Step's. */
const HTTP_LIMITS = { maxResponseBytes: 5_000_000, maxBodyChars: 100_000, maxRedirects: 5, userAgent: DEFAULT_USER_AGENT }

const DEFAULT_STEPS = STEP_IDS.map(step => ({ step, enabled: true }))

const timeout = (ms, label) => z.natural().min(1_000).max(300_000).step(1_000).default(ms)
  .description(`${label} Step timeout in milliseconds. A Step never waits past the remaining tool-call time.`)

export const Config = z.object({
  steps: z.array(z.object({
    step: z.union(STEP_IDS).required().description('Step: http, scrapedo, scrapfly, or firecrawl.'),
    enabled: z.boolean().default(true).description('Whether the Chain tries this Step.'),
  })).role('table').default(DEFAULT_STEPS)
    .description('Chain order, top to bottom. Turn a Step off to leave it out; a paid Step without an API key is skipped.'),
  scrapedoApiKeyRef: z.string().role('credential-ref').default('SCRAPEDO_API_KEY')
    .description('Credential name holding the scrape.do token (DSH credentials file, or the environment).'),
  scrapflyApiKeyRef: z.string().role('credential-ref').default('SCRAPFLY_API_KEY')
    .description('Credential name holding the Scrapfly API key.'),
  firecrawlApiKeyRef: z.string().role('credential-ref').default('FIRECRAWL_API_KEY')
    .description('Credential name holding the Firecrawl API key.'),
  httpTimeoutMs: timeout(DEFAULT_TIMEOUTS.http, 'Http'),
  scrapedoTimeoutMs: timeout(DEFAULT_TIMEOUTS.scrapedo, 'Scrape.do'),
  scrapflyTimeoutMs: timeout(DEFAULT_TIMEOUTS.scrapfly, 'Scrapfly'),
  firecrawlTimeoutMs: timeout(DEFAULT_TIMEOUTS.firecrawl, 'Firecrawl'),
  scrapedoRender: z.boolean().default(DEFAULT_OPTIONS.scrapedoRender)
    .description('scrape.do `render`: run a headless browser (costs more credits).'),
  scrapedoSuper: z.boolean().default(DEFAULT_OPTIONS.scrapedoSuper)
    .description('scrape.do `super`: residential and mobile proxies (costs more credits).'),
  scrapflyRenderJs: z.boolean().default(DEFAULT_OPTIONS.scrapflyRenderJs)
    .description('Scrapfly `render_js`: run a headless browser (costs more credits).'),
  scrapflyAsp: z.boolean().default(DEFAULT_OPTIONS.scrapflyAsp)
    .description('Scrapfly `asp`: anti-bot bypass (costs more credits).'),
  firecrawlOnlyMainContent: z.boolean().default(DEFAULT_OPTIONS.firecrawlOnlyMainContent)
    .description('Firecrawl `onlyMainContent`: drop headers, navigation, and footers.'),
})

/** Picker description shown under the selected provider. */
const DESCRIPTION = {
  en: 'Tries plain HTTP first, then scrape.do, Scrapfly, and Firecrawl in the configured order until one succeeds. Paid services spend credits and receive every URL that reaches them, including intranet URLs; a service without an API key is skipped.',
  ko: '먼저 일반 HTTP로 시도하고, 실패하면 설정한 순서대로 scrape.do, Scrapfly, Firecrawl을 차례로 시도합니다. 유료 서비스는 크레딧을 쓰고, 그 단계까지 간 URL(내부망 URL 포함)을 받습니다. API 키가 없는 서비스는 건너뜁니다.',
  zh: '先用普通 HTTP 抓取，失败后按配置顺序依次尝试 scrape.do、Scrapfly、Firecrawl，直到成功。付费服务会消耗额度，并会收到传到该步骤的所有 URL（包括内网 URL）；未配置 API 密钥的服务会被跳过。',
}

export function apply(ctx, config) {
  const http = new HttpFetchProvider({ ...HTTP_LIMITS, timeoutMs: config.httpTimeoutMs })
  const chain = new FetchChainProvider({
    http,
    transport: (input, init) => globalThis.fetch(input, init),
    WebError,
    settings: {
      steps: config.steps,
      apiKeys: {
        scrapedo: keyResolver(ctx, config.scrapedoApiKeyRef),
        scrapfly: keyResolver(ctx, config.scrapflyApiKeyRef),
        firecrawl: keyResolver(ctx, config.firecrawlApiKeyRef),
      },
      timeouts: {
        http: config.httpTimeoutMs,
        scrapedo: config.scrapedoTimeoutMs,
        scrapfly: config.scrapflyTimeoutMs,
        firecrawl: config.firecrawlTimeoutMs,
      },
      options: {
        scrapedoRender: config.scrapedoRender,
        scrapedoSuper: config.scrapedoSuper,
        scrapflyRenderJs: config.scrapflyRenderJs,
        scrapflyAsp: config.scrapflyAsp,
        firecrawlOnlyMainContent: config.firecrawlOnlyMainContent,
      },
    },
  })

  ctx.web.registerFetchProvider({
    id: PROVIDER_ID,
    title: 'Fetch chain',
    description: DESCRIPTION,
    available: () => chain.available(),
    fetch: (request, signal) => chain.fetch(request, signal),
  })
}

/**
 * Resolve an API key from DSH credentials once per request, so a saved key reaches the next
 * request without a restart. Without a credentials service, read the launch environment.
 */
function keyResolver(ctx, ref) {
  return async () => {
    const refName = typeof ref === 'string' ? ref.trim() : ''
    if (refName === '') return undefined
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return process.env[refName]
    const hit = await credentials.resolve(credentialRef(refName))
    return hit?.value
  }
}
