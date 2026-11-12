import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	DEFAULTS,
	countRetainedImages,
	countRetainedImagesAll,
	effectiveImageLimit,
	imageLimitFromFailure,
	planRecovery,
	planTrim,
	resolveConfig,
	selectOldestImages
} from '../lib/budget.js';

/** One retained image block. */
const image = (offloaded = false) => ({ type: 'image', attachment: { attachmentId: 'sha256:abc' }, ...(offloaded ? { offloaded: true } : {}) });
/** One text block. */
const text = (value = 'text') => ({ type: 'text', text: value });

test('resolveConfig fills defaults and rejects unusable entries', () => {
	assert.deepEqual(resolveConfig(), DEFAULTS);
	assert.deepEqual(resolveConfig({ maxImages: 5, recoveryMargin: 0 }), {
		...DEFAULTS,
		maxImages: 5,
		recoveryMargin: 0
	});
	assert.throws(() => resolveConfig({ maxImages: 0 }), /maxImages/);
	assert.throws(() => resolveConfig({ maxImages: 1.5 }), /maxImages/);
	assert.throws(() => resolveConfig({ recoveryMargin: -1 }), /recoveryMargin/);
	assert.throws(() => resolveConfig({ proactive: 'yes' }), /proactive/);
	assert.throws(() => resolveConfig({ maxImage: 3 }), /unknown config key "maxImage"/);
	assert.throws(() => resolveConfig(null), /config must be an object/);
	assert.deepEqual(resolveConfig({ providerLimits: { fake: 24 } }).providerLimits, { fake: 24 });
	assert.throws(() => resolveConfig({ providerLimits: { fake: -1 } }), /providerLimits\.fake/);
	assert.throws(() => resolveConfig({ providerLimits: { '': 5 } }), /non-empty provider routes/);
});

test('effectiveImageLimit prefers provider truth over the fallback', () => {
	assert.equal(effectiveImageLimit({ fallback: 20 }), 20);
	assert.equal(effectiveImageLimit({ declared: 25, fallback: 20 }), 25);
	assert.equal(effectiveImageLimit({ explicit: 30, declared: 25, learned: 24, fallback: 20 }), 24);
	assert.equal(effectiveImageLimit({ learned: 0 }), 0);
	assert.equal(effectiveImageLimit({}), undefined);
});

test('countRetainedImages ignores offloaded occurrences', () => {
	assert.equal(countRetainedImages([image(), text(), image()]), 2);
	assert.equal(countRetainedImages([image(true), image(), image(true)]), 1);
	assert.equal(countRetainedImages(undefined), 0);
	assert.equal(countRetainedImagesAll([[image()], [image(), image(true)]]), 2);
});

test('selectOldestImages indexes images across offloaded holes', () => {
	const entries = [
		{ seq: 1, content: [image(), text(), image(true), image()] },
		{ seq: 2, content: [image(), image()] }
	];
	assert.deepEqual(selectOldestImages(entries, 3), [
		{ seq: 1, imageIndexes: [0, 2] },
		{ seq: 2, imageIndexes: [0] }
	]);
	assert.deepEqual(selectOldestImages(entries, 0), []);
	assert.deepEqual(selectOldestImages(entries, 99).flatMap((target) => target.imageIndexes), [0, 2, 0, 1]);
});

test('planTrim counts the images the step is about to append', () => {
	const entries = [
		{ seq: 1, content: [image(), image()] },
		{ seq: 2, content: [image()] }
	];
	const plan = planTrim({ entries, pendingImages: 0, maxImages: 3 });
	assert.equal(plan.offload, 0);
	const tight = planTrim({ entries, pendingImages: 2, maxImages: 3 });
	assert.equal(tight.retained, 3);
	assert.equal(tight.offload, 2);
	assert.deepEqual(tight.targets, [{ seq: 1, imageIndexes: [0, 1] }]);
});

test('planRecovery keeps a margin below the provider limit', () => {
	const entries = [{ seq: 7, content: Array.from({ length: 30 }, () => image()) }];
	const plan = planRecovery({ entries, limit: 25, margin: 1 });
	assert.equal(plan.offload, 6);
	assert.deepEqual(plan.targets, [{ seq: 7, imageIndexes: [0, 1, 2, 3, 4, 5] }]);
	assert.equal(planRecovery({ entries, limit: 40, margin: 1 }).offload, 0);
	assert.equal(planRecovery({ entries, limit: 0, margin: 0 }).offload, 30);
});

test('imageLimitFromFailure reads the provider phrasings', () => {
	const message = 'litellm.BadRequestError: Hosted_vllmException - {"error":{"message":"At most 25 image(s) may be provided in one prompt. (parameter=image)"}}';
	assert.equal(imageLimitFromFailure({ message, code: 'INVALID_REQUEST' }), 25);
	assert.equal(imageLimitFromFailure({ message: 'You may use a maximum of 10 images per request.', code: 'INVALID_REQUEST' }), 10);
	assert.equal(imageLimitFromFailure({ message: '8 images is the maximum for this model.' }), 8);
	assert.equal(imageLimitFromFailure({ message: 'The images per request limit is 4.' }), 4);
	assert.equal(imageLimitFromFailure({ message: 'unrelated failure' }), undefined);
	assert.equal(imageLimitFromFailure({ message: 'At most 25 image(s)', code: 'CONTEXT_WINDOW_EXCEEDED' }), undefined);
	assert.equal(imageLimitFromFailure(null), undefined);
	assert.equal(imageLimitFromFailure('At most 25 image(s)'), undefined);
});
