import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply } from '../index.js';

/**
 * Stand-in for the parts of the Client context the plugin touches: event
 * registration, effects, the live-agent registry, the logger, and a session
 * that records what the plugin appends.
 * @param {{failure?: object, downstream?: object, live?: boolean, appendError?: Error}} [options]
 *   the failure the waterfall reports, what a downstream listener decides,
 *   whether the agent stays live, and whether the log refuses an append.
 */
function createContext({ failure = { code: 'TIMEOUT', message: 'Request timed out.' }, downstream, live = true, appendError } = {}) {
	const listeners = new Map();
	const disposers = [];
	const logs = [];
	const appended = [];
	const agent = {
		id: 'session-1',
		session: {
			append(type, data) {
				if (appendError !== undefined) throw appendError;
				appended.push({ type, data });
			}
		}
	};
	const ctx = {
		dshPlugin: {},
		effect(run) {
			const dispose = run();
			if (typeof dispose === 'function') disposers.push(dispose);
			return dispose;
		},
		on(event, listener) {
			listeners.set(event, listener);
			return () => { listeners.delete(event); };
		},
		agents: {
			get(id) {
				return live && id === agent.id ? agent : undefined;
			}
		},
		logger: {
			info: message => { logs.push(['info', message]); },
			warn: message => { logs.push(['warn', message]); }
		}
	};
	return { ctx, agent, listeners, appended, logs, disposers };
}

/** The event payload the loop hands a waterfall listener. */
function payload(agent, overrides = {}) {
	return {
		agent,
		turn: 4,
		step: 2,
		provider: 'apisix',
		failure: { code: 'TIMEOUT', message: 'Request timed out.' },
		retryPolicy: undefined,
		signal: new AbortController().signal,
		...overrides
	};
}

/** Run the plugin's listener the way the loop does: `next()` is the downstream policy. */
async function fire(state, overrides = {}, next = async () => undefined) {
	const listener = state.listeners.get('agent/request-error');
	assert.ok(listener, 'the plugin registers an agent/request-error listener');
	return listener(payload(state.agent, overrides), next);
}

const FAST = { initialDelayMs: 0, maxDelayMs: 0, maxProviderDelayMs: 0 };

test('the plugin resumes a transient failure in the same turn', async () => {
	const state = createContext();
	apply(state.ctx, FAST);
	assert.deepEqual(await fire(state), { kind: 'retry' });
});

test('every transient code is resumed', async () => {
	for (const code of ['TIMEOUT', 'TRANSPORT', 'SERVER', 'RATE_LIMIT', 'STREAM_CLOSED', 'EMPTY_RESPONSE', 'MALFORMED_RESPONSE']) {
		const state = createContext();
		apply(state.ctx, FAST);
		assert.deepEqual(await fire(state, { failure: { code, message: code } }), { kind: 'retry' }, code);
	}
});

test('a permanent failure is left to the turn', async () => {
	for (const code of ['AUTH', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'QUOTA', 'ABORTED']) {
		const state = createContext();
		apply(state.ctx, FAST);
		assert.equal(await fire(state, { failure: { code, message: code } }), undefined, code);
	}
});

test('a downstream policy that already retries is not overridden', async () => {
	let called = 0;
	const state = createContext();
	apply(state.ctx, FAST);
	const decision = await fire(state, {}, async () => { called += 1; return { kind: 'retry' }; });
	assert.equal(called, 1, 'the downstream listener runs first');
	assert.deepEqual(decision, { kind: 'retry' });
	// The plugin did not spend its own budget or log an attempt.
	assert.deepEqual(state.appended, []);
});

test('right below the duck-typed context, next() resolves to an empty decision', async () => {
	// The loop passes an ordinary function as next(), which returns undefined.
	const state = createContext();
	apply(state.ctx, FAST);
	assert.deepEqual(await fire(state), { kind: 'retry' });
});

test('the resume is recorded before the wait, and nothing is model-visible', async () => {
	const state = createContext();
	apply(state.ctx, { ...FAST, initialDelayMs: 50, maxDelayMs: 50 });
	await fire(state);
	assert.equal(state.appended.length, 1);
	const [record] = state.appended;
	assert.equal(record.type, 'llm/retry', 'an existing durable event type, never a new one');
	assert.equal(record.data.turn, 4);
	assert.equal(record.data.step, 2);
	assert.equal(record.data.provider, 'apisix');
	assert.equal(record.data.policyKey, 'request-resume:resume');
	assert.equal(record.data.retry, 1);
	assert.equal(record.data.maxRetries, 3);
	assert.equal(record.data.delayMs, 50);
	assert.equal(record.data.failure.code, 'TIMEOUT');
	// Only log-only events: no user, assistant, or system message is appended.
	assert.deepEqual(state.appended.map(entry => entry.type), ['llm/retry']);
});

test('the step budget stops resuming and the failure is left as reported', async () => {
	const state = createContext();
	apply(state.ctx, { ...FAST, maxResumes: 2, maxResumesPerTurn: 10 });
	assert.deepEqual(await fire(state), { kind: 'retry' });
	assert.deepEqual(await fire(state), { kind: 'retry' });
	assert.equal(await fire(state), undefined);
	const refusal = state.logs.find(([level, message]) => level === 'info' && message.includes('not resumed'));
	assert.match(refusal[1], /no budget left: step budget \(2\)/);
});

test('a turn cancelled during the backoff sends no request', async () => {
	const state = createContext();
	apply(state.ctx, { ...FAST, initialDelayMs: 5000, maxDelayMs: 5000 });
	const controller = new AbortController();
	const started = Date.now();
	const decision = fire(state, { signal: controller.signal });
	// The attempt is recorded before the wait starts.
	await new Promise(resolve => { setTimeout(resolve, 10); });
	assert.equal(state.appended.length, 1);
	controller.abort();
	assert.equal(await decision, undefined);
	assert.ok(Date.now() - started < 1000, 'the wait ended with the cancellation, not the full backoff');
});

test('a failure that arrives after the turn was cancelled is ignored', async () => {
	const state = createContext();
	apply(state.ctx, FAST);
	const controller = new AbortController();
	assert.equal(await fire(state, { signal: controller.signal }, async () => {
		controller.abort();
		return undefined;
	}), undefined);
	assert.deepEqual(state.appended, []);
});

test('a turn cancelled before the listener runs sends no request', async () => {
	const state = createContext();
	apply(state.ctx, FAST);
	const controller = new AbortController();
	controller.abort();
	assert.equal(await fire(state, { signal: controller.signal }), undefined);
	assert.deepEqual(state.appended, []);
});

test('an agent disposed during the wait is not resumed', async () => {
	const state = createContext();
	apply(state.ctx, { ...FAST, initialDelayMs: 30, maxDelayMs: 30 });
	const decision = fire(state);
	setTimeout(() => { state.ctx.agents.get = () => undefined; }, 5);
	assert.equal(await decision, undefined);
});

test('disabling the plugin stops a wait already in progress', async () => {
	const state = createContext();
	apply(state.ctx, { ...FAST, initialDelayMs: 5000, maxDelayMs: 5000 });
	const decision = fire(state);
	for (const dispose of state.disposers) dispose();
	assert.equal(await decision, undefined);
	// A later failure is ignored too.
	assert.equal(await fire(state), undefined);
});

test('a log that refuses the record does not stop the resume', async () => {
	const state = createContext({ appendError: new Error('log closed') });
	apply(state.ctx, FAST);
	assert.deepEqual(await fire(state), { kind: 'retry' });
	assert.match(state.logs.find(([level]) => level === 'warn')[1], /could not record the resume attempt: log closed/);
});

test('a bad setting fails activation', () => {
	const state = createContext();
	assert.throws(() => apply(state.ctx, { maxResumes: -1 }), /"maxResumes"/);
});

test('the plugin declares the service it reads', async () => {
	const module = await import('../index.js');
	assert.equal(module.name, 'request-resume');
	assert.deepEqual(module.inject, ['agents']);
});
