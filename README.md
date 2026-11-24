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

Then choose **Fetch chain** under **Settings** > **Web search and fetch** > **Web fetch provider**, and enter API keys on this bundle's [settings page](#settings-page).

### The web_fetch time limit

DSH's `web_fetch` tool stops a call after 30 seconds by default, which is too short for paid Steps that render JavaScript or bypass bot protection. While this plugin runs, it raises that limit to the **Chain Budget**: the sum of the enabled Step timeouts plus 5 seconds. With the defaults, the budget is 135 seconds (10 + 35 + 40 + 45 + 5). Every Step can use its whole timeout, and the Chain still reports its own outcome before the tool stops it.

How it works: the `tool-web` plugin that owns `web_fetch` sits inside each agent preset, where profile patches cannot reach it. Instead of editing preset declarations, the plugin copies the `web_fetch` definition each new agent inherits from its preset, changes only `timeoutMs`, and registers the copy in that agent's own scope, which takes precedence over the preset's ([ADR 0003](docs/adr/0003-raise-web-fetch-limit-per-agent.md)). The tool's behavior, schema, and description stay the same, and the model's prompt does not change.

- It applies to conversations started after the plugin loads, including subagents. Conversations that were already open keep 30 seconds.
- It applies whichever fetch provider is selected, because the plugin cannot see the selection. Turn it off with `raiseWebFetchTimeout` on the settings page.
- Switching a blank conversation to another preset copies that preset's `web_fetch` again; a preset without `web_fetch` gets none.
- Turning the plugin off removes the copies, so `web_fetch` goes back to the preset's own limit (30 seconds by default). Saving this plugin's settings restarts it, which does the same for open conversations; the new limit applies to conversations started afterwards.
- In the `ptc` preset, a `web_fetch` called from inside `run_code` is also bound by `run_code`'s own limit (120 seconds by default).

## Settings page

Open **Plugins**, choose **dsh-web-fetch-chain**, and use its settings page. It shows one card per Step in Chain order, top to bottom:

- **On** switch and **↑ / ↓** buttons to change the order
- **Timeout** in seconds (1–300)
- the service's own options, on paid Steps
- the **API key** field, on paid Steps

Below the cards are the `raiseWebFetchTimeout` switch and the Chain Budget the current values give.

**Save** writes the ordinary settings to this row's profile config through DSH's config editor. Only values that differ from the defaults are written. Saving restarts the plugin, and the new `web_fetch` limit applies to conversations started afterwards. **Revert** discards unsaved changes.

| Setting | Default | Meaning |
|---|---|---|
| `steps` | Http, Scrape.do, Scrapfly, Firecrawl, all on | Chain order from top to bottom, with an on/off switch per Step |
| `raiseWebFetchTimeout` | `true` | Raise the `web_fetch` time limit to the Chain Budget in new conversations |
| `httpTimeoutMs` | `10000` | Http Step timeout |
| `scrapedoTimeoutMs` | `35000` | Scrape.do Step timeout |
| `scrapflyTimeoutMs` | `40000` | Scrapfly Step timeout |
| `firecrawlTimeoutMs` | `45000` | Firecrawl Step timeout |
| `scrapedoRender` | `true` | scrape.do headless browser rendering |
| `scrapedoSuper` | `true` | scrape.do residential and mobile proxies |
| `scrapflyRenderJs` | `true` | Scrapfly headless browser rendering |
| `scrapflyAsp` | `true` | Scrapfly anti-bot bypass |
| `firecrawlOnlyMainContent` | `false` | When off, Firecrawl returns the whole page, including navigation and sidebars |

### API keys

Keys live in DSH credentials, never in plugin configuration. The credential names are fixed:

| Step | Credential name |
|---|---|
| Scrape.do | `SCRAPEDO_API_KEY` |
| Scrapfly | `SCRAPFLY_API_KEY` |
| Firecrawl | `FIRECRAWL_API_KEY` |

On each paid Step's card:

- A configured key shows a green marker, a masked preview, and where it comes from: the DSH credentials file, an environment variable, the project's `.env`, or `~/.dsh/.env`.
- An enabled Step without a key shows that the Chain skips it.
- **Save key** stores the typed key in the DSH credentials file, `~/.dsh/.credentials.yaml`, which outranks every other source.
- **Delete** removes a key stored in that file. Keys from the environment or a `.env` file cannot be deleted here.
- **Test** runs a **Key Check**: it checks the typed key, or the stored key when the field is empty, without saving it. It uses the service's account lookup, not a scrape, and reports one notification: valid key, or why not.

| Step | Key Check request |
|---|---|
| Scrape.do | `GET https://api.scrape.do/info?token=…` |
| Scrapfly | `GET https://api.scrapfly.io/account?key=…` |
| Firecrawl | `GET https://api.firecrawl.dev/v2/team/credit-usage`, `Authorization: Bearer …` |

These lookups read usage only. The services' documents do not explicitly promise that they are free.

Keys are looked up on every request, so a newly saved key works without a restart. You can still store keys by hand, highest priority first: the DSH credentials file, the environment that launches DSH, the project's `.env`, then `~/.dsh/.env`.

No page request ever returns a key to the browser.

The Step timeouts follow the services' own limits: scrape.do accepts server-side timeouts of 5–120 seconds, Scrapfly needs at least 30 seconds with `render_js` or `asp` and asks clients to wait 5 seconds longer, and Firecrawl defaults to 60 seconds. Raising a Step timeout also raises the Chain Budget and the `web_fetch` limit.

## How each service is called

| Step | Request | Body | Target status | Final URL |
|---|---|---|---|---|
| Scrape.do | `GET https://api.scrape.do/?token=…&url=…&output=markdown&render=…&super=…&transparentResponse=true&timeout=…` | response body | HTTP status (the target's, through `transparentResponse`) | `Scrape.do-Resolved-Url` header |
| Scrapfly | `GET https://api.scrapfly.io/scrape?key=…&url=…&format=markdown&render_js=…&asp=…&retry=false&timeout=…` | `result.content` | `result.status_code` | `result.url` |
| Firecrawl | `POST https://api.firecrawl.dev/v2/scrape`, `Authorization: Bearer …`, `{ formats: ["markdown"], onlyMainContent, timeout }` | `data.markdown` | `data.metadata.statusCode` | `data.metadata.url` |

These responses are Step Failures:

- Scrapfly: any non-2xx API status, including 401, 402, 403, 422, 429, and 5xx, or `result.success: false`.
- Firecrawl: any non-2xx API status, including 401, 402, 403, 408, 429, and 5xx, or `success: false`.
- scrape.do: a non-2xx response without scrape.do's `Scrape.do-Target-Url`/`Scrape.do-Resolved-Url` headers, which is scrape.do's own rejection (401 no credits, 429 concurrency, 502 failed). 404 and 410 stay definitive.
- Any paid Step that returns raw HTML or binary content instead of Markdown.

Scrapfly's large-object (`clob`/`blob`) responses are not downloaded and count as a Step Failure. Each paid Step asks its service to finish 5 seconds before the Step timeout, kept within that service's limits, so the response has time to arrive.

## Development

```sh
npm test            # node --test, against fake Http Steps and a fake transport
npm run verify:dsh  # re-check the web_fetch limit raise against the installed DSH
```

`npm run verify:dsh` checks the `web_fetch` limit raise against a real DSH runtime; it exits non-zero when a check fails. It boots the shipped `headless` profile twice in a throwaway `DSH_HOME`, with a temporary `--patch` overlay that adds presets holding `tool-web`, a staged copy of this bundle, and a probe. The probe creates a preset-bound conversation, switches presets, and closes it. It checks that:

- `tool-web` still registers `web_fetch` with the admission condition `index.js` copies
- a new conversation sees the Chain Budget while its preset keeps its own limit
- preset switches re-copy `web_fetch` or remove the copy, and closing logs no warnings
- `raiseWebFetchTimeout: false` keeps the preset limit

It writes only inside one temporary directory, which it deletes. It creates no profile, no Session in your `DSH_HOME`, and no link in the source tree. Model and telemetry requests go to a closed local port with a fake key. A run takes about 35 seconds.

- **Which runtime:** `--runtime <path>/node_modules/@deepseek-ai`, then `DSH_INSTALL_ANCHOR`, then the `dsh` on `PATH`. `--keep` keeps the temporary directory.
- **Maintenance installs:** the same check is `test/dsh-integration.test.mjs`, part of `npm test`. It runs when `DSH_INSTALL_ANCHOR` is set, which the dsh-plugin-update-flow testbed does for a Type 2 plugin's source tests with the target runtime. So an update that breaks the raise fails the install's unit-test gate. Elsewhere it is skipped; set `VERIFY_DSH=1` to run it from `npm test`.

The settings tests drive `lib/management.js` with a fake credential store, config writer, and transport. The Chain tests use only the Chain provider's public `fetch(request, signal)`; the `web_fetch` limit tests use a fake of the tools registry. `index.js` imports DSH packages (`@deepseek-ai/dsh-web`, `dsh-web-fetch-http`, `dsh-credentials`, `schemastery`) that resolve from the DSH installation at runtime. To load it outside DSH, symlink `node_modules/@deepseek-ai` to a DSH runtime's `node_modules/@deepseek-ai`.

## Limitations

- There is no drag-and-drop order editor; the settings page moves Steps with ↑ / ↓ buttons.
- A very short page is not treated as a failure, so JS-only pages that Http fetches as an empty shell are returned as they are.
- Whether a service's Markdown makes relative image URLs absolute depends on that service.
