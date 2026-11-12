# Image budget

Keeps every model request within the image limit its provider route states.
When a conversation accumulates more images than the route allows, the oldest
images are durably replaced by a reference — the attachment name, its id, and
the read-only normalized path — instead of being sent again. The model can
re-open that path with `read_image` when it still needs the picture, so nothing
is lost; the bytes simply stop occupying the request.

This prevents turn failures such as:

```
At most 25 image(s) may be provided in one prompt. (parameter=image)
```

## Where the limit comes from

The provider is the source of truth. For one route, the plugin resolves the
limit in this order and uses the **smallest known** value:

1. `providerLimits[<route>]` — an explicit override in this plugin's config.
2. The adapter's own configuration: `maxRequestImages` on a `dsh-llm-pi-ai`
   provider, or `maxImagesPerRequest` on `dsh-llm-deepseek`.
3. A limit the provider stated in an earlier failure (`At most N image(s)`),
   remembered for the rest of the process.
4. `maxImages` — an optional fallback, used only when the route never states a
   limit. It is unset by default.

So declare the real limit on the provider row and the plugin follows it:

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-route:
        maxRequestImages: 25
```

## What it does

- **Proactive trim.** Before every model request (`agent/pre-step`), the plugin
  counts retained images on the model-visible surface plus the images the new
  step is about to append. Beyond the resolved limit, it appends one durable
  `image/offload` event selecting exactly the oldest occurrences that no longer
  fit. Later requests carry the placeholder text the LLM layer already renders
  for an offloaded image.
- **Provider-limit recovery.** If a provider still rejects a request and names
  a limit, the plugin records the same decision, remembers the limit, and
  retries instead of failing the turn. This also covers compaction summaries
  and an adapter's own `IMAGE_OFFLOAD_REQUIRED` request.
- **Replay safe.** The decision is an ordinary session event projected by
  `image/offload`, so fork, resume, and replay derive the same request.

The plugin uses the shipped `@deepseek-ai/dsh-compaction-image-offload`
projection when it is mounted and registers an equivalent fallback projection
when it is not, so sessions that contain the decision still replay.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `providerLimits` | `{}` | Per-route image limits, for providers whose configuration states none. |
| `maxImages` | unset | Last-resort cap for routes that never state a limit. |
| `recoveryMargin` | `1` | On a stated limit `N`, retry with `N - recoveryMargin` images. |
| `proactive` | `true` | Trim before each request. |
| `recoverFromProviderErrors` | `true` | Offload and retry when a provider names an image limit. |

## Install

From the package directory:

```sh
dsh plugin --profile <profile> add file:/absolute/path/to/dsh-image-budget
```

or install the directory as a bundle through the plugin manager
(`install_bundle` with the absolute package directory). The bundle patch
inserts one row, `image-budget`.

## Test

```sh
node --test test/
```
