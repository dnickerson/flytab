/**
 * wireTap(el, handler)
 * Canonical tap handler for all FlyTab UI buttons.
 * - touchstart (passive): records finger position and timestamp
 * - touchend (passive): fires handler if < 20px movement and < 500ms
 * - click: fallback for desktop/mouse (suppressed after touch)
 *
 * Do NOT use for Leaflet SVG polygon hit-testing — that uses a separate
 * touchstart/touchend pair on the map container with capture:true.
 */
// Shared timestamp: after any wireTap touch fires, suppress synthetic click events
// for 350ms on ALL wireTap elements. Prevents double-fire when _renderWaypoints()
// rebuilds the DOM between touchend and the browser's synthetic click.
let _wireTapLastTouchAt = 0;

// Selectors for elements mounted directly into a Leaflet map container whose
// own taps must not fall through to the map's own tap-detection pipeline
// (Leaflet's own popups via .leaflet-popup, plus any custom overlay mounted
// the same way AirspaceAlertPopup is -- a raw div appended straight into the
// map container rather than going through Leaflet's popup system). Add a new
// selector HERE, not to each map touch-handler file individually, when a
// future popup/button mounts directly into the map container the same way.
const MAP_OVERLAY_SELECTORS = ['.leaflet-popup', '.airspace-alert-popup'];

function isTapOnMapOverlay(target) {
    return MAP_OVERLAY_SELECTORS.some(sel => target?.closest?.(sel));
}

function wireTap(el, handler) {
    if (!el) return;
    let tapStart = null;
    el.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1)
            tapStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
        else tapStart = null;
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
        if (!tapStart || e.changedTouches.length !== 1) { tapStart = null; return; }
        const ts = tapStart; tapStart = null;
        const dx = e.changedTouches[0].clientX - ts.x;
        const dy = e.changedTouches[0].clientY - ts.y;
        if (dx * dx + dy * dy > 400) return;
        if (Date.now() - ts.t > 500) return;
        _wireTapLastTouchAt = Date.now();
        handler(e);
    }, { passive: true });
    el.addEventListener('click', (e) => {
        if (Date.now() - _wireTapLastTouchAt < 350) return;
        handler(e);
    });
}

/**
 * wireIsolatedTap(el, handler)
 * wireTap for a control layered OVER something tappable -- a banner over the
 * map, a button inside a tappable row. Same tap rule as wireTap (one finger,
 * < 20px, < 500ms), plus:
 * - no touch, mouse or pointer event on el reaches its ancestors, so the map's
 *   own touch pipeline and any row handler never see it;
 * - touchend calls preventDefault, which cancels the browser's synthetic click,
 *   and sets _wireTapLastTouchAt, so a click can't land on whatever is under
 *   the finger once el has gone (e.g. DISMISS removing the banner).
 * Nested isolated controls work: the inner one stops the event first.
 */
function wireIsolatedTap(el, handler) {
    if (!el) return;
    let tapStart = null;
    const stop = (e) => e.stopPropagation();
    el.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        tapStart = e.touches.length === 1
            ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }
            : null;
    }, { passive: true });
    el.addEventListener('touchmove', stop, { passive: true });
    el.addEventListener('touchcancel', (e) => { e.stopPropagation(); tapStart = null; }, { passive: true });
    el.addEventListener('touchend', (e) => {
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        _wireTapLastTouchAt = Date.now();
        if (!tapStart || e.changedTouches.length !== 1) { tapStart = null; return; }
        const ts = tapStart; tapStart = null;
        const dx = e.changedTouches[0].clientX - ts.x;
        const dy = e.changedTouches[0].clientY - ts.y;
        if (dx * dx + dy * dy > 400) return;
        if (Date.now() - ts.t > 500) return;
        handler(e);
    }, { passive: false });
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'pointermove', 'dblclick', 'contextmenu']) {
        el.addEventListener(type, stop);
    }
    el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (Date.now() - _wireTapLastTouchAt < 600) return;
        handler(e);
    });
}
