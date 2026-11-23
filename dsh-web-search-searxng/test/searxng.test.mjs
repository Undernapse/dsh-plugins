import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, test } from 'node:test';

import {
	DEFAULT_BASE_URL,
	DEFAULTS,
	SearxngSearchProvider,
	SearxngSearchError,
	buildSearchUrl,
	mapSearchResponse,
	resolveConfig,
	unresponsiveEngines
} from '../lib/searxng.js';

/** Servers started by the current test, closed even when an assertion fails. */
const servers = new Set();

afterEach(async () => {
	for (const server of servers) {
		server.closeAllConnections?.();
		await new Promise((resolve) => server.close(resolve));
	}
	servers.clear();
});

/**
 * Start one mock SearXNG instance.
 * @param handler - Node request handler.
 * @returns the instance base URL.
 */
async function startInstance(handler) {
	const server = http.createServer(handler);
	servers.add(server);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	return `http://127.0.0.1:${port}`;
}

/** One successful SearXNG JSON body. */
const SAMPLE = {
	query: 'deepseek harness',
	number_of_results: 2,
	results: [
		{
			url: 'https://example.com/harness',
			title: 'DeepSeek Harness',
			content: 'A model-facing agent harness.',
			publishedDate: '2026-05-01T12:00:00Z'
		},
		{
			url: 'https://example.com/harness',
			title: 'Duplicate',
			content: 'First occurrence wins.'
		},
		{
			url: 'javascript:alert(1)',
			title: 'Unsafe'
		},
		{
			url: '/relative',
			title: 'Relative'
		},
		{
			url: 'http:///go/v1/token',
			title: 'Instance redirect without a host'
		},
		{
			url: 'https://example.com/docs',
			title: 'Docs'
		}
	],
	answers: ['Harness is a runtime.', { answer: 'It hosts agents.' }]
};

test('resolveConfig fills every default', () => {
	const options = resolveConfig();
	assert.equal(options.baseURL, `${DEFAULT_BASE_URL}/`);
	assert.equal(options.categories, 'general');
	assert.equal(options.language, 'auto');
	assert.equal(options.safesearch, 0);
	assert.equal(options.timeoutMs, DEFAULTS.timeoutMs);
	assert.deepEqual(options.engines, []);
	assert.equal(options.timeRange, undefined);
});

test('resolveConfig accepts a path prefix, engines, and a time range', () => {
	const options = resolveConfig({
		baseURL: 'https://search.example.com/searx',
		categories: 'general,news',
		language: 'en',
		safesearch: 2,
		timeRange: 'month',
		engines: 'google, bing,google',
		timeoutMs: 5_000,
		userAgent: 'test-agent'
	});
	assert.equal(options.baseURL, 'https://search.example.com/searx');
	assert.equal(options.categories, 'general,news');
	assert.deepEqual(options.engines, ['google', 'bing']);
	assert.equal(options.timeRange, 'month');
	assert.equal(options.userAgent, 'test-agent');
});

test('resolveConfig redacts credentials from the diagnostic endpoint', () => {
	const options = resolveConfig({ baseURL: 'https://user:secret@search.example.com' });
	assert.equal(options.baseURL, 'https://user:secret@search.example.com/');
	assert.equal(options.displayBaseURL, 'https://redacted:redacted@search.example.com/');
	assert.equal(options.displayBaseURL.includes('secret'), false);
});

test('resolveConfig rejects unusable values', () => {
	const cases = [
		{ config: { unknown: true }, pattern: /unknown config key/ },
		{ config: { baseURL: 'not-a-url' }, pattern: /absolute HTTP\(S\) URL/ },
		{ config: { baseURL: 'ftp://example.com' }, pattern: /http or https/ },
		{ config: { categories: '   ' }, pattern: /categories/ },
		{ config: { language: '' }, pattern: /language/ },
		{ config: { safesearch: 3 }, pattern: /safesearch/ },
		{ config: { timeRange: 'decade' }, pattern: /timeRange/ },
		{ config: { timeoutMs: 0 }, pattern: /timeoutMs/ },
		{ config: { userAgent: '' }, pattern: /userAgent/ },
		{ config: { engines: [1] }, pattern: /engines/ }
	];
	for (const { config, pattern } of cases) {
		assert.throws(() => resolveConfig(config), pattern);
	}
});

test('buildSearchUrl uses the JSON endpoint and encodes every option', () => {
	const options = resolveConfig({
		baseURL: 'https://search.example.com/searx',
		categories: 'general,news',
		language: 'en',
		safesearch: 1,
		timeRange: 'week',
		engines: ['google', 'bing']
	});
	assert.equal(
		buildSearchUrl(options.baseURL, 'deepseek harness', options),
		'https://search.example.com/searx/search?q=deepseek+harness&format=json&categories=general%2Cnews'
		+ '&language=en&safesearch=1&time_range=week&engines=google%2Cbing'
	);
});

test('buildSearchUrl does not duplicate an existing /search path', () => {
	const options = resolveConfig({ baseURL: 'https://search.example.com/search/' });
	assert.equal(
		buildSearchUrl(options.baseURL, 'q', options),
		'https://search.example.com/search?q=q&format=json&categories=general&language=auto&safesearch=0'
	);
});

test('mapSearchResponse normalizes, dedupes, and answers', () => {
	const result = mapSearchResponse(SAMPLE);
	assert.equal(result.sources.length, 2);
	assert.deepEqual(result.sources[0], {
		url: 'https://example.com/harness',
		title: 'DeepSeek Harness',
		snippet: 'A model-facing agent harness.',
		summary: 'A model-facing agent harness.',
		publishedAt: '2026-05-01T12:00:00.000Z'
	});
	assert.deepEqual(result.sources[1], {
		url: 'https://example.com/docs',
		title: 'Docs'
	});
	assert.equal(result.content, 'Harness is a runtime.\n\nIt hosts agents.');
	assert.equal(result.truncated, false);
});

test('mapSearchResponse caps excerpts and drops unparsable dates', () => {
	const long = 'x'.repeat(2_000);
	const result = mapSearchResponse({
		results: [{ url: 'https://example.com', title: long, content: long, publishedDate: 'soon' }]
	});
	assert.equal(result.sources[0].title.length, 1_000);
	assert.equal(result.sources[0].snippet.length, 1_000);
	assert.ok(result.sources[0].snippet.endsWith('…'));
	assert.equal(result.sources[0].publishedAt, undefined);
});

test('mapSearchResponse rejects a body that is not a search response', () => {
	assert.throws(() => mapSearchResponse(null), /not an object/);
	assert.throws(() => mapSearchResponse({ results: 'nope' }), /results array/);
});

test('mapSearchResponse returns an empty result for an empty body', () => {
	const result = mapSearchResponse({});
	assert.deepEqual(result, { sources: [], truncated: false });
});

test('unresponsiveEngines describes failed engines', () => {
	assert.equal(
		unresponsiveEngines({ unresponsive_engines: [['google', 'timeout'], ['bing', 'error']] }),
		'google: timeout, bing: error'
	);
	assert.equal(unresponsiveEngines({}), undefined);
	assert.equal(unresponsiveEngines({ unresponsive_engines: [] }), undefined);
});

test('the provider searches the instance and sends JSON headers', async () => {
	let seen;
	const baseURL = await startInstance((request, response) => {
		seen = { url: request.url, headers: request.headers };
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify(SAMPLE));
	});
	const provider = new SearxngSearchProvider(resolveConfig({ baseURL, timeoutMs: 1_000 }));
	const result = await provider.search({ query: '  deepseek harness  ', maxResults: 5 });

	assert.equal(provider.id, 'searxng');
	assert.equal(provider.title, 'SearXNG');
	assert.match(provider.description.en, /SearXNG instance/);
	assert.equal(provider.available(), true);
	assert.equal(seen.headers.accept, 'application/json');
	assert.match(seen.headers['user-agent'], /^dsh-web-search-searxng\//);
	assert.match(seen.url, /^\/search\?q=deepseek\+harness&format=json&/);
	assert.equal(result.sources.length, 2);
});

test('the provider reports an HTTP failure with the JSON API hint', async () => {
	const baseURL = await startInstance((_request, response) => {
		response.writeHead(403, { 'content-type': 'text/plain' });
		response.end('Forbidden');
	});
	const provider = new SearxngSearchProvider(resolveConfig({ baseURL, timeoutMs: 1_000 }));
	await assert.rejects(
		provider.search({ query: 'q' }),
		(error) => {
			assert.ok(error instanceof SearxngSearchError);
			assert.equal(error.code, 'WEB_PROVIDER_ERROR');
			assert.match(error.message, /HTTP 403: Forbidden/);
			assert.match(error.message, /search\.formats/);
			return true;
		}
	);
});

test('the provider names the endpoint when the transport fails', async () => {
	const baseURL = 'http://127.0.0.1:1';
	const provider = new SearxngSearchProvider(resolveConfig({ baseURL, timeoutMs: 1_000 }));
	await assert.rejects(
		provider.search({ query: 'q' }),
		(error) => {
			assert.match(error.message, /request failed:/);
			assert.match(error.message, /Check that baseURL \(http:\/\/127\.0\.0\.1:1\/\) is reachable/);
			return true;
		}
	);
});

test('the provider reports a body that is not JSON', async () => {
	const baseURL = await startInstance((_request, response) => {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end('not json');
	});
	const provider = new SearxngSearchProvider(resolveConfig({ baseURL, timeoutMs: 1_000 }));
	await assert.rejects(provider.search({ query: 'q' }), /request failed/);
});

test('the provider enforces its own deadline', async () => {
	const baseURL = await startInstance((_request, response) => {
		setTimeout(() => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify(SAMPLE));
		}, 250);
	});
	const provider = new SearxngSearchProvider(resolveConfig({ baseURL, timeoutMs: 30 }));
	await assert.rejects(provider.search({ query: 'q' }), /timed out after 30 ms/);
});

test('the provider forwards caller cancellation', async () => {
	const baseURL = await startInstance((_request, response) => {
		setTimeout(() => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify(SAMPLE));
		}, 250);
	});
	const provider = new SearxngSearchProvider(resolveConfig({ baseURL, timeoutMs: 1_000 }));
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 20);
	await assert.rejects(
		provider.search({ query: 'q' }, controller.signal),
		(error) => {
			assert.equal(error.code, 'WEB_ABORTED');
			assert.match(error.message, /aborted/);
			return true;
		}
	);
});

test('the provider reports unresponsive engines when nothing came back', async () => {
	const baseURL = await startInstance((_request, response) => {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({
			results: [],
			unresponsive_engines: [['google', 'timeout'], ['bing', 'error']]
		}));
	});
	const provider = new SearxngSearchProvider(resolveConfig({ baseURL, timeoutMs: 1_000 }));
	await assert.rejects(provider.search({ query: 'q' }), /unresponsive engines: google: timeout, bing: error/);
});

test('the provider rejects a blank query before any request', async () => {
	let requested = false;
	const baseURL = await startInstance((_request, response) => {
		requested = true;
		response.end('{}');
	});
	const provider = new SearxngSearchProvider(resolveConfig({ baseURL }));
	await assert.rejects(provider.search({ query: '   ' }), /non-empty query/);
	assert.equal(requested, false);
});
