import {expect} from 'chai';
import {Canvas, CircleMarker, LeafletMap, Point, Polyline} from 'leaflet';
import {assertBenchSamples, assertPositiveFiniteMs} from '../../BenchHelpers.js';
import {createContainer, removeMapContainer} from '../../SpecHelper.js';

// Report-only benchmarks: emit BENCH_RESULT for manual review. No
// performance-comparison assertions in the default suite.

const STATIC_COUNT = 10000;
const POLYLINE_COUNT = 50;
const VERTICES_PER_POLYLINE = 2000;
const REDRAWS_PER_SAMPLE = 20;
const LCG_SEED = 0xDEADBEEF;
const WARMUP = 5;
const SAMPLES = 30;
const benchResults = [];

function createLCG(seed) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

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

function logBenchResult(scenario, cache, times) {
	/* eslint-disable camelcase -- match baseline BENCH_RESULT schema */
	console.log(`BENCH_RESULT ${JSON.stringify({
		scenario,
		path2d_cache: cache,
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

function stubRendererRedraw(renderer) {
	if (!renderer) { return; }
	cancelAnimationFrame(renderer._redrawRequest);
	renderer._redrawRequest = null;
	clearTimeout(renderer._pointerHoverThrottleTimeout);
	renderer._redrawBounds = null;
	renderer._requestRedraw = () => {};
	renderer._redraw = () => {};
}

function cleanupBenchMap(map, container, renderer) {
	stubRendererRedraw(renderer);
	removeMapContainer(map, container);
}

function addGridMarkers(map) {
	const size = map.getSize();
	const cols = 100;
	const rows = 100;
	const cellW = size.x / cols;
	const cellH = size.y / rows;

	for (let i = 0; i < STATIC_COUNT; i++) {
		const col = i % cols;
		const row = Math.floor(i / cols);
		const point = new Point(col * cellW + cellW * 0.5, row * cellH + cellH * 0.5);
		new CircleMarker(map.layerPointToLatLng(point), {
			radius: 5,
			fill: true,
			fillColor: '#3388ff',
			fillOpacity: 0.8,
			stroke: true,
			color: '#2266cc',
			weight: 1,
			interactive: false
		}).addTo(map);
	}
}

function makeLongPolylineLatLngs(vertexCount, seed) {
	const rng = createLCG(seed);
	const latlngs = [];
	let lat = 10 + rng() * 5;
	let lng = -5 + rng() * 5;
	for (let i = 0; i < vertexCount; i++) {
		lat += (rng() - 0.5) * 0.002;
		lng += (rng() - 0.5) * 0.002;
		latlngs.push([lat, lng]);
	}
	return latlngs;
}

function addDensePolylines(map) {
	for (let i = 0; i < POLYLINE_COUNT; i++) {
		new Polyline(makeLongPolylineLatLngs(VERTICES_PER_POLYLINE, LCG_SEED + i), {
			weight: 1,
			color: i % 2 ? '#3388ff' : '#ff3388',
			opacity: 0.9,
			interactive: false
		}).addTo(map);
	}
}

function assertScenarioResult(result) {
	assertPositiveFiniteMs(result.cache_enabled_median_ms, `${result.scenario} cache enabled median`);
	assertPositiveFiniteMs(result.cache_disabled_median_ms, `${result.scenario} cache disabled median`);
	assertPositiveFiniteMs(result.cache_enabled_mean_ms, `${result.scenario} cache enabled mean`);
	assertPositiveFiniteMs(result.cache_disabled_mean_ms, `${result.scenario} cache disabled mean`);
}

describe('Canvas Path2D cache benchmark', () => {
	it('B1: one moving CircleMarker among 10k static dirty-rect frames', async () => {
		const container = createContainer('1280px', '720px');
		const canvas = new Canvas();
		const map = new LeafletMap(container, {renderer: canvas, zoomControl: false, attributionControl: false});
		map.setView([20.0, 0.0], 5);
		addGridMarkers(map);

		const moving = new CircleMarker(map.getCenter(), {radius: 8, interactive: true}).addTo(map);
		const bounds = map.getBounds();
		const sw = bounds.getSouthWest();
		const ne = bounds.getNorthEast();
		const rng = createLCG(LCG_SEED);

		cancelAnimationFrame(canvas._redrawRequest);
		canvas._redrawRequest = null;
		canvas._redrawBounds = null;
		canvas._redraw();

		const runFrame = (disableCache, random) => {
			const lat = sw.lat + random() * (ne.lat - sw.lat);
			const lng = sw.lng + random() * (ne.lng - sw.lng);
			moving.setLatLng([lat, lng]);
			canvas._disablePath2DCache = disableCache;
			cancelAnimationFrame(canvas._redrawRequest);
			canvas._redrawRequest = null;
			canvas._redraw();
		};

		for (let i = 0; i < WARMUP; i++) {
			runFrame(i % 2 === 0, rng);
		}

		const rngBench = createLCG(LCG_SEED);
		const enabledTimes = [];
		const disabledTimes = [];
		for (let i = 0; i < SAMPLES * 2; i++) {
			const disableCache = i % 2 !== 0;
			const start = performance.now();
			runFrame(disableCache, rngBench);
			const elapsed = performance.now() - start;
			if (disableCache) {
				disabledTimes.push(elapsed);
			} else {
				enabledTimes.push(elapsed);
			}
		}

		assertBenchSamples(enabledTimes, 'B1 cache enabled');
		assertBenchSamples(disabledTimes, 'B1 cache disabled');
		logBenchResult('B1-moving-marker', 'enabled', enabledTimes);
		logBenchResult('B1-moving-marker', 'disabled', disabledTimes);

		/* eslint-disable camelcase -- bench table schema */
		benchResults.push({
			scenario: 'B1-moving-marker',
			cache_enabled_median_ms: median(enabledTimes),
			cache_disabled_median_ms: median(disabledTimes),
			cache_enabled_mean_ms: mean(enabledTimes),
			cache_disabled_mean_ms: mean(disabledTimes)
		});
		/* eslint-enable camelcase */

		moving.remove();
		await cleanupBenchMap(map, container, canvas);
	}, 300000);

	it('B2: repeated full redraw of 50×2000-vertex polylines without view change', async () => {
		const container = createContainer('1280px', '720px');
		const canvas = new Canvas();
		const map = new LeafletMap(container, {renderer: canvas, zoomControl: false, attributionControl: false});
		map.setView([12.0, 0.0], 6);
		addDensePolylines(map);

		cancelAnimationFrame(canvas._redrawRequest);
		canvas._redrawRequest = null;
		canvas._redrawBounds = null;
		canvas._redraw();

		const redraw = (disableCache) => {
			canvas._disablePath2DCache = disableCache;
			canvas._redrawBounds = null;
			for (let r = 0; r < REDRAWS_PER_SAMPLE; r++) {
				canvas._redraw();
			}
		};

		for (let i = 0; i < WARMUP; i++) {
			redraw(i % 2 === 0);
		}

		const enabledTimes = [];
		const disabledTimes = [];
		for (let i = 0; i < SAMPLES * 2; i++) {
			const disableCache = i % 2 !== 0;
			const start = performance.now();
			redraw(disableCache);
			const elapsed = performance.now() - start;
			if (disableCache) {
				disabledTimes.push(elapsed);
			} else {
				enabledTimes.push(elapsed);
			}
		}

		assertBenchSamples(enabledTimes, 'B2 cache enabled');
		assertBenchSamples(disabledTimes, 'B2 cache disabled');
		logBenchResult('B2-static-polylines', 'enabled', enabledTimes);
		logBenchResult('B2-static-polylines', 'disabled', disabledTimes);

		/* eslint-disable camelcase -- bench table schema */
		benchResults.push({
			scenario: 'B2-static-polylines',
			cache_enabled_median_ms: median(enabledTimes),
			cache_disabled_median_ms: median(disabledTimes),
			cache_enabled_mean_ms: mean(enabledTimes),
			cache_disabled_mean_ms: mean(disabledTimes)
		});
		/* eslint-enable camelcase */

		await cleanupBenchMap(map, container, canvas);
	}, 300000);

	it('B3: setZoom toggles and pan settles (cache always cold)', async () => {
		const container = createContainer('1280px', '720px');
		const canvas = new Canvas();
		const map = new LeafletMap(container, {renderer: canvas, zoomControl: false, attributionControl: false});
		map.setView([20.0, 0.0], 5);
		addGridMarkers(map);

		cancelAnimationFrame(canvas._redrawRequest);
		canvas._redrawRequest = null;
		canvas._redrawBounds = null;
		canvas._updatePaths();

		const runColdFrame = (disableCache) => {
			canvas._disablePath2DCache = disableCache;
			const zoom = map.getZoom() === 5 ? 6 : 5;
			map.setZoom(zoom);
			map.panBy([3, -2]);
			cancelAnimationFrame(canvas._redrawRequest);
			canvas._redrawRequest = null;
			canvas._updatePaths();
		};

		for (let i = 0; i < WARMUP; i++) {
			runColdFrame(i % 2 === 0);
		}

		const enabledTimes = [];
		const disabledTimes = [];
		for (let i = 0; i < SAMPLES * 2; i++) {
			const disableCache = i % 2 !== 0;
			const start = performance.now();
			runColdFrame(disableCache);
			const elapsed = performance.now() - start;
			if (disableCache) {
				disabledTimes.push(elapsed);
			} else {
				enabledTimes.push(elapsed);
			}
		}

		assertBenchSamples(enabledTimes, 'B3 cache enabled');
		assertBenchSamples(disabledTimes, 'B3 cache disabled');
		logBenchResult('B3-cold-geometry', 'enabled', enabledTimes);
		logBenchResult('B3-cold-geometry', 'disabled', disabledTimes);

		/* eslint-disable camelcase -- bench table schema */
		benchResults.push({
			scenario: 'B3-cold-geometry',
			cache_enabled_median_ms: median(enabledTimes),
			cache_disabled_median_ms: median(disabledTimes),
			cache_enabled_mean_ms: mean(enabledTimes),
			cache_disabled_mean_ms: mean(disabledTimes)
		});
		/* eslint-enable camelcase */

		await cleanupBenchMap(map, container, canvas);
	}, 300000);

	it('benchmark table', () => {
		console.info('BENCH_TABLE', JSON.stringify(benchResults));
		expect(benchResults).to.have.length(3);
		for (const result of benchResults) {
			assertScenarioResult(result);
		}
	});
});
