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
function wireTap(el, handler) {
    if (!el) return;
    let tapStart = null, touchHandled = false;
    el.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1)
            tapStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
        else tapStart = null;
        touchHandled = false;
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
        if (!tapStart || e.changedTouches.length !== 1) { tapStart = null; return; }
        const ts = tapStart; tapStart = null;
        const dx = e.changedTouches[0].clientX - ts.x;
        const dy = e.changedTouches[0].clientY - ts.y;
        if (dx * dx + dy * dy > 400) return;
        if (Date.now() - ts.t > 500) return;
        touchHandled = true;
        handler(e);
    }, { passive: true });
    el.addEventListener('click', (e) => {
        if (touchHandled) { touchHandled = false; return; }
        handler(e);
    });
}
