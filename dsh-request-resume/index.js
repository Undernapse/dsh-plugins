/**
 * Request resume — finish a turn whose model request failed.
 *
 * A provider adapter retries a failed model request within a budget of its own
 * (`retryPolicy` on the adapter row, for example five attempts over nine
 * seconds). When that budget is spent the failure is terminal and the turn
 * ends with `This turn failed`, even though a timeout or a rate limit often
 * clears a moment later. The user then has to press Continue or type
 * something to get the work moving again.
 *
 * This plugin takes over at the same extension point the built-in retry uses,
 * `agent/request-error`. That waterfall runs on every failed model request in
 * an open step, and a listener that answers `{ kind: 'retry' }` makes the
 * driver re-run the same step inside the same turn over the same durable
 * history — no new user message, nothing added to what the model sees. The
 * plugin waits out a backoff first, so the turn visibly pauses and then
 * continues instead of dying.
 *
 * It sits downstream of the built-in retry because it only acts when that
 * retry declines, which it does exactly when its budget is spent or the code
 * is not in its policy. So the built-in retry stays the first line of defence,
 * and this plugin covers the gap after it: the failure the provider budget has
 * already retried to exhaustion, and the transient failure the budget never
 * covered (`STREAM_CLOSED` and `MALFORMED_RESPONSE` are absent from the
 * default policy of `@deepseek-ai/dsh-llm-retry`).
 *
 * Every resume is recorded before its wait, as the built-in retry does, so a
 * crash during the wait leaves a durable trace (see `LLM_RETRY_EVENT`).
 * Cancellation ends the wait without sending a request, and budgets bound the
 * work a single turn can spend.
 *
 * @module dsh-request-resume
 */

import { ResumeLedger, isResumable, resumeDelay, resolveConfig, wait } from './lib/policy.js';

/** Loader row name for diagnostics. */
export const name = 'request-resume';

/**
 * The live-agent registry, read to confirm the agent survived the backoff
 * before a request is re-sent. Declared so the plugin stays inactive in a
 * profile without an agent loop instead of failing on first use.
 */
export const inject = ['agents'];

/**
 * The retry event the durable history already understands.
 *
 * Appending a plugin-owned event type would make the session unreadable to
 * anything that does not know it, and `Session.append()` cannot set the
 * `ignorable` marker that would allow that. `llm/retry` is exactly this fact —
 * a failed attempt, a reason, and a scheduled delay — and every reader already
 * skips it, so a resumed request replays like any other retry.
 */
const LLM_RETRY_EVENT = 'llm/retry';

/** Policy key recorded on the event; it names this plugin, not a provider budget. */
const POLICY_KEY = 'request-resume:resume';

/** Render one thrown value for a log line. */
function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

/** Render a failure code for a log line. */
function codeOf(failure) {
	return typeof failure?.code === 'string' ? failure.code : 'UNKNOWN';
}

/**
 * Install the resume listener.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} [config] - the row's config.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
	// Report a bad setting at activation, where the profile shows it, rather
	// than turning a typo into silently different retry behaviour later.
	const policy = resolveConfig(config);
	const ledger = new ResumeLedger(policy);
	const lifetime = new AbortController();

	ctx.effect(() => () => {
		lifetime.abort();
		ledger.clear();
	});

	ctx.on('agent/request-error', async ({ agent, turn, step, provider, failure, signal }, next) => {
		// Always let a downstream policy decide first. Resuming instead would
		// bypass recovery the composition already installed, such as
		// compaction for an oversized request.
		const decision = await next();
		if (decision?.kind === 'retry') return decision;
		if (lifetime.signal.aborted || signal.aborted) return undefined;
		if (!isResumable(policy, failure)) return undefined;

		const reserved = ledger.next(turn, step, Date.now());
		if (reserved.kind === 'exhausted') {
			ctx.logger.info(
				`request-resume: ${codeOf(failure)} on ${provider} (turn ${turn}, step ${step}) not resumed; `
				+ `no budget left: ${reserved.reason}`
			);
			return undefined;
		}

		const delayMs = resumeDelay(policy, reserved.attempt, failure?.providerRetryAfterMs);
		// Durable before the wait, so the log shows why the turn went quiet.
		// The append is best effort: a log that refuses it must not stop the
		// turn from ending in the reported failure.
		try {
			agent.session.append(LLM_RETRY_EVENT, {
				retryId: `request-resume-${turn}-${step}-${reserved.attempt}`,
				turn,
				step,
				provider,
				mode: 'normal',
				policyKey: POLICY_KEY,
				retry: reserved.attempt,
				maxRetries: policy.maxResumes,
				delayMs,
				failure: {
					message: typeof failure?.message === 'string' ? failure.message : codeOf(failure),
					code: codeOf(failure)
				}
			});
		} catch (error) {
			ctx.logger.warn(`request-resume: could not record the resume attempt: ${describe(error)}`);
		}

		ctx.logger.info(
			`request-resume: ${codeOf(failure)} on ${provider} (turn ${turn}, step ${step}); `
			+ `retrying in ${delayMs} ms (attempt ${reserved.attempt} in this step, `
			+ `${policy.maxResumesPerTurn - reserved.turnAttempt} left in this turn)`
		);

		if (!await wait(delayMs, [signal, lifetime.signal])) return undefined;
		// Re-check after the wait: the turn may have been cancelled, and the
		// agent disposed, while the timer ran.
		if (lifetime.signal.aborted || signal.aborted) return undefined;
		if (ctx.agents.get(agent.id) !== agent) return undefined;

		return { kind: 'retry' };
	});
}
