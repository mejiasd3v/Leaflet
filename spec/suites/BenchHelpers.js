import {expect} from 'chai';

// Sanity helpers for report-only benchmark specs. These avoid flaky
// performance thresholds under full-suite load while still catching
// broken harnesses (NaN, empty samples, etc.).

export function assertPositiveFiniteMs(value, label = 'ms') {
	expect(Number.isFinite(value), `${label} must be finite`).to.be.true;
	expect(value, `${label} must be > 0`).to.be.greaterThan(0);
}

export function assertBenchSamples(times, label = 'bench samples') {
	expect(times, `${label} must be a non-empty array`).to.be.an('array').that.is.not.empty;
	for (const sample of times) {
		expect(Number.isFinite(sample), `${label} must be finite`).to.be.true;
		expect(sample, `${label} must be >= 0`).to.be.at.least(0);
	}
}
