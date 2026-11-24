import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	DEFAULTS,
	PERMANENT_CODES,
	ResumeLedger,
	isResumable,
	resolveConfig,
	resumeDelay,
	wait
} from '../lib/policy.js';

test('every omitted setting falls back to its default', () => {
	assert.deepEqual(resolveConfig(), DEFAULTS);
	assert.deepEqual(resolveConfig(undefined), DEFAULTS);
	// A profile patch replaces the whole config map, so a partial one must
	// still mean "default" for the keys it omits.
	const partial = resolveConfig({ maxResumes: 1 });
	assert.equal(partial.maxResumes, 1);
	assert.equal(partial.initialDelayMs, DEFAULTS.initialDelayMs);
	assert.deepEqual(partial.resumeCodes, DEFAULTS.resumeCodes);
});

test('a bad setting is reported instead of silently changing behaviour', () => {
	assert.throws(() => resolveConfig({ maxResumes: -1 }), /"maxResumes" must be a non-negative integer/);
	assert.throws(() => resolveConfig({ maxResumes: 1.5 }), /non-negative integer/);
	assert.throws(() => resolveConfig({ initialDelayMs: 'fast' }), /non-negative integer/);
	assert.throws(() => resolveConfig({ maxDelayMs: 1, initialDelayMs: 5 }), /at least "initialDelayMs"/);
	assert.throws(() => resolveConfig({ resumeCodes: [] }), /non-empty array of failure codes/);
	assert.throws(() => resolveConfig({ resumeCodes: ['TIMEOUT', 'TIMEOUT'] }), /lists a code twice/);
	assert.throws(() => resolveConfig({ resumeCodes: [7] }), /failure codes/);
	assert.throws(() => resolveConfig(null), /must be a mapping/);
});

test('the resolved policy cannot be changed afterwards', () => {
	const policy = resolveConfig({ resumeCodes: ['TIMEOUT'] });
	assert.throws(() => { policy.maxResumes = 99; }, TypeError);
	assert.throws(() => { policy.resumeCodes.push('SERVER'); }, TypeError);
});

test('transient failures are resumable and permanent ones never are', () => {
	const policy = resolveConfig();
	for (const code of ['TIMEOUT', 'TRANSPORT', 'SERVER', 'RATE_LIMIT', 'STREAM_CLOSED', 'EMPTY_RESPONSE', 'MALFORMED_RESPONSE']) {
		assert.equal(isResumable(policy, { code }), true, code);
	}
	for (const code of ['AUTH', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'QUOTA', 'ABORTED']) {
		assert.equal(isResumable(policy, { code }), false, code);
	}
	assert.equal(isResumable(policy, undefined), false);
	assert.equal(isResumable(policy, {}), false);
});

test('a permanent code stays out even when a user adds it to the list', () => {
	// The guard is the promise that matters: another request cannot fix it.
	for (const code of PERMANENT_CODES) {
		assert.equal(isResumable(resolveConfig({ resumeCodes: [code] }), { code }), false, code);
	}
});

test('the backoff doubles up to the cap', () => {
	const policy = resolveConfig({ initialDelayMs: 100, maxDelayMs: 500 });
	assert.deepEqual([1, 2, 3, 4].map(n => resumeDelay(policy, n)), [100, 200, 400, 500]);
});

test('the provider delay wins until it is too long, then a capped local wait is used', () => {
	const policy = resolveConfig({ initialDelayMs: 100, maxDelayMs: 500, maxProviderDelayMs: 10000 });
	assert.equal(resumeDelay(policy, 1, 2500), 2500);
	assert.equal(resumeDelay(policy, 1, 0), 100);
	assert.equal(resumeDelay(policy, 1, Number.NaN), 100);
	// Beyond the accepted maximum the provider instruction is dropped rather
	// than stalling the turn; the wait never exceeds the local cap.
	assert.equal(resumeDelay(policy, 1, 600000), 500);
});

test('one step spends its own budget and then the turn budget', () => {
	const policy = resolveConfig({ maxResumes: 2, maxResumesPerTurn: 5 });
	const ledger = new ResumeLedger(policy);
	assert.deepEqual(ledger.next(1, 1, 0), { kind: 'resume', attempt: 1, turnAttempt: 1 });
	assert.deepEqual(ledger.next(1, 1, 0), { kind: 'resume', attempt: 2, turnAttempt: 2 });
	assert.deepEqual(ledger.next(1, 1, 0), { kind: 'exhausted', reason: 'step budget (2)' });
	// A later step has its own budget, counted against the same turn.
	assert.deepEqual(ledger.next(1, 2, 0), { kind: 'resume', attempt: 1, turnAttempt: 3 });
	assert.deepEqual(ledger.next(1, 2, 0), { kind: 'resume', attempt: 2, turnAttempt: 4 });
	assert.deepEqual(ledger.next(1, 3, 0), { kind: 'resume', attempt: 1, turnAttempt: 5 });
	assert.deepEqual(ledger.next(1, 3, 0), { kind: 'exhausted', reason: 'turn budget (5)' });
});

test('a new turn starts with a fresh budget', () => {
	const policy = resolveConfig({ maxResumes: 1, maxResumesPerTurn: 1 });
	const ledger = new ResumeLedger(policy);
	assert.equal(ledger.next(1, 1, 0).kind, 'resume');
	assert.equal(ledger.next(1, 1, 0).kind, 'exhausted');
	assert.equal(ledger.next(2, 1, 0).kind, 'resume');
	// Only the live turn is retained.
	assert.deepEqual([...ledger.turns.keys()], [2]);
});

test('a turn is not returned to when its step keeps failing past the window', () => {
	const policy = resolveConfig({ maxResumes: 100, maxResumesPerTurn: 100, maxStepDurationMs: 1000, maxTurnDurationMs: 10000 });
	const ledger = new ResumeLedger(policy);
	assert.equal(ledger.next(1, 1, 5000).kind, 'resume');
	assert.deepEqual(ledger.next(1, 1, 6100), { kind: 'exhausted', reason: 'step window (1000 ms)' });
	// A later step still has its own window…
	assert.equal(ledger.next(1, 2, 8000).kind, 'resume');
	// …until the whole turn runs past its own.
	assert.deepEqual(ledger.next(1, 3, 16000), { kind: 'exhausted', reason: 'turn window (10000 ms)' });
});

test('a zero time window disables it', () => {
	const policy = resolveConfig({ maxStepDurationMs: 0, maxTurnDurationMs: 0 });
	const ledger = new ResumeLedger(policy);
	assert.equal(ledger.next(1, 1, 10_000_000).kind, 'resume');
});

test('a wait settles after the delay, or early when a signal aborts', async () => {
	assert.equal(await wait(0, []), true);
	assert.equal(await wait(5, []), true);

	const cancelled = new AbortController();
	const started = Date.now();
	const pending = wait(5000, [cancelled.signal]);
	setTimeout(() => { cancelled.abort(); }, 10);
	assert.equal(await pending, false);
	assert.ok(Date.now() - started < 1000, 'the wait ended as soon as the turn was cancelled');

	const unloaded = new AbortController();
	const forever = wait(5000, [undefined, unloaded.signal]);
	setTimeout(() => { unloaded.abort(); }, 10);
	assert.equal(await forever, false);

	const already = new AbortController();
	already.abort();
	assert.equal(await wait(5000, [already.signal]), false);
});
