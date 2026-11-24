# Raise the web_fetch limit by shadowing it per agent

The Chain needs more than `web_fetch`'s 30-second default for paid Steps that render JavaScript or bypass bot protection. The `tool-web` row that sets that limit sits inside each agent preset's `config.plugins`, which profile patches cannot target. So for every agent created while the plugin runs, the plugin copies the `web_fetch` definition that agent sees, sets only `timeoutMs` to the Chain Budget, and registers the copy in the agent's own scope, which shadows the preset's.

## Considered Options

- **Override the preset declarations.** This works, but it freezes the shipped presets against DSH updates.
- **Enable the top-level `tool-web` row with a longer limit.** The global registration is shadowed by each preset's own, so preset agents keep 30 seconds, and presets without web tools would gain them.
- **Mutate the shared definition in a `tools/execute` hook**, as `dsh-web-fetch-moli` does. This changes an object that every agent of the preset shares, and the change only ever goes up until the plugin unloads.
- **Replace the host `timeout-policy`.** The plugin would then own the time limits of every tool.
- **Stay within 30 seconds.** This was rejected: Scrapfly alone needs at least 30 seconds of server time with `asp` or `render_js`.

## Consequences

- The copy must repeat `tool-web`'s admission condition (`ctx.web.fetchReady(...)`), because a definition lookup does not return it. If `tool-web` changes that condition, the copy drifts.
- The limit is raised whichever fetch provider is selected, because the selection is not observable. `raiseWebFetchTimeout` turns it off.
- Only conversations started after the plugin loads are affected. Preset switches re-copy through `tools/change`.
- Re-check after DSH updates. The approach relies on scope shadowing and on the timeout policy reading the agent's view, which no document guarantees for this use.
