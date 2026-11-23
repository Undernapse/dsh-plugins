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

const PLUGIN_ID = '@undernapse/dsh-tracker-issue-workflow';
const ISSUE = 'https://github.com/acme/widgets/issues/12';
const FORGEJO_ISSUE = 'https://git.example.org/acme/widgets/issues/12';

/**
 * Minimal stand-in for the Client context: the two Session delivery paths, the
 * Workspace navigation calls, the composer submit plane, menu registration, and
 * locale dictionaries.
 * @param {{locale?: string, scope?: boolean, binding?: boolean, running?: boolean, workspace?: boolean, draftResult?: string}} [options]
 *   which paths answer, whether the session is mid-turn, whether a Workspace
 *   exists, and what the composer reports for a draft initialization.
 */
function createContext({ locale = 'en', scope = true, binding = true, running = false, workspace = true, draftResult = 'applied' } = {}) {
	const contributions = [];
	const notices = [];
	const started = [];
	const connected = [];
	const opened = [];
	const sent = [];
	const prompts = [];
	const prepared = [];
	const submitted = [];
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
				const conversation = {
					async send(text) {
						sent.push({ sessionId, text });
					},
					input: {
						requestDraftInitialization(binding, options) {
							prepared.push({ sessionId, binding: binding.sessionId, options });
							return draftResult;
						},
						for() {
							return {
								submit() {
									submitted.push(sessionId);
								},
							};
						},
					},
				};
				return {
					get(name) {
						return name === 'conversation' ? conversation : undefined;
					},
					conversation,
				};
			},
			binding(sessionId) {
				if (!binding) return undefined;
				return {
					sessionId,
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
	return { ctx, contributions, notices, started, connected, opened, sent, prompts, prepared, submitted };
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

test('issue links from every supported tracker get the menu', () => {
	const { contribution } = mount();
	const resolve = url => contribution.resolve({ sessionId: 's1', url });
	const tracked = [
		ISSUE,
		FORGEJO_ISSUE,
		'http://github.com/acme/widgets/issues/7/',
		'https://www.github.com/acme/widgets/issues/7?notification=1',
		'https://github.com/acme/widgets/issues/12/files',
		'https://github.enterprise.example/acme/widgets/issues/4',
		'https://git.example.org:3000/acme/widgets/issues/9#issuecomment-1',
		'https://codeberg.org/forgejo/forgejo/issues/1234',
		'//git.example.org/acme/widgets/issues/9',
		'https://git.example.org/a%20b/c/issues/1',
	];
	for (const url of tracked) assert.equal(resolve(url).length, 3, url);
});

test('pull requests, GitLab issues, and lookalike pages get no menu', () => {
	const { contribution } = mount();
	const resolve = url => contribution.resolve({ sessionId: 's1', url });
	const ignored = [
		'https://github.com/acme/widgets/pull/12',
		'https://codeberg.org/forgejo/forgejo/pulls/1234',
		'https://github.com/acme/widgets/issues',
		'https://gitlab.com/acme/widgets/-/issues/12',
		'https://gitlab.com/group/sub/project/-/issues/12',
		'https://redmine.example.org/issues/12',
		'https://git.example.org/forgejo/acme/widgets/issues/3',
		'mailto:dev@example.org',
		undefined,
	];
	for (const url of ignored) assert.equal(resolve(url).length, 0, String(url));
});

test('the command line keeps the clicked host, scheme, and port', () => {
	const { contribution, started } = mount();
	const forgejo = contribution.resolve({
		sessionId: 's1',
		url: 'https://git.example.org:3000/acme/widgets/issues/9#issuecomment-1',
	})[2];
	forgejo.children[1].run();
	const plain = contribution.resolve({ sessionId: 's1', url: 'http://forgejo.example.org/acme/widgets/issues/5' })[0];
	plain.children[1].run();
	assert.deepEqual(started.map(entry => entry.options.prompt), [
		'/uloop https://git.example.org:3000/acme/widgets/issues/9',
		'/ugo http://forgejo.example.org/acme/widgets/issues/5',
	]);
});

test('credentials in a link are dropped from the canonical URL', () => {
	const { contribution, started } = mount();
	const action = contribution.resolve({ sessionId: 's1', url: 'https://token@sso.example.org/acme/widgets/issues/3' })[0];
	action.children[1].run();
	assert.deepEqual(started[0].options.prompt, '/ugo https://sso.example.org/acme/widgets/issues/3');
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
	const { contribution, connected, opened, started, sent, prepared, submitted, notices } = mount();
	const action = contribution.resolve({
		sessionId: 's9',
		url: 'https://github.com/acme/widgets/issues/12#issuecomment-3456',
	})[1];
	await action.children[0].run();
	assert.deepEqual(connected, ['w1']);
	assert.deepEqual(opened, ['new1']);
	assert.deepEqual(started, []);
	assert.deepEqual(sent, []);
	assert.deepEqual(prepared, [{
		sessionId: 'new1',
		binding: 'new1',
		options: {
			prompt: '/ufast https://github.com/acme/widgets/issues/12',
			whenDraftExists: 'append',
		},
	}]);
	assert.deepEqual(submitted, ['new1']);
	assert.deepEqual(notices, [{ text: 'Started /ufast in a new session', success: true }]);
});

test('a composer that will not take the command reports why instead of sending something else', async () => {
	const { contribution, submitted, notices } = mount({ draftResult: 'blocked' });
	const action = contribution.resolve({ sessionId: 's1', url: ISSUE })[1];
	await action.children[0].run();
	assert.deepEqual(submitted, []);
	assert.equal(notices.length, 1);
	assert.equal(notices[0].success, false);
	assert.match(notices[0].text, /^Could not start the command in a new session: /);
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
