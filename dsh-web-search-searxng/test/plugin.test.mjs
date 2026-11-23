import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, inject, name } from '../index.js';

/** Minimal context double that records provider registrations. */
function context() {
	const registered = [];
	return {
		registered,
		ctx: {
			web: {
				registerSearchProvider(provider) {
					registered.push(provider);
					return () => {};
				}
			},
			on() {},
			logger: { info() {}, warn() {} }
		}
	};
}

test('apply registers one searxng provider with the configured endpoint', () => {
	assert.equal(name, 'web-search-searxng');
	assert.deepEqual(inject, ['web', 'tools']);

	const { ctx, registered } = context();
	apply(ctx, { baseURL: 'http://search.test:8080', categories: 'news', timeoutMs: 5_000 });
	assert.equal(registered.length, 1);
	assert.equal(registered[0].id, 'searxng');
	assert.equal(registered[0].title, 'SearXNG');
	assert.equal(registered[0].available(), true);
	assert.equal(registered[0].options.baseURL, 'http://search.test:8080/');
	assert.equal(registered[0].options.categories, 'news');
	assert.equal(registered[0].options.timeoutMs, 5_000);
});

test('apply uses every default when the row has no config', () => {
	const { ctx, registered } = context();
	apply(ctx, undefined);
	assert.equal(registered[0].options.baseURL, 'https://searxng.in.undernapse.com/');
});

test('apply refuses an unusable config before registering anything', () => {
	const { ctx, registered } = context();
	assert.throws(() => apply(ctx, { baseURL: 'ftp://search.test' }), /http or https/);
	assert.throws(() => apply(ctx, { safesearch: 9 }), /safesearch/);
	assert.equal(registered.length, 0);
});
