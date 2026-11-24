# Web Fetch Chain

A DSH web fetch provider that retrieves a page by trying several fetch backends in a user-configured order until one succeeds.

## Language

**Chain**:
The ordered list of enabled Steps that one fetch request walks through.
_Avoid_: Pipeline, provider list

**Step**:
One fetch backend inside the Chain: plain HTTP, scrape.do, Scrapfly, or Firecrawl.
_Avoid_: Stage, sub-provider, hop

**Fallback**:
Moving from a failed Step to the next Step in the Chain.
_Avoid_: Retry

**Step Failure**:
A Step outcome that triggers Fallback: a network error or timeout, an HTTP 403, 429, or 5xx response, a detected challenge page, a backend's own rejection (invalid key, exhausted credits), or content the Step cannot represent (unsupported type, oversize, too many redirects).
A 404 or 410 and a malformed URL are not Step Failures; they are definitive answers.
_Avoid_: Error (too broad)

**Chain Budget**:
The total time one fetch request may spend walking the Chain: the sum of the enabled Steps' timeouts plus a fixed margin, so every Step can use its whole timeout and the Chain still reports its own outcome.
_Avoid_: Tool timeout, deadline

**Skipped Step**:
A paid Step that is not attempted because its API key is not configured.

**Chain Failure**:
The outcome when every Step in the Chain fails or is skipped; it reports each Step's reason.

**Attribution**:
The `<step>:` prefix, on the same line as the content, that names the Step that produced a successful result, for example `Scrape.do:# Title`; the names are `Http`, `Scrape.do`, `Scrapfly`, and `Firecrawl`.
