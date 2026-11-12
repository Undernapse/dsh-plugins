/**
 * Image budget — keep every model request under a configurable image cap.
 *
 * Image-capable routes can refuse a request that carries too many images
 * ("At most 25 image(s) may be provided in one prompt"), and a provider that
 * does so fails the whole turn. This plugin keeps the model-visible surface
 * below the cap instead: before each step it records the session's durable
 * `image/offload` decision for the oldest retained occurrences, so later
 * requests carry a stable placeholder with the attachment identity and its
 * read-only local path instead of the image bytes. The model can re-open the
 * path with `read_image` when it still needs the picture.
 *
 * It also recovers when a provider reports a tighter limit than the local
 * policy assumed: the same durable decision is recorded for the oldest
 * occurrences and the request is retried, instead of failing the turn.
 *
 * @module dsh-image-budget
 */

import {
	countRetainedImagesAll,
	effectiveImageLimit,
	imageLimitFromFailure,
	planRecovery,
	planTrim,
	resolveConfig,
	selectOldestImages
} from './lib/budget.js';

export const name = 'image-budget';
export const inject = ['agents', 'sessions'];

/** Durable event type owned by `@deepseek-ai/dsh-compaction-image-offload`. */
const IMAGE_OFFLOAD = 'image/offload';

/** Surface event types that may carry input images. */
const IMAGE_BEARING_EVENT_TYPES = new Set(['user/message', 'tool/result']);

// ---------------------------------------------------------------------------
// Fallback projection
//
// `@deepseek-ai/dsh-compaction-image-offload` registers this projection in the
// shipped base bundle, and a profile that keeps that plugin never reaches this
// copy. The fallback exists so the budget still works in a profile that
// disables the built-in plugin: replaying a session that contains our
// `image/offload` events must stay possible.
// ---------------------------------------------------------------------------

/** Deep-freeze one JSON value. */
function deepFreeze(value) {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

/** Whether a durable value is a JSON object. */
function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a durable occurrence index or sequence is canonical. */
function isIndex(value) {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

/**
 * Mark selected image occurrences of one message as permanently offloaded.
 * @param message - message projected so far.
 * @param indexes - nonempty, strictly increasing depth-first image indexes.
 * @returns an immutable message with the same identity and selected images marked.
 * @throws when a selected occurrence is missing or already offloaded.
 */
function offloadMessageImages(message, indexes) {
	let imageIndex = 0;
	let selected = 0;
	let content;
	for (const [index, block] of message.content.entries()) {
		let projected = block;
		if (block.type === 'image') {
			if (imageIndex === indexes[selected]) {
				if (block.offloaded === true) {
					throw new Error(`image/offload: image index ${imageIndex} is already offloaded`);
				}
				projected = { ...block, offloaded: true };
				selected += 1;
			}
			imageIndex += 1;
		}
		if (projected !== block) content ??= message.content.slice(0, index);
		content?.push(projected);
	}
	if (selected !== indexes.length) {
		throw new Error(`image/offload: image index ${indexes[selected]} does not exist`);
	}
	return deepFreeze({ ...message, content: content ?? message.content });
}

/** Atomic validation and reconstruction shared by live sessions and detached replay. */
export const imageOffloadProjection = {
	type: IMAGE_OFFLOAD,
	project(event, context) {
		const data = event.data;
		if (!isRecord(data) || Object.keys(data).length !== 1
			|| !Array.isArray(data.targets) || data.targets.length === 0) {
			throw new Error('image/offload: data must contain a nonempty targets array');
		}
		const messages = new Map();
		const nodes = new Set(context.nodes);
		for (const target of data.targets) {
			if (!isRecord(target) || Object.keys(target).length !== 2 || !isIndex(target.seq)
				|| !Array.isArray(target.imageIndexes) || target.imageIndexes.length === 0) {
				throw new Error('image/offload: each target must contain a seq and nonempty imageIndexes');
			}
			const seq = target.seq;
			if (messages.has(seq)) throw new Error(`image/offload: duplicate target seq ${seq}`);
			if (!nodes.has(seq)) throw new Error(`image/offload: target seq ${seq} is not a current surface node`);
			const source = context.events[seq - context.baseSeq];
			if (source?.type !== 'user/message' && source?.type !== 'tool/result') {
				throw new Error(`image/offload: target seq ${seq} must be user/message or tool/result`);
			}
			let previous = -1;
			for (const index of target.imageIndexes) {
				if (!isIndex(index) || index <= previous) {
					throw new Error('image/offload: imageIndexes must be strictly increasing non-negative safe integers');
				}
				previous = index;
			}
			const message = context.messages.get(seq)
				?? (source.type === 'user/message' ? source.data : source.data.message);
			messages.set(seq, offloadMessageImages(message, target.imageIndexes));
		}
		return messages;
	}
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/** One-line diagnostic for a caught value. */
function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Mount proactive trimming and provider-error recovery.
 * @param ctx - the plugin context.
 * @param rawConfig - the row's configuration, omitted for every default.
 */
export function apply(ctx, rawConfig) {
	const config = resolveConfig(rawConfig);

	// The shipped image-offload plugin registers the same projection. Register
	// ours only when no owner is present, so a profile that disables it still
	// replays the events this plugin writes.
	const ensureProjection = () => {
		if (ctx.sessions.messageProjections.some((projection) => projection.type === IMAGE_OFFLOAD)) return;
		try {
			ctx.sessions.registerMessageProjection(imageOffloadProjection);
		} catch (error) {
			// Another plugin owns the event type; its definition is authoritative.
			ctx.logger.info(`image-budget: keeping the registered ${IMAGE_OFFLOAD} projection (${describe(error)})`);
		}
	};
	ensureProjection();

	/**
	 * Model-ordered image-bearing messages of the live surface.
	 * @param session - the session whose surface is read.
	 * @param seqs - surface sequences to consider; defaults to the whole surface.
	 * @returns `{ seq, content }` entries in surface order.
	 */
	const imageEntries = (session, seqs = session.surface.nodes) => {
		const entries = [];
		for (const seq of seqs) {
			const event = session.eventAt(seq);
			if (event === undefined || !IMAGE_BEARING_EVENT_TYPES.has(event.type)) continue;
			const message = session.deriveEventMessage(event);
			if (message === null) continue;
			entries.push({ seq, content: message.content });
		}
		return entries;
	};

	/**
	 * Record one durable offload decision for selected occurrences.
	 * @param session - session whose next request applies the decision.
	 * @param targets - selected occurrences, in model order.
	 */
	const offload = (session, targets) => {
		ensureProjection();
		session.append(IMAGE_OFFLOAD, { targets });
	};

	/** Image limits this plugin learned from provider failures, keyed by route. */
	const learnedLimits = new Map();

	/**
	 * Read the image limit a mounted adapter declares in its own configuration.
	 * Providers that keep their budget elsewhere (or state none) return
	 * `undefined`, and the limit is then learned from the provider's error.
	 * @param provider - provider route id.
	 * @returns the declared limit, or undefined when the adapter states none.
	 */
	const declaredLimit = (provider) => {
		try {
			const loader = ctx.get('loader');
			for (const entry of loader?.entries?.() ?? []) {
				const raw = entry.options?.config;
				if (raw === null || typeof raw !== 'object') continue;
				if (entry.options?.name === '@deepseek-ai/dsh-llm-pi-ai') {
					const limit = raw.providers?.[provider]?.maxRequestImages;
					if (Number.isSafeInteger(limit) && limit > 0) return limit;
				} else if (entry.options?.name === '@deepseek-ai/dsh-llm-deepseek') {
					const limit = raw.maxImagesPerRequest;
					if (Number.isSafeInteger(limit) && limit > 0) return limit;
				}
			}
		} catch (error) {
			ctx.logger.warn(`image-budget: cannot read the provider image limit: ${describe(error)}`);
		}
		return undefined;
	};

	/**
	 * Resolve the image limit for one route, provider truth first.
	 * @param provider - provider route id.
	 * @returns the effective limit, or undefined when the provider states none.
	 */
	const routeLimit = (provider) => effectiveImageLimit({
		explicit: config.providerLimits[provider],
		declared: declaredLimit(provider),
		learned: learnedLimits.get(provider),
		fallback: config.maxImages
	});

	/**
	 * Remember the tightest limit a provider has stated.
	 * @param provider - provider route id.
	 * @param limit - the images per request the provider accepts.
	 */
	const learn = (provider, limit) => {
		if (typeof provider !== 'string' || provider.length === 0) return;
		if (!Number.isSafeInteger(limit) || limit < 0) return;
		const previous = learnedLimits.get(provider);
		if (previous === undefined || limit < previous) learnedLimits.set(provider, limit);
	};

	/**
	 * Keep the forthcoming request within the route's image limit.
	 * @param session - session about to build a request.
	 * @param pendingImages - retained images the step's own messages add.
	 * @param provider - route the request will use.
	 * @returns how many occurrences were offloaded.
	 */
	const trim = (session, pendingImages, provider) => {
		const limit = routeLimit(provider);
		if (limit === undefined) return 0;
		const plan = planTrim({ entries: imageEntries(session), pendingImages, maxImages: limit });
		if (plan.offload === 0 || plan.targets.length === 0) return 0;
		offload(session, plan.targets);
		ctx.logger.info(
			`image-budget: offloaded ${plan.offload} oldest image(s); `
			+ `${plan.retained - plan.offload + pendingImages} retained within the ${limit}-image provider limit`
		);
		return plan.offload;
	};

	/**
	 * Recover one provider failure that states an image limit. A stated limit is
	 * remembered for the route so later steps stay under it.
	 * @param session - session whose failed request is being repaired.
	 * @param seqs - message events of the failed request, in model order.
	 * @param failure - rendered provider facts.
	 * @param provider - route the failed request used.
	 * @returns whether a durable decision was recorded.
	 */
	const recover = (session, seqs, failure, provider) => {
		const entries = imageEntries(session, seqs);
		const stated = imageLimitFromFailure(failure);
		if (stated !== undefined) learn(provider, stated);
		const requested = failure?.offloadImages;
		if (stated === undefined && Number.isSafeInteger(requested) && requested > 0) {
			const retained = countRetainedImagesAll(entries.map((entry) => entry.content));
			const targets = selectOldestImages(entries, requested);
			if (targets.length === 0) return false;
			learn(provider, Math.max(0, retained - requested));
			offload(session, targets);
			ctx.logger.info(`image-budget: adapter requested ${requested} more offload(s); retrying`);
			return true;
		}
		const limit = stated ?? routeLimit(provider);
		if (limit === undefined) return false;
		const plan = planRecovery({ entries, limit, margin: config.recoveryMargin });
		if (plan.offload === 0 || plan.targets.length === 0) return false;
		offload(session, plan.targets);
		ctx.logger.info(
			`image-budget: provider accepts at most ${limit} image(s); offloaded ${plan.offload} oldest `
			+ `and retrying with ${plan.retained - plan.offload}`
		);
		return true;
	};

	ctx.on('agent/pre-step', async ({ agent, messages, signal, modelSelection }, next) => {
		const decision = await next();
		if (decision.kind === 'reject' || !config.proactive || signal.aborted) return decision;
		try {
			const pendingImages = countRetainedImagesAll(
				(decision.messages ?? messages).map((message) => message.content)
			);
			trim(agent.session, pendingImages, modelSelection?.provider);
		} catch (error) {
			// A failed trim must never fail the step; the provider-error path can
			// still recover a request the untrimmed surface sends.
			ctx.logger.warn(`image-budget: proactive trim failed: ${describe(error)}; continuing the step`);
		}
		return decision;
	});

	ctx.on('agent/request-error', async ({ agent, failure, provider, signal }, next) => {
		if (!config.recoverFromProviderErrors || signal.aborted) return next();
		const requested = failure?.offloadImages;
		if (imageLimitFromFailure(failure) === undefined && !(Number.isSafeInteger(requested) && requested > 0)) return next();
		try {
			if (!recover(agent.session, agent.session.surface.nodes, failure, provider)) return next();
		} catch (error) {
			ctx.logger.warn(`image-budget: provider-limit recovery failed: ${describe(error)}; keeping the original error`);
			return next();
		}
		return { kind: 'retry' };
	});

	ctx.on('compaction/summary-error', ({ session, sourceEventSeqs, error, signal }, next) => {
		if (!config.recoverFromProviderErrors || signal?.aborted === true) return next();
		const failure = error?.failure ?? error;
		const requested = failure?.offloadImages;
		if (imageLimitFromFailure(failure) === undefined && !(Number.isSafeInteger(requested) && requested > 0)) return next();
		try {
			const provider = session.requestHeader()?.config?.provider;
			return recover(session, sourceEventSeqs, failure, provider);
		} catch (caught) {
			ctx.logger.warn(`image-budget: summary recovery failed: ${describe(caught)}; keeping the original error`);
			return next();
		}
	});
}
