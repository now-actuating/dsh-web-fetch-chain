# dsh-web-fetch-chain

A DeepSeek Harness (DSH) bundle that adds the **Fetch chain** web fetch provider (id `web-fetch-chain`). Each `web_fetch` call walks a **Chain** of fetch backends in order until one succeeds:

```
Http  →  Scrape.do  →  Scrapfly  →  Firecrawl
```

## What it does

- **Http** goes first and costs nothing. It is DSH's own `dsh-web-fetch-http` provider with DSH's default limits.
- If a Step fails, the Chain falls back to the next Step. A **Step Failure** is any of these:
  - a network error or timeout
  - a target response of 403, 429, or 5xx
  - a challenge page, such as Cloudflare "Just a moment...", "Attention Required", `cf-chl`, or "Checking your browser"
  - a rejection from the service itself: invalid key, no credits, or concurrency limit
  - content the Step cannot represent: an unsupported type such as a PDF on Http, an oversized body, or too many redirects
- **404 and 410 are definitive answers.** They are returned as they are, without spending credits. A malformed URL fails at once, before any Step runs.
- A paid Step without an API key is **skipped**. Http alone is a working Chain, so the provider is always available.
- The result starts with the name of the Step that answered, on the same line (**Attribution**): `Http:`, `Scrape.do:`, `Scrapfly:`, or `Firecrawl:`.
- The result URL and status code come from the Step that answered: the final URL after redirects, and the target page's status.
- Paid Steps return the service's own Markdown as a `text` body ([ADR 0002](docs/adr/0002-paid-steps-return-backend-markdown.md)). Http results pass through unchanged, so HTML is still converted by DSH.
- If every Step fails or is skipped, the call fails with code `WEB_FETCH_CHAIN_FAILED`. The message lists each Step's reason:

  ```
  Fetch chain failed for https://httpbin.org/status/403:
  - Http: target HTTP 403
  - Scrape.do: skipped (no API key)
  - Scrapfly: skipped (no API key)
  - Firecrawl: skipped (no API key)
  ```

- Every request starts fresh. Earlier failures are not remembered.
- Cancelling the tool call aborts the running Step and stops the Chain with `WEB_ABORTED`.

### Costs and privacy

scrape.do, Scrapfly, and Firecrawl are paid services. Any URL that reaches a paid Step is sent to that service, including localhost and intranet URLs ([ADR 0001](docs/adr/0001-private-urls-walk-the-full-chain.md)). The services cannot reach private networks, so such URLs usually fail there after spending credits and time. Turn off the Steps you do not want, or leave their keys unset.

JS rendering (`render`, `render_js`) and the stronger anti-bot options (scrape.do `super`, Scrapfly `asp`) are **on by default**. They make protected pages succeed more often, but they cost more credits per request.

## Install

From a local checkout, open **Plugins** > **Add plugin** and choose this directory. An agent with `plugin_manager` can also run `install_bundle` with the directory path.

Then choose **Fetch chain** under **Settings** > **Web search and fetch** > **Web fetch provider**.

### Raise the web_fetch tool timeout

The default Step timeouts add up to 115 seconds (10 + 30 + 30 + 45). The `web_fetch` tool's default budget is 30 seconds. Raise it to 120 seconds in your profile's `cordis.patch.yml`:

```yaml
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetchTimeoutMs: 120000
```

Each Step waits for its own timeout or for the remaining tool-call time, whichever is shorter. When the tool budget runs out, the Chain stops cleanly.

## API keys

Keys are read from DSH credentials, not from plugin configuration. The plugin settings hold only the credential **names**:

| Setting | Default credential name |
|---|---|
| `scrapedoApiKeyRef` | `SCRAPEDO_API_KEY` |
| `scrapflyApiKeyRef` | `SCRAPFLY_API_KEY` |
| `firecrawlApiKeyRef` | `FIRECRAWL_API_KEY` |

You can store a key in any of these places, highest priority first:

1. the DSH credentials file, `~/.dsh/.credentials.yaml`
2. the environment that launches DSH
3. the project's `.env`
4. `~/.dsh/.env`

Keys are looked up on every request, so a newly saved key works without a restart.

## Settings

Edit these in the plugin's default settings form.

| Field | Default | Meaning |
|---|---|---|
| `steps` | Http, Scrape.do, Scrapfly, Firecrawl, all on | Chain order from top to bottom, with an on/off switch per Step |
| `httpTimeoutMs` | `10000` | Http Step timeout |
| `scrapedoTimeoutMs` | `30000` | Scrape.do Step timeout |
| `scrapflyTimeoutMs` | `30000` | Scrapfly Step timeout |
| `firecrawlTimeoutMs` | `45000` | Firecrawl Step timeout |
| `scrapedoRender` | `true` | scrape.do headless browser rendering |
| `scrapedoSuper` | `true` | scrape.do residential and mobile proxies |
| `scrapflyRenderJs` | `true` | Scrapfly headless browser rendering |
| `scrapflyAsp` | `true` | Scrapfly anti-bot bypass |
| `firecrawlOnlyMainContent` | `false` | When off, Firecrawl returns the whole page, including navigation and sidebars |

## How each service is called

| Step | Request | Body | Target status | Final URL |
|---|---|---|---|---|
| Scrape.do | `GET https://api.scrape.do/?token=…&url=…&output=markdown&render=…&super=…&transparentResponse=true` | response body | HTTP status (the target's, through `transparentResponse`) | `Scrape.do-Resolved-Url` header |
| Scrapfly | `GET https://api.scrapfly.io/scrape?key=…&url=…&format=markdown&render_js=…&asp=…&retry=false&timeout=…` | `result.content` | `result.status_code` | `result.url` |
| Firecrawl | `POST https://api.firecrawl.dev/v2/scrape`, `Authorization: Bearer …`, `{ formats: ["markdown"], onlyMainContent, timeout }` | `data.markdown` | `data.metadata.statusCode` | `data.metadata.url` |

These responses are Step Failures:

- Scrapfly: any non-2xx API status, including 401, 402, 403, 422, 429, and 5xx, or `result.success: false`.
- Firecrawl: any non-2xx API status, including 401, 402, 403, 408, 429, and 5xx, or `success: false`.
- scrape.do: a non-2xx response without scrape.do's `Scrape.do-Target-Url`/`Scrape.do-Resolved-Url` headers, which is scrape.do's own rejection (401 no credits, 429 concurrency, 502 failed). 404 and 410 stay definitive.
- Any paid Step that returns raw HTML or binary content instead of Markdown.

Scrapfly's large-object (`clob`/`blob`) responses are not downloaded and count as a Step Failure. Scrapfly's server-side `timeout` is set to the Step timeout minus 5 seconds, kept within Scrapfly's limits.

## Development

```sh
npm test        # node --test, against fake Http Steps and a fake transport
```

The tests use only the Chain provider's public `fetch(request, signal)`. `index.js` imports DSH packages (`@deepseek-ai/dsh-web`, `dsh-web-fetch-http`, `dsh-credentials`, `schemastery`) that resolve from the DSH installation at runtime. To load it outside DSH, symlink `node_modules/@deepseek-ai` to a DSH runtime's `node_modules/@deepseek-ai`.

## Limitations

- There is no drag-and-drop order editor. The order is the `steps` table in the default settings form.
- A very short page is not treated as a failure, so JS-only pages that Http fetches as an empty shell are returned as they are.
- Whether a service's Markdown makes relative image URLs absolute depends on that service.
