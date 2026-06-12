import {Renderer} from './Renderer.js';
import {CanvasSpatialGrid} from './CanvasSpatialGrid.js';
import {Polyline} from './Polyline.js';
import {Polygon} from './Polygon.js';
import {CircleMarker} from './CircleMarker.js';
import * as DomEvent from '../../dom/DomEvent.js';
import * as Util from '../../core/Util.js';
import {Bounds} from '../../geometry/Bounds.js';
import {Point} from '../../geometry/Point.js';

const DASH_SEPARATOR_RE = /[, ]+/;
const BATCH_MAX_SIZE = 512;
const BATCH_BAIL_PROBE = 64;
const BATCH_KIND_POLY = 1;
const BATCH_KIND_CIRCLE = 2;
const REDRAW_PROMOTE_THRESHOLD = 0.25;
const REDRAW_PROMOTE_CANDIDATE_THRESHOLD = 1500;
const PAN_STRIP_PADDING = 32;
const STOCK_POLYLINE_UPDATE_PATH = Polyline.prototype._updatePath;
const STOCK_CIRCLE_MARKER_UPDATE_PATH = CircleMarker.prototype._updatePath;
const STOCK_POLYLINE_UPDATE = Polyline.prototype._update;
const STOCK_POLYLINE_CLIP = Polyline.prototype._clipPoints;
const STOCK_POLYGON_CLIP = Polygon.prototype._clipPoints;
const STOCK_CIRCLE_MARKER_UPDATE = CircleMarker.prototype._update;
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
		const w = Math.round(m * size.x);
		const h = Math.round(m * size.y);

		// Assigning width/height clears the backing store; skip when unchanged.
		if (this._container.width !== w || this._container.height !== h) {
			this._container.width = w;
			this._container.height = h;
		}

		return size;
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

		const panBlit = this._getPanBlitState();
		if (panBlit) {
			const stripUnion = this._unionPanStrips(panBlit.strips);
			const expandedStrip = stripUnion ? this._expandPanStrip(stripUnion) : null;
			this._blitPan(panBlit.delta);
			if (expandedStrip) {
				const expandedStrips = [expandedStrip];
				for (const layer of Object.values(this._layers)) {
					if (!this._shouldSkipLayerUpdateOnPan(layer, panBlit.oldBounds, panBlit.newBounds, expandedStrips)) {
						layer._update();
					}
				}
				this._redrawPanStrips(expandedStrips);
			}
			this._saveSettleState();
			return;
		}

		this._redrawBounds = null;
		for (const layer of Object.values(this._layers)) {
			layer._update();
		}

		if (this._spatialIndexDirty) {
			this._spatialGrid?.rebuild(this._layers);
			this._spatialIndexDirty = false;
		}

		this._redraw();
		this._saveSettleState();
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

	_redrawPanStrips(strips) {
		this._panStripRedraw = true;
		const batchingDisabled = this._disablePathBatching;
		this._disablePathBatching = true;
		try {
			for (const strip of strips) {
				this._redrawBounds = strip;
				this._redrawBounds.min._floor();
				this._redrawBounds.max._ceil();
				this._maybePromoteRedrawBounds();
				this._clear();
				this._draw();
			}
		} finally {
			this._disablePathBatching = batchingDisabled;
			this._panStripRedraw = false;
			this._redrawBounds = null;
		}
	}

	_saveSettleState() {
		if (!this._bounds || !this._container) { return; }

		this._lastSettleBounds = new Bounds(this._bounds.min, this._bounds.max);
		this._lastSettleZoom = this._zoom;
		this._lastSettleCtxScale = this._ctxScale;
		this._lastContainerWidth = this._container.width;
		this._lastContainerHeight = this._container.height;
	}

	_getPanBlitState() {
		if (this._disablePanBlit || !this._lastSettleBounds || !this._bounds || !this._map) {
			return null;
		}

		if (this._map._animatingZoom || this._zoom !== this._lastSettleZoom) {
			return null;
		}

		if (this._ctxScale !== this._lastSettleCtxScale ||
			this._container.width !== this._lastContainerWidth ||
			this._container.height !== this._lastContainerHeight) {
			return null;
		}

		const oldBounds = this._lastSettleBounds;
		const newBounds = this._bounds;
		const delta = newBounds.min.subtract(oldBounds.min);

		if (delta.x === 0 && delta.y === 0) {
			return null;
		}

		const s = this._ctxScale;
		const deviceDx = delta.x * s;
		const deviceDy = delta.y * s;

		if (!Number.isInteger(deviceDx) || !Number.isInteger(deviceDy)) {
			return null;
		}

		const canvasW = this._container.width;
		const canvasH = this._container.height;

		if (Math.abs(deviceDx) >= canvasW || Math.abs(deviceDy) >= canvasH) {
			return null;
		}

		const strips = this._computePanStrips(newBounds, delta);
		if (!strips.length) {
			return null;
		}

		return {delta, strips, oldBounds, newBounds};
	}

	_computePanStrips(newBounds, delta) {
		const strips = [];
		const d = delta;

		if (d.x > 0) {
			strips.push(new Bounds(
				new Point(newBounds.max.x - d.x, newBounds.min.y),
				new Point(newBounds.max.x, newBounds.max.y - (d.y > 0 ? d.y : 0))
			));
		} else if (d.x < 0) {
			strips.push(new Bounds(
				new Point(newBounds.min.x, newBounds.min.y),
				new Point(newBounds.min.x - d.x, newBounds.max.y - (d.y > 0 ? d.y : 0))
			));
		}

		if (d.y > 0) {
			strips.push(new Bounds(
				new Point(newBounds.min.x, newBounds.max.y - d.y),
				new Point(newBounds.max.x - (d.x > 0 ? d.x : 0), newBounds.max.y)
			));
		} else if (d.y < 0) {
			strips.push(new Bounds(
				new Point(newBounds.min.x + (d.x < 0 ? -d.x : 0), newBounds.min.y),
				new Point(newBounds.max.x, newBounds.min.y - d.y)
			));
		}

		return strips;
	}

	_blitPan(delta) {
		const s = this._ctxScale;
		const ox = -delta.x * s;
		const oy = -delta.y * s;
		const w = this._container.width;
		const h = this._container.height;

		let buffer = this._panBlitBuffer;
		if (!buffer || buffer.width !== w || buffer.height !== h) {
			buffer = this._panBlitBuffer = document.createElement('canvas');
			buffer.width = w;
			buffer.height = h;
		}

		buffer.getContext('2d').drawImage(this._container, 0, 0, w, h);

		this._ctx.save();
		this._ctx.setTransform(1, 0, 0, 1, 0, 0);
		this._ctx.clearRect(0, 0, w, h);
		this._ctx.drawImage(buffer, 0, 0, w, h, ox, oy, w, h);
		this._ctx.restore();
	}

	_canClipSkipOnPan(layer) {
		if (this._disableClipSkip) { return false; }

		const update = layer._update;
		if (update === STOCK_CIRCLE_MARKER_UPDATE) {
			return true;
		}

		if (update !== STOCK_POLYLINE_UPDATE) {
			return false;
		}

		const clip = layer._clipPoints;
		return clip === STOCK_POLYLINE_CLIP || clip === STOCK_POLYGON_CLIP;
	}

	_unionPanStrips(strips) {
		let union = null;
		for (const strip of strips) {
			union = union ?
				new Bounds(union).extend(strip) :
				new Bounds(strip.min, strip.max);
		}
		return union;
	}

	_expandPanStrip(strip) {
		const view = this._bounds;
		const expanded = new Bounds(
			new Point(
				Math.max(strip.min.x - PAN_STRIP_PADDING, view.min.x),
				Math.max(strip.min.y - PAN_STRIP_PADDING, view.min.y)
			),
			new Point(
				Math.min(strip.max.x + PAN_STRIP_PADDING, view.max.x),
				Math.min(strip.max.y + PAN_STRIP_PADDING, view.max.y)
			)
		);

		// Include full bounds of every layer touching the strip so translucent
		// stacks composite with the same underpaint a full redraw would use.
		for (const layer of Object.values(this._layers)) {
			if (layer._pxBounds?.intersects(strip)) {
				expanded.extend(layer._pxBounds);
			}
		}

		expanded.min.x = Math.max(expanded.min.x, view.min.x);
		expanded.min.y = Math.max(expanded.min.y, view.min.y);
		expanded.max.x = Math.min(expanded.max.x, view.max.x);
		expanded.max.y = Math.min(expanded.max.y, view.max.y);

		return expanded;
	}

	_shouldSkipLayerUpdateOnPan(layer, oldBounds, newBounds, expandedStrips) {
		if (!this._canClipSkipOnPan(layer) || !layer._pxBounds) {
			return false;
		}

		if (!oldBounds.contains(layer._pxBounds) || !newBounds.contains(layer._pxBounds)) {
			return false;
		}

		for (const strip of expandedStrips) {
			if (layer._pxBounds.intersects(strip)) {
				return false;
			}
		}

		return true;
	}

	_maybePromoteRedrawBounds() {
		if (this._disableDirtyRectPromotion || this._panStripRedraw ||
			!this._redrawBounds || !this._bounds) {
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
		const candidates = this._panStripRedraw ?
			null :
			this._spatialGrid?.queryBounds(bounds);
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

	_fillStroke(ctx, layer) {
		const options = layer.options;

		if (options.fill) {
			ctx.globalAlpha = options.fillOpacity;
			ctx.fillStyle = options.fillColor ?? options.color;
			ctx.fill(options.fillRule || 'evenodd');
		}

		if (options.stroke && options.weight !== 0) {
			ctx.lineDashOffset = Number(options.dashOffset ?? 0);
			ctx.setLineDash(options._dashArray ?? []);
			ctx.globalAlpha = options.opacity;
			ctx.lineWidth = options.weight;
			ctx.strokeStyle = options.color;
			ctx.lineCap = options.lineCap;
			ctx.lineJoin = options.lineJoin;
			ctx.stroke();
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
