import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * The bundle registers itself through the browser module loader, so the suite
 * stands in for that loader and then runs the shipped factory and plugin.
 */
let registration;
globalThis.window = {
	__ModuleLoader__: {
		load(entry) {
			registration = entry;
		},
	},
};

await import('../client.js');

const PLUGIN_ID = '@undernapse/dsh-github-issue-workflow';
const ISSUE = 'https://github.com/acme/widgets/issues/12';

/**
 * Minimal stand-in for the Client context: the two Session delivery paths, the
 * Workspace navigation call, menu registration, and locale dictionaries.
 * @param {{locale?: string, scope?: boolean, binding?: boolean}} [options] - which paths answer.
 */
function createContext({ locale = 'en', scope = true, binding = true } = {}) {
	const contributions = [];
	const notices = [];
	const started = [];
	const sent = [];
	const prompts = [];
	const dictionaries = new Map();
	const ctx = {
		effect(run) {
			return run();
		},
		locale: {
			register(namespace, dictionariesByLocale) {
				dictionaries.set(namespace, dictionariesByLocale);
				return () => {};
			},
			bind(namespace) {
				return (key, params) => {
					const template = dictionaries.get(namespace)?.[locale]?.[key] ?? key;
					if (params === undefined) return template;
					return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
				};
			},
		},
		contextMenus: {
			register(contribution) {
				contributions.push(contribution);
				return () => {};
			},
			notify(text, success) {
				notices.push({ text, success });
			},
		},
		sessions: {
			scope(sessionId) {
				if (!scope) return undefined;
				return {
					conversation: {
						async send(text) {
							sent.push({ sessionId, text });
						},
					},
				};
			},
			binding(sessionId) {
				if (!binding) return undefined;
				return {
					session: {
						async prompt(content, mode) {
							prompts.push({ sessionId, content, mode });
							return { ok: true, value: { accepted: true } };
						},
					},
				};
			},
		},
		uiWorkspace: {
			startSession(workspaceId, options) {
				started.push({ workspaceId, options });
			},
		},
	};
	return { ctx, contributions, notices, started, sent, prompts };
}

/**
 * Register the plugin against a fresh context.
 * @param {object} [options] - context behaviour.
 * @returns the fake context state plus the registered `url` contribution.
 */
function mount(options) {
	const state = createContext(options);
	registration.factory().apply(state.ctx);
	const contribution = state.contributions.find(entry => entry.target === 'url');
	assert.ok(contribution, 'the plugin registers a url menu contribution');
	return { ...state, contribution };
}

/** @returns the plugin object the bundle factory returns. */
function plugin() {
	return registration.factory();
}

test('the bundle registers one client plugin', () => {
	assert.equal(registration.id, PLUGIN_ID);
	const exported = plugin();
	assert.equal(typeof exported.apply, 'function');
	assert.deepEqual(exported.inject, ['contextMenus', 'sessions', 'uiWorkspace', 'conversation', 'locale']);
});

test('the menu offers three commands with two destinations each', () => {
	const { contribution } = mount();
	const actions = contribution.resolve({ sessionId: 's1', url: ISSUE });
	assert.equal(actions.length, 3);
	assert.deepEqual(actions.map(action => action.id), ['ugo', 'ufast', 'uloop']);
	for (const action of actions) {
		assert.deepEqual(action.children.map(child => child.id), [`${action.id}:new`, `${action.id}:current`]);
	}
	assert.equal(actions[0].label, '/ugo — route this issue');
	assert.equal(actions[0].children[0].label, 'In a new session');
	assert.equal(actions[0].separatorBefore, true);
	assert.equal(actions[1].separatorBefore, false);
});

test('only GitHub issue links get the menu', () => {
	const { contribution } = mount();
	const resolve = url => contribution.resolve({ sessionId: 's1', url });
	assert.equal(resolve('https://github.com/acme/widgets/issues/12').length, 3);
	assert.equal(resolve('http://github.com/acme/widgets/issues/7/').length, 3);
	assert.equal(resolve('https://www.github.com/acme/widgets/issues/7?notification=1').length, 3);
	assert.equal(resolve('https://github.com/acme/widgets/pull/12').length, 0);
	assert.equal(resolve('https://github.com/acme/widgets/issues').length, 0);
	assert.equal(resolve('https://gitlab.com/acme/widgets/issues/12').length, 0);
	assert.equal(resolve('https://github.com/acme/widgets/issues/12/files').length, 3);
	assert.equal(resolve(undefined).length, 0);
});

test('a new session opens with the canonical command in its composer', () => {
	const { contribution, started, notices } = mount();
	const action = contribution.resolve({
		sessionId: 's1',
		url: 'https://github.com/acme/widgets/issues/12#issuecomment-3456',
	})[2];
	action.children[0].run();
	assert.deepEqual(started, [{
		workspaceId: undefined,
		options: { prompt: '/uloop https://github.com/acme/widgets/issues/12', whenDraftExists: 'replace' },
	}]);
	assert.deepEqual(notices, [{ text: 'New session opened with /uloop in its composer', success: true }]);
});

test('the current session receives the command through the conversation service', async () => {
	const { contribution, sent, prompts, notices } = mount();
	const action = contribution.resolve({ sessionId: 's9', url: ISSUE })[1];
	await action.children[1].run();
	assert.deepEqual(sent, [{ sessionId: 's9', text: `/ufast ${ISSUE}` }]);
	assert.deepEqual(prompts, []);
	assert.deepEqual(notices, [{ text: 'Sent /ufast to this session', success: true }]);
});

test('the session binding carries the command when no Client scope is live', async () => {
	const { contribution, sent, prompts } = mount({ scope: false });
	const action = contribution.resolve({ sessionId: 's9', url: ISSUE })[0];
	await action.children[1].run();
	assert.deepEqual(sent, []);
	assert.deepEqual(prompts, [{
		sessionId: 's9',
		content: [{ type: 'text', text: `/ugo ${ISSUE}` }],
		mode: 'queue',
	}]);
});

test('a session that can no longer receive a message rejects', async () => {
	const { contribution } = mount({ scope: false, binding: false });
	const action = contribution.resolve({ sessionId: 's9', url: ISSUE })[0];
	await assert.rejects(action.children[1].run(), /can no longer receive a message/);
});

test('labels follow the active locale', () => {
	const { contribution } = mount({ locale: 'zh' });
	const actions = contribution.resolve({ sessionId: 's1', url: ISSUE });
	assert.equal(actions[2].label, '/uloop — 自主交付循环');
	assert.equal(actions[2].children[0].label, '在新会话中');
	assert.equal(actions[2].children[1].label, '在当前会话中');
});
