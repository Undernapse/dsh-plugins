/**
 * Cross-origin redirect recovery for `web_fetch`.
 *
 * The shipped HTTP fetch provider deliberately stops at a cross-origin
 * redirect, so the model would otherwise have to retry against a URL it cannot
 * see in full (the provider's message names only the target origin). This
 * helper follows the redirect chain with header-only requests and returns the
 * final URL; the caller then fetches that URL through `ctx.web.fetch`, which
 * retrieves it normally.
 *
 * @module dsh-web-search-searxng/redirect
 */

/** Redirect statuses a GET request may follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Default redirect-hop cap, matching the shipped fetch provider. */
export const DEFAULT_MAX_REDIRECTS = 5;

/** `User-Agent` used for the header probe; matches the shipped provider's product UA. */
export const PROBE_USER_AGENT = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)';

/** Release a response body without letting a cancellation failure abort the probe. */
async function cancelBody(response) {
	try {
		await response.body?.cancel?.();
	} catch {
		// The redirect status and Location are already enough for this hop.
	}
}

/** Whether a status is a redirect this helper follows. */
export function isRedirectStatus(status) {
	return REDIRECT_STATUSES.has(status);
}

/**
 * Resolve a `Location` header against the URL that returned it.
 * @param location - the raw header value.
 * @param base - the URL that returned the redirect.
 * @returns the absolute HTTP(S) target, or undefined for an unusable target.
 */
export function resolveRedirectTarget(location, base) {
	if (typeof location !== 'string' || location.length === 0) return undefined;
	let url;
	try {
		url = new URL(location, base);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
	return url;
}

/**
 * Follow a redirect chain with header-only GET requests and return the final
 * URL when at least one redirect was crossed.
 *
 * Only the URL is returned: the caller re-fetches it through the web service so
 * decoding, content limits, and response presentation stay owned by the shipped
 * provider and tool. A chain with no redirect, an unusable target, or an
 * exhausted hop budget returns undefined and the caller keeps the original
 * failure.
 *
 * @param startUrl - the URL the tool originally requested.
 * @param options.signal - caller cancellation.
 * @param options.maxRedirects - maximum hops to follow.
 * @param options.fetchImpl - fetch implementation, injectable for tests.
 * @param options.userAgent - probe `User-Agent`.
 * @returns the final URL, or undefined when following is not possible or not needed.
 */
export async function followCrossOriginRedirects(startUrl, options = {}) {
	const {
		signal,
		maxRedirects = DEFAULT_MAX_REDIRECTS,
		fetchImpl = (...args) => globalThis.fetch(...args),
		userAgent = PROBE_USER_AGENT
	} = options;

	let current;
	try {
		current = new URL(startUrl);
	} catch {
		return undefined;
	}
	if (current.protocol !== 'http:' && current.protocol !== 'https:') return undefined;

	let redirected = false;
	for (let hops = 0; hops <= maxRedirects; hops += 1) {
		if (signal?.aborted === true) return undefined;
		const response = await fetchImpl(current.href, {
			method: 'GET',
			redirect: 'manual',
			headers: {
				accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
				'user-agent': userAgent
			},
			...(signal === undefined ? {} : { signal })
		});
		if (!isRedirectStatus(response.status)) {
			await cancelBody(response);
			return redirected ? current.href : undefined;
		}
		const target = resolveRedirectTarget(response.headers.get('location'), current);
		await cancelBody(response);
		if (target === undefined) return undefined;
		current = target;
		redirected = true;
	}
	return undefined;
}
