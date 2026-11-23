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
 * Workspace navigation calls, menu registration, and locale dictionaries.
 * @param {{locale?: string, scope?: boolean, binding?: boolean, running?: boolean, workspace?: boolean}} [options]
 *   which paths answer, whether the session is mid-turn, and whether a Workspace exists.
 */
function createContext({ locale = 'en', scope = true, binding = true, running = false, workspace = true } = {}) {
	const contributions = [];
	const notices = [];
	const started = [];
	const connected = [];
	const opened = [];
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
			list: {
				getSnapshot() {
					return {
						byId: {
							s1: { id: 's1', blank: false, updatedAt: 30, cwd: '/work/acme' },
							s9: { id: 's9', blank: false, updatedAt: 20, cwd: '/work/acme' },
						},
					};
				},
			},
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
						getSnapshot() {
							return { running };
						},
						async prompt(content, mode) {
							prompts.push({ sessionId, content, mode });
							return { ok: true, value: { accepted: true } };
						},
					},
				};
			},
		},
		workspaces: {
			list: {
				getSnapshot() {
					return {
						items: workspace ? [{
							workspaceId: 'w1',
							sessionIds: ['s1', 's9'],
							createdAt: '2026-01-01T00:00:00.000Z',
						}] : [],
					};
				},
			},
		},
		uiWorkspace: {
			startSession(workspaceId, options) {
				started.push({ workspaceId, options });
			},
			async connectWorkspace(workspaceId) {
				connected.push(workspaceId);
				return 'new1';
			},
			openSession(sessionId) {
				opened.push(sessionId);
			},
		},
	};
	return { ctx, contributions, notices, started, connected, opened, sent, prompts };
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
	assert.deepEqual(exported.inject, ['contextMenus', 'sessions', 'uiWorkspace', 'workspaces', 'locale']);
});

test('the menu offers three commands with three destinations each', () => {
	const { contribution } = mount();
	const actions = contribution.resolve({ sessionId: 's1', url: ISSUE });
	assert.equal(actions.length, 3);
	assert.deepEqual(actions.map(action => action.id), ['ugo', 'ufast', 'uloop']);
	for (const action of actions) {
		assert.deepEqual(action.children.map(child => child.id), [`${action.id}:run`, `${action.id}:new`, `${action.id}:current`]);
	}
	assert.equal(actions[0].label, 'Route this issue (/ugo)');
	assert.equal(actions[1].label, 'Small change (/ufast)');
	assert.equal(actions[2].label, 'Deliver autonomously (/uloop)');
	assert.equal(actions[0].children[0].label, 'Open a new session and run');
	assert.equal(actions[0].children[1].label, 'Open a new session (not sent)');
	assert.equal(actions[0].children[2].label, 'Send to this session now');
	assert.equal(actions[0].separatorBefore, true);
	assert.equal(actions[1].separatorBefore, false);
});

test('only GitHub issue links get the menu', () => {
	const { contribution } = mount();
	const resolve = url => contribution.resolve({ sessionId: 's1', url });
	assert.equal(resolve('https://github.com/acme/widgets/issues/12').length, 3);
	assert.equal(resolve('http://github.com/acme/widgets/issues/7/').length, 3);
	assert.equal(resolve('https://www.github.com/acme/widgets/issues/7?notification=1').length, 3);
	assert.equal(resolve('https://github.com/acme/widgets/issues/12/files').length, 3);
	assert.equal(resolve('https://github.com/acme/widgets/pull/12').length, 0);
	assert.equal(resolve('https://github.com/acme/widgets/issues').length, 0);
	assert.equal(resolve('https://gitlab.com/acme/widgets/issues/12').length, 0);
	assert.equal(resolve(undefined).length, 0);
});

test('a new session opens with the canonical command in its composer, unsent', () => {
	const { contribution, started, notices, sent } = mount();
	const action = contribution.resolve({
		sessionId: 's1',
		url: 'https://github.com/acme/widgets/issues/12#issuecomment-3456',
	})[2];
	action.children[1].run();
	assert.deepEqual(started, [{
		workspaceId: undefined,
		options: { prompt: '/uloop https://github.com/acme/widgets/issues/12', whenDraftExists: 'append' },
	}]);
	assert.deepEqual(sent, []);
	assert.deepEqual(notices, []);
});

test('a new session opens in the clicked session’s workspace and runs the command at once', async () => {
	const { contribution, connected, opened, started, sent, notices } = mount();
	const action = contribution.resolve({
		sessionId: 's9',
		url: 'https://github.com/acme/widgets/issues/12#issuecomment-3456',
	})[1];
	await action.children[0].run();
	assert.deepEqual(connected, ['w1']);
	assert.deepEqual(opened, ['new1']);
	assert.deepEqual(started, []);
	assert.deepEqual(sent, [{ sessionId: 'new1', text: '/ufast https://github.com/acme/widgets/issues/12' }]);
	assert.deepEqual(notices, [{ text: 'Started /ufast in a new session', success: true }]);
});

test('with no Workspace yet the run destination falls back to the unsent draft', async () => {
	const { contribution, connected, opened, started, notices } = mount({ workspace: false });
	const action = contribution.resolve({ sessionId: 's1', url: ISSUE })[1];
	await action.children[0].run();
	assert.deepEqual(connected, []);
	assert.deepEqual(opened, []);
	assert.deepEqual(started, [{
		workspaceId: undefined,
		options: { prompt: `/ufast ${ISSUE}`, whenDraftExists: 'append' },
	}]);
	assert.deepEqual(notices, []);
});

test('the current session receives the command through the conversation service', async () => {
	const { contribution, sent, prompts, notices } = mount();
	const action = contribution.resolve({ sessionId: 's9', url: ISSUE })[1];
	await action.children[2].run();
	assert.deepEqual(sent, [{ sessionId: 's9', text: `/ufast ${ISSUE}` }]);
	assert.deepEqual(prompts, []);
	assert.deepEqual(notices, [{ text: 'Sent /ufast to this session', success: true }]);
});

test('a running session is told the command is queued', async () => {
	const { contribution, notices } = mount({ running: true });
	const action = contribution.resolve({ sessionId: 's9', url: ISSUE })[1];
	await action.children[2].run();
	assert.deepEqual(notices, [{ text: 'Queued /ufast behind the current turn', success: true }]);
});

test('the session binding carries the command when no Client scope is live', async () => {
	const { contribution, sent, prompts } = mount({ scope: false });
	const action = contribution.resolve({ sessionId: 's9', url: ISSUE })[0];
	await action.children[2].run();
	assert.deepEqual(sent, []);
	assert.deepEqual(prompts, [{
		sessionId: 's9',
		content: [{ type: 'text', text: `/ugo ${ISSUE}` }],
		mode: 'queue',
	}]);
});

test('a session that can no longer receive a message is not offered', async () => {
	const { contribution } = mount({ scope: false, binding: false });
	const actions = contribution.resolve({ sessionId: 's9', url: ISSUE });
	assert.equal(actions.length, 3);
	for (const action of actions) {
		assert.deepEqual(action.children.map(child => child.id), [`${action.id}:run`, `${action.id}:new`]);
	}
});

test('labels follow the active locale', () => {
	const chinese = mount({ locale: 'zh' }).contribution.resolve({ sessionId: 's1', url: ISSUE });
	assert.equal(chinese[2].label, '自主交付（/uloop）');
	assert.equal(chinese[2].children[0].label, '在新会话中打开并运行');
	assert.equal(chinese[2].children[1].label, '在新会话中打开（不发送）');
	assert.equal(chinese[2].children[2].label, '立即发送到当前会话');
	const japanese = mount({ locale: 'ja' }).contribution.resolve({ sessionId: 's1', url: ISSUE });
	assert.equal(japanese[0].label, 'このイシューを振り分ける（/ugo）');
});
