import {bench, describe} from 'vitest';
import {Bounds, LeafletMap, Point, Polyline} from 'leaflet';

const VERTEX_COUNT = 100_000;
const ZOOM_LEVELS = [4, 6, 8, 10, 12, 14, 16, 18, 15, 11];

function makeLatLngs(count) {
	const latlngs = new Array(count);
	for (let i = 0; i < count; i++) {
		latlngs[i] = [55 + (i * 0.0001), 37 + (i * 0.0001)];
	}
	return latlngs;
}

// Replicates the pre-cache _projectLatlngs path (full projection per vertex).
function projectWithoutCache(polyline, map) {
	const pxBounds = new Bounds();
	const rings = [];
	const crs = map.options.crs;
	const scale = crs.scale(map._zoom);
	const transformation = crs.transformation;
	const pixelOrigin = map.getPixelOrigin();
	const projection = crs.projection;
	const ring = [];

	for (let i = 0, len = polyline._latlngs.length; i < len; i++) {
		const projected = projection.project(polyline._latlngs[i]);
		const projectedPoint = transformation._transform(
			new Point(projected.x, projected.y),
			scale
		)._round();
		const pt = projectedPoint._subtract(pixelOrigin);
		ring.push(pt);
		pxBounds.extend(pt);
	}

	rings.push(ring);
	polyline._rings = rings;
	if (polyline._bounds.isValid() && pxBounds.isValid()) {
		polyline._rawPxBounds = pxBounds;
	}
}

function runZoomProjections(project) {
	const container = document.createElement('div');
	container.style.width = '800px';
	container.style.height = '600px';
	document.body.appendChild(container);

	const map = new LeafletMap(container, {center: [55.8, 37.6], zoom: ZOOM_LEVELS[0]});
	const polyline = new Polyline(makeLatLngs(VERTEX_COUNT));
	polyline._bounds.extend(polyline._latlngs[0]);
	polyline._bounds.extend(polyline._latlngs[polyline._latlngs.length - 1]);
	map.addLayer(polyline);

	for (const zoom of ZOOM_LEVELS) {
		map._zoom = zoom;
		project(polyline, map);
	}

	map.remove();
	document.body.removeChild(container);
}

describe('polyline projection', () => {
	bench('uncached: latLngToLayerPoint per vertex across zoom changes', () => {
		runZoomProjections(projectWithoutCache);
	});

	bench('cached: zoom-invariant projection cache across zoom changes', () => {
		runZoomProjections((polyline) => {
			polyline._project();
		});
	});
});
