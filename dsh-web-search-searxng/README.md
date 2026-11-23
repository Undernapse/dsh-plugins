# SearXNG web search

Searches the web through a [SearXNG](https://docs.searxng.org/) instance. The
plugin registers a search provider with the Harness web capability seam
(`ctx.web`), so the existing `web_search` tool routes its queries to SearXNG —
no separate model-facing tool, prompt, or workflow is added.

## What it does

- Registers the search provider id `searxng`.
- Pins `searchProvider: searxng` in the bundle patch, so `web_search` uses the
  instance without a manual settings change. The patch keeps the base
  composition's `fetchProvider: http` so `web_fetch` keeps working.
- Calls `GET <baseURL>/search?format=json&q=…` and maps SearXNG's JSON results
  to the seam's normalized sources: URL, title, excerpt, and publication date.
  SearXNG `answers` become the optional provider answer text.
- Cancels the HTTP request when the tool call is cancelled, and enforces its own
  `timeoutMs` deadline.
- Recovers a `web_fetch` call that the shipped HTTP provider stopped at a
  cross-origin redirect (for example `arxiv.org/api/...` → `export.arxiv.org`).
  The plugin resolves the redirect chain and fetches the final URL through the
  same web service, so decoding, limits, and presentation stay owned by the
  shipped provider.
- Shadows the `web_search` tool row in Chat with a source-aware status row:
  the collapsed line shows up to five site favicons plus how many distinct
  sites the search used, and the expanded body groups every source by site with
  its title, excerpt, and date. `web_fetch` keeps its shipped row.

The provider appears in **Plugins** › **Web search and fetch** as
**SearXNG**. Selecting another provider there overrides this bundle's pin for
the current profile.

## Search status row

The collapsed `web_search` row keeps the query summary and adds a compact site
strip: up to five site icons and a count of distinct sites. Expanding the row
shows the optional provider answer, the number of sites and sources, and each
site's pages with their titles, excerpts, and publication dates. A truncated
result says so, and a failed search shows its message in the error color.

The row registers into the keyed `tool.call.toolview` slot at priority `-1`.
The shipped `web-toolview` already owns the `web_search` key at priority `0`,
and a keyed slot allows one entry per key and priority with the lowest priority
rendering; registering at `0` fails with an "already has an entry" error and the
row never appears.

Icons load directly from each cited site (`https://<site>/favicon.ico`) with
`referrer-policy: no-referrer`; no third-party icon service is used. When a site
serves no favicon, or the browser refuses the request, a letter badge from the
site name remains. Because the request goes to the cited site, the site can see
that the icon was requested; the plugin never sends the search query or any
credential with it.

The row is a browser contribution loaded with the bundle. After installing or
updating the bundle, reload the DSH page so the new client module and its
dictionaries are loaded.

## Cross-origin fetch redirects

The shipped `http` fetch provider deliberately follows only same-origin
redirects, so a `web_fetch` against a URL that redirects to another host fails
with `WEB_REDIRECT_BLOCKED` and names only the target origin. This plugin
recovers that failed call: it follows the redirect chain with header-only
requests, then fetches the final URL through `ctx.web.fetch`. The recovered
result is rendered exactly like a normal fetch, including the external-content
notice and output caps.

The recovery runs only for a failed `web_fetch` whose code is
`WEB_REDIRECT_BLOCKED`; other failures keep their original error. It follows up
to five redirects and stops if the chain loops, leaves HTTP(S), or the tool call
is cancelled. The probe sends no credentials and uses the same product
`User-Agent` as the shipped provider. If the final fetch fails, the original
redirect error is returned unchanged.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `baseURL` | `https://searxng.in.undernapse.com` | Instance base URL; a path prefix and a trailing `/search` are both accepted. |
| `categories` | `general` | Comma-separated SearXNG categories. |
| `language` | `auto` | `auto`, `all`, or a language code. |
| `safesearch` | `0` | `0` off, `1` moderate, `2` strict. |
| `timeRange` | unset | `day`, `week`, `month`, or `year`. |
| `engines` | unset | Comma-separated engine names, or an array; the instance default when unset. |
| `timeoutMs` | `20000` | Per-search HTTP deadline in milliseconds. |
| `userAgent` | `dsh-web-search-searxng/0.1.0` | `User-Agent` sent to the instance. |

Example row:

```yaml
- id: web-search-searxng
  name: '@undernapse/dsh-web-search-searxng'
  config:
    baseURL: https://search.example.com
    categories: general,news
    timeRange: month
    engines: google,bing
```

Credentials embedded in `baseURL` (basic auth) are supported and redacted from
logs and diagnostics. The endpoint must be reachable from the process that runs
the Harness Host, not just from the browser. The instance must also expose the
JSON API: add `json` to `search.formats` in its `settings.yml` (a default
SearXNG installation serves HTML only, and the plugin reports the resulting
HTTP 403 with that hint).

The bundle patch also repeats `fetchProvider: http` because overriding the
`web` row replaces that row's whole config. A profile that uses a different
fetch provider should repeat its choice in a later `web` override; otherwise
`web_fetch` keeps using Direct fetch.

## Result shape and limitations

`web_search` accepts only queries and a result-count bound; it has no
recency/domain arguments. The provider therefore exposes recency and engines as
instance-level configuration (`timeRange`, `engines`) rather than per-call
arguments. The seam caps the number of returned sources; the plugin passes
SearXNG's list through and lets the seam truncate it.

Search quality, rate limits, and latency belong to the instance and the engines
it queries. An instance with every engine unresponsive returns an empty result
set plus a description of the failed engines in the provider error.

## Install

From the package directory:

```sh
dsh plugin --profile <profile> add file:/absolute/path/to/dsh-web-search-searxng
```

or install the directory as a bundle through the plugin manager
(`install_bundle` with the absolute package directory). The bundle patch pins
the provider and inserts one row, `web-search-searxng`.

To stop using SearXNG, select another provider in **Plugins** › **Web search
and fetch**, or disable the bundle; disabling the bundle also removes its
`web` pin.

## Test

```sh
node --test test/
```

The suite covers configuration validation, URL construction, response mapping,
and the HTTP client against a local mock instance; it does not require a running
SearXNG deployment.
