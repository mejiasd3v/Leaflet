import {CircleMarker, LeafletMap, Point, Polyline} from 'leaflet';
import {assertBenchSamples, assertPositiveFiniteMs} from '../../BenchHelpers.js';
import {createContainer} from '../../SpecHelper.js';

const WARMUP = 10;
const SAMPLES = 30;
const PAN_OFFSET = [73, 41];

function median(values) {
	const sorted = values.toSorted((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ?
		(sorted[mid - 1] + sorted[mid]) / 2 :
		sorted[mid];
}

function mean(values) {
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function p95(values) {
	const sorted = values.toSorted((a, b) => a - b);
	const idx = Math.ceil(sorted.length * 0.95) - 1;
	return sorted[Math.max(0, idx)];
}

function logBenchResult(scenario, extra, times) {
	/* eslint-disable camelcase -- match baseline BENCH_RESULT schema */
	console.log(`BENCH_RESULT ${JSON.stringify({
		scenario,
		...extra,
		warmup: WARMUP,
		samples: times.length,
		times_ms: times,
		median_ms: median(times),
		mean_ms: mean(times),
		p95_ms: p95(times),
		hardwareConcurrency: navigator.hardwareConcurrency
	})}`);
	/* eslint-enable camelcase */
}

function cleanupBenchMap(map, container) {
	const renderer = map?._renderer;
	if (renderer) {
		cancelAnimationFrame(renderer._redrawRequest);
		renderer._redrawRequest = null;
		clearTimeout(renderer._pointerHoverThrottleTimeout);
		renderer._redrawBounds = null;
	}
	if (container?.parentNode) {
		container.parentNode.removeChild(container);
	}
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

function makeVertexLatLngs(count, baseLat, baseLng, step = 0.00005) {
	const latlngs = new Array(count);
	for (let i = 0; i < count; i++) {
		latlngs[i] = [baseLat + i * step, baseLng + i * step];
	}
	return latlngs;
}

function setPanBlitFlags(renderer, enabled) {
	renderer._disablePanBlit = !enabled;
	renderer._disableClipSkip = !enabled;
}

function interleavedBench(label, map, samples) {
	const enabledTimes = [];
	const disabledTimes = [];

	for (let i = 0; i < WARMUP + samples; i++) {
		const measure = i >= WARMUP;
		const enabled = i % 2 === 0;

		setPanBlitFlags(map._renderer, enabled);

		const start = performance.now();
		map.panBy([
			PAN_OFFSET[0] * (i % 2 === 0 ? 1 : -1),
			PAN_OFFSET[1] * (i % 2 === 0 ? 1 : -1)
		], {animate: false});
		const elapsed = performance.now() - start;

		if (measure) {
			(enabled ? enabledTimes : disabledTimes).push(elapsed);
		}
	}

	assertBenchSamples(enabledTimes, `${label} enabled`);
	assertBenchSamples(disabledTimes, `${label} disabled`);

	for (const mode of ['enabled', 'disabled']) {
		const times = mode === 'enabled' ? enabledTimes : disabledTimes;
		for (const t of times) {
			assertPositiveFiniteMs(t, `${label} ${mode}`);
		}
		logBenchResult(label, {mode, interleaved: true}, times);
	}
}

describe('Canvas pan blit benchmark', () => {
	it('P1: 10k CircleMarkers pan settle (interleaved A/B)', () => {
		const container = createContainer('1280px', '720px');
		const map = new LeafletMap(container, {
			preferCanvas: true,
			zoomControl: false,
			attributionControl: false
		});
		map.setView([20.0, 0.0], 5);
		addGridMarkers(map, 10000);

		const renderer = map._renderer;
		cancelAnimationFrame(renderer._redrawRequest);
		renderer._redrawRequest = null;
		renderer._redrawBounds = null;
		renderer._redraw();
		renderer._saveSettleState();
		map.panBy(PAN_OFFSET, {animate: false});

		interleavedBench('P1-pan-10k-markers', map, SAMPLES);
		cleanupBenchMap(map, container);
	}, 300000);

	it('P2: 50x2k-vertex polylines pan settle (interleaved A/B)', () => {
		const container = createContainer('1280px', '720px');
		const map = new LeafletMap(container, {
			preferCanvas: true,
			zoomControl: false,
			attributionControl: false
		});
		map.setView([55.0, 37.0], 8);

		for (let p = 0; p < 50; p++) {
			const baseLat = 54.0 + (p % 10) * 0.3;
			const baseLng = 36.0 + Math.floor(p / 10) * 0.3;
			new Polyline(makeVertexLatLngs(2000, baseLat, baseLng), {
				weight: 1,
				interactive: false
			}).addTo(map);
		}

		const renderer = map._renderer;
		cancelAnimationFrame(renderer._redrawRequest);
		renderer._redrawRequest = null;
		renderer._redrawBounds = null;
		renderer._redraw();
		renderer._saveSettleState();
		map.panBy(PAN_OFFSET, {animate: false});

		interleavedBench('P2-pan-50-polylines-2k', map, SAMPLES);
		cleanupBenchMap(map, container);
	}, 300000);

	it('P3: zoom toggle no-regression vs flag-disabled (interleaved A/B)', () => {
		const container = createContainer('1280px', '720px');
		const map = new LeafletMap(container, {
			preferCanvas: true,
			zoomControl: false,
			attributionControl: false
		});
		map.setView([20.0, 0.0], 5);
		addGridMarkers(map, 10000);

		const zoomA = 5;
		const zoomB = 6;
		let currentZoom = zoomA;
		const enabledTimes = [];
		const disabledTimes = [];

		for (let i = 0; i < WARMUP + SAMPLES; i++) {
			const measure = i >= WARMUP;
			const enabled = i % 2 === 0;
			setPanBlitFlags(map._renderer, enabled);

			currentZoom = currentZoom === zoomA ? zoomB : zoomA;
			const start = performance.now();
			map.setZoom(currentZoom, {animate: false});
			const elapsed = performance.now() - start;

			if (measure) {
				(enabled ? enabledTimes : disabledTimes).push(elapsed);
			}
		}

		assertBenchSamples(enabledTimes, 'P3 zoom enabled');
		assertBenchSamples(disabledTimes, 'P3 zoom disabled');
		logBenchResult('P3-zoom-10k-markers', {mode: 'enabled', interleaved: true}, enabledTimes);
		logBenchResult('P3-zoom-10k-markers', {mode: 'disabled', interleaved: true}, disabledTimes);

		cleanupBenchMap(map, container);
	}, 300000);
});
