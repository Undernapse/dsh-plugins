/**
 * SearXNG search provider policy and mapping.
 *
 * A SearXNG instance exposes a JSON search API at `/search?format=json`. This
 * module owns the request URL, configuration validation, response mapping to
 * the `ctx.web` search vocabulary, and the HTTP client. The provider object
 * itself lives in `index.js` so the network machinery stays testable without a
 * running Harness.
 *
 * @module dsh-web-search-searxng/searxng
 */

/** Default instance URL supplied by the deployment. */
export const DEFAULT_BASE_URL = 'https://searxng.in.undernapse.com';

/** Stable provider id the `web` seam pins with `searchProvider`. */
export const PROVIDER_ID = 'searxng';

/** Default per-search timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** Cap on one result excerpt sent to the model, in characters. */
const MAX_SNIPPET_CHARS = 1_000;

/** Cap on provider answer text, in characters. */
const MAX_ANSWER_CHARS = 2_000;

/** Cap on an HTTP error body kept in a diagnostic message, in characters. */
const MAX_ERROR_BODY_CHARS = 300;

/** Default settings; `resolveConfig` fills every field. */
export const DEFAULTS = Object.freeze({
	baseURL: DEFAULT_BASE_URL,
	categories: 'general',
	language: 'auto',
	safesearch: 0,
	timeoutMs: DEFAULT_TIMEOUT_MS,
	userAgent: 'dsh-web-search-searxng/0.1.0'
});

/** Configuration keys this provider accepts. */
const CONFIG_KEYS = Object.freeze([
	'baseURL',
	'categories',
	'language',
	'safesearch',
	'timeRange',
	'engines',
	'timeoutMs',
	'userAgent'
]);

/** SearXNG time-range values. */
const TIME_RANGES = Object.freeze(['day', 'week', 'month', 'year']);

/**
 * A provider failure carrying the seam's machine-routable code.
 *
 * `WebError` lives in a shipped package that a profile-installed plugin cannot
 * reliably import, so this class mirrors its `code` contract without extending
 * it. Tool execution keeps the message; routing code stays on `error.code`.
 */
export class SearxngSearchError extends Error {
	/**
	 * @param message - actionable failure description.
	 * @param code - seam-compatible code, `WEB_PROVIDER_ERROR` unless aborted.
	 * @param options - standard error options carrying `cause`.
	 */
	constructor(message, code = 'WEB_PROVIDER_ERROR', options) {
		super(message, options);
		this.name = 'SearxngSearchError';
		this.code = code;
	}
}

/** Whether a decoded JSON value is a non-array object. */
function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Cap one string, marking a cut with an ellipsis and keeping surrogate pairs intact.
 * @param text - already-cleaned text.
 * @param maxChars - maximum length including the ellipsis.
 * @returns the text, shortened when necessary.
 */
function capText(text, maxChars) {
	if (text.length <= maxChars) return text;
	let end = maxChars - 1;
	const code = text.charCodeAt(end - 1);
	// Do not split a surrogate pair at the cut.
	if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	return `${text.slice(0, end)}…`;
}

/**
 * Collapse whitespace, trim, and cap one provider string.
 * @param value - candidate text.
 * @param maxChars - maximum length including the ellipsis.
 * @returns cleaned text, or undefined when nothing usable remains.
 */
function cleanText(value, maxChars) {
	if (typeof value !== 'string') return undefined;
	const text = value.replace(/\s+/gu, ' ').trim();
	if (text.length === 0) return undefined;
	return capText(text, maxChars);
}

/**
 * Normalize a provider-supplied date to ISO-8601.
 * @param value - SearXNG's `publishedDate`.
 * @returns an ISO timestamp, or undefined when absent or unparsable.
 */
function isoDate(value) {
	if (typeof value !== 'string' || value.trim().length === 0) return undefined;
	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) return undefined;
	return new Date(timestamp).toISOString();
}

/**
 * Accept only absolute HTTP(S) source URLs.
 * @param value - candidate URL.
 * @returns the normalized URL, or undefined when unsupported.
 */
function httpUrl(value) {
	if (typeof value !== 'string') return undefined;
	let url;
	try {
		url = new URL(value.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
	// SearXNG can emit its own relative redirector with an empty host
	// (`http:///go/v1/...`), which URL parses as host "go". A citeable source
	// needs a resolvable host; a dotless intranet name is not one.
	if (!url.hostname.includes('.') && !url.hostname.includes(':') && url.hostname !== 'localhost') {
		return undefined;
	}
	return url.href;
}

/**
 * Normalize the configured engine list.
 * @param value - a comma-separated string, an array of engine names, or unset.
 * @returns a frozen array of unique, non-empty engine names.
 * @throws {SearxngSearchError} when the value is neither unset, a string, nor an array of strings.
 */
function engineList(value) {
	if (value === undefined || value === null) return Object.freeze([]);
	const parts = typeof value === 'string'
		? value.split(',')
		: Array.isArray(value)
			? value
			: undefined;
	if (parts === undefined) {
		throw new SearxngSearchError('searxng: engines must be a comma-separated string or an array of names');
	}
	const names = [];
	for (const part of parts) {
		if (typeof part !== 'string') {
			throw new SearxngSearchError('searxng: engines must contain only strings');
		}
		const name = part.trim();
		if (name.length > 0 && !names.includes(name)) names.push(name);
	}
	return Object.freeze(names);
}

/**
 * Resolve and validate the provider configuration.
 * @param raw - the plugin row's `config` object; omitted for every default.
 * @returns a detached, frozen policy.
 * @throws {SearxngSearchError} naming the unusable entry.
 */
export function resolveConfig(raw = {}) {
	if (!isRecord(raw)) throw new SearxngSearchError('searxng: config must be an object');
	for (const key of Object.keys(raw)) {
		if (!CONFIG_KEYS.includes(key)) {
			throw new SearxngSearchError(
				`searxng: unknown config key "${key}" (allowed: ${CONFIG_KEYS.join(', ')})`
			);
		}
	}

	const baseURL = raw.baseURL ?? DEFAULTS.baseURL;
	if (typeof baseURL !== 'string' || !URL.canParse(baseURL)) {
		throw new SearxngSearchError('searxng: baseURL must be an absolute HTTP(S) URL');
	}
	const parsedBase = new URL(baseURL);
	if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
		throw new SearxngSearchError(`searxng: baseURL must use http or https, not "${parsedBase.protocol}"`);
	}

	const categories = raw.categories ?? DEFAULTS.categories;
	if (typeof categories !== 'string' || categories.trim().length === 0) {
		throw new SearxngSearchError('searxng: categories must be a non-empty string');
	}

	const language = raw.language ?? DEFAULTS.language;
	if (typeof language !== 'string' || language.trim().length === 0) {
		throw new SearxngSearchError('searxng: language must be a non-empty string');
	}

	const safesearch = raw.safesearch ?? DEFAULTS.safesearch;
	if (!Number.isSafeInteger(safesearch) || safesearch < 0 || safesearch > 2) {
		throw new SearxngSearchError('searxng: safesearch must be 0, 1, or 2');
	}

	const timeRange = raw.timeRange ?? undefined;
	if (timeRange !== undefined && !TIME_RANGES.includes(timeRange)) {
		throw new SearxngSearchError(`searxng: timeRange must be one of ${TIME_RANGES.join(', ')}`);
	}

	const timeoutMs = raw.timeoutMs ?? DEFAULTS.timeoutMs;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
		throw new SearxngSearchError('searxng: timeoutMs must be a positive safe integer');
	}

	const userAgent = raw.userAgent ?? DEFAULTS.userAgent;
	if (typeof userAgent !== 'string' || userAgent.trim().length === 0) {
		throw new SearxngSearchError('searxng: userAgent must be a non-empty string');
	}

	// A base URL may carry basic-auth credentials; diagnostics must not show them.
	const display = new URL(parsedBase.href);
	if (display.username.length > 0 || display.password.length > 0) {
		display.username = 'redacted';
		display.password = 'redacted';
	}

	return Object.freeze({
		baseURL: parsedBase.href,
		displayBaseURL: display.href,
		categories: categories.trim(),
		language: language.trim(),
		safesearch,
		...(timeRange === undefined ? {} : { timeRange }),
		engines: engineList(raw.engines),
		timeoutMs,
		userAgent: userAgent.trim()
	});
}

/**
 * Build the JSON endpoint for one query.
 *
 * A base URL may include a path prefix (`https://host/searx`) and may already
 * end in `/search`; both are preserved without duplication.
 *
 * @param baseURL - validated instance base URL.
 * @param query - non-empty search query.
 * @param options - resolved config.
 * @returns the absolute endpoint URL string.
 */
export function buildSearchUrl(baseURL, query, options) {
	const url = new URL(baseURL);
	const path = url.pathname.replace(/\/+$/u, '');
	url.pathname = path.endsWith('/search') ? path : `${path}/search`;
	url.search = '';
	url.hash = '';
	url.searchParams.set('q', query);
	url.searchParams.set('format', 'json');
	url.searchParams.set('categories', options.categories);
	url.searchParams.set('language', options.language);
	url.searchParams.set('safesearch', String(options.safesearch));
	if (options.timeRange !== undefined) url.searchParams.set('time_range', options.timeRange);
	if (options.engines.length > 0) url.searchParams.set('engines', options.engines.join(','));
	return url.href;
}

/**
 * Render SearXNG's `answers` array as provider answer text.
 * @param answers - string answers or `{ answer }` objects.
 * @returns joined answer text, or undefined when none is usable.
 */
function answerText(answers) {
	if (!Array.isArray(answers)) return undefined;
	const lines = [];
	for (const entry of answers) {
		const raw = typeof entry === 'string'
			? entry
			: isRecord(entry) && typeof entry.answer === 'string'
				? entry.answer
				: undefined;
		const text = cleanText(raw, MAX_ANSWER_CHARS);
		if (text !== undefined && !lines.includes(text)) lines.push(text);
	}
	if (lines.length === 0) return undefined;
	return capText(lines.join('\n\n'), MAX_ANSWER_CHARS);
}

/**
 * Describe engines that failed inside the instance.
 * @param payload - decoded SearXNG response.
 * @returns a compact description, or undefined when every engine answered.
 */
export function unresponsiveEngines(payload) {
	if (!isRecord(payload) || !Array.isArray(payload.unresponsive_engines)) return undefined;
	const parts = [];
	for (const entry of payload.unresponsive_engines) {
		const text = Array.isArray(entry)
			? entry.filter((part) => typeof part === 'string').join(': ')
			: typeof entry === 'string'
				? entry
				: undefined;
		if (text !== undefined && text.length > 0 && !parts.includes(text)) parts.push(text);
	}
	return parts.length === 0 ? undefined : parts.join(', ');
}

/**
 * Map one SearXNG JSON response to the seam's search result.
 *
 * Results without an absolute HTTP(S) URL are skipped, first occurrence wins,
 * and answers become optional provider answer text. The seam owns the final
 * source-count bound, so this function reports `truncated: false`.
 *
 * @param payload - decoded JSON body.
 * @returns normalized sources and optional answer text.
 * @throws {SearxngSearchError} when the body is not a SearXNG search response.
 */
export function mapSearchResponse(payload) {
	if (!isRecord(payload)) {
		throw new SearxngSearchError('SearXNG returned a JSON body that is not an object');
	}
	if (payload.results !== undefined && !Array.isArray(payload.results)) {
		throw new SearxngSearchError('SearXNG returned a response without a results array');
	}

	const sources = [];
	const seen = new Set();
	for (const item of payload.results ?? []) {
		if (!isRecord(item)) continue;
		const url = httpUrl(item.url);
		if (url === undefined || seen.has(url)) continue;
		seen.add(url);
		const title = cleanText(item.title, MAX_SNIPPET_CHARS);
		const snippet = cleanText(item.content, MAX_SNIPPET_CHARS);
		const publishedAt = isoDate(item.publishedDate);
		sources.push({
			url,
			...(title === undefined ? {} : { title }),
			...(snippet === undefined ? {} : { snippet, summary: snippet }),
			...(publishedAt === undefined ? {} : { publishedAt })
		});
	}

	const content = answerText(payload.answers);
	return Object.freeze({
		...(content === undefined ? {} : { content }),
		sources: Object.freeze(sources),
		truncated: false
	});
}

/** True for a DOMException/fetch abort. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === 'AbortError'
		|| (typeof error === 'object' && error !== null && error.name === 'AbortError');
}

/**
 * Render one error and its cause chain for a diagnostic message.
 * @param error - thrown failure.
 * @returns a compact description, deduplicated across repeated wrapper messages.
 */
function failureText(error) {
	const parts = [];
	let current = error;
	for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
		if (current instanceof Error) {
			const code = typeof current.code === 'string' && !current.message.includes(current.code)
				? ` (${current.code})`
				: '';
			if (current.message.length > 0) parts.push(`${current.message}${code}`);
			current = current.cause;
		} else {
			parts.push(String(current));
			break;
		}
	}
	const unique = [...new Set(parts.filter((part) => part.length > 0))];
	return unique.length === 0 ? 'unknown error' : unique.join('; ');
}

/**
 * Translate one transport or body-read failure into a provider error.
 * @param error - thrown failure.
 * @param signal - caller cancellation signal.
 * @param timedOut - whether this provider's own deadline fired.
 * @param timeoutMs - the configured deadline, for the message.
 * @param diagnosticBaseURL - credential-free instance URL for reachability diagnostics.
 * @returns the error to throw.
 */
function operationError(error, signal, timedOut, timeoutMs, diagnosticBaseURL) {
	if (signal?.aborted === true) {
		return new SearxngSearchError(
			'SearXNG search was aborted',
			'WEB_ABORTED',
			{ cause: signal.reason ?? error }
		);
	}
	if (timedOut) {
		return new SearxngSearchError(
			`SearXNG search timed out after ${timeoutMs} ms; raise timeoutMs or check that the instance is reachable`,
			'WEB_PROVIDER_ERROR',
			{ cause: error }
		);
	}
	if (isAbortError(error)) {
		return new SearxngSearchError('SearXNG search was aborted', 'WEB_ABORTED', { cause: error });
	}
	return new SearxngSearchError(
		`SearXNG search request failed: ${failureText(error)}.`
		+ ` Check that baseURL (${diagnosticBaseURL}) is reachable from the Harness host.`,
		'WEB_PROVIDER_ERROR',
		{ cause: error }
	);
}

/**
 * Describe a non-2xx response, including the instance's own explanation.
 * @param response - the failed HTTP response.
 * @param signal - caller cancellation signal.
 * @param timedOut - whether the deadline fired while reading the body.
 * @param timeoutMs - the configured deadline, for the message.
 * @param diagnosticBaseURL - credential-free instance URL for reachability diagnostics.
 * @returns the provider error to throw.
 */
async function httpError(response, signal, timedOut, timeoutMs, diagnosticBaseURL) {
	let detail;
	try {
		detail = cleanText(await response.text(), MAX_ERROR_BODY_CHARS);
	} catch (error) {
		return operationError(error, signal, timedOut, timeoutMs, diagnosticBaseURL);
	}
	const hint = response.status === 403
		? ' The instance may not expose its JSON API; add "json" to `search.formats` in its settings.yml.'
		: '';
	const suffix = detail === undefined ? '' : `: ${detail}`;
	return new SearxngSearchError(
		`SearXNG search failed with HTTP ${response.status}${suffix}.${hint}`,
		'WEB_PROVIDER_ERROR'
	);
}

/**
 * The SearXNG-backed search provider. One instance is registered with
 * `ctx.web`; each search uses the resolved options it was constructed with.
 */
export class SearxngSearchProvider {
	/**
	 * @param options - resolved config.
	 * @param fetchImpl - fetch implementation, injectable for tests.
	 */
	constructor(options, fetchImpl) {
		this.options = options;
		this.fetchImpl = fetchImpl ?? ((...args) => globalThis.fetch(...args));
		this.id = PROVIDER_ID;
		this.title = 'SearXNG';
		this.description = Object.freeze({
			en: 'Metasearch through your SearXNG instance. No API key; result quality and latency depend on the instance and its engines.',
			zh: '通过你的 SearXNG 实例进行元搜索，无需 API Key；结果质量与延迟取决于实例及其搜索引擎。'
		});
	}

	/** Whether the configured endpoint is a usable HTTP(S) URL. */
	available() {
		return URL.canParse(this.options.baseURL);
	}

	/**
	 * Run one search against the instance.
	 * @param request - the seam's search request.
	 * @param signal - caller cancellation.
	 * @returns normalized sources and optional answer text.
	 * @throws {SearxngSearchError} on missing query, transport failure, HTTP failure, or malformed body.
	 */
	async search(request, signal) {
		const query = typeof request?.query === 'string' ? request.query.trim() : '';
		if (query.length === 0) throw new SearxngSearchError('SearXNG search requires a non-empty query');
		if (signal?.aborted === true) {
			throw new SearxngSearchError('SearXNG search was aborted', 'WEB_ABORTED', { cause: signal.reason });
		}

		const endpoint = buildSearchUrl(this.options.baseURL, query, this.options);
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.options.timeoutMs);
		const onAbort = () => controller.abort(signal.reason);
		signal?.addEventListener('abort', onAbort, { once: true });

		try {
			let response;
			try {
				response = await this.fetchImpl(endpoint, {
					method: 'GET',
					headers: {
						accept: 'application/json',
						'user-agent': this.options.userAgent
					},
					signal: controller.signal
				});
			} catch (error) {
				throw operationError(
					error, signal, timedOut, this.options.timeoutMs, this.options.displayBaseURL
				);
			}

			if (!response.ok) {
				throw await httpError(
					response, signal, timedOut, this.options.timeoutMs, this.options.displayBaseURL
				);
			}

			let payload;
			try {
				payload = await response.json();
			} catch (error) {
				throw operationError(
					error, signal, timedOut, this.options.timeoutMs, this.options.displayBaseURL
				);
			}
			const result = mapSearchResponse(payload);
			if (result.sources.length === 0) {
				const failed = unresponsiveEngines(payload);
				if (failed !== undefined) {
					throw new SearxngSearchError(
						`SearXNG returned no results; unresponsive engines: ${failed}`,
						'WEB_PROVIDER_ERROR'
					);
				}
			}
			return result;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
		}
	}
}
