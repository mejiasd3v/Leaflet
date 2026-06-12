import {expect} from 'chai';
import {Bounds, Canvas, CircleMarker, LeafletMap} from 'leaflet';
import {assertPositiveFiniteMs} from '../../BenchHelpers.js';
import {createContainer, removeMapContainer} from '../../SpecHelper.js';

// Report-only benchmark: logs timings for manual review. No
// performance-comparison assertions in the default suite.

const LAYER_COUNT = 10000;
const HOVER_ITERATIONS = 50;
const REDRAW_QUERY_ITERATIONS = 100;

function linearFindInteractiveLayerAt(canvas, point) {
	let topmost;
	for (let order = canvas._drawFirst; order; order = order.next) {
		const layer = order.layer;
		if (layer.options.interactive && layer._containsPoint(point)) {
			topmost = layer;
		}
	}
	return topmost;
}

function linearQueryDrawCandidates(canvas, bounds) {
	const candidates = [];
	for (let order = canvas._drawFirst; order; order = order.next) {
		const layer = order.layer;
		if (!bounds || (layer._pxBounds && layer._pxBounds.intersects(bounds))) {
			candidates.push(layer);
		}
	}
	return candidates;
}

function meanTime(fn, iterations) {
	const start = performance.now();
	for (let i = 0; i < iterations; i++) {
		fn();
	}
	return (performance.now() - start) / iterations;
}

describe('Canvas spatial index benchmark', () => {
	let container, map, canvas, markers, queryPoint, dirtyBounds, results;

	beforeEach(() => {
		container = createContainer('1280px', '720px');
		canvas = new Canvas();
		map = new LeafletMap(container, {renderer: canvas, zoomControl: false});
		map.setView([0, 0], 6);

		markers = [];
		for (let i = 0; i < LAYER_COUNT; i++) {
			markers.push(new CircleMarker([
				(Math.random() - 0.5) * 20,
				(Math.random() - 0.5) * 20
			], {radius: 4}).addTo(map));
		}

		queryPoint = map.latLngToLayerPoint([0, 0]);
		const target = markers[0];
		const padding = 4;
		dirtyBounds = new Bounds(
			target._pxBounds.min.subtract([padding, padding]),
			target._pxBounds.max.add([padding, padding])
		);

		results = {
			layerCount: LAYER_COUNT,
			hoverIterations: HOVER_ITERATIONS,
			redrawQueryIterations: REDRAW_QUERY_ITERATIONS,
			linearHoverMs: meanTime(
				() => linearFindInteractiveLayerAt(canvas, queryPoint),
				HOVER_ITERATIONS
			),
			indexedHoverMs: meanTime(() => {
				canvas._pointerHoverThrottled = false;
				canvas._handlePointerHover({type: 'pointermove'}, queryPoint);
			}, HOVER_ITERATIONS),
			linearRedrawQueryMs: meanTime(
				() => linearQueryDrawCandidates(canvas, dirtyBounds),
				REDRAW_QUERY_ITERATIONS
			),
			indexedRedrawQueryMs: meanTime(
				() => canvas._spatialGrid.queryBounds(dirtyBounds),
				REDRAW_QUERY_ITERATIONS
			)
		};

		console.info('Canvas spatial index benchmark:', results);
	}, 30000);

	afterEach(() => {
		removeMapContainer(map, container);
	});

	it(`indexes ${LAYER_COUNT} CircleMarkers for hover and dirty-rect queries`, () => {
		expect(canvas._spatialGrid.usesIndex()).to.be.true;
		assertPositiveFiniteMs(results.linearHoverMs, 'linear hover');
		assertPositiveFiniteMs(results.indexedHoverMs, 'indexed hover');
		assertPositiveFiniteMs(results.linearRedrawQueryMs, 'linear redraw query');
		assertPositiveFiniteMs(results.indexedRedrawQueryMs, 'indexed redraw query');
	});
});
