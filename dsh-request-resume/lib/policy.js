/**
 * Resume policy for a failed model request.
 *
 * The plugin's decisions are pure functions of a configuration record, a
 * failure, and the attempts already made, so the whole policy is testable
 * without a running Harness. `index.js` owns the side effects: reading the
 * failure from the `agent/request-error` waterfall, waiting on a timer, and
 * returning `{ kind: 'retry' }`.
 *
 * @module dsh-request-resume/policy
 */

/** Failure codes that another request can plausibly fix. */
export const DEFAULT_RESUME_CODES = Object.freeze([
	'TIMEOUT',
	'TRANSPORT',
	'SERVER',
	'RATE_LIMIT',
	'STREAM_CLOSED',
	'EMPTY_RESPONSE',
	'MALFORMED_RESPONSE'
]);

/** Failure codes that no number of attempts can fix, so they are never resumed. */
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
	'NO_ADAPTER',
	'NO_CREDENTIAL_STORE',
	'MODEL_UNSUPPORTED',
	'UNKNOWN_MODEL'
]);

/** Defaults, shared with the comments in `cordis.patch.yml`. */
export const DEFAULTS = Object.freeze({
	resumeCodes: DEFAULT_RESUME_CODES,
	maxResumes: 3,
	initialDelayMs: 2000,
	maxDelayMs: 60000,
	maxProviderDelayMs: 300000,
	maxStepDurationMs: 600000,
	maxResumesPerTurn: 6,
	maxTurnDurationMs: 1800000
});

/** Whether a value is a non-negative safe integer. */
function isCount(value) {
	return Number.isSafeInteger(value) && value >= 0;
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
 * omitted key must mean "default", never "disabled". Validation runs once at
 * activation and reports a bad value instead of silently changing behaviour.
 * @param {Record<string, unknown>} [config] - the row's config.
 * @returns {Readonly<typeof DEFAULTS>} the effective policy.
 * @throws {TypeError} when a setting has the wrong type or range.
 */
export function resolveConfig(config = {}) {
	if (typeof config !== 'object' || config === null || Array.isArray(config)) {
		throw new TypeError('request-resume: config must be a mapping');
	}
	const merged = { ...DEFAULTS, ...config };
	const initialDelayMs = count(merged.initialDelayMs, 'initialDelayMs');
	const maxDelayMs = count(merged.maxDelayMs, 'maxDelayMs');
	const maxProviderDelayMs = count(merged.maxProviderDelayMs, 'maxProviderDelayMs');
	if (maxDelayMs < initialDelayMs) {
		throw new TypeError('request-resume: "maxDelayMs" must be at least "initialDelayMs"');
	}
	return Object.freeze({
		resumeCodes: Object.freeze(codes(merged.resumeCodes, 'resumeCodes')),
		maxResumes: count(merged.maxResumes, 'maxResumes'),
		initialDelayMs,
		maxDelayMs,
		maxProviderDelayMs,
		maxStepDurationMs: count(merged.maxStepDurationMs, 'maxStepDurationMs'),
		maxResumesPerTurn: count(merged.maxResumesPerTurn, 'maxResumesPerTurn'),
		maxTurnDurationMs: count(merged.maxTurnDurationMs, 'maxTurnDurationMs')
	});
}

/**
 * Decide whether one failure may be resumed.
 * @param {Readonly<typeof DEFAULTS>} policy - resolved configuration.
 * @param {{code?: unknown}} [failure] - the failure facts from `agent/request-error`.
 * @returns {boolean} whether the code is eligible.
 */
export function isResumable(policy, failure) {
	const code = failure?.code;
	if (typeof code !== 'string') return false;
	return policy.resumeCodes.includes(code) && !PERMANENT_CODES.includes(code);
}

/**
 * Bounded exponential backoff for the n-th resume of a step.
 *
 * The first resume waits `initialDelayMs`; each later one doubles, up to
 * `maxDelayMs`. A provider `Retry-After` within `maxProviderDelayMs` wins over
 * the local backoff because the provider knows when it will serve a request
 * again; a longer one falls back to a capped local wait so a single
 * instruction cannot stall the turn.
 * @param {Readonly<typeof DEFAULTS>} policy - resolved configuration.
 * @param {number} attempt - 1 for the first resume of the step.
 * @param {number} [providerRetryAfterMs] - the provider's own delay, when stated.
 * @returns {number} milliseconds to wait before the resumed request.
 */
export function resumeDelay(policy, attempt, providerRetryAfterMs) {
	const exponent = Math.max(0, attempt - 1);
	const local = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** Math.min(exponent, 30));
	if (Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs > 0) {
		if (providerRetryAfterMs <= policy.maxProviderDelayMs) return providerRetryAfterMs;
		return Math.max(local, Math.min(policy.maxProviderDelayMs, policy.maxDelayMs));
	}
	return local;
}

/**
 * Track the resumes spent on one step and on the turn that contains it.
 *
 * A step's own budget is what the user configured; the turn's is the ceiling
 * across all of its steps, so a turn that keeps failing in later steps cannot
 * run forever. Time windows live here too: a step or turn already failing for
 * longer than its window is not worth another request.
 */
export class ResumeLedger {
	/** @param {Readonly<typeof DEFAULTS>} policy - resolved configuration. */
	constructor(policy) {
		this.policy = policy;
		/** @type {Map<number, {attempts: number, firstAt: number}>} - per-turn state, keyed by turn number. */
		this.turns = new Map();
	}

	/**
	 * Read, or start, the state of one step inside one turn.
	 * @param {number} turn - turn number from the event.
	 * @param {number} step - step number from the event.
	 * @param {number} now - current time in epoch milliseconds.
	 * @returns {{turn: {attempts: number, firstAt: number}, step: {attempts: number, firstAt: number}}} state.
	 */
	slot(turn, step, now) {
		// Turns run forwards; dropping older keys keeps the map at one entry.
		for (const key of this.turns.keys()) {
			if (key !== turn) this.turns.delete(key);
		}
		let state = this.turns.get(turn);
		if (state === undefined) {
			state = { attempts: 0, firstAt: now, step: undefined };
			this.turns.set(turn, state);
		}
		if (state.step?.number !== step) state.step = { number: step, attempts: 0, firstAt: now };
		return { turn: state, step: state.step };
	}

	/**
	 * Reserve the next resume of one step, or explain why none is left.
	 * @param {number} turn - turn number.
	 * @param {number} step - step number.
	 * @param {number} now - current time in epoch milliseconds.
	 * @returns {{kind: 'resume', attempt: number, turnAttempt: number} | {kind: 'exhausted', reason: string}} the decision.
	 */
	next(turn, step, now) {
		const { turn: turnState, step: stepState } = this.slot(turn, step, now);
		const policy = this.policy;
		if (stepState.attempts >= policy.maxResumes) {
			return { kind: 'exhausted', reason: `step budget (${policy.maxResumes})` };
		}
		if (turnState.attempts >= policy.maxResumesPerTurn) {
			return { kind: 'exhausted', reason: `turn budget (${policy.maxResumesPerTurn})` };
		}
		if (policy.maxStepDurationMs > 0 && now - stepState.firstAt >= policy.maxStepDurationMs) {
			return { kind: 'exhausted', reason: `step window (${policy.maxStepDurationMs} ms)` };
		}
		if (policy.maxTurnDurationMs > 0 && now - turnState.firstAt >= policy.maxTurnDurationMs) {
			return { kind: 'exhausted', reason: `turn window (${policy.maxTurnDurationMs} ms)` };
		}
		stepState.attempts += 1;
		turnState.attempts += 1;
		return { kind: 'resume', attempt: stepState.attempts, turnAttempt: turnState.attempts };
	}

	/**
	 * Forget one turn, for example when its agent is disposed.
	 * @param {number} turn - turn number.
	 * @returns {void}
	 */
	release(turn) {
		this.turns.delete(turn);
	}

	/**
	 * Forget every turn, when the plugin unloads.
	 * @returns {void}
	 */
	clear() {
		this.turns.clear();
	}
}

/**
 * Wait for a delay, ending early when the turn is aborted or the plugin unloads.
 *
 * A settling wait reports whether the time really elapsed, so the caller never
 * resumes a request after the turn was cancelled.
 * @param {number} ms - the delay.
 * @param {AbortSignal[]} signals - turn cancellation and plugin lifetime.
 * @returns {Promise<boolean>} false when a signal aborted first.
 */
export function wait(ms, signals) {
	const active = signals.filter(signal => signal !== undefined);
	const aborted = () => active.find(signal => signal.aborted);
	if (aborted() !== undefined) return Promise.resolve(false);
	if (ms <= 0) return Promise.resolve(true);
	return new Promise((resolve) => {
		const settle = (elapsed) => {
			clearTimeout(timer);
			for (const signal of active) signal.removeEventListener('abort', onAbort);
			resolve(elapsed);
		};
		const onAbort = () => { settle(false); };
		const timer = setTimeout(() => { settle(true); }, ms);
		for (const signal of active) signal.addEventListener('abort', onAbort, { once: true });
	});
}
