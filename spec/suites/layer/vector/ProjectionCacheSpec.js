import {expect} from 'chai';
import {LatLng, LeafletMap, Polyline, SimpleCRS} from 'leaflet';
import {createContainer, removeMapContainer} from '../../SpecHelper.js';

function isFlatLatLngs(latlngs) {
	return !latlngs.length || latlngs[0] instanceof LatLng || typeof latlngs[0][0] === 'number';
}

function expectedRings(map, latlngs) {
	if (isFlatLatLngs(latlngs)) {
		return [latlngs.map(ll => map.latLngToLayerPoint(ll))];
	}
	return latlngs.map(ring => ring.map(ll => map.latLngToLayerPoint(ll)));
}

function expectRingsEqual(ringsA, ringsB) {
	expect(ringsA.length).to.equal(ringsB.length);
	for (let i = 0; i < ringsA.length; i++) {
		expect(ringsA[i].length).to.equal(ringsB[i].length);
		for (let j = 0; j < ringsA[i].length; j++) {
			expect(ringsA[i][j]).to.eql(ringsB[i][j]);
		}
	}
}

describe('Polyline projection cache', () => {
	let map, container;

	beforeEach(() => {
		container = createContainer();
		map = new LeafletMap(container, {center: [55.8, 37.6], zoom: 6});
	});

	afterEach(() => {
		removeMapContainer(map, container);
	});

	it('reprojects correctly across zoom changes using the cache', () => {
		const latlngs = [[55.8, 37.6], [55.9, 38.0], [56.0, 38.5], [56.1, 39.0]];
		const polyline = new Polyline(latlngs).addTo(map);
		const cache = polyline._projCache;

		map.setZoom(8);
		expect(polyline._projCacheValid).to.be.true;
		expect(polyline._projCache).to.equal(cache);
		expectRingsEqual(polyline._rings, expectedRings(map, latlngs));

		map.setZoom(12);
		expect(polyline._projCacheValid).to.be.true;
		expect(polyline._projCache).to.equal(cache);
		expectRingsEqual(polyline._rings, expectedRings(map, latlngs));
	});

	it('invalidates the cache when setLatLngs is called', () => {
		const initialLatLngs = [[55.8, 37.6], [55.9, 38.0]];
		const updatedLatLngs = [[50.0, 30.0], [51.0, 31.0], [52.0, 32.0]];
		const polyline = new Polyline(initialLatLngs).addTo(map);

		expect(polyline._projCacheValid).to.be.true;

		polyline.setLatLngs(updatedLatLngs);

		expect(polyline._projCacheValid).to.be.true;
		expectRingsEqual(polyline._rings, expectedRings(map, updatedLatLngs));
	});

	it('invalidates the cache when coordinates are mutated in place and redraw is called', () => {
		const latlngs = [[55.8, 37.6], [55.9, 38.0], [56.0, 38.5]];
		const polyline = new Polyline(latlngs).addTo(map);
		const cache = polyline._projCache;

		polyline._latlngs[1].lat = 57.5;
		polyline._latlngs[1].lng = 40.0;
		polyline.redraw();

		expect(polyline._projCache).to.not.equal(cache);
		expectRingsEqual(polyline._rings, expectedRings(map, polyline._latlngs));
	});

	it('does not leave a ghost ring when setLatLngs shrinks a multi-polyline', () => {
		const multiLatLngs = [
			[[55.8, 37.6], [55.9, 38.0]],
			[[56.0, 38.5], [56.1, 39.0]]
		];
		const singleLatLngs = [[50.0, 30.0], [51.0, 31.0]];
		const polyline = new Polyline(multiLatLngs).addTo(map);

		expect(polyline._rings.length).to.equal(2);

		polyline.setLatLngs(singleLatLngs);

		expect(polyline._rings.length).to.equal(1);
		expectRingsEqual(polyline._rings, expectedRings(map, singleLatLngs));
	});

	it('rebuilds the cache when moved to a map with a different CRS', () => {
		const latlngs = [[10, 10], [20, 20], [30, 10]];
		const polyline = new Polyline(latlngs).addTo(map);

		map.removeLayer(polyline);

		const simpleContainer = createContainer();
		const simpleMap = new LeafletMap(simpleContainer, {
			crs: SimpleCRS,
			center: [0, 0],
			zoom: 0
		});

		polyline.addTo(simpleMap);

		expect(polyline._projCacheProjection).to.equal(SimpleCRS.projection);
		expectRingsEqual(polyline._rings, expectedRings(simpleMap, latlngs));

		removeMapContainer(simpleMap, simpleContainer);
	});
});
