/**
 * Watch policy for model availability.
 *
 * A failed turn is not retried in place. It is recorded here, grouped by the
 * provider and model route it used, and the group is watched: one probe loop
 * per route, and one Continue per waiting conversation when that probe
 * succeeds. Grouping is the point — fifty chats stuck on the same route cost
 * one probe, not fifty.
 *
 * Everything in this module is a pure function or plain data, so the schedule,
 * the budgets, and the grouping are testable without a Harness or a timer.
 * `index.js` owns the effects: the probe request, the timers, and the resume.
 *
 * @module dsh-request-resume/watch
 */

/**
 * Failure codes a conversation can be continued from.
 *
 * These are exactly the codes the Harness itself offers Continue for
 * (`CONTINUABLE_FAILURES` in the session controller's continuation rule). A
 * wider list would only produce resumes that the continuation check rejects,
 * so the plugin keeps the same set and inherits the same promise: the model
 * owed an answer and the request failed before it produced one.
 */
export const RESUME_CODES = Object.freeze([
	'TIMEOUT',
	'TRANSPORT',
	'SERVER',
	'RATE_LIMIT',
	'STREAM_CLOSED',
	'EMPTY_RESPONSE'
]);

/** Failure codes no number of probes can fix, so watching stops at once. */
export const PERMANENT_CODES = Object.freeze([
	'AUTH',
	'ACCOUNT_QUOTA',
	'ACCOUNT_SIGN_IN_REQUIRED',
	'ACCOUNT_TOKEN_INVALID',
	'CLIENT_UPGRADE_REQUIRED',
	'CONTEXT_WINDOW_EXCEEDED',
	'CONTENT_REFUSED',
	'INVALID_CREDENTIAL',
	'INVALID_REQUEST',
	'MISSING_CREDENTIAL',
	'MODEL_UNSUPPORTED',
	'NO_ADAPTER',
	'NO_CREDENTIAL_STORE',
	'UNKNOWN_MODEL'
]);

/** Defaults, shared with the comments in `cordis.patch.yml`. */
export const DEFAULTS = Object.freeze({
	resumeCodes: RESUME_CODES,
	initialProbeDelayMs: 5000,
	maxProbeDelayMs: 300000,
	maxProbeWaitMs: 7200000,
	maxProbes: 60,
	probeTimeoutMs: 30000,
	probeText: 'ping',
	probeMaxTokens: 1,
	resumeIntervalMs: 1000,
	maxResumesPerSession: 2,
	sessionResumeWindowMs: 3600000,
	sweepOnStart: true,
	diagnosticsFile: '',
	sweepDays: 3,
	sweepMaxSessions: 200,
	sweepMaxMs: 15000
});

/** Whether a value is a non-negative safe integer. */
function isCount(value) {
	return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reject a value that must be a positive safe integer.
 * @param {unknown} value - supplied setting.
 * @param {string} name - setting name for the message.
 * @returns {number} the value.
 * @throws {TypeError} when the value is not a positive safe integer.
 */
function positive(value, name) {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`request-resume: "${name}" must be a positive integer, got ${String(value)}`);
	}
	return value;
}

/**
 * Reject a non-count where the policy needs one.
 * @param {unknown} value - supplied setting.
 * @param {string} name - setting name for the message.
 * @returns {number} the value.
 * @throws {TypeError} when the value is not a non-negative safe integer.
 */
function count(value, name) {
	if (!isCount(value)) throw new TypeError(`request-resume: "${name}" must be a non-negative integer, got ${String(value)}`);
	return value;
}

/**
 * Validate a code list: nonempty strings without duplicates.
 * @param {unknown} value - supplied setting.
 * @param {string} name - setting name for the message.
 * @returns {string[]} the codes.
 * @throws {TypeError} when the list is malformed.
 */
function codes(value, name) {
	if (!Array.isArray(value) || value.length === 0 || value.some(code => typeof code !== 'string' || code === '')) {
		throw new TypeError(`request-resume: "${name}" must be a non-empty array of failure codes`);
	}
	if (new Set(value).size !== value.length) throw new TypeError(`request-resume: "${name}" lists a code twice`);
	return [...value];
}

/**
 * Normalize the plugin configuration, filling every omitted setting.
 *
 * A profile patch that names this row replaces the whole `config` map, so an
 * omitted key must mean "default", never "disabled".
 * @param {Record<string, unknown>} [config] - the row's config.
 * @returns {Readonly<typeof DEFAULTS>} the effective policy.
 * @throws {TypeError} when a setting has the wrong type or range.
 */
export function resolveConfig(config = {}) {
	if (typeof config !== 'object' || config === null || Array.isArray(config)) {
		throw new TypeError('request-resume: config must be a mapping');
	}
	const merged = { ...DEFAULTS, ...config };
	const initialProbeDelayMs = count(merged.initialProbeDelayMs, 'initialProbeDelayMs');
	const maxProbeDelayMs = count(merged.maxProbeDelayMs, 'maxProbeDelayMs');
	if (maxProbeDelayMs < initialProbeDelayMs) {
		throw new TypeError('request-resume: "maxProbeDelayMs" must be at least "initialProbeDelayMs"');
	}
	if (typeof merged.probeText !== 'string' || merged.probeText.trim() === '') {
		throw new TypeError('request-resume: "probeText" must be a non-empty string');
	}
	if (typeof merged.sweepOnStart !== 'boolean') {
		throw new TypeError('request-resume: "sweepOnStart" must be a boolean');
	}
	if (typeof merged.diagnosticsFile !== 'string') {
		throw new TypeError('request-resume: "diagnosticsFile" must be a string path');
	}
	return Object.freeze({
		resumeCodes: Object.freeze(codes(merged.resumeCodes, 'resumeCodes')),
		initialProbeDelayMs,
		maxProbeDelayMs,
		maxProbeWaitMs: count(merged.maxProbeWaitMs, 'maxProbeWaitMs'),
		maxProbes: count(merged.maxProbes, 'maxProbes'),
		probeTimeoutMs: positive(merged.probeTimeoutMs, 'probeTimeoutMs'),
		probeText: merged.probeText,
		probeMaxTokens: count(merged.probeMaxTokens, 'probeMaxTokens'),
		resumeIntervalMs: count(merged.resumeIntervalMs, 'resumeIntervalMs'),
		maxResumesPerSession: count(merged.maxResumesPerSession, 'maxResumesPerSession'),
		sessionResumeWindowMs: count(merged.sessionResumeWindowMs, 'sessionResumeWindowMs'),
		sweepOnStart: merged.sweepOnStart,
		diagnosticsFile: merged.diagnosticsFile,
		sweepDays: count(merged.sweepDays, 'sweepDays'),
		sweepMaxSessions: count(merged.sweepMaxSessions, 'sweepMaxSessions'),
		sweepMaxMs: count(merged.sweepMaxMs, 'sweepMaxMs')
	});
}

/**
 * Decide whether a failure belongs to a conversation worth continuing.
 * @param {Readonly<typeof DEFAULTS>} policy - resolved configuration.
 * @param {{code?: unknown}} [failure] - the failure facts from the turn or a probe.
 * @returns {boolean} whether the code is resumable.
 */
export function isResumable(policy, failure) {
	const code = failure?.code;
	if (typeof code !== 'string') return false;
	return policy.resumeCodes.includes(code) && !PERMANENT_CODES.includes(code);
}

/**
 * Whether a probe failure means watching should stop rather than wait.
 * @param {Readonly<typeof DEFAULTS>} policy - resolved configuration.
 * @param {{code?: unknown}} [failure] - the probe's failure facts.
 * @returns {boolean} whether no later probe can succeed.
 */
export function isHopeless(policy, failure) {
	const code = failure?.code;
	if (typeof code !== 'string') return false;
	return PERMANENT_CODES.includes(code) || !policy.resumeCodes.includes(code);
}

/**
 * The stable identity of one watched route.
 *
 * The pair is encoded rather than joined with a separator, so no provider or
 * model id can collide with another pair's key.
 * @param {string} provider - provider route.
 * @param {string} model - model id.
 * @returns {string} the group key.
 */
export function routeKey(provider, model) {
	return JSON.stringify([provider, model]);
}

/**
 * Wait before probe number `attempt` of one route.
 *
 * The first probe waits `initialProbeDelayMs`; each later one doubles, up to
 * `maxProbeDelayMs`. A route that recovers quickly is picked up quickly, and a
 * long outage costs at most one request per `maxProbeDelayMs`.
 * @param {Readonly<typeof DEFAULTS>} policy - resolved configuration.
 * @param {number} attempt - 1 for the first probe of a route.
 * @returns {number} milliseconds to wait before the probe.
 */
export function probeDelay(policy, attempt) {
	const exponent = Math.max(0, attempt - 1);
	return Math.min(policy.maxProbeDelayMs, policy.initialProbeDelayMs * 2 ** Math.min(exponent, 30));
}

/**
 * Whether one route has been watched for long enough to give up.
 * @param {Readonly<typeof DEFAULTS>} policy - resolved configuration.
 * @param {{probes: number, startedAt: number}} run - the route's probe run.
 * @param {number} now - current time in epoch milliseconds.
 * @returns {string | undefined} why watching stopped, or undefined to continue.
 */
export function watchLimit(policy, run, now) {
	if (run.probes >= policy.maxProbes) return `${policy.maxProbes} probes`;
	if (policy.maxProbeWaitMs > 0 && now - run.startedAt >= policy.maxProbeWaitMs) {
		return `${policy.maxProbeWaitMs} ms`;
	}
	return undefined;
}

/**
 * How often each conversation has already been continued.
 *
 * Route budgets are per run, so a route that recovers and immediately fails
 * again would otherwise continue the same conversation forever. This ledger
 * caps that: a conversation is continued `maxResumesPerSession` times inside
 * `sessionResumeWindowMs`, and a completed turn clears its history so a later,
 * unrelated outage is still covered.
 */
export class Continues {
	/** @param {Readonly<typeof DEFAULTS>} policy - resolved configuration. */
	constructor(policy) {
		this.policy = policy;
		/** @type {Map<string, {count: number, firstAt: number}>} */
		this.#state = new Map();
	}

	/** @type {Map<string, {count: number, firstAt: number}>} */
	#state;

	/**
	 * Whether one conversation may be continued again.
	 * @param {string} sessionId - the conversation.
	 * @param {number} now - current time in epoch milliseconds.
	 * @returns {{allowed: boolean, used: number}} the decision and how many were used.
	 */
	allow(sessionId, now) {
		const entry = this.#state.get(sessionId);
		if (entry === undefined) return { allowed: true, used: 0 };
		if (this.policy.sessionResumeWindowMs > 0 && now - entry.firstAt >= this.policy.sessionResumeWindowMs) {
			this.#state.delete(sessionId);
			return { allowed: true, used: 0 };
		}
		return { allowed: entry.count < this.policy.maxResumesPerSession, used: entry.count };
	}

	/**
	 * Record one continue spent on a conversation.
	 * @param {string} sessionId - the conversation.
	 * @param {number} now - current time in epoch milliseconds.
	 * @returns {void}
	 */
	spend(sessionId, now) {
		const entry = this.#state.get(sessionId);
		if (entry === undefined) {
			this.#state.set(sessionId, { count: 1, firstAt: now });
			return;
		}
		entry.count += 1;
	}

	/**
	 * Forget a conversation, because it finished a turn of its own.
	 * @param {string} sessionId - the conversation.
	 * @returns {void}
	 */
	reset(sessionId) {
		this.#state.delete(sessionId);
	}

	/**
	 * Forget every conversation, when the plugin unloads.
	 * @returns {void}
	 */
	clear() {
		this.#state.clear();
	}
}

/**
 * The conversations waiting on their routes.
 *
 * One entry per conversation, indexed by route so a whole group can be drained
 * at once. Recording a conversation twice keeps its newest failure, because the
 * newest failure is the one whose continuation is still eligible.
 */
export class Pending {
	/** @type {Map<string, {provider: string, model: string, failureSeq: number, since: number}>} */
	#bySession = new Map();
	/** @type {Map<string, Set<string>>} route key to session ids. */
	#byRoute = new Map();

	/**
	 * Record one failed conversation, replacing any earlier failure of its own.
	 * @param {{sessionId: string, provider: string, model: string, failureSeq: number, since: number}} entry - the failure.
	 * @returns {{key: string, isNewRoute: boolean}} the route and whether it had no waiter before.
	 */
	record(entry) {
		const key = routeKey(entry.provider, entry.model);
		const previous = this.#bySession.get(entry.sessionId);
		if (previous !== undefined) this.#dropFromRoute(routeKey(previous.provider, previous.model), entry.sessionId);
		this.#bySession.set(entry.sessionId, {
			provider: entry.provider,
			model: entry.model,
			failureSeq: entry.failureSeq,
			since: entry.since
		});
		let sessions = this.#byRoute.get(key);
		const isNewRoute = sessions === undefined || sessions.size === 0;
		if (sessions === undefined) {
			sessions = new Set();
			this.#byRoute.set(key, sessions);
		}
		sessions.add(entry.sessionId);
		return { key, isNewRoute };
	}

	/**
	 * Forget one conversation, for example because a later turn superseded it.
	 * @param {string} sessionId - the conversation.
	 * @returns {boolean} whether it was waiting.
	 */
	drop(sessionId) {
		const entry = this.#bySession.get(sessionId);
		if (entry === undefined) return false;
		this.#bySession.delete(sessionId);
		this.#dropFromRoute(routeKey(entry.provider, entry.model), sessionId);
		return true;
	}

	/**
	 * Read the failure recorded for one conversation.
	 * @param {string} sessionId - the conversation.
	 * @returns {{provider: string, model: string, failureSeq: number, since: number} | undefined} the entry.
	 */
	get(sessionId) {
		return this.#bySession.get(sessionId);
	}

	/**
	 * Take every conversation waiting on one route, removing them.
	 * @param {string} key - route key.
	 * @returns {{sessionId: string, provider: string, model: string, failureSeq: number}[]} the drained entries.
	 */
	drain(key) {
		const sessions = this.#byRoute.get(key);
		if (sessions === undefined) return [];
		const drained = [];
		for (const sessionId of sessions) {
			const entry = this.#bySession.get(sessionId);
			if (entry !== undefined) drained.push({ sessionId, ...entry });
			this.#bySession.delete(sessionId);
		}
		this.#byRoute.delete(key);
		return drained;
	}

	/**
	 * How many conversations are waiting on one route.
	 * @param {string} key - route key.
	 * @returns {number} the count.
	 */
	size(key) {
		return this.#byRoute.get(key)?.size ?? 0;
	}

	/**
	 * Every route with at least one waiter.
	 * @returns {string[]} the route keys.
	 */
	keys() {
		return [...this.#byRoute.keys()];
	}

	/**
	 * How many conversations are waiting in total.
	 * @returns {number} the count.
	 */
	get total() {
		return this.#bySession.size;
	}

	/**
	 * Drop one session id from its route's index.
	 * @param {string} key - route key.
	 * @param {string} sessionId - the conversation.
	 * @returns {void}
	 */
	#dropFromRoute(key, sessionId) {
		const sessions = this.#byRoute.get(key);
		if (sessions === undefined) return;
		sessions.delete(sessionId);
		if (sessions.size === 0) this.#byRoute.delete(key);
	}
}
