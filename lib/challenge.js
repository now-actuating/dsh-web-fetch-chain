/**
 * Challenge page detection, applied to every Step result: a 200 response can still be a bot
 * challenge (Cloudflare "Just a moment...", "Attention Required", and similar).
 * @module dsh-web-fetch-chain/challenge
 */

/** Page titles that only challenge or block pages use. */
const TITLE_MARKERS = [
  /^just a moment\.{0,3}$/i,
  /^attention required!?( \| cloudflare)?$/i,
  /^checking your browser/i,
  /^ddos-guard$/i,
]

/** Body fragments that only challenge pages contain. */
const BODY_MARKERS = [
  [/cf-chl-|cf_chl_opt|\/cdn-cgi\/challenge-platform\//i, 'cf-chl'],
  [/checking (if the site connection is secure|your browser before accessing)/i, 'Checking your browser'],
  [/enable javascript and cookies to continue/i, 'Enable JavaScript and cookies'],
  [/attention required! \| cloudflare/i, 'Attention Required'],
]

/**
 * @param {{ body: { kind: string, content: string }, title?: string }} result - a Step result;
 *   `title` is the backend-reported page title when the body has none.
 * @returns {string | undefined} the matched marker, or undefined for an ordinary page.
 */
export function detectChallenge(result) {
  const content = result.body.content
  for (const title of candidateTitles(result)) {
    const normalized = title.replace(/\s+/g, ' ').trim()
    if (TITLE_MARKERS.some(marker => marker.test(normalized))) return normalized
  }
  for (const [marker, name] of BODY_MARKERS) {
    if (marker.test(content)) return name
  }
  return undefined
}

/** The HTML `<title>`, a backend-reported title, and a Markdown body's first line. */
function candidateTitles(result) {
  const titles = []
  if (typeof result.title === 'string') titles.push(result.title)
  const content = result.body.content
  const html = /<title[^>]*>([^<]*)<\/title>/i.exec(content)
  if (html) titles.push(decodeEntities(html[1]))
  if (result.body.kind === 'text') {
    const firstLine = content.split('\n').find(line => line.trim() !== '')
    if (firstLine !== undefined) titles.push(firstLine.replace(/^#+\s*/, ''))
  }
  return titles
}

function decodeEntities(text) {
  return text.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&hellip;/g, '...')
}
