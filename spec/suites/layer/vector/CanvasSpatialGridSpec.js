import {expect} from 'chai';
import {Bounds, Util} from 'leaflet';
import {
	BYPASS_THRESHOLD,
	CanvasSpatialGrid,
	CELL_SIZE,
	MAX_CELLS_PER_LAYER
} from '../../../../src/layer/vector/CanvasSpatialGrid.js';

function makeLayer(minX, minY, maxX, maxY, seq = 1) {
	const layer = {
		_pxBounds: new Bounds([minX, minY], [maxX, maxY]),
		_order: {seq}
	};
	Util.stamp(layer);
	return layer;
}

describe('CanvasSpatialGrid', () => {
	let grid;

	beforeEach(() => {
		grid = new CanvasSpatialGrid();
	});

	it('bypasses the index below the layer threshold', () => {
		for (let i = 0; i < BYPASS_THRESHOLD; i++) {
			grid.add(makeLayer(0, 0, 10, 10, i));
		}
		expect(grid.usesIndex()).to.be.false;
		expect(grid.queryPoint({x: 5, y: 5})).to.be.null;
	});

	it('queries point candidates from a single cell', () => {
		const inside = makeLayer(0, 0, 10, 10, 2);
		const outside = makeLayer(CELL_SIZE * 2, 0, CELL_SIZE * 2 + 10, 10, 1);
		for (let i = 0; i < BYPASS_THRESHOLD; i++) {
			grid.add(makeLayer(CELL_SIZE * 3, 0, CELL_SIZE * 3 + 1, 1, i + 10));
		}
		grid.add(inside);
		grid.add(outside);

		const candidates = grid.queryPoint({x: 5, y: 5});
		expect(candidates.map(layer => layer._order.seq)).to.eql([2]);
	});

	it('sorts candidates by draw-order sequence', () => {
		for (let i = 0; i < BYPASS_THRESHOLD; i++) {
			grid.add(makeLayer(CELL_SIZE * 3, 0, CELL_SIZE * 3 + 1, 1, i + 10));
		}
		grid.add(makeLayer(0, 0, 20, 20, 1));
		grid.add(makeLayer(0, 0, 20, 20, 3));
		grid.add(makeLayer(0, 0, 20, 20, 2));

		const candidates = grid.queryPoint({x: 5, y: 5});
		expect(candidates.map(layer => layer._order.seq)).to.eql([1, 2, 3]);
	});

	it('keeps oversized layers in the overflow list', () => {
		const span = Math.ceil(Math.sqrt(MAX_CELLS_PER_LAYER)) * CELL_SIZE + CELL_SIZE;
		for (let i = 0; i < BYPASS_THRESHOLD; i++) {
			grid.add(makeLayer(CELL_SIZE * 4, 0, CELL_SIZE * 4 + 1, 1, i + 10));
		}
		const oversized = makeLayer(0, 0, span, span, 99);
		grid.add(oversized);

		const candidates = grid.queryPoint({x: 5, y: 5});
		expect(candidates).to.eql([oversized]);
	});

	it('reindexes a layer after bounds change', () => {
		for (let i = 0; i < BYPASS_THRESHOLD; i++) {
			grid.add(makeLayer(CELL_SIZE * 3, 0, CELL_SIZE * 3 + 1, 1, i + 10));
		}
		const layer = makeLayer(0, 0, 10, 10, 1);
		grid.add(layer);
		layer._pxBounds = new Bounds([CELL_SIZE * 2, 0], [CELL_SIZE * 2 + 10, 10]);
		grid.reindex(layer);

		expect(grid.queryPoint({x: CELL_SIZE * 2 + 5, y: 5}).map(l => l._order.seq)).to.eql([1]);
		expect(grid.queryPoint({x: 5, y: 5})).to.eql([]);
	});
});
