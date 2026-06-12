import {expect} from 'chai';
import {Canvas, CircleMarker, LeafletMap, Polygon, Polyline} from 'leaflet';
import {createContainer, removeMapContainer} from '../../SpecHelper.js';

const LCG_SEED = 0xFEEDFACE;
const SEAM_BAND_PX = 2;
const CHANNEL_TOLERANCE = 4;

function createLCG(seed) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

function getCanvasImageData(renderer) {
	const canvas = renderer._container;
	const ctx = canvas.getContext('2d');
	return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function buildMixedScene(map) {
	const style = {
		radius: 12,
		fill: true,
		fillOpacity: 0.5,
		fillColor: '#3388ff',
		stroke: false
	};

	for (let i = 0; i < 30; i++) {
		const angle = (i / 30) * Math.PI * 2;
		new CircleMarker([
			Math.cos(angle) * 0.002,
			Math.sin(angle) * 0.002
		], style).addTo(map);
	}

	const outer = [[-0.02, -0.02], [0.02, -0.02], [0.02, 0.02], [-0.02, 0.02]];
	const hole = [[-0.005, -0.005], [0.005, -0.005], [0.005, 0.005], [-0.005, 0.005]];

	for (let i = 0; i < 4; i++) {
		const offset = i * 0.004;
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

	for (let i = 0; i < 8; i++) {
		const lat = (i % 4) * 0.008;
		const lng = Math.floor(i / 4) * 0.008;
		new Polyline([[lat, lng], [lat + 0.006, lng + 0.004]], {
			weight: 3,
			color: '#00aa00',
			opacity: 0.7
		}).addTo(map);
	}
}

function makePanDeltas(count, rng) {
	const pans = [];
	for (let i = 0; i < count; i++) {
		const dx = Math.round((rng() * 2 - 1) * 37);
		const dy = Math.round((rng() * 2 - 1) * 29);
		if (dx === 0 && dy === 0) {
			pans.push([1, -1]);
		} else {
			pans.push([dx, dy]);
		}
	}
	return pans;
}

function isSeamPixel(x, y, w, h, deviceDx, deviceDy, band = SEAM_BAND_PX) {
	if (deviceDx > 0 && Math.abs(x - (w - deviceDx)) <= band) {
		return true;
	}
	if (deviceDx < 0 && Math.abs(x + deviceDx) <= band) {
		return true;
	}
	if (deviceDy > 0 && Math.abs(y - (h - deviceDy)) <= band) {
		return true;
	}
	if (deviceDy < 0 && Math.abs(y + deviceDy) <= band) {
		return true;
	}
	return false;
}

function compareImages(actual, expected, deviceDx, deviceDy) {
	const w = actual.width;
	const h = actual.height;
	let seamDiffPixels = 0;
	let nonSeamDiffPixels = 0;
	let maxChannelDelta = 0;

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const idx = (y * w + x) * 4;
			let pixelDiff = false;
			for (let c = 0; c < 4; c++) {
				const delta = Math.abs(actual.data[idx + c] - expected.data[idx + c]);
				if (delta > CHANNEL_TOLERANCE) {
					pixelDiff = true;
					maxChannelDelta = Math.max(maxChannelDelta, delta);
				} else if (delta > 0) {
					maxChannelDelta = Math.max(maxChannelDelta, delta);
				}
			}
			if (!pixelDiff) { continue; }

			if (isSeamPixel(x, y, w, h, deviceDx, deviceDy)) {
				seamDiffPixels++;
			} else {
				nonSeamDiffPixels++;
			}
		}
	}

	return {seamDiffPixels, nonSeamDiffPixels, maxChannelDelta};
}

function settleCanvas(canvas) {
	cancelAnimationFrame(canvas._redrawRequest);
	canvas._redrawRequest = null;
	canvas._redrawBounds = null;
	canvas._redraw();
	canvas._saveSettleState();
}

function flushCanvasRedraw(canvas) {
	cancelAnimationFrame(canvas._redrawRequest);
	canvas._redrawRequest = null;
	canvas._redraw();
}

function createFreshMap(container) {
	const canvas = new Canvas();
	const map = new LeafletMap(container, {renderer: canvas, zoomControl: false});
	map.setView([0, 0], 8);
	buildMixedScene(map);
	settleCanvas(canvas);
	return {map, canvas};
}

function teardownMap(map, canvas) {
	if (canvas) {
		cancelAnimationFrame(canvas._redrawRequest);
		canvas._redrawRequest = null;
		canvas._redraw = () => {};
	}
	map?.remove();
}

function runPanSequence(map, canvas, pans, disableFlags) {
	canvas._disablePanBlit = disableFlags;
	canvas._disableClipSkip = disableFlags;

	const results = [];
	for (const [dx, dy] of pans) {
		const oldMin = canvas._lastSettleBounds.min.clone();
		map.panBy([dx, dy], {animate: false});
		const boundsDelta = canvas._bounds.min.subtract(oldMin);
		const s = canvas._ctxScale;
		results.push({
			image: getCanvasImageData(canvas),
			deviceDx: boundsDelta.x * s,
			deviceDy: boundsDelta.y * s
		});
	}
	return results;
}

describe('Canvas pan blit pixel equivalence', () => {
	let container;

	afterEach(() => {
		removeMapContainer(null, container);
		container = null;
	});

	it('matches flag-disabled control for >=20 seeded pans (seam band only)', () => {
		container = createContainer('400px', '400px');
		const rng = createLCG(LCG_SEED);
		const pans = makePanDeltas(24, rng);

		const {map: mapOn, canvas: canvasOn} = createFreshMap(container);
		const onResults = runPanSequence(mapOn, canvasOn, pans, false);
		teardownMap(mapOn, canvasOn);

		const {map: mapOff, canvas: canvasOff} = createFreshMap(container);
		const offResults = runPanSequence(mapOff, canvasOff, pans, true);
		teardownMap(mapOff, canvasOff);

		let totalSeamDiff = 0;
		let totalNonSeamDiff = 0;
		let maxChannelDelta = 0;

		for (let i = 0; i < pans.length; i++) {
			const {image: actual, deviceDx, deviceDy} = onResults[i];
			const {image: expected} = offResults[i];
			const report = compareImages(actual, expected, deviceDx, deviceDy);
			totalSeamDiff += report.seamDiffPixels;
			totalNonSeamDiff += report.nonSeamDiffPixels;
			maxChannelDelta = Math.max(maxChannelDelta, report.maxChannelDelta);
		}


		console.log(`PAN_BLIT_PIXEL_REPORT ${JSON.stringify({
			pans: pans.length,
			totalSeamDiffPixels: totalSeamDiff,
			totalNonSeamDiffPixels: totalNonSeamDiff,
			maxChannelDelta
		})}`);

		expect(totalSeamDiff, 'seam-band diffs are expected with strip clipping').to.be.at.least(0);
		expect(totalNonSeamDiff, 'pixels outside seam band must match exactly').to.equal(0);
	});

	it('interleaves pans with one setLatLng between pans', () => {
		container = createContainer('400px', '400px');
		const rng = createLCG(LCG_SEED);
		const pans = makePanDeltas(24, rng);

		const runScenario = (disableFlags) => {
			const {map, canvas} = createFreshMap(container);
			canvas._disablePanBlit = disableFlags;
			canvas._disableClipSkip = disableFlags;

			const moving = new CircleMarker([0.01, 0.01], {
				radius: 14,
				fill: true,
				fillOpacity: 0.6,
				fillColor: '#ff8800',
				stroke: false
			}).addTo(map);
			flushCanvasRedraw(canvas);
			canvas._saveSettleState();

			const results = [];
			for (let i = 0; i < pans.length; i++) {
				const [dx, dy] = pans[i];
				const oldMin = canvas._lastSettleBounds.min.clone();
				map.panBy([dx, dy], {animate: false});
				if (i === 12) {
					moving.setLatLng([0.012, 0.008]);
					flushCanvasRedraw(canvas);
				}
				const boundsDelta = canvas._bounds.min.subtract(oldMin);
				const s = canvas._ctxScale;
				results.push({
					image: getCanvasImageData(canvas),
					deviceDx: boundsDelta.x * s,
					deviceDy: boundsDelta.y * s
				});
			}
			teardownMap(map, canvas);
			return results;
		};

		const onResults = runScenario(false);
		const offResults = runScenario(true);

		let totalNonSeamDiff = 0;
		for (let i = 0; i < onResults.length; i++) {
			const report = compareImages(
				onResults[i].image,
				offResults[i].image,
				onResults[i].deviceDx,
				onResults[i].deviceDy
			);
			totalNonSeamDiff += report.nonSeamDiffPixels;
		}
		expect(totalNonSeamDiff).to.equal(0);
	});

	it('matches flag-disabled when both pan blit and clip skip are disabled', () => {
		container = createContainer('400px', '400px');
		const pans = [[17, 11], [-19, 7], [23, -13]];

		const {map: mapOn, canvas: canvasOn} = createFreshMap(container);
		canvasOn._disablePanBlit = false;
		canvasOn._disableClipSkip = false;
		for (const [dx, dy] of pans) {
			mapOn.panBy([dx, dy], {animate: false});
		}
		const onImage = getCanvasImageData(canvasOn);
		teardownMap(mapOn, canvasOn);

		const {map: mapOff, canvas: canvasOff} = createFreshMap(container);
		canvasOff._disablePanBlit = true;
		canvasOff._disableClipSkip = true;
		for (const [dx, dy] of pans) {
			mapOff.panBy([dx, dy], {animate: false});
		}
		const offImage = getCanvasImageData(canvasOff);
		teardownMap(mapOff, canvasOff);

		const report = compareImages(onImage, offImage, 0, 0);
		expect(report.nonSeamDiffPixels).to.equal(0);
	});
});
