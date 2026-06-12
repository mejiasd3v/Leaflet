import * as Util from '../../core/Util.js';

// Uniform grid spatial index for Canvas renderer hit-testing and dirty-rect
// redraws. Layers are indexed by layer._pxBounds in layer-pixel space (the
// same space as pointerEventToLayerPoint and _redrawBounds).
//
// Cell size is chosen relative to a typical map tile/viewport chunk (256px).
// Layers whose bounds cover more than MAX_CELLS_PER_LAYER grid cells are kept
// in an "oversized" overflow list that is always consulted on queries.
//
// Z-order is NOT stored in the grid. Each layer._order node carries a
// monotonically assigned seq number; query results are sorted by seq so draw
// order and topmost hit-testing match the _drawFirst/_drawLast linked list.
//
// Below BYPASS_THRESHOLD layers the index is bypassed and the renderer falls
// back to a linear linked-list walk to avoid index overhead on small maps.

export const CELL_SIZE = 256;
export const MAX_CELLS_PER_LAYER = 64;
export const BYPASS_THRESHOLD = 32;

function cellKey(cx, cy) {
	return `${cx},${cy}`;
}

export class CanvasSpatialGrid {

	constructor() {
		this._cells = new Map();
		this._oversized = new Set();
		this._layerCells = new Map();
		this._count = 0;
		this._minSeq = 0;
		this._maxSeq = 0;
	}

	get count() {
		return this._count;
	}

	usesIndex() {
		return this._count > BYPASS_THRESHOLD;
	}

	assignSeq(order) {
		order.seq = ++this._maxSeq;
		if (this._maxSeq === 1) {
			this._minSeq = 1;
		}
	}

	seqToFront() {
		return ++this._maxSeq;
	}

	seqToBack() {
		return --this._minSeq;
	}

	add(layer) {
		if (!layer._pxBounds?.isValid()) {
			return;
		}

		const stamp = Util.stamp(layer);
		if (this._layerCells.has(stamp)) {
			return;
		}

		this._insert(layer, stamp);
		this._count++;
	}

	remove(layer) {
		const stamp = Util.stamp(layer);
		if (!this._layerCells.has(stamp) && !this._oversized.has(layer)) {
			return;
		}

		this._removeFromCells(layer, stamp);
		this._count--;
	}

	reindex(layer) {
		const stamp = Util.stamp(layer);
		if (this._layerCells.has(stamp) || this._oversized.has(layer)) {
			this._removeFromCells(layer, stamp);
			this._count--;
		}

		if (layer._pxBounds?.isValid()) {
			this._insert(layer, stamp);
			this._count++;
		}
	}

	rebuild(layers) {
		this._cells.clear();
		this._oversized.clear();
		this._layerCells.clear();
		this._count = 0;

		for (const layer of Object.values(layers)) {
			if (layer._pxBounds?.isValid()) {
				this._insert(layer, Util.stamp(layer));
				this._count++;
			}
		}
	}

	queryPoint(point) {
		if (!this.usesIndex()) {
			return null;
		}

		const cx = Math.floor(point.x / CELL_SIZE);
		const cy = Math.floor(point.y / CELL_SIZE);
		const cell = this._cells.get(cellKey(cx, cy));
		const result = new Set();

		if (cell) {
			for (const layer of cell) {
				result.add(layer);
			}
		}

		for (const layer of this._oversized) {
			result.add(layer);
		}

		return this._sortBySeq(result);
	}

	queryBounds(bounds) {
		if (!this.usesIndex() || !bounds) {
			return null;
		}

		const minX = Math.floor(bounds.min.x / CELL_SIZE);
		const minY = Math.floor(bounds.min.y / CELL_SIZE);
		const maxX = Math.floor(bounds.max.x / CELL_SIZE);
		const maxY = Math.floor(bounds.max.y / CELL_SIZE);
		const result = new Set();

		for (let x = minX; x <= maxX; x++) {
			for (let y = minY; y <= maxY; y++) {
				const cell = this._cells.get(cellKey(x, y));
				if (cell) {
					for (const layer of cell) {
						result.add(layer);
					}
				}
			}
		}

		for (const layer of this._oversized) {
			result.add(layer);
		}

		return this._sortBySeq(result);
	}

	_insert(layer, stamp) {
		const bounds = layer._pxBounds;
		const minX = Math.floor(bounds.min.x / CELL_SIZE);
		const minY = Math.floor(bounds.min.y / CELL_SIZE);
		const maxX = Math.floor(bounds.max.x / CELL_SIZE);
		const maxY = Math.floor(bounds.max.y / CELL_SIZE);
		const cellCount = (maxX - minX + 1) * (maxY - minY + 1);

		if (cellCount > MAX_CELLS_PER_LAYER) {
			this._oversized.add(layer);
			this._layerCells.set(stamp, null);
			return;
		}

		const keys = [];
		for (let x = minX; x <= maxX; x++) {
			for (let y = minY; y <= maxY; y++) {
				const key = cellKey(x, y);
				keys.push(key);
				let cell = this._cells.get(key);
				if (!cell) {
					cell = new Set();
					this._cells.set(key, cell);
				}
				cell.add(layer);
			}
		}
		this._layerCells.set(stamp, keys);
	}

	_removeFromCells(layer, stamp) {
		const keys = this._layerCells.get(stamp);

		if (keys === null) {
			this._oversized.delete(layer);
		} else if (keys) {
			for (const key of keys) {
				const cell = this._cells.get(key);
				if (cell) {
					cell.delete(layer);
					if (cell.size === 0) {
						this._cells.delete(key);
					}
				}
			}
		}

		this._layerCells.delete(stamp);
	}

	_sortBySeq(layers) {
		const arr = [...layers];
		arr.sort((a, b) => a._order.seq - b._order.seq);
		return arr;
	}
}
