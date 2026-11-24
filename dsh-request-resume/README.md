# Request resume

A turn that loses its model request to a timeout does not have a problem worth
ending. The usual cause is a provider that is briefly unavailable, and the usual
outcome is that every conversation using that provider and model stops at the
same moment — you come back to several chats all reading `This turn failed`.

This plugin watches the cause rather than the symptoms. It groups failed turns
by their `provider` and `model`, keeps one availability probe per route, and
when that route answers again it presses Continue on every conversation waiting
on it. Fifty chats stuck on one dead route cost one probe and recover together.

## How it works

1. **Notice.** A turn ending with a retryable failure (`TIMEOUT`, `TRANSPORT`,
   `SERVER`, `RATE_LIMIT`, `STREAM_CLOSED`, `EMPTY_RESPONSE`) is recorded under
   its route, read from the Session's own request header. Nothing is retried in
   the failed turn; it ends with its error, as it would without the plugin.
2. **Probe once per route.** The route gets one probe loop, no matter how many
   conversations are waiting. A probe is a one-token request to that exact
   provider and model, so it proves the route works rather than guessing from
   metadata. The first waits `initialProbeDelayMs`, then the wait doubles up to
   `maxProbeDelayMs`.
3. **Continue everything waiting.** When a probe succeeds, every conversation
   on that route receives Continue — the Session controller's own `prompt` with
   empty content, exactly what the button sends. That reuses the controller's
   eligibility rule and its Agent resume path, so a chat closed days ago comes
   back with its own preset.

Conversations are spaced by `resumeIntervalMs` after a recovery, so a backlog
does not arrive at the provider as one burst.

## What counts as stuck

The plugin watches exactly the failures the Harness itself offers Continue for.
Permanent failures are never watched, because a probe cannot fix them: bad
credentials, refused requests, an exhausted plan, a context window that will not
fit, an unavailable model. A probe that fails with one of those stops the watch
immediately instead of waiting out the budget.

A conversation leaves the list as soon as anything else happens to it: a
completed turn, a cancellation, or your own Continue. The controller would
refuse a second continuation anyway; this keeps the plugin from collecting stale
entries. When a route's budget runs out — `maxProbes` or `maxProbeWaitMs` — the
watch stops and its conversations keep their failed turn, exactly as without the
plugin.

## Earlier runs

At startup the plugin looks for conversations that were left failed by an
earlier run: the last turn of each Session within `sweepDays`, up to
`sweepMaxSessions` sessions, skipping subagent children. A route that is healthy
again is continued immediately; a route that is still down joins the normal
probe loop. Set `sweepOnStart: false` to watch only failures that happen while
the application is running.

The sweep needs a Session query backend (`ctx.sessionQuery`, mounted by
`@deepseek-ai/dsh-session-query-sqlite`) and simply does nothing without one.

## Configuration

Every setting lives in the plugin row, and the defaults in `cordis.patch.yml`
are the defaults here. A profile patch that names the `request-resume` row
replaces the whole `config` map, so restate the keys you need.

| Setting | Default | Meaning |
| --- | --- | --- |
| `resumeCodes` | `TIMEOUT`, `TRANSPORT`, `SERVER`, `RATE_LIMIT`, `STREAM_CLOSED`, `EMPTY_RESPONSE` | Failures that leave a conversation worth continuing. |
| `initialProbeDelayMs` | `5000` | Wait before a route's first probe. |
| `maxProbeDelayMs` | `300000` | Cap on that wait; each later probe doubles it up to here. |
| `maxProbeWaitMs` | `7200000` | Stop watching a route after this long. `0` disables the window. |
| `maxProbes` | `60` | Stop watching a route after this many probes. |
| `probeTimeoutMs` | `30000` | Deadline for one probe request. |
| `probeText` | `ping` | Text of the probe request. |
| `probeMaxTokens` | `1` | Output-token ceiling of the probe. |
| `resumeIntervalMs` | `1000` | Spacing between Continues after a recovery. |
| `sweepOnStart` | `true` | Look for conversations left failed by an earlier run. |
| `sweepDays` | `3` | How old such a failure may be. |
| `sweepMaxSessions` | `200` | Most Session logs the sweep reads. |

A longer outage recovery, with a tighter request cap:

```yaml
- id: request-resume
  name: '@undernapse/dsh-request-resume'
  config:
    initialProbeDelayMs: 10000
    maxProbeDelayMs: 600000
    maxProbeWaitMs: 21600000
    maxProbes: 40
```

## Where it hooks in

- `session/event` for `turn/end`, on the Host, so every live Session is covered
  whether or not its chat is open.
- `ctx.llm.stream()` for the probe: a provider-neutral one-shot request that
  never reaches a Session log and never becomes a message.
- `ctx.sessionController.prompt()` for the Continue, the same call the interface
  makes, so eligibility and Agent resume stay owned by that controller.

The plugin declares `llm`, `sessionController`, and `sessions` as required
services, so it stays inactive in a profile that has no Session controller
rather than failing on first use.

## Install

From this directory:

```sh
dsh plugin --profile <profile> add file:"$PWD"
```

or install the directory as a bundle through the plugin manager
(`install_bundle` with the absolute package path). The bundle patch inserts the
row `request-resume`; nothing else in the profile needs to change.

## Test

```sh
node --test test/
```

`test/watch.test.mjs` covers configuration, the failure set, the probe schedule
and limits, and the grouping ledger. `test/plugin.test.mjs` runs the shipped
`apply` against a stand-in Host: it checks that one route with three stuck chats
costs a single probe and continues all three, that routes recover
independently, that a failing probe backs off, that a hopeless probe or an
exhausted budget stops the watch, that a later completed turn drops a
conversation, that a refused Continue does not stop the rest, and that the
startup sweep handles old, completed, permanent, unreadable, and subagent
Sessions correctly.
