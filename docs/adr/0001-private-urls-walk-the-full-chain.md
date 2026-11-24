# Private URLs walk the full Chain

Every URL, including localhost, private IP ranges, and intranet hosts, walks the full Chain, so a Step Failure on the Http Step can forward the URL to scrape.do, Scrapfly, and Firecrawl.
We chose one uniform rule over a private-URL guard that would stop such URLs after the Http Step.

## Consequences

- Internal hostnames, paths, and query strings can reach third-party services and their logs.
- Paid backends cannot reach private networks, so these forwards usually end in a Step Failure that costs credits and time.
