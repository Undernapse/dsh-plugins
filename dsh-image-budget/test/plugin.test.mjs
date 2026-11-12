import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, imageOffloadProjection } from '../index.js';

/** One retained image block. */
const image = (id) => ({ type: 'image', attachment: { attachmentId: `sha256:${id}` } });

/**
 * Minimal session double: a log, the messages the projection derived so far,
 * and the `image/offload` fold the real SurfaceManager performs.
 */
class FakeSession {
	events = [];
	projected = new Map();

	get surface() {
		return this;
	}

	get nodes() {
		return this.events
			.filter((event) => event.type === 'user/message' || event.type === 'tool/result')
			.map((event) => event.seq);
	}

	eventAt(seq) {
		return this.events[seq];
	}

	requestHeader() {
		return { config: { provider: 'fake', model: 'fake-model' } };
	}

	deriveEventMessage(event) {
		const projected = this.projected.get(event.seq);
		if (projected !== undefined) return projected;
		if (event.type === 'user/message') return event.data;
		if (event.type === 'tool/result') return event.data.message;
		return null;
	}

	pushUser(content) {
		const seq = this.events.length;
		this.events.push({ type: 'user/message', seq, data: { content } });
		return seq;
	}

	pushTool(callId, content) {
		const seq = this.events.length;
		this.events.push({ type: 'tool/result', seq, data: { callId, message: { content } } });
		return seq;
	}

	append(type, data) {
		const seq = this.events.length;
		const event = { type, seq, data };
		this.events.push(event);
		if (type === 'image/offload') {
			const messages = imageOffloadProjection.project(event, {
				nodes: this.nodes,
				events: this.events,
				baseSeq: 0,
				messages: this.projected
			});
			for (const [targetSeq, message] of messages) this.projected.set(targetSeq, message);
		}
		return event;
	}

	offloads() {
		return this.events.filter((event) => event.type === 'image/offload');
	}

	retained() {
		let count = 0;
		for (const seq of this.nodes) {
			const message = this.deriveEventMessage(this.eventAt(seq));
			for (const block of message.content) if (block.type === 'image' && block.offloaded !== true) count += 1;
		}
		return count;
	}
}

/** Mount the plugin on a recording context. */
function mount(config, { builtInProjection = false, loaderEntries = [] } = {}) {
	const handlers = new Map();
	const logs = [];
	const loader = { entries: () => loaderEntries };
	const projections = builtInProjection
		? [{ type: 'image/offload', project: () => { throw new Error('the built-in projection must win'); } }]
		: [];
	const ctx = {
		logger: {
			info: (message) => logs.push(message),
			warn: (message) => logs.push(`warn:${message}`)
		},
		sessions: {
			messageProjections: projections,
			registerMessageProjection(projection) {
				if (projections.some((item) => item.type === projection.type)) throw new Error('duplicate projection');
				projections.push(projection);
				return () => {};
			}
		},
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		get: (name) => (name === 'loader' ? loader : undefined)
	};
	apply(ctx, config);
	const dispatch = async (event, payload, fallback) => {
		const list = handlers.get(event) ?? [];
		const run = async (index) => (index >= list.length ? fallback : list[index](payload, () => run(index + 1)));
		return run(0);
	};
	return { ctx, logs, projections, dispatch };
}

/** Run one pre-step and return its decision. */
const preStep = (harness, session, pending = [], provider = 'fake') => harness.dispatch(
	'agent/pre-step',
	{ agent: { session }, messages: pending, signal: { aborted: false }, modelSelection: { provider, model: 'fake-model' } },
	{ kind: 'enter', messages: pending }
);

test('no offload while the surface fits the budget', async () => {
	const harness = mount({ maxImages: 20 });
	const session = new FakeSession();
	session.pushUser([image('1'), image('2')]);
	const decision = await preStep(harness, session);
	assert.equal(decision.kind, 'enter');
	assert.equal(session.offloads().length, 0);
	assert.equal(session.retained(), 2);
});

test('oldest images are offloaded down to the budget', async () => {
	const harness = mount({ maxImages: 20 });
	const session = new FakeSession();
	const first = session.pushUser(Array.from({ length: 8 }, (_, index) => image(`a${index}`)));
	session.pushTool('call-1', Array.from({ length: 8 }, (_, index) => image(`b${index}`)));
	session.pushUser(Array.from({ length: 10 }, (_, index) => image(`c${index}`)));
	await preStep(harness, session);
	assert.equal(session.retained(), 20);
	const [offload] = session.offloads();
	assert.deepEqual(offload.data.targets, [
		{ seq: first, imageIndexes: [0, 1, 2, 3, 4, 5] }
	]);
	assert.equal(session.events[first].data.content[0].offloaded, undefined);
	assert.equal(session.deriveEventMessage(session.eventAt(first)).content[0].offloaded, true);
});

test('the step about to append keeps room for its own images', async () => {
	const harness = mount({ maxImages: 20 });
	const session = new FakeSession();
	session.pushUser(Array.from({ length: 18 }, (_, index) => image(`a${index}`)));
	const pending = [{ content: Array.from({ length: 5 }, (_, index) => image(`p${index}`)) }];
	await preStep(harness, session, pending);
	assert.equal(session.retained(), 15);
	assert.equal(session.offloads().length, 1);
});

test('a second pass over the same surface records nothing new', async () => {
	const harness = mount({ maxImages: 4 });
	const session = new FakeSession();
	session.pushUser(Array.from({ length: 9 }, (_, index) => image(`a${index}`)));
	await preStep(harness, session);
	assert.equal(session.retained(), 4);
	await preStep(harness, session);
	assert.equal(session.retained(), 4);
	assert.equal(session.offloads().length, 1);
});

test('a provider limit error offloads and asks for a retry', async () => {
	const harness = mount({ maxImages: 50, recoveryMargin: 1 });
	const session = new FakeSession();
	session.pushUser(Array.from({ length: 30 }, (_, index) => image(`a${index}`)));
	const outcome = await harness.dispatch(
		'agent/request-error',
		{
			agent: { session },
			signal: { aborted: false },
			failure: {
				code: 'INVALID_REQUEST',
				message: '400: ... "At most 25 image(s) may be provided in one prompt."'
			}
		},
		undefined
	);
	assert.deepEqual(outcome, { kind: 'retry' });
	assert.equal(session.retained(), 24);
	assert.equal(session.offloads().length, 1);
	assert.match(harness.logs.at(-1), /at most 25 image\(s\).*offloaded 6/);
});

test('unrelated failures fall through to the next listener', async () => {
	const harness = mount({ maxImages: 50 });
	const session = new FakeSession();
	session.pushUser([image('a')]);
	const outcome = await harness.dispatch(
		'agent/request-error',
		{ agent: { session }, signal: { aborted: false }, failure: { code: 'SERVER', message: 'upstream exploded' } },
		'delegated'
	);
	assert.equal(outcome, 'delegated');
	assert.equal(session.offloads().length, 0);
});

test('recovery never runs when the API key or abort already decided the failure', async () => {
	const harness = mount({ maxImages: 50 });
	const session = new FakeSession();
	session.pushUser(Array.from({ length: 30 }, (_, index) => image(`a${index}`)));
	const imageError = { code: 'INVALID_REQUEST', message: 'At most 25 image(s) may be provided' };
	assert.equal(await harness.dispatch(
		'agent/request-error',
		{ agent: { session }, signal: { aborted: true }, failure: imageError },
		'delegated'
	), 'delegated');
	assert.equal(await harness.dispatch(
		'agent/request-error',
		{ agent: { session }, signal: { aborted: false }, failure: { ...imageError, code: 'AUTH' } },
		'delegated'
	), 'delegated');
	assert.equal(session.offloads().length, 0);
});

test('compaction summary errors use the same recovery', async () => {
	const harness = mount({ maxImages: 50 });
	const session = new FakeSession();
	session.pushUser(Array.from({ length: 30 }, (_, index) => image(`a${index}`)));
	const outcome = await harness.dispatch(
		'compaction/summary-error',
		{
			session,
			sourceEventSeqs: session.nodes,
			error: { failure: { code: 'INVALID_REQUEST', message: 'At most 25 image(s) may be provided' } }
		},
		false
	);
	assert.equal(outcome, true);
	assert.equal(session.retained(), 24);
});

test('a profile that already owns the projection keeps its definition', () => {
	const harness = mount({}, { builtInProjection: true });
	assert.equal(harness.projections.length, 1);
	assert.equal(harness.projections[0].project.name, 'project');
});

test('a profile without the built-in plugin gets the fallback projection', () => {
	const harness = mount({});
	assert.equal(harness.projections.length, 1);
	assert.equal(harness.projections[0].type, 'image/offload');
});

/** A pi-ai row declaring an image limit for the fake route. */
const piAiRow = (maxRequestImages) => [{
	options: { name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { fake: { maxRequestImages } } } }
}];

test('a provider-declared limit replaces the fallback', async () => {
	const harness = mount({ maxImages: 20 }, { loaderEntries: piAiRow(5) });
	const session = new FakeSession();
	session.pushUser(Array.from({ length: 8 }, (_, index) => image(`a${index}`)));
	await preStep(harness, session);
	assert.equal(session.retained(), 5);
});

test('a stated provider limit is learned and raises the cap', async () => {
	const harness = mount({ maxImages: 20, recoveryMargin: 1 });
	const session = new FakeSession();
	session.pushUser(Array.from({ length: 30 }, (_, index) => image(`a${index}`)));
	await harness.dispatch('agent/request-error', {
		agent: { session },
		provider: 'fake',
		signal: { aborted: false },
		failure: { code: 'INVALID_REQUEST', message: 'At most 25 image(s) may be provided' }
	}, undefined);
	assert.equal(session.retained(), 24);
	session.pushUser([image('extra')]);
	await preStep(harness, session);
	assert.equal(session.retained(), 25);
	assert.equal(session.offloads().length, 1);
});

test('explicit providerLimits override the declaration when tighter', async () => {
	const harness = mount({ providerLimits: { fake: 3 } }, { loaderEntries: piAiRow(5) });
	const session = new FakeSession();
	session.pushUser(Array.from({ length: 8 }, (_, index) => image(`a${index}`)));
	await preStep(harness, session);
	assert.equal(session.retained(), 3);
});

test('no limit and no fallback leaves the request untouched', async () => {
	const harness = mount({});
	const session = new FakeSession();
	session.pushUser(Array.from({ length: 30 }, (_, index) => image(`a${index}`)));
	await preStep(harness, session);
	assert.equal(session.retained(), 30);
	assert.equal(session.offloads().length, 0);
});

test('an adapter image-budget failure is honored when no other listener handles it', async () => {
	const harness = mount({});
	const session = new FakeSession();
	session.pushUser(Array.from({ length: 8 }, (_, index) => image(`a${index}`)));
	const outcome = await harness.dispatch('agent/request-error', {
		agent: { session },
		provider: 'fake',
		signal: { aborted: false },
		failure: { code: 'IMAGE_OFFLOAD_REQUIRED', message: 'pi-ai request images exceed the route image budget', offloadImages: 3 }
	}, undefined);
	assert.deepEqual(outcome, { kind: 'retry' });
	assert.equal(session.retained(), 5);
	session.pushUser([image('extra')]);
	await preStep(harness, session);
	assert.equal(session.retained(), 5);
	assert.equal(session.offloads().length, 2);
});
