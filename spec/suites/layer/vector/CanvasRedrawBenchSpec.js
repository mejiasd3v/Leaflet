import {expect} from 'chai';
import {Bounds, Canvas, CircleMarker, LeafletMap, Point} from 'leaflet';
import {createContainer} from '../../SpecHelper.js';

const LAYER_COUNT = 10000;
const LCG_SEED_S4 = 0xDEADBEEF;
const WARMUP = 5;
const SAMPLES = 30;
const S4_WARMUP = 10;
const S4_SAMPLES = 200;

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

function benchTimes(count, fn) {
	const times = new Array(count);
	for (let i = 0; i < count; i++) {
		const start = performance.now();
		fn(i);
		times[i] = performance.now() - start;
	}
	return times;
}

function logBenchResult(scenario, extra, times) {
	/* eslint-disable camelcase -- match baseline BENCH_RESULT schema */
	console.log(`BENCH_RESULT ${JSON.stringify({
		scenario,
		...extra,
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

async function cleanupBenchMap(map, container, canvas) {
	stubRendererRedraw(canvas);
	stubRendererRedraw(map?._renderer);
	if (container?.parentNode) {
		container.parentNode.removeChild(container);
	}
	await new Promise((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(resolve));
	});
}

function addGridMarkers(map) {
	const size = map.getSize();
	const cols = 100;
	const rows = 100;
	const cellW = size.x / cols;
	const cellH = size.y / rows;

	for (let i = 0; i < LAYER_COUNT; i++) {
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

function make90PctDirtyBounds(canvas) {
	const min = canvas._bounds.min;
	const max = canvas._bounds.max;
	const size = canvas._bounds.getSize();
	const marginX = size.x * 0.05;
	const marginY = size.y * 0.05;
	return new Bounds(
		[min.x + marginX, min.y + marginY],
		[max.x - marginX, max.y - marginY]
	);
}

describe('Canvas redraw benchmark', () => {
	it('compares full vs 90% partial dirty-rect redraw on 10k markers', async () => {
		const container = createContainer('1280px', '720px');
		const canvas = new Canvas();
		const map = new LeafletMap(container, {renderer: canvas, zoomControl: false, attributionControl: false});
		map.setView([20.0, 0.0], 5);
		addGridMarkers(map);

		cancelAnimationFrame(canvas._redrawRequest);
		canvas._redrawRequest = null;
		canvas._redrawBounds = null;
		canvas._redraw();

		const dirty90 = make90PctDirtyBounds(canvas);

		for (const mode of ['full', 'partial-90pct']) {
			for (let i = 0; i < WARMUP; i++) {
				canvas._redrawBounds = mode === 'full' ? null : new Bounds(dirty90.min, dirty90.max);
				canvas._redraw();
			}
			const times = benchTimes(SAMPLES, () => {
				canvas._redrawBounds = mode === 'full' ? null : new Bounds(dirty90.min, dirty90.max);
				canvas._redraw();
			});
			logBenchResult('clip-investigation', {mode}, times);
		}

		await cleanupBenchMap(map, container, canvas);
		expect(true).to.be.true;
	}, 300000);

	it('isolates _redraw-only cost for small vs full dirty rects', async () => {
		const container = createContainer('1280px', '720px');
		const canvas = new Canvas();
		const map = new LeafletMap(container, {renderer: canvas, zoomControl: false, attributionControl: false});
		map.setView([20.0, 0.0], 5);
		addGridMarkers(map);

		cancelAnimationFrame(canvas._redrawRequest);
		canvas._redrawRequest = null;
		canvas._redrawBounds = null;
		canvas._redraw();

		const marker = new CircleMarker(map.getCenter(), {radius: 8}).addTo(map);
		const smallDirty = new Bounds(
			marker._pxBounds.min,
			marker._pxBounds.max
		);

		for (const mode of ['redraw-full', 'redraw-small-dirty']) {
			for (let i = 0; i < WARMUP; i++) {
				canvas._redrawBounds = mode === 'redraw-full' ? null : new Bounds(smallDirty.min, smallDirty.max);
				canvas._redraw();
			}
			const times = benchTimes(SAMPLES, () => {
				canvas._redrawBounds = mode === 'redraw-full' ? null : new Bounds(smallDirty.min, smallDirty.max);
				canvas._redraw();
			});
			logBenchResult('clip-investigation-redraw-only', {mode}, times);
		}

		stubRendererRedraw(canvas);
		marker.remove();
		await cleanupBenchMap(map, container, canvas);
		expect(true).to.be.true;
	}, 300000);

	it('S4 moving marker among 10k static with and without dirty-rect promotion', async () => {
		const container = createContainer('1280px', '720px');
		const map = new LeafletMap(container, {
			preferCanvas: true,
			zoomControl: false,
			attributionControl: false
		});
		map.setView([20.0, 0.0], 5);

		const size = map.getSize();
		const cols = 100;
		const rows = 100;
		const cellW = size.x / cols;
		const cellH = size.y / rows;

		for (let i = 0; i < LAYER_COUNT; i++) {
			const col = i % cols;
			const row = Math.floor(i / cols);
			const point = new Point(col * cellW + cellW * 0.5, row * cellH + cellH * 0.5);
			new CircleMarker(map.layerPointToLatLng(point), {radius: 5, interactive: true}).addTo(map);
		}

		const moving = new CircleMarker(map.getCenter(), {radius: 8, interactive: true}).addTo(map);
		const renderer = map._renderer;
		const bounds = map.getBounds();
		const sw = bounds.getSouthWest();
		const ne = bounds.getNorthEast();
		const rng = createLCG(LCG_SEED_S4);

		for (const promotion of ['disabled', 'enabled']) {
			renderer._disableDirtyRectPromotion = promotion === 'disabled';

			for (let i = 0; i < S4_WARMUP; i++) {
				const lat = sw.lat + rng() * (ne.lat - sw.lat);
				const lng = sw.lng + rng() * (ne.lng - sw.lng);
				moving.setLatLng([lat, lng]);
				cancelAnimationFrame(renderer._redrawRequest);
				renderer._redrawRequest = null;
				renderer._redraw();
			}

			const times = benchTimes(S4_SAMPLES, () => {
				const lat = sw.lat + rng() * (ne.lat - sw.lat);
				const lng = sw.lng + rng() * (ne.lng - sw.lng);
				moving.setLatLng([lat, lng]);
				cancelAnimationFrame(renderer._redrawRequest);
				renderer._redrawRequest = null;
				renderer._redraw();
			});

			logBenchResult('S4-moving-marker', {promotion}, times);
		}

		const rngBreakdown = createLCG(LCG_SEED_S4);
		for (let i = 0; i < S4_WARMUP; i++) {
			moving.setLatLng([
				sw.lat + rngBreakdown() * (ne.lat - sw.lat),
				sw.lng + rngBreakdown() * (ne.lng - sw.lng)
			]);
			cancelAnimationFrame(renderer._redrawRequest);
			renderer._redrawRequest = null;
			renderer._redraw();
		}

		const setLatLngTimes = benchTimes(S4_SAMPLES, () => {
			const jumpLat = sw.lat + rngBreakdown() * (ne.lat - sw.lat);
			const jumpLng = sw.lng + rngBreakdown() * (ne.lng - sw.lng);
			moving.setLatLng([jumpLat, jumpLng]);
		});
		logBenchResult('S4-component-breakdown', {component: 'setLatLng-only'}, setLatLngTimes);

		const rngRedraw = createLCG(LCG_SEED_S4);
		for (let i = 0; i < S4_WARMUP; i++) {
			moving.setLatLng([
				sw.lat + rngRedraw() * (ne.lat - sw.lat),
				sw.lng + rngRedraw() * (ne.lng - sw.lng)
			]);
			cancelAnimationFrame(renderer._redrawRequest);
			renderer._redrawRequest = null;
			renderer._redraw();
		}

		const redrawTimes = new Array(S4_SAMPLES);
		for (let i = 0; i < S4_SAMPLES; i++) {
			const jumpLat = sw.lat + rngRedraw() * (ne.lat - sw.lat);
			const jumpLng = sw.lng + rngRedraw() * (ne.lng - sw.lng);
			moving.setLatLng([jumpLat, jumpLng]);
			cancelAnimationFrame(renderer._redrawRequest);
			renderer._redrawRequest = null;
			const start = performance.now();
			renderer._redraw();
			redrawTimes[i] = performance.now() - start;
		}
		logBenchResult('S4-component-breakdown', {component: 'redraw-after-setLatLng'}, redrawTimes);

		stubRendererRedraw(renderer);
		moving.remove();
		await cleanupBenchMap(map, container, renderer);
		expect(true).to.be.true;
	}, 300000);
});
