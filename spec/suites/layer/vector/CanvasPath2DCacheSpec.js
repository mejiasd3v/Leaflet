import {expect} from 'chai';
import {Canvas, CircleMarker, LeafletMap, Polygon, Polyline} from 'leaflet';
import {createContainer, removeMapContainer} from '../../SpecHelper.js';

function getCanvasImageData(renderer) {
	const canvas = renderer._container;
	const ctx = canvas.getContext('2d');
	return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function expectPixelsEqual(actual, expected) {
	expect(actual.width).to.equal(expected.width);
	expect(actual.height).to.equal(expected.height);
	expect(actual.data).to.deep.equal(expected.data);
}

function redrawCanvas(renderer) {
	cancelAnimationFrame(renderer._redrawRequest);
	renderer._redrawRequest = null;
	renderer._redrawBounds = null;
	renderer._redraw();
}

function renderPixels(renderer, disableCache) {
	renderer._disablePath2DCache = disableCache;
	redrawCanvas(renderer);
	return getCanvasImageData(renderer);
}

function expectCacheMatchesUncached(renderer) {
	const cached = renderPixels(renderer, false);
	for (const layer of Object.values(renderer._layers)) {
		delete layer._path2d;
	}
	const uncached = renderPixels(renderer, true);
	expectPixelsEqual(cached, uncached);
}

describe('Canvas Path2D cache pixel equivalence', () => {
	let container, map;

	afterEach(() => {
		removeMapContainer(map, container);
	});

	beforeEach(() => {
		container = createContainer('400px', '400px');
		map = new LeafletMap(container, {preferCanvas: true, zoomControl: false});
		map.setView([0, 0], 8);
	});

	function expectCacheMatchesUncachedForMap() {
		expectCacheMatchesUncached(map._renderer);
	}

	it('matches uncached pixels for 50 overlapping translucent circles', () => {
		const style = {
			radius: 12,
			fill: true,
			fillOpacity: 0.5,
			fillColor: '#3388ff',
			stroke: false
		};

		const markers = [];
		for (let i = 0; i < 50; i++) {
			const angle = (i / 50) * Math.PI * 2;
			markers.push(new CircleMarker([
				Math.cos(angle) * 0.001,
				Math.sin(angle) * 0.001
			], style).addTo(map));
		}

		expectCacheMatchesUncachedForMap();
		renderPixels(map._renderer, false);
		renderPixels(map._renderer, false);
		for (const marker of markers) {
			expect(marker._path2d).to.be.undefined;
		}
	});

	it('matches uncached pixels for overlapping polygons with holes', () => {
		const outer = [[-0.02, -0.02], [0.02, -0.02], [0.02, 0.02], [-0.02, 0.02]];
		const hole = [[-0.005, -0.005], [0.005, -0.005], [0.005, 0.005], [-0.005, 0.005]];

		for (let i = 0; i < 6; i++) {
			const offset = i * 0.003;
			new Polygon([
				outer.map(([lat, lng]) => [lat + offset, lng + offset]),
				hole.map(([lat, lng]) => [lat + offset, lng + offset])
			], {
				fill: true,
				fillOpacity: 0.4,
				fillColor: i % 2 ? '#ff0000' : '#0000ff',
				stroke: false
			}).addTo(map);
		}

		expectCacheMatchesUncachedForMap();
	});

	it('matches uncached pixels for interleaved styles', () => {
		const markers = [];
		for (let i = 0; i < 40; i++) {
			const lat = (i % 8) * 0.01;
			const lng = Math.floor(i / 8) * 0.01;
			markers.push(new CircleMarker([lat, lng], {
				radius: 6,
				fill: true,
				fillColor: i % 2 ? '#ff0000' : '#0000ff',
				fillOpacity: 0.8,
				stroke: false
			}).addTo(map));
		}

		expectCacheMatchesUncachedForMap();
		renderPixels(map._renderer, false);
		for (const marker of markers) {
			expect(marker._path2d).to.be.undefined;
		}
	});

	it('matches uncached pixels for mixed batchable and custom _updatePath layers', () => {
		class CustomPolyline extends Polyline {
			_updatePath() {
				this._renderer._updatePoly(this, false);
				this._renderer._ctx.globalAlpha = 0.25;
			}
		}

		for (let i = 0; i < 20; i++) {
			const lat = (i % 5) * 0.02;
			const lng = Math.floor(i / 5) * 0.02;
			if (i % 3 === 0) {
				new CustomPolyline([[lat, lng], [lat + 0.005, lng + 0.005]], {
					weight: 2,
					color: '#00aa00'
				}).addTo(map);
			} else {
				new CircleMarker([lat, lng], {
					radius: 5,
					fill: true,
					fillColor: '#3388ff',
					stroke: false
				}).addTo(map);
			}
		}

		expectCacheMatchesUncachedForMap();
	});

	it('matches uncached pixels after setLatLngs geometry change', () => {
		const polyline = new Polyline([[0, 0], [0.01, 0.01], [0.02, 0]], {
			weight: 3,
			color: '#3388ff'
		}).addTo(map);

		expectCacheMatchesUncachedForMap();

		polyline.setLatLngs([[0.005, 0.005], [0.015, 0.015], [0.025, 0.005]]);
		expectCacheMatchesUncachedForMap();
	});

	it('matches uncached pixels after setZoom', () => {
		new Polyline([[0, 0], [0.05, 0.05]], {weight: 2, color: '#ff0000'}).addTo(map);
		const marker = new CircleMarker([0.02, 0.02], {radius: 8, fill: true, fillColor: '#0000ff'}).addTo(map);

		expectCacheMatchesUncachedForMap();

		map.setZoom(10);
		expectCacheMatchesUncachedForMap();
		renderPixels(map._renderer, false);
		expect(marker._path2d).to.be.undefined;
	});

	it('matches uncached pixels after pan re-clips geometry', () => {
		new Polyline(
			[[0, -0.5], [0, 0.5]],
			{weight: 4, color: '#00aa00', noClip: false}
		).addTo(map);

		expectCacheMatchesUncachedForMap();

		map.panBy([200, 0]);
		expectCacheMatchesUncachedForMap();

		map.panBy([-400, 0]);
		expectCacheMatchesUncachedForMap();
	});

	it('matches uncached pixels after setRadius', () => {
		const marker = new CircleMarker([0, 0], {
			radius: 10,
			fill: true,
			fillColor: '#3388ff',
			stroke: true,
			weight: 2
		}).addTo(map);

		expectCacheMatchesUncachedForMap();

		marker.setRadius(25);
		expectCacheMatchesUncachedForMap();
		renderPixels(map._renderer, false);
		expect(marker._path2d).to.be.undefined;
	});

	it('matches uncached pixels after setStyle weight change without geometry invalidation', () => {
		const polyline = new Polyline([[0, 0], [0.03, 0.03]], {
			weight: 2,
			color: '#3388ff'
		}).addTo(map);

		// Draw 1: direct emission, warm flag only.
		renderPixels(map._renderer, false);
		expect(polyline._path2d).to.be.undefined;
		expect(polyline._path2dWarm).to.be.true;

		// Draw 2: geometry stable, Path2D retained.
		renderPixels(map._renderer, false);
		expect(polyline._path2d).to.exist;

		polyline.setStyle({weight: 8});
		expect(polyline._path2d).to.exist;
		expectCacheMatchesUncachedForMap();
	});

	it('allocates no Path2D on first draw after invalidation, then caches on second', () => {
		const polyline = new Polyline([[0, 0], [0.02, 0.02], [0.04, 0]], {
			weight: 3,
			color: '#3388ff'
		}).addTo(map);

		renderPixels(map._renderer, false);
		renderPixels(map._renderer, false);
		expect(polyline._path2d).to.exist;

		polyline.setLatLngs([[0.01, 0.01], [0.03, 0.03], [0.05, 0.01]]);
		renderPixels(map._renderer, false);
		expect(polyline._path2d).to.be.undefined;
		expect(polyline._path2dWarm).to.be.true;

		renderPixels(map._renderer, false);
		expect(polyline._path2d).to.exist;
		expectCacheMatchesUncachedForMap();
	});

	it('preserves z-order with cached batchable markers', () => {
		removeMapContainer(map, container);
		container = createContainer('200px', '200px');
		const canvas = new Canvas();
		map = new LeafletMap(container, {renderer: canvas, zoomControl: false});
		map.setView([0, 0], 8);

		const bottom = new CircleMarker([0, 0], {
			radius: 30,
			fill: true,
			fillColor: '#ff0000',
			fillOpacity: 1,
			stroke: false
		}).addTo(map);
		const top = new CircleMarker([0.001, 0.001], {
			radius: 10,
			fill: true,
			fillColor: '#0000ff',
			fillOpacity: 1,
			stroke: false
		}).addTo(map);

		new CircleMarker([0.02, 0.02], {
			radius: 8,
			fill: true,
			fillColor: '#ff0000',
			fillOpacity: 1,
			stroke: false
		}).addTo(map);

		expectCacheMatchesUncached(canvas);
		renderPixels(canvas, false);
		expect(bottom._path2d).to.be.undefined;
		expect(top._path2d).to.be.undefined;

		const center = map.latLngToLayerPoint([0, 0]);
		const image = getCanvasImageData(canvas);
		const idx = ((center.y * canvas._ctxScale) | 0) * image.width * 4 + ((center.x * canvas._ctxScale) | 0) * 4;

		expect(image.data[idx]).to.equal(255);
		expect(image.data[idx + 2]).to.equal(0);
		expect(bottom._order.next.layer).to.equal(top);
	});
});
