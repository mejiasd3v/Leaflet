import {Renderer} from './Renderer.js';
import {CanvasSpatialGrid} from './CanvasSpatialGrid.js';
import {Polyline} from './Polyline.js';
import {CircleMarker} from './CircleMarker.js';
import * as DomEvent from '../../dom/DomEvent.js';
import * as Util from '../../core/Util.js';
import {Bounds} from '../../geometry/Bounds.js';

const DASH_SEPARATOR_RE = /[, ]+/;
const BATCH_MAX_SIZE = 512;
const BATCH_BAIL_PROBE = 64;
const BATCH_KIND_POLY = 1;
const BATCH_KIND_CIRCLE = 2;
const REDRAW_PROMOTE_THRESHOLD = 0.25;
const REDRAW_PROMOTE_CANDIDATE_THRESHOLD = 1500;
const STOCK_POLYLINE_UPDATE_PATH = Polyline.prototype._updatePath;
const STOCK_CIRCLE_MARKER_UPDATE_PATH = CircleMarker.prototype._updatePath;

/*
 * @class Canvas
 * @inherits Renderer
 *
 * Allows vector layers to be displayed with [`<canvas>`](https://developer.mozilla.org/docs/Web/API/Canvas_API).
 * Inherits `Renderer`.
 *
 * @example
 *
 * Use Canvas by default for all paths in the map:
 *
 * ```js
 * const map = new LeafletMap('map', {
 * 	renderer: new Canvas()
 * });
 * ```
 *
 * Use a Canvas renderer with extra padding for specific vector geometries:
 *
 * ```js
 * const map = new LeafletMap('map');
 * const myRenderer = new Canvas({ padding: 0.5 });
 * const line = new Polyline( coordinates, { renderer: myRenderer } );
 * const circle =  new Circle( center, { renderer: myRenderer, radius: 100 } );
 * ```
 */

// @constructor Canvas(options?: Renderer options)
// Creates a Canvas renderer with the given options.
export class Canvas extends Renderer {

	static {
		// @section
		// @aka Canvas options
		this.setDefaultOptions({
			// @option tolerance: Number = 0
			// How much to extend the click tolerance around a path/object on the map.
			tolerance: 0
		});
	}

	getEvents() {
		const events = super.getEvents();
		events.viewprereset = this._onViewPreReset;
		return events;
	}

	_onViewPreReset() {
		// Set a flag so that a viewprereset+moveend+viewreset only updates&redraws once
		this._postponeUpdatePaths = true;
	}

	onAdd(map) {
		this._spatialGrid ??= new CanvasSpatialGrid();
		this._spatialIndexDirty = true;

		super.onAdd(map);

		// Redraw vectors since canvas is cleared upon removal,
		// in case of removing the renderer itself from the map.
		this._draw();
	}

	onRemove() {
		super.onRemove();

		clearTimeout(this._pointerHoverThrottleTimeout);
	}

	_initContainer() {
		const container = this._container = document.createElement('canvas');

		DomEvent.on(container, 'pointermove', this._onPointerMove, this);
		DomEvent.on(container, 'click dblclick pointerdown pointerup contextmenu', this._onClick, this);
		DomEvent.on(container, 'pointerout', this._handlePointerOut, this);
		container['_leaflet_disable_events'] = true;

		this._ctx = container.getContext('2d');
	}

	_destroyContainer() {
		cancelAnimationFrame(this._redrawRequest);
		this._redrawRequest = null;
		delete this._ctx;
		super._destroyContainer();
	}

	_resizeContainer() {
		const size = super._resizeContainer();
		const m = this._ctxScale = window.devicePixelRatio;

		// set canvas size (also clearing it); use double size on retina
		this._container.width = m * size.x;
		this._container.height = m * size.y;
	}

	_onZoomEnd() {
		super._onZoomEnd();
		this._spatialIndexDirty = true;
	}

	_onViewReset() {
		super._onViewReset();
		this._spatialIndexDirty = true;
	}

	_updatePaths() {
		if (this._postponeUpdatePaths) { return; }

		this._redrawBounds = null;
		for (const layer of Object.values(this._layers)) {
			this._invalidatePath2D(layer);
			layer._update();
		}

		if (this._spatialIndexDirty) {
			this._spatialGrid?.rebuild(this._layers);
			this._spatialIndexDirty = false;
		}

		this._redraw();
	}

	_update() {
		if (this._map._animatingZoom && this._bounds) { return; }

		const b = this._bounds,
		s = this._ctxScale;

		// translate so we use the same path coordinates after canvas element moves
		this._ctx.setTransform(
			s, 0, 0, s,
			-b.min.x * s,
			-b.min.y * s);

		// Tell paths to redraw themselves
		this.fire('update');
	}

	_reset() {
		super._reset();

		if (this._postponeUpdatePaths) {
			this._postponeUpdatePaths = false;
			this._updatePaths();
		}
	}

	_initPath(layer) {
		this._updateDashArray(layer);
		this._invalidateBatchStyleKey(layer);
		this._layers[Util.stamp(layer)] = layer;

		const order = layer._order = {
			layer,
			prev: this._drawLast,
			next: null
		};
		this._spatialGrid?.assignSeq(order);
		if (this._drawLast) { this._drawLast.next = order; }
		this._drawLast = order;
		this._drawFirst ??= this._drawLast;
	}

	_addPath(layer) {
		this._spatialGrid?.add(layer);
		this._requestRedraw(layer);
	}

	_removePath(layer) {
		this._invalidatePath2D(layer);

		const order = layer._order;
		const next = order.next;
		const prev = order.prev;

		if (next) {
			next.prev = prev;
		} else {
			this._drawLast = prev;
		}
		if (prev) {
			prev.next = next;
		} else {
			this._drawFirst = next;
		}

		delete layer._order;

		delete this._layers[Util.stamp(layer)];

		this._spatialGrid?.remove(layer);
		this._requestRedraw(layer);
	}

	_updatePath(layer) {
		// Redraw the union of the layer's old pixel
		// bounds and the new pixel bounds.
		this._extendRedrawBounds(layer);
		this._invalidatePath2D(layer);
		layer._project();
		layer._update();
		this._spatialGrid?.reindex(layer);
		// The redraw will extend the redraw bounds
		// with the new pixel bounds.
		this._requestRedraw(layer);
	}

	_updateStyle(layer) {
		this._updateDashArray(layer);
		this._invalidateBatchStyleKey(layer);
		this._requestRedraw(layer);
	}

	_updateDashArray(layer) {
		if (typeof layer.options.dashArray === 'string') {
			const parts = layer.options.dashArray.split(DASH_SEPARATOR_RE);
			// Ignore dash array containing invalid lengths
			layer.options._dashArray = parts.map(n => Number(n)).filter(n => !isNaN(n));
		} else {
			layer.options._dashArray = layer.options.dashArray;
		}
	}

	_requestRedraw(layer) {
		if (!this._map) { return; }

		this._extendRedrawBounds(layer);
		this._redrawRequest ??= requestAnimationFrame(this._redraw.bind(this));
	}

	_extendRedrawBounds(layer) {
		if (layer._pxBounds) {
			const padding = (layer.options.weight ?? 0) + 1;
			this._redrawBounds ??= new Bounds();
			this._redrawBounds.extend(layer._pxBounds.min.subtract([padding, padding]));
			this._redrawBounds.extend(layer._pxBounds.max.add([padding, padding]));
		}
	}

	_redraw() {
		this._redrawRequest = null;

		if (this._redrawBounds) {
			this._redrawBounds.min._floor();
			this._redrawBounds.max._ceil();
			this._maybePromoteRedrawBounds();
		}

		this._clear(); // clear layers in redraw bounds
		this._draw(); // draw layers

		this._redrawBounds = null;
	}

	_maybePromoteRedrawBounds() {
		if (this._disableDirtyRectPromotion || !this._redrawBounds || !this._bounds) {
			return;
		}

		const dirtySize = this._redrawBounds.getSize();
		const canvasSize = this._bounds.getSize();
		const dirtyArea = dirtySize.x * dirtySize.y;
		const canvasArea = canvasSize.x * canvasSize.y;

		if (canvasArea > 0 && dirtyArea / canvasArea >= REDRAW_PROMOTE_THRESHOLD) {
			this._redrawBounds = null;
			return;
		}

		const candidates = this._spatialGrid?.queryBounds(this._redrawBounds);
		if (candidates && candidates.length >= REDRAW_PROMOTE_CANDIDATE_THRESHOLD) {
			this._redrawBounds = null;
		}
	}

	_clear() {
		const bounds = this._redrawBounds;
		if (bounds) {
			const size = bounds.getSize();
			this._ctx.clearRect(bounds.min.x, bounds.min.y, size.x, size.y);
		} else {
			this._ctx.save();
			this._ctx.setTransform(1, 0, 0, 1, 0, 0);
			this._ctx.clearRect(0, 0, this._container.width, this._container.height);
			this._ctx.restore();
		}
	}

	_draw() {
		const bounds = this._redrawBounds;
		const candidates = this._spatialGrid?.queryBounds(bounds);
		this._ctx.save();
		if (bounds) {
			const size = bounds.getSize();
			this._ctx.beginPath();
			this._ctx.rect(bounds.min.x, bounds.min.y, size.x, size.y);
			this._ctx.clip();
		}

		this._drawing = true;

		let batchLayers = null;
		let batchKinds = null;
		let batchStyleKey = null;
		let batchUnionBounds = null;
		let pendingLayer = null;
		let pendingKind = 0;
		let pendingStyleKey = null;
		let batchableProbeCount = 0;
		let batchPairFormed = false;
		let batchingDisabled = false;

		const extendBatchUnionBounds = (pxBounds) => {
			batchUnionBounds = batchUnionBounds ?
				new Bounds(batchUnionBounds).extend(pxBounds) :
				new Bounds(pxBounds.min, pxBounds.max);
		};

		const flushBatch = () => {
			if (!batchLayers?.length) { return; }

			const ctx = this._ctx;
			if (!this._disablePath2DCache && this._batchCanUsePath2D(batchLayers)) {
				const batchPath = new Path2D();
				let allCached = true;
				for (let i = 0; i < batchLayers.length; i++) {
					if (!batchLayers[i]._path2d) {
						allCached = false;
						break;
					}
				}
				if (allCached) {
					for (let i = 0; i < batchLayers.length; i++) {
						batchPath.addPath(batchLayers[i]._path2d);
					}
				} else {
					for (let i = 0; i < batchLayers.length; i++) {
						const layer = batchLayers[i];
						const kind = batchKinds[i];
						if (kind === BATCH_KIND_POLY) {
							this._buildPolyPath2D(layer, batchPath, false);
						} else {
							this._buildCirclePath2D(layer, batchPath);
						}
						this._ensurePath2D(layer, kind, kind === BATCH_KIND_POLY ? false : undefined);
					}
				}
				this._fillStroke(ctx, batchLayers[0], batchPath);
			} else {
				ctx.beginPath();
				for (let i = 0; i < batchLayers.length; i++) {
					const layer = batchLayers[i];
					if (batchKinds[i] === BATCH_KIND_POLY) {
						this._appendPolyPath(layer, false);
					} else {
						this._appendCirclePath(layer);
					}
				}
				this._fillStroke(ctx, batchLayers[0]);
			}
			batchLayers = null;
			batchKinds = null;
			batchStyleKey = null;
			batchUnionBounds = null;
		};

		const drawPending = () => {
			if (!pendingLayer) { return; }
			pendingLayer._updatePath();
			pendingLayer = null;
			pendingKind = 0;
			pendingStyleKey = null;
		};

		const startBatch = (firstLayer, firstKind, secondLayer, secondKind, styleKey) => {
			batchPairFormed = true;
			batchLayers = [firstLayer, secondLayer];
			batchKinds = [firstKind, secondKind];
			batchStyleKey = styleKey;
			batchUnionBounds = null;
			const firstBounds = firstLayer._pxBounds;
			const secondBounds = secondLayer._pxBounds;
			if (firstBounds) {
				extendBatchUnionBounds(firstBounds);
			}
			if (secondBounds) {
				extendBatchUnionBounds(secondBounds);
			}
		};

		const drawLayer = (layer) => {
			if (bounds && (!layer._pxBounds || !layer._pxBounds.intersects(bounds))) {
				return;
			}

			if (this._disablePathBatching || batchingDisabled) {
				layer._updatePath();
				return;
			}

			const kind = this._getLayerBatchKind(layer);
			if (kind === 0) {
				flushBatch();
				drawPending();
				layer._updatePath();
				return;
			}

			batchableProbeCount++;
			if (!batchPairFormed && batchableProbeCount > BATCH_BAIL_PROBE) {
				batchingDisabled = true;
				flushBatch();
				drawPending();
				layer._updatePath();
				return;
			}

			const styleKey = this._getBatchStyleKey(layer);

			if (batchLayers) {
				if (!this._batchStyleKeysEqual(batchStyleKey, styleKey) ||
					batchLayers.length >= BATCH_MAX_SIZE ||
					this._batchBoundsOverlap(batchLayers, batchUnionBounds, layer)) {
					flushBatch();
				} else {
					batchLayers.push(layer);
					batchKinds.push(kind);
					if (layer._pxBounds) {
						extendBatchUnionBounds(layer._pxBounds);
					}
					return;
				}
			}

			if (pendingLayer) {
				if (this._batchStyleKeysEqual(pendingStyleKey, styleKey) &&
					!this._pxBoundsOverlap(pendingLayer._pxBounds, layer._pxBounds)) {
					startBatch(pendingLayer, pendingKind, layer, kind, styleKey);
					pendingLayer = null;
					pendingKind = 0;
					pendingStyleKey = null;
					return;
				}
				drawPending();
			}

			pendingLayer = layer;
			pendingKind = kind;
			pendingStyleKey = styleKey;
		};

		if (candidates) {
			for (const layer of candidates) {
				drawLayer(layer);
			}
		} else {
			for (let order = this._drawFirst; order; order = order.next) {
				drawLayer(order.layer);
			}
		}

		flushBatch();
		drawPending();

		this._drawing = false;

		this._ctx.restore();  // Restore state before clipping.
	}

	_invalidateBatchStyleKey(layer) {
		delete layer._batchStyleKey;
	}

	_getBatchStyleKey(layer) {
		if (layer._batchStyleKey) { return layer._batchStyleKey; }

		const options = layer.options;
		const dash = options._dashArray;
		layer._batchStyleKey = [
			options.stroke,
			options.color,
			options.weight,
			options.opacity,
			options.lineCap,
			options.lineJoin,
			dash,
			options.dashOffset,
			options.fill,
			options.fillColor,
			options.fillOpacity,
			options.fillRule || 'evenodd'
		];
		return layer._batchStyleKey;
	}

	_batchStyleKeysEqual(a, b) {
		if (a.length !== b.length) { return false; }
		for (let i = 0; i < a.length; i++) {
			const av = a[i];
			const bv = b[i];
			if (av === bv) { continue; }
			if (Array.isArray(av) && Array.isArray(bv)) {
				if (av.length !== bv.length) { return false; }
				for (let j = 0; j < av.length; j++) {
					if (av[j] !== bv[j]) { return false; }
				}
				continue;
			}
			return false;
		}
		return true;
	}

	_getLayerBatchKind(layer) {
		const updatePath = layer._updatePath;
		if (updatePath === STOCK_POLYLINE_UPDATE_PATH) {
			return BATCH_KIND_POLY;
		}
		if (updatePath === STOCK_CIRCLE_MARKER_UPDATE_PATH && !this._isEllipseCircle(layer)) {
			return BATCH_KIND_CIRCLE;
		}
		return 0;
	}

	_isEllipseCircle(layer) {
		const r = Math.max(Math.round(layer._pxRadius), 1);
		const ry = layer._pxRadiusY;
		if (ry == null) { return false; }
		const s = (Math.max(Math.round(ry), 1) || r) / r;
		return s !== 1;
	}

	_pxBoundsOverlap(a, b) {
		if (!a || !b) { return false; }
		return a.intersects(b);
	}

	_batchBoundsOverlap(batchLayers, batchUnionBounds, layer) {
		const pxBounds = layer._pxBounds;
		if (!pxBounds || !batchLayers.length) { return false; }

		if (batchUnionBounds && pxBounds.intersects(batchUnionBounds)) {
			for (const member of batchLayers) {
				const memberBounds = member._pxBounds;
				if (memberBounds && pxBounds.intersects(memberBounds)) {
					return true;
				}
			}
		}
		return false;
	}

	_invalidatePath2D(layer) {
		delete layer._path2d;
	}

	_canUsePath2DCache(layer) {
		const updatePath = layer._updatePath;
		if (updatePath !== STOCK_POLYLINE_UPDATE_PATH &&
			updatePath !== STOCK_CIRCLE_MARKER_UPDATE_PATH) {
			return false;
		}
		if (updatePath === STOCK_CIRCLE_MARKER_UPDATE_PATH && this._isEllipseCircle(layer)) {
			return false;
		}
		return true;
	}

	_batchCanUsePath2D(batchLayers) {
		for (let i = 0; i < batchLayers.length; i++) {
			if (!this._canUsePath2DCache(batchLayers[i])) {
				return false;
			}
		}
		return true;
	}

	_buildPolyPath2D(layer, path, closed) {
		const parts = layer._parts;
		if (!parts.length) { return; }

		for (const ring of parts) {
			for (let j = 0; j < ring.length; j++) {
				const p = ring[j];
				if (j === 0) {
					path.moveTo(p.x, p.y);
				} else {
					path.lineTo(p.x, p.y);
				}
			}
			if (closed) {
				path.closePath();
			}
		}
	}

	_buildCirclePath2D(layer, path) {
		if (layer._empty()) { return; }

		const p = layer._point,
		r = Math.max(Math.round(layer._pxRadius), 1);

		path.arc(p.x, p.y, r, 0, Math.PI * 2, false);
	}

	_ensurePath2D(layer, kind, closed) {
		if (layer._path2d) { return layer._path2d; }

		const path = new Path2D();
		if (kind === BATCH_KIND_POLY) {
			this._buildPolyPath2D(layer, path, closed);
		} else {
			this._buildCirclePath2D(layer, path);
		}

		const parts = kind === BATCH_KIND_POLY ? layer._parts : null;
		if (kind === BATCH_KIND_POLY && !parts.length) {
			return null;
		}
		if (kind === BATCH_KIND_CIRCLE && layer._empty()) {
			return null;
		}

		layer._path2d = path;
		return path;
	}

	_appendPolyPath(layer, closed) {
		const parts = layer._parts;
		const ctx = this._ctx;

		if (!parts.length) { return; }

		parts.forEach((p0) => {
			p0.forEach((p, j) => {
				ctx[j ? 'lineTo' : 'moveTo'](p.x, p.y);
			});
			if (closed) {
				ctx.closePath();
			}
		});
	}

	_updatePoly(layer, closed) {
		if (!this._drawing) { return; }

		const parts = layer._parts,
		ctx = this._ctx;

		if (!parts.length) { return; }

		if (!this._disablePath2DCache && this._canUsePath2DCache(layer)) {
			const path = this._ensurePath2D(layer, BATCH_KIND_POLY, closed);
			if (path) {
				this._fillStroke(ctx, layer, path);
			}
			return;
		}

		ctx.beginPath();
		this._appendPolyPath(layer, closed);
		this._fillStroke(ctx, layer);
	}

	_appendCirclePath(layer) {
		if (layer._empty()) { return; }

		const p = layer._point,
		ctx = this._ctx,
		r = Math.max(Math.round(layer._pxRadius), 1);

		ctx.arc(p.x, p.y, r, 0, Math.PI * 2, false);
	}

	_updateCircle(layer) {

		if (!this._drawing || layer._empty()) { return; }

		const p = layer._point,
		ctx = this._ctx,
		r = Math.max(Math.round(layer._pxRadius), 1),
		s = (Math.max(Math.round(layer._pxRadiusY), 1) || r) / r;

		if (!this._disablePath2DCache && this._canUsePath2DCache(layer)) {
			const path = this._ensurePath2D(layer, BATCH_KIND_CIRCLE);
			if (path) {
				this._fillStroke(ctx, layer, path);
			}
			return;
		}

		if (s !== 1) {
			ctx.save();
			ctx.scale(1, s);
		}

		ctx.beginPath();
		ctx.arc(p.x, p.y / s, r, 0, Math.PI * 2, false);

		if (s !== 1) {
			ctx.restore();
		}

		this._fillStroke(ctx, layer);
	}

	_fillStroke(ctx, layer, path) {
		const options = layer.options;

		if (options.fill) {
			ctx.globalAlpha = options.fillOpacity;
			ctx.fillStyle = options.fillColor ?? options.color;
			if (path) {
				ctx.fill(path, options.fillRule || 'evenodd');
			} else {
				ctx.fill(options.fillRule || 'evenodd');
			}
		}

		if (options.stroke && options.weight !== 0) {
			ctx.lineDashOffset = Number(options.dashOffset ?? 0);
			ctx.setLineDash(options._dashArray ?? []);
			ctx.globalAlpha = options.opacity;
			ctx.lineWidth = options.weight;
			ctx.strokeStyle = options.color;
			ctx.lineCap = options.lineCap;
			ctx.lineJoin = options.lineJoin;
			if (path) {
				ctx.stroke(path);
			} else {
				ctx.stroke();
			}
		}
	}

	// Canvas obviously doesn't have pointer events for individual drawn objects,
	// so we emulate that by calculating what's under the pointer on pointermove/click manually

	_onClick(e) {
		const point = this._map.pointerEventToLayerPoint(e);
		const clickedLayer = this._findInteractiveLayerAt(point, layer => !(e.type === 'click' || e.type === 'preclick') || !this._map._draggableMoved(layer)
		);
		this._fireEvent(clickedLayer ? [clickedLayer] : false, e);
	}

	_onPointerMove(e) {
		if (!this._map || this._map.dragging.moving() || this._map._animatingZoom) { return; }

		const point = this._map.pointerEventToLayerPoint(e);
		this._handlePointerHover(e, point);
	}


	_handlePointerOut(e) {
		const layer = this._hoveredLayer;
		if (layer) {
			// if we're leaving the layer, fire pointerout
			this._container.classList.remove('leaflet-interactive');
			this._fireEvent([layer], e, 'pointerout');
			this._hoveredLayer = null;
			this._pointerHoverThrottled = false;
		}
	}

	_handlePointerHover(e, point) {
		if (this._pointerHoverThrottled) {
			return;
		}

		const candidateHoveredLayer = this._findInteractiveLayerAt(point);

		if (candidateHoveredLayer !== this._hoveredLayer) {
			this._handlePointerOut(e);

			if (candidateHoveredLayer) {
				this._container.classList.add('leaflet-interactive'); // change cursor
				this._fireEvent([candidateHoveredLayer], e, 'pointerover');
				this._hoveredLayer = candidateHoveredLayer;
			}
		}

		this._fireEvent(this._hoveredLayer ? [this._hoveredLayer] : false, e);

		this._pointerHoverThrottled = true;
		this._pointerHoverThrottleTimeout = setTimeout((() => {
			this._pointerHoverThrottled = false;
		}), 32);
	}

	_fireEvent(layers, e, type) {
		this._map._fireDOMEvent(e, type || e.type, layers);
	}

	// Indexed candidates are sorted ascending by _order.seq, which must stay in
	// sync with linked-list draw order; the last matching layer is topmost.
	_findInteractiveLayerAt(point, accept) {
		const candidates = this._spatialGrid?.queryPoint(point);
		let topmost;

		if (candidates) {
			for (const layer of candidates) {
				if (layer.options.interactive && layer._containsPoint(point)) {
					if (!accept || accept(layer)) {
						topmost = layer;
					}
				}
			}
		} else {
			for (let order = this._drawFirst; order; order = order.next) {
				const layer = order.layer;
				if (layer.options.interactive && layer._containsPoint(point)) {
					if (!accept || accept(layer)) {
						topmost = layer;
					}
				}
			}
		}

		return topmost;
	}

	_bringToFront(layer) {
		const order = layer._order;

		if (!order) { return; }

		const next = order.next;
		const prev = order.prev;

		if (next) {
			next.prev = prev;
		} else {
			// Already last
			return;
		}
		if (prev) {
			prev.next = next;
		} else if (next) {
			// Update first entry unless this is the
			// single entry
			this._drawFirst = next;
		}

		order.prev = this._drawLast;
		this._drawLast.next = order;

		order.next = null;
		this._drawLast = order;

		order.seq = this._spatialGrid?.seqToFront() ?? order.seq;
		this._requestRedraw(layer);
	}

	_bringToBack(layer) {
		const order = layer._order;

		if (!order) { return; }

		const next = order.next;
		const prev = order.prev;

		if (prev) {
			prev.next = next;
		} else {
			// Already first
			return;
		}
		if (next) {
			next.prev = prev;
		} else if (prev) {
			// Update last entry unless this is the
			// single entry
			this._drawLast = prev;
		}

		order.prev = null;

		order.next = this._drawFirst;
		this._drawFirst.prev = order;
		this._drawFirst = order;

		order.seq = this._spatialGrid?.seqToBack() ?? order.seq;
		this._requestRedraw(layer);
	}
}
