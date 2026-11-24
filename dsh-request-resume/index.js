/**
 * Request resume — watch a model route and finish the turns that are stuck on it.
 *
 * A provider adapter retries a failed model request within a budget of its own
 * (five attempts inside about nine seconds by default). When that budget is
 * spent the failure is terminal: the turn ends with `This turn failed`, even
 * though a timeout or an outage usually clears later. Every conversation that
 * used the same provider and model is then stuck on the same cause.
 *
 * This plugin treats that as one problem per route, not one per conversation.
 * It records each failed turn under its `provider` and `model`, keeps a single
 * probe loop for that route, and — when a tiny probe request finally succeeds —
 * continues every conversation waiting on it. Fifty chats stuck on one dead
 * route cost one probe, and they all recover within the stagger.
 *
 * It resumes through the Session controller's own `prompt` with empty content,
 * which is exactly what the Continue button sends. That reuses the
 * controller's eligibility rule (a continuation is offered only for a
 * retryable failure of admitted human work) and its Agent resume path, so a
 * Session closed days ago comes back with its own preset rather than one this
 * plugin guessed.
 *
 * @module dsh-request-resume
 */

import { randomUUID } from 'node:crypto';
import {
	Pending,
	isHopeless,
	isResumable,
	probeDelay,
	resolveConfig,
	routeKey,
	watchLimit
} from './lib/watch.js';

/** Loader row name for diagnostics. */
export const name = 'request-resume';

/**
 * The services this plugin cannot work without: the route registry to probe,
 * the live-event feed to notice failures, and the Session controller whose
 * Continue path does the resuming.
 */
export const inject = ['llm', 'sessionController', 'sessions'];

/** Render a failure code for a log line. */
function codeOf(failure) {
	return typeof failure?.code === 'string' ? failure.code : 'UNKNOWN';
}

/** Render one thrown value for a log line. */
function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

/** The provider and model of a route, when both are named. */
function routeOf(config) {
	if (typeof config?.provider !== 'string' || typeof config?.model !== 'string') return undefined;
	return { provider: config.provider, model: config.model };
}

/**
 * Install the watcher.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} [config] - the row's config.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
	const policy = resolveConfig(config);
	const pending = new Pending();
	/** @type {Map<string, {provider: string, model: string, timer: ReturnType<typeof setTimeout> | undefined, probes: number, startedAt: number, controller: AbortController | undefined}>} */
	const runs = new Map();
	const lifetime = new AbortController();

	ctx.effect(() => () => {
		lifetime.abort();
		for (const run of runs.values()) {
			if (run.timer !== undefined) clearTimeout(run.timer);
			run.controller?.abort();
		}
		runs.clear();
	});

	/**
	 * Start watching one route, unless it is already being watched.
	 * @param {string} key - route key.
	 * @param {string} provider - provider route.
	 * @param {string} model - model id.
	 * @returns {void}
	 */
	function ensureRun(key, provider, model) {
		if (runs.has(key)) return;
		const run = { provider, model, timer: undefined, probes: 0, startedAt: Date.now(), controller: undefined };
		runs.set(key, run);
		schedule(key, run);
	}

	/**
	 * Arm the next probe of one route.
	 * @param {string} key - route key.
	 * @param {{timer: ReturnType<typeof setTimeout> | undefined, probes: number, startedAt: number, controller: AbortController | undefined}} run - the route's run.
	 * @returns {void}
	 */
	function schedule(key, run) {
		const reason = watchLimit(policy, run, Date.now());
		if (reason !== undefined) {
			giveUp(key, reason);
			return;
		}
		const delay = probeDelay(policy, run.probes + 1);
		run.timer = setTimeout(() => {
			run.timer = undefined;
			void probe(key, run);
		}, delay);
		// Never hold the process open just to keep watching a dead route.
		run.timer.unref?.();
	}

	/**
	 * Stop watching one route and leave its conversations to the user.
	 * @param {string} key - route key.
	 * @param {string} reason - why watching stopped.
	 * @returns {void}
	 */
	function giveUp(key, reason) {
		const run = runs.get(key);
		const provider = run?.provider ?? key;
		const model = run?.model ?? '';
		// Drain the group as well: a route that is given up on must re-arm from
		// scratch if a later failure lands on it, so the group cannot go stale.
		const waiting = pending.drain(key).length;
		runs.delete(key);
		ctx.logger.info(
			`request-resume: stopped watching ${provider}/${model} after ${reason}; `
			+ `${waiting} conversation(s) keep their failed turn`
		);
	}

	/**
	 * Send one tiny request to see whether the route answers again.
	 * @param {string} key - route key.
	 * @param {{provider: string, model: string, probes: number, startedAt: number, controller: AbortController | undefined}} run - the route's run.
	 * @returns {Promise<void>} when this probe settled and the next step was armed.
	 */
	async function probe(key, run) {
		if (lifetime.signal.aborted) return;
		const waiting = pending.size(key);
		if (waiting === 0) {
			runs.delete(key);
			return;
		}
		const { provider, model } = run;
		run.probes += 1;
		run.controller = new AbortController();
		const signal = AbortSignal.any([
			lifetime.signal,
			run.controller.signal,
			AbortSignal.timeout(policy.probeTimeoutMs)
		]);
		let failure;
		try {
			const stream = ctx.llm.stream({
				provider,
				model,
				messages: [{ role: 'user', content: [{ type: 'text', text: policy.probeText }] }],
				maxTokens: policy.probeMaxTokens,
				signal
			});
			for await (const chunk of stream) {
				if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
					failure = chunk.reason.failure;
				}
			}
		} catch (error) {
			// A thrown probe is unavailable too; a permanent code still stops watching.
			failure = { code: 'TRANSPORT', message: describe(error) };
		}
		// Disposal or a cancelled wait ends the run without another probe.
		if (lifetime.signal.aborted || !runs.has(key)) return;

		if (failure === undefined) {
			ctx.logger.info(`request-resume: ${provider}/${model} answered again; continuing ${waiting} conversation(s)`);
			runs.delete(key);
			await continueAll(key);
			return;
		}
		if (isHopeless(policy, failure)) {
			giveUp(key, `${codeOf(failure)} cannot be fixed by retrying`);
			return;
		}
		ctx.logger.info(
			`request-resume: ${provider}/${model} still unavailable (${codeOf(failure)}); `
			+ `${waiting} conversation(s) waiting, probe ${run.probes}`
		);
		schedule(key, run);
	}

	/**
	 * Send Continue to every conversation waiting on one route, one at a time.
	 *
	 * The stagger keeps a recovered route from receiving the whole backlog in
	 * one burst, which is what a rate limit would punish.
	 * @param {string} key - route key.
	 * @returns {Promise<void>} when the group settled.
	 */
	async function continueAll(key) {
		const waiting = pending.drain(key);
		for (const [index, entry] of waiting.entries()) {
			if (lifetime.signal.aborted) break;
			if (index > 0 && policy.resumeIntervalMs > 0) {
				await new Promise((resolve) => {
					const timer = setTimeout(resolve, policy.resumeIntervalMs);
					timer.unref?.();
				});
			}
			await continueOne(entry);
		}
	}

	/**
	 * Ask the Session controller to continue one conversation.
	 *
	 * An empty prompt is the Continue the interface would send; the controller
	 * refuses it unless the Session is still idle on that exact failure, which
	 * is the check that keeps a manual retry from being continued twice.
	 * @param {{sessionId: string, provider: string, model: string, failureSeq: number}} entry - the waiting conversation.
	 * @returns {Promise<void>} when this continuation settled.
	 */
	async function continueOne(entry) {
		try {
			await ctx.sessionController.prompt({
				sessionId: entry.sessionId,
				requestId: randomUUID(),
				mode: 'queue',
				content: []
			}, lifetime.signal);
			ctx.logger.info(
				`request-resume: continued ${entry.sessionId} on ${entry.provider}/${entry.model} `
				+ `after its failed turn ${entry.failureSeq}`
			);
		} catch (error) {
			// No longer idle on that failure, no longer continuable, or the
			// Session went away: nothing to repair, so the entry stays dropped.
			ctx.logger.info(
				`request-resume: did not continue ${entry.sessionId}: ${describe(error)}`
			);
		}
	}

	ctx.on('session/event', (session, event) => {
		if (event.type !== 'turn/end') return;
		const reason = event.data.reason;
		const failure = reason.kind === 'error' ? reason.error : undefined;
		// Any other ending supersedes an earlier failure: the conversation moved
		// on, so continuing it would replay work the user already restarted.
		if (failure === undefined || !isResumable(policy, failure)) {
			pending.drop(session.id);
			return;
		}
		const route = routeOf(session.requestHeader()?.config);
		if (route === undefined) return;
		const { key, isNewRoute } = pending.record({
			sessionId: session.id,
			provider: route.provider,
			model: route.model,
			failureSeq: event.seq,
			since: Date.now()
		});
		ctx.logger.info(
			`request-resume: ${session.id} failed on ${route.provider}/${route.model} (${codeOf(failure)}); `
			+ `${pending.size(key)} waiting on that route`
		);
		if (isNewRoute) ensureRun(key, route.provider, route.model);
	});

	/**
	 * Find conversations that failed before this process started.
	 *
	 * Only the last turn of a Session matters, and only a recent one: an old
	 * failure is either already continued or no longer wanted. The query
	 * service is optional, so a profile without it simply sweeps nothing.
	 * @returns {Promise<void>} when the sweep settled.
	 */
	async function sweep(query) {
		const cutoff = Date.now() - policy.sweepDays * 86400000;
		let seen = 0;
		for (const record of await query.listSessions(lifetime.signal)) {
			if (lifetime.signal.aborted) return;
			// A subagent child is not a conversation the user can continue.
			if (record.header.origin === 'subagent') continue;
			if (seen >= policy.sweepMaxSessions) break;
			seen += 1;
			const failed = await lastFailure(query, record.header.id, cutoff);
			if (failed === undefined) continue;
			const { key, isNewRoute } = pending.record({ ...failed, sessionId: record.header.id, since: Date.now() });
			ctx.logger.info(
				`request-resume: ${record.header.id} was left failed on ${failed.provider}/${failed.model} `
				+ `(${failed.code}); ${pending.size(key)} waiting on that route`
			);
			if (isNewRoute) ensureRun(key, failed.provider, failed.model);
		}
	}

	/**
	 * Read a Session's last turn ending and the route it used.
	 * @param {import('@deepseek-ai/dsh-session-query').SessionQuery} query - query service.
	 * @param {string} sessionId - the Session.
	 * @param {number} cutoff - oldest acceptable failure time.
	 * @returns {Promise<{provider: string, model: string, failureSeq: number, code: string} | undefined>} the failure facts.
	 */
	async function lastFailure(query, sessionId, cutoff) {
		try {
			const endings = await query.filterEvents(sessionId, [{ kind: 'type', values: ['turn/end'] }]);
			const ending = endings.at(-1);
			if (ending === undefined || ending.time < cutoff) return undefined;
			const turn = await query.readEvent({ sessionId, seq: ending.seq });
			const reason = turn.target.data?.reason;
			if (reason?.kind !== 'error' || !isResumable(policy, reason.error)) return undefined;
			const headers = await query.filterEvents(sessionId, [{ kind: 'type', values: ['request/header'] }]);
			const header = headers.at(-1);
			if (header === undefined) return undefined;
			const request = await query.readEvent({ sessionId, seq: header.seq });
			const route = routeOf(request.target.data?.header?.config);
			if (route === undefined) return undefined;
			return { ...route, failureSeq: ending.seq, code: codeOf(reason.error) };
		} catch (error) {
			// A Session that moved to a newer format, or a torn log, is skipped:
			// one unreadable log must not stop the sweep.
			ctx.logger.warn(`request-resume: could not inspect ${sessionId}: ${describe(error)}`);
			return undefined;
		}
	}

	// The query service is optional: this callback simply never runs in a
	// profile without a query backend, and the live watcher still works.
	if (policy.sweepOnStart) {
		ctx.inject(['sessionQuery'], (scoped) => {
			void sweep(scoped.sessionQuery).catch((error) => {
				ctx.logger.warn(`request-resume: startup sweep failed: ${describe(error)}`);
			});
		});
	}
}
