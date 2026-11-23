import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

/** Minimal React-shaped element factory; the row uses no React hooks itself. */
function react() {
	return {
		Fragment: 'Fragment',
		createElement(type, props, ...children) {
			return {
				type,
				props: {
					...(props ?? {}),
					children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children
				}
			};
		}
	};
}

/** Concatenate every rendered text node. */
function textOf(node) {
	if (node === null || node === undefined || node === false || node === true) return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).join(' ');
	if (typeof node === 'object') return textOf(node.props?.children);
	return '';
}

/** Collect rendered elements matching a predicate. */
function collect(node, predicate, found = []) {
	if (node === null || node === undefined || typeof node !== 'object') return found;
	if (Array.isArray(node)) {
		for (const child of node) collect(child, predicate, found);
		return found;
	}
	if (predicate(node)) found.push(node);
	collect(node.props?.children, predicate, found);
	return found;
}

/** Load the browser module with a stubbed module loader and host context. */
function load() {
	let definition;
	const sandbox = {
		window: { __ModuleLoader__: { load(value) { definition = value; } } },
		console,
		URL
	};
	vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox, {
		filename: 'client.js'
	});
	assert.ok(definition, 'the module loader receives one definition');
	const registrations = [];
	const dictionaries = [];
	const ctx = {
		effect(effect) {
			const disposer = effect();
			return typeof disposer === 'function' ? disposer : () => {};
		},
		locale: {
			register(namespace, dictionary) {
				dictionaries.push({ namespace, ...dictionary });
				return () => {};
			}
		},
		slots: {
			inject(_name, register) {
				return register();
			},
			register(registration, component) {
				registrations.push({ registration, component });
				return () => {};
			}
		}
	};
	const module = definition.factory((id) => {
		if (id === 'react') return react();
		throw new Error(`unexpected module: ${id}`);
	});
	module.apply(ctx);
	return { definition, module, registrations, dictionaries };
}

/** Translate one English key, as the locale seat would. */
function english(key) {
	return load().dictionaries[0].en[key] ?? key;
}

test('the client module registers one keyed web_search view and its dictionaries', () => {
	const { definition, module, registrations, dictionaries } = load();
	assert.equal(definition.id, '@undernapse/dsh-web-search-searxng');
	assert.deepEqual(Array.from(module.inject), ['slots', 'locale']);
	assert.equal(registrations.length, 1);
	assert.equal(registrations[0].registration.name, 'tool.call.toolview');
	assert.equal(registrations[0].registration.key, 'web_search');
	// The shipped `web_search` row registers at priority 0 and the lowest
	// priority renders, so this row must sit below it to shadow it.
	assert.equal(registrations[0].registration.priority, -1);
	assert.equal(registrations[0].registration.locale, 'web-search-searxng');
	assert.equal(typeof registrations[0].component, 'function');
	assert.ok(dictionaries[0].en.title);
	assert.ok(dictionaries[0].zh.title);
});

test('the row shows one icon per site and the distinct site count', () => {
	const { registrations } = load();
	const { component } = registrations[0];
	const tree = component({
		block: {
			kind: 'tool-result',
			isError: false,
			call: { name: 'web_search', argsRaw: JSON.stringify({ queries: ['deepseek harness'] }) },
			meta: {
				truncated: false,
				sources: [
					{ url: 'https://www.example.com/a', title: 'Alpha', snippet: 'First page', publishedAt: '2026-01-01' },
					{ url: 'https://example.com/b', title: 'Beta' },
					{ url: 'https://docs.example.org/c', title: 'Gamma' }
				]
			},
			content: [{ type: 'text', text: 'ok' }]
		},
		useDisclosure: () => ({ expanded: true, toggle() {} }),
		t: english,
		inspect: () => {}
	});
	const text = textOf(tree);
	assert.match(text, /2 sites/);
	assert.match(text, /3 sources/);
	assert.match(text, /example\.com/);
	assert.match(text, /docs\.example\.org/);
	assert.match(text, /Alpha/);
	const icons = collect(tree, (node) => node.type === 'img');
	assert.equal(icons.length, 4); // two in the collapsed strip, two in the grouped body
	assert.ok(icons.some((icon) => icon.props.src === 'https://example.com/favicon.ico'));
	assert.ok(icons.some((icon) => icon.props.src === 'https://docs.example.org/favicon.ico'));
});

test('the row renders a failed search without losing its message', () => {
	const { registrations } = load();
	const { component } = registrations[0];
	const tree = component({
		block: {
			kind: 'tool-result',
			isError: true,
			call: { name: 'web_search', argsRaw: JSON.stringify({ queries: ['boom'] }) },
			content: [{ type: 'text', text: 'Provider unavailable' }]
		},
		useDisclosure: () => ({ expanded: false, toggle() {} }),
		t: english
	});
	const text = textOf(tree);
	assert.match(text, /Provider unavailable/);
	assert.match(text, /Search failed/);
});

test('the row renders a running search without a site count', () => {
	const { registrations } = load();
	const { component } = registrations[0];
	const tree = component({
		block: { phase: 'start', argsRaw: JSON.stringify({ queries: ['still running'] }) },
		useDisclosure: () => ({ expanded: false, toggle() {} }),
		t: english
	});
	const text = textOf(tree);
	assert.match(text, /still running/);
	assert.match(text, /Searching…/);
	assert.doesNotMatch(text, / sites/);
});
