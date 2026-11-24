import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply } from '../index.js';

/** Wait until a predicate holds, so timers settle without fixed sleeps. */
async function until(predicate, label = 'condition', timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise(resolve => { setTimeout(resolve, 5); });
	}
	throw new Error(`timed out waiting for ${label}`);
}

/** One outcome of a probe: a successful stream ending in `stop`, or a failure code. */
function streamOf(outcome) {
	return {
		async *[Symbol.asyncIterator]() {
			if (outcome === 'ok') {
				yield { type: 'finish', reason: { kind: 'stop' } };
				return;
			}
			yield { type: 'finish', reason: { kind: 'error', failure: { code: outcome, message: outcome } } };
		}
	};
}

/**
 * Stand-in for the Client context: the event feed, the model route, the
 * Session controller, effects, optional injection, and the logger.
 * @param {{probe?: (call: number) => string, prompt?: (request: object) => void, sessions?: object[]}} [options]
 *   what each probe returns, what the controller does, and what the sweep lists.
 */
function createContext({ probe, prompt, sessions = [] } = {}) {
	const listeners = new Map();
	const logs = [];
	const probes = [];
	const prompts = [];
	const disposers = [];
	const injected = new Map();
	let calls = 0;
	const ctx = {
		effect(run) {
			const dispose = run();
			if (typeof dispose === 'function') disposers.push(dispose);
			return dispose;
		},
		on(event, listener) {
			listeners.set(event, listener);
			return () => { listeners.delete(event); };
		},
		inject(deps, callback) {
			injected.set(deps.join(','), callback);
		},
		logger: {
			info: message => { logs.push(message); },
			warn: message => { logs.push(message); }
		},
		llm: {
			stream(options) {
				probes.push(options);
				const outcome = probe === undefined ? 'ok' : probe(calls);
				calls += 1;
				return streamOf(outcome);
			}
		},
		sessionController: {
			async prompt(request) {
				prompts.push(request);
				if (prompt !== undefined) return prompt(request);
				return { accepted: true };
			}
		},
		sweepSessions: sessions
	};
	return { ctx, listeners, logs, probes, prompts, disposers, injected };
}

/** Report one turn ending exactly as the Session feed does. */
function turnEnd(state, { sessionId = 's1', provider = 'apisix', model = 'auto', code, seq = 10 }) {
	const session = { id: sessionId, requestHeader: () => ({ config: { provider, model } }) };
	const reason = code === undefined ? { kind: 'completed' } : { kind: 'error', error: { code, message: code } };
	state.listeners.get('session/event')(session, { type: 'turn/end', seq, data: { turn: 1, reason } });
}

const FAST = {
	initialProbeDelayMs: 0,
	maxProbeDelayMs: 1,
	resumeIntervalMs: 0,
	probeTimeoutMs: 1000,
	sweepOnStart: false
};

test('the plugin declares the services it needs', async () => {
	const module = await import('../index.js');
	assert.equal(module.name, 'request-resume');
	assert.deepEqual(module.inject, ['llm', 'sessionController', 'sessions']);
});

test('one failed turn is watched and continued once its route answers', async () => {
	const state = createContext();
	apply(state.ctx, FAST);
	turnEnd(state, { code: 'SERVER' });
	await until(() => state.prompts.length === 1, 'the continuation');
	assert.equal(state.probes.length, 1);
	assert.deepEqual(state.prompts[0].content, [], 'Continue sends an empty prompt');
	assert.equal(state.prompts[0].mode, 'queue');
	assert.equal(state.prompts[0].sessionId, 's1');
	assert.equal(typeof state.prompts[0].requestId, 'string');
	assert.match(state.logs.join('\n'), /answered again; continuing 1 conversation/);
});

test('the probe asks the exact provider and model with one token', async () => {
	const state = createContext();
	apply(state.ctx, FAST);
	turnEnd(state, { provider: 'vllm-local', model: 'deepseek-v4.1-flash-1017', code: 'TIMEOUT' });
	await until(() => state.probes.length === 1, 'the probe');
	assert.equal(state.probes[0].provider, 'vllm-local');
	assert.equal(state.probes[0].model, 'deepseek-v4.1-flash-1017');
	assert.equal(state.probes[0].maxTokens, 1);
	assert.equal(state.probes[0].messages.length, 1);
	assert.equal(state.probes[0].signal instanceof AbortSignal, true);
});

test('many conversations on one route share a single probe', async () => {
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	const state = createContext({
		probe: () => 'ok'
	});
	// Hold the first probe open so the second failure lands while it is running.
	const originalStream = state.ctx.llm.stream;
	state.ctx.llm.stream = (options) => {
		state.probes.push(options);
		return {
			async *[Symbol.asyncIterator]() {
				await gate;
				yield { type: 'finish', reason: { kind: 'stop' } };
			}
		};
	};
	apply(state.ctx, FAST);
	turnEnd(state, { sessionId: 'a', code: 'SERVER' });
	turnEnd(state, { sessionId: 'b', code: 'TIMEOUT' });
	turnEnd(state, { sessionId: 'c', code: 'TRANSPORT' });
	await until(() => state.probes.length === 1, 'the single probe');
	release();
	await until(() => state.prompts.length === 3, 'all three continuations');
	assert.equal(state.probes.length, 1, 'three stuck chats cost one probe');
	assert.deepEqual(state.prompts.map(entry => entry.sessionId).sort(), ['a', 'b', 'c']);
	assert.equal(state.ctx.llm.stream, state.ctx.llm.stream);
	assert.ok(originalStream);
});

test('different routes are probed and continued independently', async () => {
	const state = createContext({ probe: call => (call === 0 ? 'SERVER' : 'ok') });
	apply(state.ctx, FAST);
	turnEnd(state, { sessionId: 'a', provider: 'p1', model: 'm1', code: 'SERVER' });
	turnEnd(state, { sessionId: 'b', provider: 'p2', model: 'm2', code: 'SERVER' });
	await until(() => state.prompts.some(entry => entry.sessionId === 'b'), 'the healthy route continues');
	// The route still down retries and follows once it recovers.
	await until(() => state.prompts.some(entry => entry.sessionId === 'a'), 'the recovered route continues');
	assert.deepEqual(state.prompts.map(entry => entry.sessionId).sort(), ['a', 'b']);
	assert.ok(state.probes.length >= 2);
});

test('a probe that keeps failing backs off and tries again', async () => {
	const state = createContext({ probe: call => (call < 2 ? 'TIMEOUT' : 'ok') });
	apply(state.ctx, FAST);
	turnEnd(state, { code: 'SERVER' });
	await until(() => state.prompts.length === 1, 'the continuation after two failed probes');
	assert.equal(state.probes.length, 3);
	assert.match(state.logs.join('\n'), /still unavailable \(TIMEOUT\)/);
});

test('a probe failure that retrying cannot fix stops the watch at once', async () => {
	const state = createContext({ probe: () => 'AUTH' });
	apply(state.ctx, FAST);
	turnEnd(state, { code: 'SERVER' });
	await until(() => state.logs.some(line => line.includes('stopped watching')), 'the give-up');
	assert.equal(state.probes.length, 1);
	assert.deepEqual(state.prompts, []);
	assert.match(state.logs.join('\n'), /AUTH cannot be fixed by retrying/);
});

test('watching stops at the probe limit and leaves the failed turn alone', async () => {
	const state = createContext({ probe: () => 'SERVER' });
	apply(state.ctx, { ...FAST, maxProbes: 2 });
	turnEnd(state, { code: 'SERVER' });
	await until(() => state.logs.some(line => line.includes('stopped watching')), 'the limit');
	assert.equal(state.probes.length, 2);
	assert.deepEqual(state.prompts, []);
	assert.match(state.logs.join('\n'), /after 2 probes; 1 conversation\(s\) keep their failed turn/);
});

test('a later completed turn supersedes the failure', async () => {
	const state = createContext();
	apply(state.ctx, { ...FAST, initialProbeDelayMs: 50, maxProbeDelayMs: 50 });
	turnEnd(state, { code: 'SERVER' });
	// The user retried by hand and it worked.
	turnEnd(state, { code: undefined });
	await new Promise(resolve => { setTimeout(resolve, 120); });
	assert.deepEqual(state.prompts, []);
	// The route stopped being watched because nothing was waiting on it.
	assert.equal(state.probes.length, 0);
});

test('permanent failures are never watched', async () => {
	for (const code of ['AUTH', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'MALFORMED_RESPONSE']) {
		const state = createContext();
		apply(state.ctx, FAST);
		turnEnd(state, { code });
		await new Promise(resolve => { setTimeout(resolve, 30); });
		assert.equal(state.probes.length, 0, code);
		assert.deepEqual(state.prompts, [], code);
	}
});

test('a controller that refuses the continuation is reported and the rest still run', async () => {
	const state = createContext({
		prompt: (request) => {
			if (request.sessionId === 'a') throw new Error('generation continuation is unavailable');
			return { accepted: true };
		}
	});
	apply(state.ctx, FAST);
	turnEnd(state, { sessionId: 'a', code: 'SERVER' });
	turnEnd(state, { sessionId: 'b', code: 'SERVER' });
	await until(() => state.prompts.length === 2, 'both attempts');
	assert.match(state.logs.join('\n'), /did not continue a: generation continuation is unavailable/);
	assert.match(state.logs.join('\n'), /continued b on apisix\/auto/);
});

test('a thrown probe is treated as unavailable and can recover', async () => {
	let call = 0;
	const state = createContext();
	state.ctx.llm.stream = () => {
		call += 1;
		if (call === 1) {
			return {
				async *[Symbol.asyncIterator]() {
					throw new Error('connection reset');
				}
			};
		}
		return streamOf('ok');
	};
	apply(state.ctx, FAST);
	turnEnd(state, { code: 'TRANSPORT' });
	await until(() => state.prompts.length === 1, 'the continuation');
	assert.equal(call, 2);
});

test('unloading stops the timers and drops a probe in flight', async () => {
	const state = createContext();
	let aborted;
	state.ctx.llm.stream = (options) => {
		state.probes.push(options);
		options.signal.addEventListener('abort', () => { aborted = true; });
		return {
			async *[Symbol.asyncIterator]() {
				await new Promise(resolve => { setTimeout(resolve, 1000); });
				yield { type: 'finish', reason: { kind: 'stop' } };
			}
		};
	};
	apply(state.ctx, { ...FAST, probeTimeoutMs: 5000 });
	turnEnd(state, { code: 'SERVER' });
	await until(() => state.probes.length === 1, 'the probe in flight');
	for (const dispose of state.disposers) dispose();
	await until(() => aborted === true, 'the probe was cancelled');
	assert.deepEqual(state.prompts, []);
});

test('the startup sweep continues a conversation left failed by an earlier run', async () => {
	const state = createContext();
	apply(state.ctx, { ...FAST, sweepOnStart: true });
	const sweep = state.injected.get('sessionQuery');
	assert.ok(sweep, 'the sweep waits for the optional query service');
	const query = {
		async listSessions() {
			return [
				{ header: { id: 'old', createdAt: 1 } },
				{ header: { id: 'child', createdAt: 1, origin: 'subagent' } }
			];
		},
		async filterEvents(sessionId, filters) {
			const type = filters[0].values[0];
			if (sessionId === 'child') throw new Error('should not be read');
			return type === 'turn/end' ? [{ seq: 12, time: Date.now() }] : [{ seq: 3, time: Date.now() }];
		},
		async readEvent({ seq }) {
			return seq === 12
				? { target: { data: { reason: { kind: 'error', error: { code: 'SERVER', message: 'down' } } } } }
				: { target: { data: { header: { config: { provider: 'apisix', model: 'auto' } } } } };
		}
	};
	sweep({ sessionQuery: query });
	await until(() => state.prompts.length === 1, 'the swept continuation');
	assert.equal(state.prompts[0].sessionId, 'old');
	assert.equal(state.probes.length, 1);
});

test('the sweep ignores old failures, completed turns, and permanent codes', async () => {
	const cases = [
		{ time: Date.now() - 10 * 86400000, reason: { kind: 'error', error: { code: 'SERVER' } } },
		{ time: Date.now(), reason: { kind: 'completed' } },
		{ time: Date.now(), reason: { kind: 'error', error: { code: 'AUTH' } } }
	];
	for (const item of cases) {
		const state = createContext();
		apply(state.ctx, { ...FAST, sweepOnStart: true });
		state.injected.get('sessionQuery')({
			sessionQuery: {
				async listSessions() { return [{ header: { id: 'old', createdAt: 1 } }]; },
				async filterEvents(sessionId, filters) {
					return filters[0].values[0] === 'turn/end'
						? [{ seq: 12, time: item.time }]
						: [{ seq: 3, time: item.time }];
				},
				async readEvent({ seq }) {
					return seq === 12
						? { target: { data: { reason: item.reason } } }
						: { target: { data: { header: { config: { provider: 'p', model: 'm' } } } } };
				}
			}
		});
		await new Promise(resolve => { setTimeout(resolve, 40); });
		assert.equal(state.probes.length, 0, JSON.stringify(item.reason));
	}
});

test('a sweep that cannot read one log still continues the rest', async () => {
	const state = createContext();
	apply(state.ctx, { ...FAST, sweepOnStart: true });
	state.injected.get('sessionQuery')({
		sessionQuery: {
			async listSessions() { return [{ header: { id: 'broken' } }, { header: { id: 'good' } }]; },
			async filterEvents(sessionId, filters) {
				if (sessionId === 'broken') throw new Error('unreadable log');
				return filters[0].values[0] === 'turn/end' ? [{ seq: 12, time: Date.now() }] : [{ seq: 3, time: Date.now() }];
			},
			async readEvent({ seq }) {
				return seq === 12
					? { target: { data: { reason: { kind: 'error', error: { code: 'SERVER' } } } } }
					: { target: { data: { header: { config: { provider: 'p', model: 'm' } } } } };
			}
		}
	});
	await until(() => state.prompts.length === 1, 'the readable continuation');
	assert.equal(state.prompts[0].sessionId, 'good');
	assert.match(state.logs.join('\n'), /could not inspect broken: unreadable log/);
});

test('a bad setting fails activation', () => {
	const state = createContext();
	assert.throws(() => apply(state.ctx, { maxProbes: -1 }), /"maxProbes"/);
});
