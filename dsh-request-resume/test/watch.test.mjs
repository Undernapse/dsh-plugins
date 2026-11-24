import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	DEFAULTS,
	PERMANENT_CODES,
	Pending,
	isHopeless,
	isResumable,
	probeDelay,
	resolveConfig,
	routeKey,
	watchLimit
} from '../lib/watch.js';

test('every omitted setting falls back to its default', () => {
	assert.deepEqual(resolveConfig(), DEFAULTS);
	assert.deepEqual(resolveConfig(undefined), DEFAULTS);
	// A profile patch replaces the whole config map, so a partial one must
	// still mean "default" for the keys it omits.
	const partial = resolveConfig({ maxProbes: 7 });
	assert.equal(partial.maxProbes, 7);
	assert.equal(partial.initialProbeDelayMs, DEFAULTS.initialProbeDelayMs);
	assert.deepEqual(partial.resumeCodes, DEFAULTS.resumeCodes);
});

test('a bad setting is reported instead of silently changing behaviour', () => {
	assert.throws(() => resolveConfig({ maxProbes: -1 }), /"maxProbes" must be a non-negative integer/);
	assert.throws(() => resolveConfig({ probeTimeoutMs: 0 }), /"probeTimeoutMs" must be a positive integer/);
	assert.throws(() => resolveConfig({ probeText: '  ' }), /"probeText" must be a non-empty string/);
	assert.throws(() => resolveConfig({ sweepOnStart: 'yes' }), /"sweepOnStart" must be a boolean/);
	assert.throws(() => resolveConfig({ maxProbeDelayMs: 10, initialProbeDelayMs: 100 }), /at least "initialProbeDelayMs"/);
	assert.throws(() => resolveConfig({ resumeCodes: [] }), /non-empty array of failure codes/);
	assert.throws(() => resolveConfig({ resumeCodes: ['TIMEOUT', 'TIMEOUT'] }), /lists a code twice/);
	assert.throws(() => resolveConfig(null), /must be a mapping/);
});

test('the resolved policy cannot be changed afterwards', () => {
	const policy = resolveConfig({ resumeCodes: ['TIMEOUT'] });
	assert.throws(() => { policy.maxProbes = 99; }, TypeError);
	assert.throws(() => { policy.resumeCodes.push('SERVER'); }, TypeError);
});

test('the continuable failures are watched and permanent ones are not', () => {
	const policy = resolveConfig();
	for (const code of ['TIMEOUT', 'TRANSPORT', 'SERVER', 'RATE_LIMIT', 'STREAM_CLOSED', 'EMPTY_RESPONSE']) {
		assert.equal(isResumable(policy, { code }), true, code);
	}
	// `MALFORMED_RESPONSE` is deliberately absent: the Harness offers no
	// Continue for it, so a resume would be rejected by the controller.
	for (const code of ['MALFORMED_RESPONSE', 'AUTH', 'INVALID_REQUEST', 'QUOTA', 'ABORTED']) {
		assert.equal(isResumable(policy, { code }), false, code);
	}
	assert.equal(isResumable(policy, undefined), false);
});

test('a permanent code stays out even when a user adds it to the list', () => {
	for (const code of PERMANENT_CODES) {
		assert.equal(isResumable(resolveConfig({ resumeCodes: [code] }), { code }), false, code);
	}
});

test('a probe failure decides whether waiting can still help', () => {
	const policy = resolveConfig();
	// Transient: keep probing.
	for (const code of ['TIMEOUT', 'TRANSPORT', 'SERVER', 'RATE_LIMIT']) {
		assert.equal(isHopeless(policy, { code }), false, code);
	}
	// Permanent or unknown: another probe cannot change the answer.
	for (const code of ['AUTH', 'NO_ADAPTER', 'UNKNOWN_MODEL', 'SOMETHING_NEW']) {
		assert.equal(isHopeless(policy, { code }), true, code);
	}
	assert.equal(isHopeless(policy, undefined), false);
});

test('the route key is injective, even for ids containing separators', () => {
	assert.equal(routeKey('p', 'm'), routeKey('p', 'm'));
	assert.notEqual(routeKey('p', 'm'), routeKey('p', 'other'));
	assert.notEqual(routeKey('p', 'm'), routeKey('other', 'm'));
	// A provider or model id containing the joining character cannot collide.
	assert.notEqual(routeKey('p\u0000m', 'x'), routeKey('p', 'm\u0000x'));
	assert.notEqual(routeKey('p', 'm\u0000x'), routeKey('p', 'm', 'x'));
});

test('the probe backoff doubles up to the cap', () => {
	const policy = resolveConfig({ initialProbeDelayMs: 100, maxProbeDelayMs: 500 });
	assert.deepEqual([1, 2, 3, 4].map(n => probeDelay(policy, n)), [100, 200, 400, 500]);
	// A first probe may be immediate.
	assert.equal(probeDelay(resolveConfig({ initialProbeDelayMs: 0 }), 1), 0);
});

test('watching stops on the probe count or the time window', () => {
	const policy = resolveConfig({ maxProbes: 3, maxProbeWaitMs: 1000 });
	assert.equal(watchLimit(policy, { probes: 0, startedAt: 0 }, 0), undefined);
	assert.equal(watchLimit(policy, { probes: 3, startedAt: 0 }, 10), '3 probes');
	assert.equal(watchLimit(policy, { probes: 1, startedAt: 0 }, 1000), '1000 ms');
	assert.equal(watchLimit(resolveConfig({ maxProbeWaitMs: 0 }), { probes: 1, startedAt: 0 }, 1e9), undefined);
});

test('conversations group by route, and one drain takes the whole group', () => {
	const pending = new Pending();
	const first = pending.record({ sessionId: 'a', provider: 'p', model: 'm', failureSeq: 5, since: 0 });
	assert.deepEqual(first, { key: routeKey('p', 'm'), isNewRoute: true });
	assert.equal(pending.record({ sessionId: 'b', provider: 'p', model: 'm', failureSeq: 9, since: 0 }).isNewRoute, false);
	assert.equal(pending.record({ sessionId: 'c', provider: 'p', model: 'other', failureSeq: 2, since: 0 }).isNewRoute, true);
	assert.equal(pending.size(routeKey('p', 'm')), 2);
	assert.equal(pending.total, 3);

	const drained = pending.drain(routeKey('p', 'm'));
	assert.deepEqual(drained.map(entry => entry.sessionId).sort(), ['a', 'b']);
	assert.equal(pending.size(routeKey('p', 'm')), 0);
	// The same route re-arms from scratch after being drained.
	assert.equal(pending.record({ sessionId: 'd', provider: 'p', model: 'm', failureSeq: 1, since: 0 }).isNewRoute, true);
	assert.equal(pending.total, 2);
});

test('a conversation that fails again keeps only its newest failure', () => {
	const pending = new Pending();
	pending.record({ sessionId: 'a', provider: 'p', model: 'm', failureSeq: 5, since: 0 });
	pending.record({ sessionId: 'a', provider: 'p', model: 'other', failureSeq: 8, since: 1 });
	assert.equal(pending.size(routeKey('p', 'm')), 0, 'the old route no longer lists it');
	assert.equal(pending.get('a').failureSeq, 8);
	assert.equal(pending.get('a').model, 'other');
	assert.equal(pending.total, 1);
});

test('dropping and reading one conversation', () => {
	const pending = new Pending();
	pending.record({ sessionId: 'a', provider: 'p', model: 'm', failureSeq: 5, since: 0 });
	assert.equal(pending.drop('a'), true);
	assert.equal(pending.drop('a'), false);
	assert.deepEqual(pending.keys(), []);
	assert.equal(pending.get('a'), undefined);
});

/**
 * Read the `config` block of the shipped patch.
 *
 * The file is small and regular, so the test parses the shape it actually uses
 * — scalars and one string list — instead of taking a YAML dependency.
 * @param {string} text - patch source.
 * @returns {Record<string, unknown>} the configured values.
 */
function patchConfig(text) {
	const values = {};
	let listKey;
	for (const line of text.split('\n')) {
		const item = /^\s{10}- (\S+)$/.exec(line);
		if (item !== null && listKey !== undefined) {
			values[listKey].push(item[1]);
			continue;
		}
		const entry = /^\s{8}([A-Za-z]+):\s*(.*)$/.exec(line);
		if (entry === null) continue;
		const [, key, raw] = entry;
		if (raw === '') {
			listKey = key;
			values[key] = [];
			continue;
		}
		listKey = undefined;
		values[key] = raw === 'true' ? true : raw === 'false' ? false : /^\d+$/.test(raw) ? Number(raw) : raw;
	}
	return values;
}

test('the shipped patch defaults are valid and match the code', async () => {
	const { readFile } = await import('node:fs/promises');
	const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
	const configured = patchConfig(text);
	// A profile row that silently dropped or renamed a key would keep working
	// with a default the README no longer describes; this keeps them identical.
	assert.deepEqual(configured, { ...DEFAULTS });
	assert.deepEqual(resolveConfig(configured), DEFAULTS);
});
