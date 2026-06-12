import {CircleMarker, LeafletMap, Point, Polyline} from 'leaflet';
import {createContainer, removeMapContainer} from '../SpecHelper.js';

const LCG_SEED_S3 = 0xC0FFEE;
const LCG_SEED_S4 = 0xDEADBEEF;

function createLCG(seed) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

function median(values) {
	const sorted = values.slice().sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[mid - 1] + sorted[mid]) / 2
		: sorted[mid];
}

function mean(values) {
	return values.reduce((sum, v) => sum + v, 0) / values.length;
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

function logBenchResult(scenario, unit, warmup, samples, times) {
	console.log(`BENCH_RESULT ${JSON.stringify({
		scenario,
		unit,
		warmup,
		samples,
		times_ms: times,
		median_ms: median(times),
		mean_ms: mean(times),
		hardwareConcurrency: navigator.hardwareConcurrency,
	})}`);
}

function makeVertexLatLngs(count, baseLat, baseLng, step = 0.00005) {
	const latlngs = new Array(count);
	for (let i = 0; i < count; i++) {
		latlngs[i] = [baseLat + i * step, baseLng + i * step];
	}
	return latlngs;
}

function cleanupBenchMap(map, container) {
	const renderer = map?._renderer;
	if (renderer) {
		cancelAnimationFrame(renderer._redrawRequest);
		renderer._redrawRequest = null;
		clearTimeout(renderer._pointerHoverThrottleTimeout);
		renderer._redrawBounds = null;
		renderer._redraw = () => {};
	}
	removeMapContainer(map, container);
}

function makeSyntheticPointerEvent() {
	return new PointerEvent('pointermove', {
		bubbles: true,
		cancelable: true,
		pointerId: 1,
		pointerType: 'mouse',
		clientX: 640,
		clientY: 360,
	});
}

describe('Main baseline perf bench', () => {
	it('S1 end-to-end zoom with vector load', () => {
		const container = createContainer('1280px', '720px');
		const map = new LeafletMap(container, {
			preferCanvas: true,
			zoomControl: false,
			attributionControl: false,
		});
		map.setView([55.0, 37.0], 8);

		for (let p = 0; p < 50; p++) {
			const baseLat = 54.0 + (p % 10) * 0.3;
			const baseLng = 36.0 + Math.floor(p / 10) * 0.3;
			new Polyline(makeVertexLatLngs(2000, baseLat, baseLng), {
				weight: 1,
				interactive: false,
			}).addTo(map);
		}

		const zoomA = 8;
		const zoomB = 10;
		let currentZoom = zoomA;

		const doZoom = () => {
			currentZoom = currentZoom === zoomA ? zoomB : zoomA;
			map.setZoom(currentZoom, {animate: false});
		};

		for (let i = 0; i < 5; i++) {
			doZoom();
		}

		const times = benchTimes(30, () => {
			doZoom();
		});

		logBenchResult('S1', 'ms_per_zoom', 5, 30, times);
		cleanupBenchMap(map, container);
	}, 300000);

	it('S2 focused reprojection', () => {
		const container = createContainer('1280px', '720px');
		const map = new LeafletMap(container, {
			preferCanvas: true,
			zoomControl: false,
			attributionControl: false,
		});
		map.setView([55.8, 37.6], 10);

		const polyline = new Polyline(makeVertexLatLngs(100000, 55.0, 37.0)).addTo(map);

		for (let i = 0; i < 5; i++) {
			polyline._project();
		}

		const times = benchTimes(50, () => {
			polyline._project();
		});

		logBenchResult('S2', 'ms_per_project', 5, 50, times);
		cleanupBenchMap(map, container);
	}, 300000);

	it('S3 canvas hover hit-test', () => {
		const container = createContainer('1280px', '720px');
		const map = new LeafletMap(container, {
			preferCanvas: true,
			zoomControl: false,
			attributionControl: false,
		});
		map.setView([20.0, 0.0], 5);

		const size = map.getSize();
		const cols = 100;
		const rows = 100;
		const cellW = size.x / cols;
		const cellH = size.y / rows;

		for (let i = 0; i < 10000; i++) {
			const col = i % cols;
			const row = Math.floor(i / cols);
			const point = new Point(col * cellW + cellW * 0.5, row * cellH + cellH * 0.5);
			const latlng = map.layerPointToLatLng(point);
			new CircleMarker(latlng, {radius: 5, interactive: true}).addTo(map);
		}

		const renderer = map._renderer;
		const syntheticEvent = makeSyntheticPointerEvent();
		const rng = createLCG(LCG_SEED_S3);
		const queryPoints = new Array(200);
		for (let i = 0; i < 200; i++) {
			queryPoints[i] = new Point(rng() * (size.x - 1), rng() * (size.y - 1));
		}

		const times = benchTimes(200, (i) => {
			renderer._pointerHoverThrottled = false;
			clearTimeout(renderer._pointerHoverThrottleTimeout);
			renderer._handlePointerHover(syntheticEvent, queryPoints[i]);
		});

		renderer._pointerHoverThrottled = true;
		clearTimeout(renderer._pointerHoverThrottleTimeout);
		const throttleDrainDeadline = performance.now() + 40;
		while (performance.now() < throttleDrainDeadline) {
			// drain final 32ms hover throttle callbacks before teardown
		}

		logBenchResult('S3', 'ms_per_hover', 0, 200, times);
		cleanupBenchMap(map, container);
	}, 300000);

	it('S4 one animated layer among 10k static', () => {
		const container = createContainer('1280px', '720px');
		const map = new LeafletMap(container, {
			preferCanvas: true,
			zoomControl: false,
			attributionControl: false,
		});
		map.setView([20.0, 0.0], 5);

		const size = map.getSize();
		const cols = 100;
		const rows = 100;
		const cellW = size.x / cols;
		const cellH = size.y / rows;

		for (let i = 0; i < 10000; i++) {
			const col = i % cols;
			const row = Math.floor(i / cols);
			const point = new Point(col * cellW + cellW * 0.5, row * cellH + cellH * 0.5);
			const latlng = map.layerPointToLatLng(point);
			new CircleMarker(latlng, {radius: 5, interactive: true}).addTo(map);
		}

		const moving = new CircleMarker(map.getCenter(), {radius: 8, interactive: true}).addTo(map);
		const renderer = map._renderer;
		const bounds = map.getBounds();
		const sw = bounds.getSouthWest();
		const ne = bounds.getNorthEast();
		const rng = createLCG(LCG_SEED_S4);

		const warmup = 10;
		const samples = 200;

		for (let i = 0; i < warmup; i++) {
			const lat = sw.lat + rng() * (ne.lat - sw.lat);
			const lng = sw.lng + rng() * (ne.lng - sw.lng);
			moving.setLatLng([lat, lng]);
			cancelAnimationFrame(renderer._redrawRequest);
			renderer._redrawRequest = null;
			renderer._redraw();
		}

		const times = benchTimes(samples, () => {
			const lat = sw.lat + rng() * (ne.lat - sw.lat);
			const lng = sw.lng + rng() * (ne.lng - sw.lng);
			moving.setLatLng([lat, lng]);
			cancelAnimationFrame(renderer._redrawRequest);
			renderer._redrawRequest = null;
			renderer._redraw();
		});

		logBenchResult('S4', 'ms_per_redraw_iteration', warmup, samples, times);
		moving.remove();
		cleanupBenchMap(map, container);
	}, 300000);
});