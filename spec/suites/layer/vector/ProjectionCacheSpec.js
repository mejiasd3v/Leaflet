import {expect} from 'chai';
import {LeafletMap, Polyline} from 'leaflet';
import {createContainer, removeMapContainer} from '../../SpecHelper.js';

function expectRingsEqual(ringsA, ringsB) {
	expect(ringsA.length).to.equal(ringsB.length);
	for (let i = 0; i < ringsA.length; i++) {
		expect(ringsA[i].length).to.equal(ringsB[i].length);
		for (let j = 0; j < ringsA[i].length; j++) {
			expect(ringsA[i][j]).to.eql(ringsB[i][j]);
		}
	}
}

function referenceRings(map, latlngs) {
	const reference = new Polyline(latlngs).addTo(map);
	return reference._rings;
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
		expectRingsEqual(polyline._rings, referenceRings(map, latlngs));

		map.setZoom(12);
		expect(polyline._projCacheValid).to.be.true;
		expect(polyline._projCache).to.equal(cache);
		expectRingsEqual(polyline._rings, referenceRings(map, latlngs));
	});

	it('invalidates the cache when setLatLngs is called', () => {
		const initialLatLngs = [[55.8, 37.6], [55.9, 38.0]];
		const updatedLatLngs = [[50.0, 30.0], [51.0, 31.0], [52.0, 32.0]];
		const polyline = new Polyline(initialLatLngs).addTo(map);

		expect(polyline._projCacheValid).to.be.true;

		polyline.setLatLngs(updatedLatLngs);

		expect(polyline._projCacheValid).to.be.true;
		expectRingsEqual(polyline._rings, referenceRings(map, updatedLatLngs));
	});

	it('invalidates the cache when coordinates are mutated in place and redraw is called', () => {
		const latlngs = [[55.8, 37.6], [55.9, 38.0], [56.0, 38.5]];
		const polyline = new Polyline(latlngs).addTo(map);
		const cache = polyline._projCache;

		polyline._latlngs[1].lat = 57.5;
		polyline._latlngs[1].lng = 40.0;
		polyline.redraw();

		expect(polyline._projCache).to.not.equal(cache);
		const mutatedLatLngs = polyline._latlngs.map(ll => [ll.lat, ll.lng]);
		expectRingsEqual(polyline._rings, referenceRings(map, mutatedLatLngs));
	});
});
