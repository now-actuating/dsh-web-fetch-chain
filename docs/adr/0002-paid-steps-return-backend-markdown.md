# Paid Steps return backend-converted Markdown

The scrape.do, Scrapfly, and Firecrawl Steps request Markdown from the backend and return it as a `text` body, instead of returning HTML for the DSH `web_fetch` tool's built-in turndown conversion.
DSH cuts HTML sources at 200k characters before converting them, which drops the end of large pages, and keeps relative image URLs; backend Markdown is bounded only after conversion.

## Consequences

- Each paid Step's output shape follows its backend's converter, so results differ slightly from the Http Step, which still uses the DSH converter.
- A `text` body is passed to the model verbatim, so the plugin must not return raw HTML under the `text` kind.
