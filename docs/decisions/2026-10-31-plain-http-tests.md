# dex-tracker's tests stay on plain HTTP

Decided 2026-10-31, before the first full dex-tracker run. Applies to the dex-tracker
scenario; pokedex has no form submissions, so none of this affects it.

## The problem

`npm test` talks to the app directly over plain HTTP. The measurements put the app behind
Caddy, which handles HTTPS and sets `X-Forwarded-Proto` and `X-Forwarded-Host`, as
SPEC.md describes for production.

Several frameworks reject form submissions (POST with a form content type) whose `Origin`
header doesn't match the origin the server thinks it's serving. That origin includes the
protocol, and the frameworks disagree about how to work it out:

| Framework (version read) | How it works out its own protocol | Plain HTTP (tests) | Behind the HTTPS proxy (measurement) |
| --- | --- | --- | --- |
| SvelteKit 3.1.1, adapter-node 6.0.1 | Always `https` unless `PROTOCOL_HEADER` is set and the header is present (`get_origin` in adapter-node's `handler.js`). The check can't be turned off: `csrf.checkOrigin` was removed in SvelteKit 3 | Rejected | Works |
| Astro 7.4.4, @astrojs/node 11.1.9 | The connection's protocol; forwarded headers are ignored unless `security.allowedDomains` is configured | Works | Rejected |
| Qwik City 1.20.3 | `ORIGIN`, or `PROTOCOL_HEADER`, or the connection's protocol (node middleware) | Works | Rejected |
| TanStack Start (start-client-core 1.170) | Checks `Sec-Fetch-Site`, which the browser sets | Works | Works |
| Next.js 16.4 (Server Actions) | Compares host names only | Works | Works |

No default origin check was found in Nuxt, React Router, SolidStart, Angular or Hono. The
three Vite entries render in the browser and will most likely call the API directly.

The SvelteKit pilot (`runs/pilot-20261030-dex-tracker/`) lost most of its 83 minutes to
this. Its fix was a ~25-line `app/server.js` wrapper around adapter-node.

## Options considered

1. **Keep plain-HTTP tests (chosen).**
2. **Run `npm test` behind the same HTTPS proxy as the measurements**, and say so in
   SPEC.md. Tests and production would be one setup: SvelteKit would pay nothing, Astro
   and Qwik would need one documented setting, and a passing app would be known to work
   behind the proxy. It costs ~25 lines in `tests/run.mjs` and moves Caddy into the base
   image.
3. **Spec says "there are no logins, so turn off origin checks."** Doesn't work: SvelteKit 3
   removed that switch.
4. **Spec says production is HTTPS but tests are HTTP, plus a hidden "prod" test run behind
   Caddy in the measurement step.** More moving parts than option 2, for the same result.

## Why option 1

The benchmark measures the cost of building an app with a framework and what it costs its
users. Getting a framework to agree with its proxy about the protocol is a day-one setup
problem a team solves once, not something to measure. Every option makes some framework
deal with it; option 1 keeps the harness as it is and nothing agents see changes.

## Consequences

- SvelteKit agents will likely spend time and tokens on a workaround in every run. Expect
  this in SvelteKit's agent time and cost, and say so when reporting them. With the Svelte
  MCP server and docs, real runs may find the fix faster than the pilot did.
- An Astro or Qwik app that keeps its default origin check passes the tests but can't
  accept form submissions behind the proxy. The measurements only click links, so no
  measured number is affected, but such an app would be broken in a real deployment.
  Some agents may avoid it on their own: the Astro pilot turned the check off because the
  spec mentions the proxy.

## Revisit if

- SvelteKit's agent time or cost stands out in the full run and this is the cause (check
  the transcripts for 403s on form submissions).
- A future scenario's measurements submit forms.
- The frameworks' defaults change.
