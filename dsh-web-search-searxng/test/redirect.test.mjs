import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, test } from 'node:test';

import { apply } from '../index.js';
import { followCrossOriginRedirects, resolveRedirectTarget } from '../lib/redirect.js';

/** Servers started by the current test, closed even when an assertion fails. */
const servers = new Set();

afterEach(async () => {
	for (const server of servers) {
		server.closeAllConnections?.();
		await new Promise((resolve) => server.close(resolve));
	}
	servers.clear();
});

/** Start one local HTTP server and return its origin. */
async function startServer(handler) {
	const server = http.createServer(handler);
	servers.add(server);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${server.address().port}`;
}

test('resolveRedirectTarget resolves relative locations and rejects other schemes', () => {
	const base = new URL('https://example.com/a/b');
	assert.equal(resolveRedirectTarget('../c', base)?.href, 'https://example.com/c');
	assert.equal(resolveRedirectTarget('//other.example/x', base)?.href, 'https://other.example/x');
	assert.equal(resolveRedirectTarget('file:///etc/passwd', base), undefined);
	assert.equal(resolveRedirectTarget('', base), undefined);
});

test('followCrossOriginRedirects returns the final URL after a cross-origin hop', async () => {
	const finalOrigin = await startServer((_request, response) => {
		response.writeHead(200, { 'content-type': 'text/plain' });
		response.end('final');
	});
	const startOrigin = await startServer((_request, response) => {
		response.writeHead(302, { location: `${finalOrigin}/final` });
		response.end();
	});
	assert.equal(await followCrossOriginRedirects(`${startOrigin}/start`), `${finalOrigin}/final`);
});

test('followCrossOriginRedirects returns undefined without a redirect', async () => {
	const origin = await startServer((_request, response) => {
		response.writeHead(200, { 'content-type': 'text/plain' });
		response.end('ok');
	});
	assert.equal(await followCrossOriginRedirects(`${origin}/page`), undefined);
});

test('followCrossOriginRedirects stops at the hop budget', async () => {
	const origin = await startServer((_request, response) => {
		response.writeHead(302, { location: '/loop' });
		response.end();
	});
	assert.equal(await followCrossOriginRedirects(`${origin}/loop`, { maxRedirects: 2 }), undefined);
});

test('followCrossOriginRedirects honors cancellation', async () => {
	const origin = await startServer((_request, response) => {
		response.writeHead(302, { location: '/next' });
		response.end();
	});
	const controller = new AbortController();
	controller.abort();
	assert.equal(await followCrossOriginRedirects(`${origin}/start`, { signal: controller.signal }), undefined);
});

/** Minimal context capture for the around-dispatch recovery wrapper. */
function context(fetchImpl, toolDef) {
	const hooks = [];
	const fetched = [];
	const ctx = {
		web: {
			registerSearchProvider() {},
			async fetch(request, signal) {
				fetched.push(request.url);
				return fetchImpl(request, signal);
			}
		},
		tools: {
			get() {
				return toolDef;
			}
		},
		on(event, listener) {
			if (event === 'tools/execute') hooks.push(listener);
		},
		logger: { info() {}, warn() {} }
	};
	apply(ctx, { baseURL: 'https://searxng.in.undernapse.com' });
	return { ctx, hooks, fetched };
}

/** The web_fetch tool definition shape the wrapper reads. */
function fetchTool() {
	return {
		output: {
			render(args, value) {
				return [{ type: 'text', text: `fetched ${value.url}` }];
			},
			presentationMeta(args, value) {
				return { url: value.url, statusCode: value.statusCode, truncated: value.truncated };
			}
		}
	};
}

/** A web_fetch failure carrying the provider's redirect code. */
function redirectFailure() {
	return {
		isError: true,
		error: {
			message: 'cross-origin redirect to https://export.arxiv.org is not followed automatically; retry against that URL directly',
			info: { name: 'WebError', code: 'WEB_REDIRECT_BLOCKED' }
		},
		content: [{ type: 'text', text: 'cross-origin redirect' }]
	};
}

test('the around-dispatch wrapper replaces a cross-origin fetch failure with the final page', async () => {
	const finalOrigin = await startServer((_request, response) => {
		response.writeHead(200, { 'content-type': 'text/plain' });
		response.end('final');
	});
	const startOrigin = await startServer((_request, response) => {
		response.writeHead(302, { location: `${finalOrigin}/final` });
		response.end();
	});
	const { hooks, fetched } = context(async (request) => ({
		url: request.url,
		statusCode: 200,
		body: { kind: 'text', content: 'arXiv response' },
		truncated: false
	}), fetchTool());
	assert.equal(hooks.length, 1);
	const decision = await hooks[0](
		{ name: 'web_fetch', arguments: { url: `${startOrigin}/start` }, signal: new AbortController().signal, agent: 'agent', toolSet: undefined },
		async () => redirectFailure()
	);
	assert.deepEqual(decision, {
		isError: false,
		value: {
			url: `${finalOrigin}/final`,
			statusCode: 200,
			body: { kind: 'text', content: 'arXiv response' },
			truncated: false
		},
		content: [{ type: 'text', text: `fetched ${finalOrigin}/final` }],
		meta: { url: `${finalOrigin}/final`, statusCode: 200, truncated: false }
	});
	assert.deepEqual(fetched, [`${finalOrigin}/final`]);
});

test('the around-dispatch wrapper leaves other failures and tools untouched', async () => {
	const { hooks } = context(async (request) => ({
		url: request.url,
		statusCode: 200,
		body: { kind: 'text', content: 'unused' },
		truncated: false
	}), fetchTool());
	const exec = { name: 'web_fetch', arguments: { url: 'https://example.com' }, signal: new AbortController().signal };
	const ordinary = { isError: true, error: { message: 'boom' } };
	assert.deepEqual(await hooks[0](exec, async () => ordinary), ordinary);
	const redirect = redirectFailure();
	assert.deepEqual(await hooks[0]({ ...exec, name: 'web_search' }, async () => redirect), redirect);
});

test('the around-dispatch wrapper keeps the original failure when the recovery fetch fails', async () => {
	const finalOrigin = await startServer((_request, response) => {
		response.writeHead(200, { 'content-type': 'text/plain' });
		response.end('final');
	});
	const startOrigin = await startServer((_request, response) => {
		response.writeHead(302, { location: `${finalOrigin}/final` });
		response.end();
	});
	const { hooks } = context(async () => {
		throw new Error('network down');
	}, fetchTool());
	const failure = redirectFailure();
	const decision = await hooks[0](
		{ name: 'web_fetch', arguments: { url: `${startOrigin}/start` }, signal: new AbortController().signal },
		async () => failure
	);
	assert.deepEqual(decision, failure);
});
