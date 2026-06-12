import {expect} from 'chai';
import {Canvas, CircleMarker, LeafletMap, Point} from 'leaflet';
import {createContainer, removeMapContainer} from '../../SpecHelper.js';

const LAYER_COUNT = 10000;
const WARMUP = 5;
const SAMPLES = 30;
const benchResults = [];

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

function benchRedraw(renderer, iterations) {
	const times = new Array(iterations);
	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		renderer._redrawBounds = null;
		renderer._redraw();
		times[i] = performance.now() - start;
	}
	return times;
}

function logBenchResult(scenario, disableBatching, times) {
	/* eslint-disable camelcase -- match baseline BENCH_RESULT schema */
	console.log(`BENCH_RESULT ${JSON.stringify({
		scenario,
		batching: disableBatching ? 'disabled' : 'enabled',
		warmup: WARMUP,
		samples: SAMPLES,
		times_ms: times,
		median_ms: median(times),
		mean_ms: mean(times),
		hardwareConcurrency: navigator.hardwareConcurrency
	})}`);
	/* eslint-enable camelcase */
}

function cleanupBenchMap(map, container, canvas) {
	if (canvas) {
		cancelAnimationFrame(canvas._redrawRequest);
		canvas._redrawRequest = null;
		clearTimeout(canvas._pointerHoverThrottleTimeout);
		canvas._redrawBounds = null;
		canvas._requestRedraw = () => {};
		canvas._redraw = () => {};
	}
	removeMapContainer(map, container);
}

function addGridMarkers(map, styleFn) {
	const size = map.getSize();
	const cols = 100;
	const rows = 100;
	const cellW = size.x / cols;
	const cellH = size.y / rows;

	for (let i = 0; i < LAYER_COUNT; i++) {
		const col = i % cols;
		const row = Math.floor(i / cols);
		const point = new Point(col * cellW + cellW * 0.5, row * cellH + cellH * 0.5);
		const latlng = map.layerPointToLatLng(point);
		new CircleMarker(latlng, styleFn(i)).addTo(map);
	}
}

function addClusteredMarkers(map, styleFn) {
	const center = map.getCenter();
	for (let i = 0; i < LAYER_COUNT; i++) {
		const angle = (i / LAYER_COUNT) * Math.PI * 2;
		const radius = (i % 50) * 0.00002;
		new CircleMarker([
			center.lat + Math.cos(angle) * radius,
			center.lng + Math.sin(angle) * radius
		], styleFn(i)).addTo(map);
	}
}

function runScenario(scenario, addMarkers) {
	const container = createContainer('1280px', '720px');
	const canvas = new Canvas();
	const map = new LeafletMap(container, {renderer: canvas, zoomControl: false, attributionControl: false});
	map.setView([20.0, 0.0], 5);

	addMarkers(map);

	cancelAnimationFrame(canvas._redrawRequest);
	canvas._redrawRequest = null;
	canvas._redrawBounds = null;
	canvas._redraw();

	const scenarioResult = {scenario};

	for (const mode of [false, true]) {
		canvas._disablePathBatching = mode;
		for (let i = 0; i < WARMUP; i++) {
			canvas._redrawBounds = null;
			canvas._redraw();
		}
		const times = benchRedraw(canvas, SAMPLES);
		logBenchResult(scenario, mode, times);
		scenarioResult[mode ? 'unbatched_median_ms' : 'batched_median_ms'] = median(times);
		scenarioResult[mode ? 'unbatched_mean_ms' : 'batched_mean_ms'] = mean(times);
	}

	benchResults.push(scenarioResult);
	cleanupBenchMap(map, container, canvas);
}

describe('Canvas batch draw benchmark', () => {
	it('reports full-canvas redraw for 10k disjoint same-styled CircleMarkers', () => {
		const sameStyle = () => ({
			radius: 5,
			fill: true,
			fillColor: '#3388ff',
			fillOpacity: 0.8,
			stroke: true,
			color: '#2266cc',
			weight: 1,
			interactive: false
		});
		runScenario('disjoint-same-style', map => addGridMarkers(map, sameStyle));
		expect(true).to.be.true;
	}, 300000);

	it('reports full-canvas redraw for 10k alternating-style CircleMarkers', () => {
		const alternatingStyle = i => ({
			radius: 5,
			fill: true,
			fillColor: i % 2 ? '#ff0000' : '#0000ff',
			fillOpacity: 0.8,
			stroke: true,
			color: i % 2 ? '#aa0000' : '#0000aa',
			weight: 1,
			interactive: false
		});
		runScenario('alternating-style', map => addGridMarkers(map, alternatingStyle));
		expect(true).to.be.true;
	}, 300000);

	it('reports full-canvas redraw for 10k overlap-heavy CircleMarkers', () => {
		const sameStyle = () => ({
			radius: 6,
			fill: true,
			fillColor: '#3388ff',
			fillOpacity: 0.6,
			stroke: false,
			interactive: false
		});
		runScenario('overlap-heavy', map => addClusteredMarkers(map, sameStyle));
		expect(true).to.be.true;
	}, 300000);

	it('benchmark table', () => {
		console.info('BENCH_TABLE', JSON.stringify(benchResults));
		expect(benchResults).to.have.length(3);
	});
});
