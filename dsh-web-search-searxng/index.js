/**
 * SearXNG web search — register a `searxng` search provider with `ctx.web`.
 *
 * The shipped `web_search` tool asks the `web` seam for a provider, so this
 * plugin adds no model-facing tool of its own. The bundle patch pins
 * `searchProvider: searxng` while preserving the deployment's `http` fetch
 * provider, which makes the model's existing `web_search` call run against the
 * configured SearXNG instance.
 *
 * It also recovers `web_fetch` calls that the shipped fetch provider stops at a
 * cross-origin redirect: the final URL is resolved with header-only requests and
 * fetched through the same web service, so decoding and limits stay owned by
 * the shipped provider.
 *
 * @module dsh-web-search-searxng
 */

import { followCrossOriginRedirects } from './lib/redirect.js';
import { PROVIDER_ID, SearxngSearchProvider, resolveConfig } from './lib/searxng.js';

export { SearxngSearchProvider, resolveConfig } from './lib/searxng.js';
export { followCrossOriginRedirects, resolveRedirectTarget } from './lib/redirect.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng';

/** The web seam this provider registers into. */
export const inject = ['web', 'tools'];

/** Describe one thrown value for a log line. */
function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a failed tool result is the shipped fetch provider's cross-origin
 * redirect refusal. The code is authoritative; the message check keeps the
 * recovery working across a provider that reports only text.
 */
function isCrossOriginRedirectFailure(result) {
	if (result?.isError !== true) return false;
	if (result.error?.info?.code === 'WEB_REDIRECT_BLOCKED') return true;
	return /cross-origin redirect to/i.test(result.error?.message ?? '');
}

/**
 * Project one seam fetch result into the `web_fetch` tool's output schema.
 * @param result - result returned by `ctx.web.fetch`.
 * @returns the value the tool definition renders.
 */
function fetchedToolValue(result) {
	return {
		url: result.url,
		statusCode: result.statusCode,
		body: { kind: result.body.kind, content: result.body.content },
		truncated: result.truncated
	};
}

/**
 * Register the SearXNG search provider and the cross-origin fetch recovery.
 *
 * Configuration is validated before registration so an unusable endpoint
 * fails the plugin row at activation instead of every later search. The web
 * registry ties the provider registration to this plugin's fiber, and the
 * `tools/execute` wrapper is removed on disposal.
 *
 * @param ctx - plugin context; `ctx.web` and `ctx.tools` are present because of {@link inject}.
 * @param rawConfig - the row's `config` object, omitted for every default.
 * @throws {SearxngSearchError} when the configuration is unusable.
 */
export function apply(ctx, rawConfig) {
	const options = resolveConfig(rawConfig ?? {});
	ctx.web.registerSearchProvider(new SearxngSearchProvider(options));

	// The shipped HTTP fetch provider refuses a cross-origin redirect and names
	// only the target origin, so the model cannot retry against the full URL.
	// Recover that failed call by resolving the chain and fetching the final URL
	// through the same seam. The wrapper replaces the failure with an ordinary
	// successful result, rendered by the tool's own output definition so
	// downstream post-execute policy still runs.
	ctx.on('tools/execute', async (exec, next) => {
		const result = await next();
		if (exec?.name !== 'web_fetch' || !isCrossOriginRedirectFailure(result)) return result;
		const original = exec.arguments?.url;
		if (typeof original !== 'string' || original.length === 0 || exec.signal?.aborted === true) {
			return result;
		}
		try {
			const target = await followCrossOriginRedirects(original, { signal: exec.signal });
			if (target === undefined) return result;
			const fetched = await ctx.web.fetch({ url: target }, exec.signal);
			if (fetched?.body?.kind !== 'html' && fetched?.body?.kind !== 'text') return result;
			const tool = ctx.tools.get('web_fetch', exec.agent, exec.toolSet);
			if (tool?.output?.render === undefined) return result;
			const value = fetchedToolValue(fetched);
			const content = tool.output.render(exec.arguments, value);
			const meta = tool.output.presentationMeta?.(exec.arguments, value);
			ctx.logger.info(
				`web-search-searxng: followed a web_fetch cross-origin redirect to ${new URL(target).origin}`
			);
			return {
				isError: false,
				value,
				content,
				...(meta === undefined ? {} : { meta })
			};
		} catch (error) {
			ctx.logger.warn(`web-search-searxng: cross-origin redirect recovery failed: ${describe(error)}`);
			return result;
		}
	});

	ctx.logger.info(`web-search-searxng: registered "${PROVIDER_ID}" for ${options.displayBaseURL}`);
}
