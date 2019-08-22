/*
 * Copyright (c) 2018 PIXILAB Technologies AB, Sweden (http://pixilab.se). All Rights Reserved.
 */


/**
 * Misc touch interaction support functionality, useful in editor as well as in some
 * client projects (e.g., CoverFlow interaction, and such).
 */
export class TouchSupport {

	public static acceptTouch(
		preferTouch: boolean,
		elem: HTMLElement,
		downHandler: (event: DragEvent)=>DragResponder|undefined,
		enclScrollable?: boolean	// Allow for enclosing scrollable (hold off interaction a bit)
	): void {
		if (!preferTouch) {	// Fire up regular mouse listener style
			elem.addEventListener("mousedown", function(evt: MouseEvent) {
				var responder: DragResponder|undefined;
				if (evt.button === 0) { // Primary mouse btn
					evt.stopPropagation();
					responder = new DownDeferrer(enclScrollable, makeDragEvt(evt), downHandler).getResponder();
					if (responder) {
						document.body.addEventListener("mousemove", mouseMove);
						document.body.addEventListener("mouseup", mouseEnd);
					}
				}
				function mouseMove(evt: MouseEvent) {
					if (evt.buttons === 0)	// Note to self: buttons not supported by Safari
						mouseEnd(evt);	// NO button down - threat this as mouseUp instead
					else {
						if (responder.dragMove)
							responder.dragMove(makeDragEvt(evt));
					}
				}
				function mouseEnd(evt: MouseEvent) {
					document.body.removeEventListener("mousemove", mouseMove);
					document.body.removeEventListener("mouseup", mouseEnd);
					responder.eventEnd(makeDragEvt(evt));
				}
				/*	Make my DragEvent from the MouseEvent.
				 */
				function makeDragEvt(event:MouseEvent): DragEvent {
					var result = new DragEvent(event, event, false);
					result.transformElemToElem(document.body, elem);
					return result;
				}
			});
		} else {
			var touchEventPassivePar = supportsPassive() ? <any>{passive: true} : false;
			elem.addEventListener("touchstart", function(evt: TouchEvent) {
				var touch = evt.changedTouches[0],	// Use only 1st touch to act like mouse case
					myTouchID = touch.identifier;	// The one I track for move/end
				var responder: DragResponder|undefined;
				responder = new DownDeferrer(
					enclScrollable,
					makeDragEvt(evt, touch),
					downHandler
				).getResponder();
				if (responder) {
					elem.addEventListener("touchcancel", touchEnd);
					elem.addEventListener("touchmove", touchMove, touchEventPassivePar);
					elem.addEventListener("touchend", touchEnd);
				}

				function touchMove(evt: TouchEvent) {
					if (responder.dragMove) {
						let touch = touchById(evt, myTouchID);
						if (touch)
							responder.dragMove(makeDragEvt(evt, touch));
					}
				}

				function touchEnd(event: TouchEvent) {
					let touch = touchById(event, myTouchID);
					if (touch) {
						elem.removeEventListener("touchcancel", touchEnd);
						elem.removeEventListener("touchmove", touchMove);
						elem.removeEventListener("touchend", touchEnd);
						responder.eventEnd(makeDragEvt(event, touch));
					}
				}


				/*	Make my DragEvent based on the touch event and specified touch.
				 */
				function makeDragEvt(event:TouchEvent, touch:Touch): DragEvent {
					var result = new DragEvent(touch, event, supportsPassive());
					result.transformElemToElem(document.body, elem);
					return result;
				}
				// Cast below since type definitions have no support for "passive"
			}, touchEventPassivePar);
		}
		elem.addEventListener("contextmenu", function(evt: UIEvent) {
			evt.preventDefault();
		});
	}
}

/**
 * Return true if "passive" event listeners supported. See
 * https://github.com/WICG/EventListenerOptions/blob/gh-pages/explainer.md
 *
 * This was further used to make the touchEventPassivePar parameter, which
 * was passed when registering the touchmove handler. However, that stopped
 * preventDefault from working, which I need to NOT scroll on slider drags,
 * so let's revert for now. Apparently can be handled by CSS, as described
 * https://stackoverflow.com/questions/16348031/disable-scrolling-when-touch-moving-certain-element
 * under .lock-screen
 */
function supportsPassive() {
	if (sSupportsPassive === undefined) {	// Not yet determined - do so now
		// Test via a getter in the options object to see if the passive property is accessed
		sSupportsPassive = false;
		try {
			var opts = Object.defineProperty({}, 'passive', {
				get: function () {
					sSupportsPassive = true;
				}
			});
			window.addEventListener("testPassive", null, opts);
			window.removeEventListener("testPassive", null, opts);
		} catch (e) {
		}
	}
	// return sSupportsPassive;
	return false;	// SEE BLOCK COMMENT ABOVE
}
var sSupportsPassive: boolean;	// Initially undefined

/**
 * Return the single touch I deal with (as specified by myId), else undefined
 * if not found.
 */
function touchById(event: TouchEvent, myId: number) {
	let touchList = event.changedTouches;
	for (let i = touchList.length; i--; ) {
		let touch = touchList[i];
		if (myId === touch.identifier)
			return touch;
	}
	return undefined;
}

/**
 * Defer the "down" action if requested. Used to hold off touch interaction
 * inside scrollable areas, to avoid triggering a touch if a scroll (swipe)
 * gesture is what happened. Perhaps need a more sophisticated method here later...
 */
class DownDeferrer implements DragResponder {
	private readonly responder: DragResponder;	// What's returned from getResponder
	private subResponder: DragResponder;	// The responder I wrap
	private timeout: number;		// Set while waiting to determine
	private suppressed: boolean;	// Set once I decided I'm suppressed

	constructor(
		defer: boolean,
		private downEvent: DragEvent,
		private downHandler: (event: DragEvent)=>DragResponder|undefined,
	) {

		this.responder = defer ? this : downHandler(downEvent);
		if (defer) {
			this.timeout = setTimeout(()=> {
				delete this.timeout;
				if (!this.suppressed)
					this.subResponder = this.downHandler(this.downEvent);
			}, 200);
		} else
			downEvent.preventDefault();
	}

	/**
	 * Return either myself (if deferred) or the client's responder directly, if any.
	 */
	getResponder(): DragResponder|undefined {
		return this.responder;
	}

	/**
	 * Handle move. If there's significant motion before my timeout, then
	 * suppress this event, considering it a scroll instead.
	 */
	dragMove(event: DragEvent) {
		if (this.timeout) {	// Still waiting to figure things out
			if (distanceBetween(event, this.downEvent) > 10) {
				this.suppressed = true;
				this.cancelTimeout();
			}
		}
		if (this.subResponder && this.subResponder.dragMove)
			this.subResponder.dragMove(event);
	}

	private cancelTimeout() {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = 0;
		}
	}

	/**
	 * End of interaction. If I was suppressed, then do nothing, else forward
	 * BOTH the initial down event and the end event to the handler, essentially
	 * turning it into a tap.
	 */
	eventEnd(event: DragEvent) {
		if (this.timeout) {		// Still waiting to figure things out
			// Cancel wait and consider this a "click", sending both down and end downstream
			this.cancelTimeout();
			this.subResponder = this.downHandler(this.downEvent);
		}
		if (this.subResponder)
			this.subResponder.eventEnd(event);
	}
}

/**
 * Return distance from p1 to p2.
 */
function distanceBetween(p1: IPoint, p2: IPoint) {
	const xDist = p1.x - p2.x, yDist = p1.y - p2.y;
	return Math.sqrt(xDist * xDist + yDist * yDist);
}

interface IPoint {
	x: number;
	y: number;
}

/**
 * A rudimentary "drag event" used for both mouse and
 * touch handling, providing only the coordinate (similar to
 * offsetX and offsetY for the tracked element) and the
 * event target (which may be a child of the tracked
 * element).
 *
 * Note that I implement IPoint without saying so,
 * as I don't want to drag in Geom along with @serializable
 * since I want to use this also for misc client apps.
 */
export class DragEvent implements IPoint {
	x: number;			// These two fields implement IPoint
	y: number;
	target: HTMLElement;	// Target of original event

	constructor(
		tmEvt: Touch | MouseEvent,
		public readonly uiEvt: TouchEvent|MouseEvent,
		private readonly usesPassiveEvent: boolean
	) {
		this.x = tmEvt.pageX;
		this.y = tmEvt.pageY;
		this.target = <HTMLElement>tmEvt.target; // Blatantly assume HTMLElement here
	}

	get timeStamp(): number {
		return this.uiEvt.timeStamp;
	}

	/**
	 * Prevent default and stop propagation of associated event.
	 */
	preventDefault() {
		if (!this.usesPassiveEvent)
			this.uiEvt.preventDefault();
		this.uiEvt.stopPropagation();
	}

	/**
	 * Transform pt from its source coordinate system of srcEl to the corresponding
	 * location in the coordinate system of destEl, taking translation and scaling into
	 * account (assuming any scaling is uniform).
	 *
	 * Blatantly stolen from Geom.Point, since I didn't want to drag that in.
	 */
	public transformElemToElem(srcEl: HTMLElement, destEl: HTMLElement) {
		const enclRect = destEl.getBoundingClientRect();
		const targetRect = srcEl.getBoundingClientRect();
		this.x += targetRect.left - enclRect.left;
		this.y += targetRect.top - enclRect.top;
		// Calculate any scaling applied to targetEl and enclEl
		const targetScale = targetRect.width / srcEl.offsetWidth;
		const enclScale = enclRect.width / destEl.offsetWidth;
		// Scale pt by factor to go from target to encl
		const factor =targetScale / enclScale;
		this.x *= factor;
		this.y *= factor;
	}
}

/**
 * Callback interface for clients that wish to learn about drags or
 * touch/mouse up.
 */
export interface DragResponder {
	dragMove?: (event: DragEvent) => void;
	eventEnd: (event: DragEvent) => void;
}