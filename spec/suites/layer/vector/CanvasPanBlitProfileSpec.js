import {expect} from 'chai';
import {CircleMarker, LeafletMap, Point} from 'leaflet';
import {createContainer} from '../../SpecHelper.js';

const WARMUP = 10;
const SAMPLES = 30;
const PAN_DIAGONAL = [73, 41];

function median(values) {
	const sorted = values.toSorted((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ?
		(sorted[mid - 1] + sorted[mid]) / 2 :
		sorted[mid];
}

function addGridMarkers(map, count) {
	const size = map.getSize();
	const cols = 100;
	const rows = Math.ceil(count / cols);
	const cellW = size.x / cols;
	const cellH = size.y / rows;

	for (let i = 0; i < count; i++) {
		const col = i % cols;
		const row = Math.floor(i / cols);
		const point = new Point(col * cellW + cellW * 0.5, row * cellH + cellH * 0.5);
		new CircleMarker(map.layerPointToLatLng(point), {
			radius: 5,
			fill: true,
			fillColor: '#3388ff',
			fillOpacity: 0.8,
			stroke: false,
			interactive: false
		}).addTo(map);
	}
}

function settleRenderer(renderer) {
	cancelAnimationFrame(renderer._redrawRequest);
	renderer._redrawRequest = null;
	renderer._redrawBounds = null;
	renderer._redraw();
	renderer._saveSettleState();
}

function setupMarkerMap(container) {
	const map = new LeafletMap(container, {
		preferCanvas: true,
		zoomControl: false,
		attributionControl: false
	});
	map.setView([20.0, 0.0], 5);
	addGridMarkers(map, 10000);
	settleRenderer(map._renderer);
	return map;
}

function collectProfileMedians(map, panOffset) {
	const renderer = map._renderer;
	const blit = [];
	const scanUpdate = [];
	const reindex = [];
	const strip = [];
	const wall = [];
	const stripCandidates = [];

	for (let i = 0; i < WARMUP + SAMPLES; i++) {
		const flip = Math.floor(i / 2) % 2 === 0 ? 1 : -1;
		renderer._profilePanBlit = true;
		renderer._disablePanBlit = false;
		renderer._disableClipSkip = false;
		renderer._panStripDrawExperiment = null;

		const start = performance.now();
		map.panBy([panOffset[0] * flip, panOffset[1] * flip], {animate: false});
		const wallMs = Math.max(performance.now() - start, 0.001);

		if (i < WARMUP) { continue; }

		const p = renderer._lastPanBlitProfile;
		expect(p?.panBlitUsed, `sample ${i} missed pan-blit path`).to.be.true;
		blit.push(p.blitMs);
		scanUpdate.push(p.scanUpdateMs);
		reindex.push(p.reindexMs);
		strip.push(p.stripMs);
		wall.push(wallMs);
		stripCandidates.push(p.stripCandidateCount);
	}

	return {
		blitMs: median(blit),
		scanUpdateMs: median(scanUpdate),
		reindexMs: median(reindex),
		stripMs: median(strip),
		wallMs: median(wall),
		stripCandidateCount: median(stripCandidates)
	};
}

function collectStripExperimentMedians(map, panOffset, experiment) {
	const renderer = map._renderer;
	const strip = [];
	const stripCandidates = [];

	for (let i = 0; i < WARMUP + SAMPLES; i++) {
		const flip = Math.floor(i / 2) % 2 === 0 ? 1 : -1;
		renderer._profilePanBlit = true;
		renderer._disablePanBlit = false;
		renderer._disableClipSkip = false;
		renderer._panStripDrawExperiment = experiment;

		map.panBy([panOffset[0] * flip, panOffset[1] * flip], {animate: false});

		if (i < WARMUP) { continue; }

		const p = renderer._lastPanBlitProfile;
		expect(p?.panBlitUsed, `sample ${i} missed pan-blit path`).to.be.true;
		strip.push(p.stripMs);
		stripCandidates.push(p.stripCandidateCount);
	}

	renderer._panStripDrawExperiment = null;

	return {
		stripMs: median(strip),
		stripCandidateCount: median(stripCandidates)
	};
}

describe('Canvas pan blit profiling', () => {
	let container;
	let map;
	let renderer;

	beforeEach(() => {
		container = createContainer('1280px', '720px');
		map = setupMarkerMap(container);
		renderer = map._renderer;
		map.panBy(PAN_DIAGONAL, {animate: false});
	});

	afterEach(() => {
		if (container?.parentNode) {
			container.parentNode.removeChild(container);
		}
		container = null;
		map = null;
		renderer = null;
	});

	it('P1 settle-path breakdown (30 medians)', () => {
		const medians = collectProfileMedians(map, PAN_DIAGONAL);

		console.log(`BENCH_RESULT ${JSON.stringify({
			scenario: 'P1-profile-breakdown',
			pan: PAN_DIAGONAL,
			samples: SAMPLES,
			...medians,
			hardwareConcurrency: navigator.hardwareConcurrency
		})}`);

		expect(medians.stripCandidateCount, JSON.stringify(medians)).to.be.greaterThan(200);
		expect(medians.stripMs).to.be.greaterThan(0);
	});

	it('P1 interleaved enabled wall time (30 medians)', () => {
		const wall = [];
		const projected = [];

		for (let i = 0; i < WARMUP + SAMPLES * 2; i++) {
			const measure = i >= WARMUP && i % 2 === 0;
			const enabled = i % 2 === 0;
			const flip = Math.floor(i / 2) % 2 === 0 ? 1 : -1;

			renderer._profilePanBlit = enabled;
			renderer._disablePanBlit = !enabled;
			renderer._disableClipSkip = !enabled;
			renderer._panStripDrawExperiment = null;

			const start = performance.now();
			map.panBy([PAN_DIAGONAL[0] * flip, PAN_DIAGONAL[1] * flip], {animate: false});
			const wallMs = Math.max(performance.now() - start, 0.001);

			if (measure) {
				wall.push(wallMs);
				projected.push(renderer._lastPanBlitProfile?.projectedLayerCount ?? -1);
			}
		}

		const report = {
			scenario: 'P1-interleaved-enabled-wall',
			wallMs: median(wall),
			projectedLayerCount: median(projected)
		};
		console.log(`BENCH_RESULT ${JSON.stringify(report)}`);
		expect(report.wallMs).to.be.greaterThan(0);
	});

	it('P1 strip-draw clip isolation (30 medians)', () => {
		const clip = collectStripExperimentMedians(map, PAN_DIAGONAL, 'clip');
		const noClipSame = collectStripExperimentMedians(map, PAN_DIAGONAL, 'no-clip-same');
		const noClipFull = collectStripExperimentMedians(map, PAN_DIAGONAL, 'no-clip-full');

		const report = {
			scenario: 'P1-clip-isolation',
			candidateCount: clip.stripCandidateCount,
			clipMs: clip.stripMs,
			noClipSameMs: noClipSame.stripMs,
			noClipFullMs: noClipFull.stripMs
		};

		console.log(`BENCH_RESULT ${JSON.stringify(report)}`);

		expect(report.candidateCount, JSON.stringify(report)).to.be.greaterThan(200);
		// Report-only: clip-vs-no-clip verdict is read from BENCH_RESULT console output.
	});
});
