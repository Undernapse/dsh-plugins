# Request resume

A turn that loses its model request to a timeout usually does not have a
problem worth ending. It has a request that arrived too late, or a provider
that asked to be called again in a moment. DeepSeek Harness retries such a
request a bounded number of times per provider route (five attempts within
about nine seconds by default), and when that budget is spent the turn ends
with `This turn failed: Request timed out.` You then press Continue, or type
something, to get the work moving again.

This plugin does that for you. When a model request fails with a transient
error and the route's own retries are spent, it waits a moment and re-sends the
request — in the same turn, over the same conversation, with nothing new for
the model to read. The turn pauses, then carries on.

## Using it

There is nothing to configure to start. Once installed, a turn whose request
fails with `TIMEOUT`, `TRANSPORT`, `SERVER`, `RATE_LIMIT`, `STREAM_CLOSED`,
`EMPTY_RESPONSE`, or `MALFORMED_RESPONSE` is resumed instead of ending, up to
the budgets below. Each resume is logged (`request-resume: TIMEOUT on apisix
(turn 4, step 2); retrying in 4000 ms …`), so you can tell a resumed turn from
a hung one.

The pause is visible and the turn is still yours: pressing Stop during the
wait cancels the turn, and the interface shows the failure that happened rather
than pretending it did not.

## What it does and does not do

- **Same turn, same step.** A resume re-runs the failed step through the
  driver's own retry path, so the retried request is part of the session log
  exactly like the original. No user message is added and no message text
  changes.
- **Never ahead of the provider's own policy.** The plugin acts only when the
  adapter's `retryPolicy` has declined the failure — because its budget is
  spent or the code is outside its policy. Raise the adapter's own limits in
  the provider row if you want more retries inside it; this plugin covers what
  lies beyond.
- **Transient failures only.** Permanent failures are never resumed, because
  another request cannot fix them: bad credentials (`AUTH`,
  `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`), refused requests
  (`INVALID_REQUEST`, `CONTENT_REFUSED`), an exhausted plan (`QUOTA`,
  `ACCOUNT_QUOTA`), a context window that will not fit (`CONTEXT_WINDOW_EXCEEDED`),
  and an unavailable model (`MODEL_UNSUPPORTED`, `UNKNOWN_MODEL`). This holds
  even if you list such a code in `resumeCodes`.
- **Bounded.** A step and a turn each have a resume budget and a time window,
  so a provider that is simply down cannot keep one turn running forever. When
  a budget runs out the failure stands, exactly as it would without the plugin.
- **Not a crash recovery.** It resumes failed requests in a turn that is still
  open. A turn cut short by a crash or by closing the application is not
  resumed on the next start.

## Configuration

Every setting lives in the plugin row, and the defaults in
`cordis.patch.yml` are the defaults here. A profile patch that names the
`request-resume` row replaces the whole `config` map, so restate the keys you
need when you override one.

| Setting | Default | Meaning |
| --- | --- | --- |
| `resumeCodes` | `TIMEOUT`, `TRANSPORT`, `SERVER`, `RATE_LIMIT`, `STREAM_CLOSED`, `EMPTY_RESPONSE`, `MALFORMED_RESPONSE` | Failure codes worth another request. Must be non-empty. |
| `maxResumes` | `3` | Resumes one step may spend. |
| `initialDelayMs` | `2000` | Wait before the first resume of a step. |
| `maxDelayMs` | `60000` | Cap on that wait; each later resume doubles it up to here. |
| `maxProviderDelayMs` | `300000` | A longer provider `Retry-After` is ignored in favor of a capped local wait. |
| `maxStepDurationMs` | `600000` | A step failing longer than this is not resumed. `0` disables the window. |
| `maxResumesPerTurn` | `6` | Resumes one turn may spend across all of its steps. |
| `maxTurnDurationMs` | `1800000` | A turn failing longer than this is not resumed. `0` disables the window. |

For example, to wait longer and allow fewer attempts:

```yaml
- id: request-resume
  name: '@undernapse/dsh-request-resume'
  config:
    initialDelayMs: 5000
    maxDelayMs: 120000
    maxResumes: 2
```

A provider `Retry-After` within `maxProviderDelayMs` wins over the local
backoff, because the provider knows when it will serve a request again.

## Where it hooks in

The plugin listens on `agent/request-error`, the waterfall the agent loop
raises for every failed model request in an open step, and the same extension
point `@deepseek-ai/dsh-llm-retry` uses. It calls the rest of the chain first
and only acts when nobody else retried. After the backoff it answers
`{ kind: 'retry' }`, which makes the driver re-run the failed step inside the
open turn; the failure never becomes `turn/end`.

Each scheduled resume is recorded before its wait, as an `llm/retry` event —
the durable record the built-in retry already writes. Using the existing event
type rather than a new one keeps the session readable by every current reader
and keeps a resumed request replayable. If the record cannot be written, the
resume still happens and the failure is logged.

The plugin needs the `agents` service. It keeps no state that outlives the
turn: the event log holds the record of every resume.

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

`test/policy.test.mjs` covers the configuration, eligibility, backoff, budgets,
and the cancellable wait. `test/plugin.test.mjs` runs the shipped `apply`
against a stand-in context: it checks that transient codes resume in the same
turn, that permanent codes and a downstream retry are left alone, that the
attempt is recorded as `llm/retry` with nothing model-visible appended, that
budgets stop resuming, and that cancellation, disposal, plugin unload, and a
failing log are all handled.
