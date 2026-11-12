/**
 * Pure image-budget planning shared by the plugin and its tests.
 *
 * The plugin never rewrites message content. It selects the oldest retained
 * image occurrences of the current model-visible surface, so the session's
 * `image/offload` projection can replace them with path references on the
 * next derived request. These helpers therefore only count and select; the
 * session owns durability.
 *
 * @module dsh-image-budget/budget
 */

/**
 * Default policy. Every image limit comes from the provider route: its
 * declared configuration first, then the limit it states when it rejects a
 * request. `maxImages` is only a fallback for routes that never state one.
 */
export const DEFAULTS = Object.freeze({
	/** Explicit per-provider overrides, keyed by provider route. */
	providerLimits: Object.freeze({}),
	/** Spare images kept below a known hard limit. */
	recoveryMargin: 1,
	/** Keep the surface within the resolved limit before every model request. */
	proactive: true,
	/** Recover from provider errors that name an image limit. */
	recoverFromProviderErrors: true
});

/** Configuration keys this plugin accepts. */
const CONFIG_KEYS = Object.freeze(['providerLimits', 'maxImages', 'recoveryMargin', 'proactive', 'recoverFromProviderErrors']);

/**
 * Resolve the effective limit for one route.
 *
 * A known limit — explicit override, adapter declaration, or a limit the
 * provider itself stated — always wins over the `maxImages` fallback. Several
 * known limits resolve to the smallest, because any of them can refuse the
 * request.
 *
 * @param options.explicit - configured per-route override.
 * @param options.declared - limit read from the mounted adapter's configuration.
 * @param options.learned - limit the provider stated in an earlier failure.
 * @param options.fallback - `maxImages`, used only when nothing else is known.
 * @returns the images a request may carry, or `undefined` when unknown.
 */
export function effectiveImageLimit({ explicit, declared, learned, fallback }) {
	const known = [explicit, declared, learned].filter((value) => Number.isSafeInteger(value) && value >= 0);
	if (known.length > 0) return Math.min(...known);
	return Number.isSafeInteger(fallback) && fallback >= 1 ? fallback : undefined;
}

/**
 * Resolve and validate the plugin configuration.
 * @param raw - the row's `config` object, omitted for every default.
 * @returns a detached, deeply immutable policy.
 * @throws when a key or value is unusable, naming the offending entry.
 */
export function resolveConfig(raw = {}) {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error('image-budget: config must be an object');
	}
	for (const key of Object.keys(raw)) {
		if (!CONFIG_KEYS.includes(key)) {
			throw new Error(`image-budget: unknown config key "${key}" (allowed: ${CONFIG_KEYS.join(', ')})`);
		}
	}
	const providerLimits = Object.freeze({ ...(raw.providerLimits ?? DEFAULTS.providerLimits) });
	for (const [provider, limit] of Object.entries(providerLimits)) {
		if (provider.length === 0) throw new Error('image-budget: providerLimits keys must be non-empty provider routes');
		if (!Number.isSafeInteger(limit) || limit < 0) {
			throw new Error(`image-budget: providerLimits.${provider} (${String(limit)}) must be a non-negative safe integer`);
		}
	}
	const maxImages = raw.maxImages;
	if (maxImages !== undefined && (!Number.isSafeInteger(maxImages) || maxImages < 1)) {
		throw new Error(`image-budget: maxImages (${String(maxImages)}) must be a positive safe integer`);
	}
	const recoveryMargin = raw.recoveryMargin ?? DEFAULTS.recoveryMargin;
	if (!Number.isSafeInteger(recoveryMargin) || recoveryMargin < 0) {
		throw new Error(`image-budget: recoveryMargin (${String(recoveryMargin)}) must be a non-negative safe integer`);
	}
	const proactive = raw.proactive ?? DEFAULTS.proactive;
	const recoverFromProviderErrors = raw.recoverFromProviderErrors ?? DEFAULTS.recoverFromProviderErrors;
	for (const [key, value] of [['proactive', proactive], ['recoverFromProviderErrors', recoverFromProviderErrors]]) {
		if (typeof value !== 'boolean') throw new Error(`image-budget: ${key} (${String(value)}) must be a boolean`);
	}
	return Object.freeze({
		providerLimits,
		recoveryMargin,
		proactive,
		recoverFromProviderErrors,
		...maxImages === undefined ? {} : { maxImages }
	});
}

/**
 * Count the images one content list would still send to the model.
 * @param content - typed model content blocks; a missing list holds none.
 * @returns the number of image blocks without an `offloaded` mark.
 */
export function countRetainedImages(content) {
	let count = 0;
	if (!Array.isArray(content)) return count;
	for (const block of content) {
		if (block?.type === 'image' && block.offloaded !== true) count += 1;
	}
	return count;
}

/**
 * Sum the retained images of several content lists.
 * @param contents - one content list per message, in model order.
 * @returns the total retained image count.
 */
export function countRetainedImagesAll(contents) {
	let count = 0;
	for (const content of contents) count += countRetainedImages(content);
	return count;
}

/**
 * Select the oldest retained image occurrences of model-ordered messages.
 *
 * Image indexes count every image block of one message, including occurrences
 * an earlier decision already offloaded, because that is the coordinate the
 * session's `image/offload` projection expects.
 *
 * @param entries - model-ordered `{ seq, content }` messages; assistant nodes are excluded by the caller.
 * @param count - how many retained occurrences to select; zero selects none.
 * @returns one target per touched message, each with strictly increasing indexes;
 *   fewer than `count` selections when the surface holds fewer retained images.
 */
export function selectOldestImages(entries, count) {
	const targets = [];
	let remaining = count;
	for (const entry of entries) {
		if (remaining <= 0) break;
		if (!Array.isArray(entry.content)) continue;
		const indexes = [];
		let imageIndex = 0;
		for (const block of entry.content) {
			if (block?.type !== 'image') continue;
			if (block.offloaded !== true) {
				indexes.push(imageIndex);
				remaining -= 1;
				if (remaining === 0) break;
			}
			imageIndex += 1;
		}
		if (indexes.length > 0) targets.push({ seq: entry.seq, imageIndexes: indexes });
	}
	return targets;
}

/**
 * Plan one proactive trim that makes room for images about to be appended.
 * @param options.entries - current model-ordered surface messages.
 * @param options.pendingImages - retained images in the messages this step will append.
 * @param options.maxImages - the request budget.
 * @returns retained count, how many to offload, and the selected targets.
 */
export function planTrim({ entries, pendingImages, maxImages }) {
	const retained = countRetainedImagesAll(entries.map((entry) => entry.content));
	const excess = retained + pendingImages - maxImages;
	if (excess <= 0) return { retained, offload: 0, targets: [] };
	const offload = Math.min(excess, retained);
	if (offload === 0) return { retained, offload: 0, targets: [] };
	return { retained, offload, targets: selectOldestImages(entries, offload) };
}

/**
 * Plan one recovery trim after a provider rejected an over-limit request.
 * @param options.entries - the failed request's model-ordered messages.
 * @param options.limit - the provider's stated image limit.
 * @param options.margin - spare images to keep below that limit.
 * @returns retained count, how many to offload, and the selected targets.
 */
export function planRecovery({ entries, limit, margin }) {
	const retained = countRetainedImagesAll(entries.map((entry) => entry.content));
	const keep = Math.max(0, limit - Math.max(0, margin));
	const offload = Math.max(0, retained - keep);
	if (offload === 0) return { retained, offload: 0, targets: [] };
	return { retained, offload, targets: selectOldestImages(entries, offload) };
}

/**
 * Provider phrasings that name an image-per-request limit. Each capture group
 * is the limit itself.
 */
const IMAGE_LIMIT_PATTERNS = Object.freeze([
	/\bat most\s+(\d+)\s+image(?:\(s\)|s)?\b/i,
	/\b(?:maximum|max)(?:\s+(?:number|count))?(?:\s+of)?\s+(\d+)\s+images?\b/i,
	/\b(\d+)\s+images?\s+(?:is|are)\s+(?:the\s+)?(?:maximum|max)\b/i,
	/\bimages?\s+per\s+(?:prompt|request|message)\b[^\n.]{0,40}?\b(?:is|of|:)\s*(\d+)\b/i
]);

/** Failure codes that never describe an image-count limit. */
const NON_IMAGE_FAILURE_CODES = Object.freeze(new Set([
	'ABORTED',
	'AUTH',
	'CONTEXT_WINDOW_EXCEEDED',
	'MISSING_CREDENTIAL',
	'QUOTA_EXCEEDED',
	'RATE_LIMIT',
	'TIMEOUT',
	'TRANSPORT'
]));

/**
 * Extract the image limit a provider failure states, when it names one.
 * @param failure - `{ message, code? }` rendered provider facts, or anything thrown.
 * @returns the stated limit, or `undefined` when this is not an image-limit failure.
 */
export function imageLimitFromFailure(failure) {
	if (failure === null || typeof failure !== 'object') return undefined;
	const message = typeof failure.message === 'string' ? failure.message : '';
	if (message.length === 0) return undefined;
	const code = typeof failure.code === 'string' ? failure.code : undefined;
	if (code !== undefined && NON_IMAGE_FAILURE_CODES.has(code)) return undefined;
	for (const pattern of IMAGE_LIMIT_PATTERNS) {
		const match = pattern.exec(message);
		if (match === null) continue;
		const limit = Number(match[1]);
		if (Number.isSafeInteger(limit) && limit >= 0) return limit;
	}
	return undefined;
}
