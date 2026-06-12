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

function renderPixels(map, disableBatching) {
	const renderer = map._renderer;
	renderer._disablePathBatching = disableBatching;
	redrawCanvas(renderer);
	return getCanvasImageData(renderer);
}

describe('Canvas batch draw pixel equivalence', () => {
	let container, map;

	afterEach(() => {
		removeMapContainer(map, container);
	});

	it('matches unbatched pixels for 50 overlapping translucent circles', () => {
		container = createContainer('400px', '400px');
		map = new LeafletMap(container, {preferCanvas: true, zoomControl: false});
		map.setView([0, 0], 8);

		const style = {
			radius: 12,
			fill: true,
			fillOpacity: 0.5,
			fillColor: '#3388ff',
			stroke: false
		};

		for (let i = 0; i < 50; i++) {
			const angle = (i / 50) * Math.PI * 2;
			new CircleMarker([
				Math.cos(angle) * 0.001,
				Math.sin(angle) * 0.001
			], style).addTo(map);
		}

		const batched = renderPixels(map, false);
		const unbatched = renderPixels(map, true);
		expectPixelsEqual(batched, unbatched);
	});

	it('matches unbatched pixels for overlapping polygons with holes', () => {
		container = createContainer('400px', '400px');
		map = new LeafletMap(container, {preferCanvas: true, zoomControl: false});
		map.setView([0, 0], 8);

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

		const batched = renderPixels(map, false);
		const unbatched = renderPixels(map, true);
		expectPixelsEqual(batched, unbatched);
	});

	it('matches unbatched pixels for interleaved styles', () => {
		container = createContainer('400px', '400px');
		map = new LeafletMap(container, {preferCanvas: true, zoomControl: false});
		map.setView([0, 0], 6);

		for (let i = 0; i < 40; i++) {
			const lat = (i % 8) * 0.01;
			const lng = Math.floor(i / 8) * 0.01;
			new CircleMarker([lat, lng], {
				radius: 6,
				fill: true,
				fillColor: i % 2 ? '#ff0000' : '#0000ff',
				fillOpacity: 0.8,
				stroke: false
			}).addTo(map);
		}

		const batched = renderPixels(map, false);
		const unbatched = renderPixels(map, true);
		expectPixelsEqual(batched, unbatched);
	});

	it('matches unbatched pixels for mixed batchable and custom _updatePath layers', () => {
		container = createContainer('400px', '400px');
		map = new LeafletMap(container, {preferCanvas: true, zoomControl: false});
		map.setView([0, 0], 6);

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

		const batched = renderPixels(map, false);
		const unbatched = renderPixels(map, true);
		expectPixelsEqual(batched, unbatched);
	});

	it('preserves z-order when batching consecutive same-style disjoint markers', () => {
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

		// Disjoint bounds with identical style should still respect painter order.
		new CircleMarker([0.02, 0.02], {
			radius: 8,
			fill: true,
			fillColor: '#ff0000',
			fillOpacity: 1,
			stroke: false
		}).addTo(map);

		redrawCanvas(canvas);

		const center = map.latLngToLayerPoint([0, 0]);
		const image = getCanvasImageData(canvas);
		const idx = ((center.y * canvas._ctxScale) | 0) * image.width * 4 + ((center.x * canvas._ctxScale) | 0) * 4;

		expect(image.data[idx]).to.equal(255);
		expect(image.data[idx + 2]).to.equal(0);

		expect(bottom._order.next.layer).to.equal(top);
	});
});
