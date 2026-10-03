/**
 * FlyTab — Shared pinch-to-zoom + pan gesture handler.
 * Extracted from approach-charts.js's plate viewer, which pioneered this
 * exact touch-gesture pattern on this app's target hardware. Attaches
 * touch listeners to `bodyEl` (the element that receives touch events —
 * typically the outer clipping/viewport element) and applies a CSS
 * transform to `containerEl` (the element being zoomed/panned — must have
 * `transform-origin: 0 0` and `touch-action: none` in its CSS).
 */
function attachPinchZoom(bodyEl, containerEl, { onApply, panAlways = false } = {}) {
    const pz = { scale: 1, tx: 0, ty: 0 };
    let lastDist = 0;
    let pinching = false;
    let panStartX = 0, panStartY = 0, panBaseTx = 0, panBaseTy = 0;
    let lastTap = 0;

    const apply = () => {
        containerEl.style.transform = `translate(${pz.tx}px, ${pz.ty}px) scale(${pz.scale})`;
        if (onApply) onApply();
    };

    const onTouchStart = (e) => {
        if (e.touches.length === 2) {
            pinching = true;
            lastDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
        } else if (e.touches.length === 1) {
            pinching = false;
            panStartX = e.touches[0].clientX;
            panStartY = e.touches[0].clientY;
            panBaseTx = pz.tx;
            panBaseTy = pz.ty;
        }
    };

    const onTouchMove = (e) => {
        if (e.touches.length === 2) {
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

            const newScale = Math.max(0.8, Math.min(8, pz.scale * (dist / lastDist)));
            const factor = newScale / pz.scale;

            const rect = containerEl.getBoundingClientRect();
            pz.tx += (midX - rect.left) * (1 - factor);
            pz.ty += (midY - rect.top) * (1 - factor);
            pz.scale = newScale;
            lastDist = dist;
            apply();
        } else if (e.touches.length === 1 && !pinching && (panAlways || pz.scale > 1.05)) {
            pz.tx = panBaseTx + (e.touches[0].clientX - panStartX);
            pz.ty = panBaseTy + (e.touches[0].clientY - panStartY);
            apply();
        }
    };

    const onTouchEnd = (e) => {
        if (e.touches.length === 0) {
            pinching = false;
            if (pz.scale < 1) {
                pz.scale = 1; pz.tx = 0; pz.ty = 0;
                apply();
            }
            const now = Date.now();
            if (now - lastTap < 350) {
                pz.scale = 1; pz.tx = 0; pz.ty = 0;
                apply();
            }
            lastTap = now;
        }
    };

    bodyEl.addEventListener('touchstart', onTouchStart, { passive: true });
    bodyEl.addEventListener('touchmove', onTouchMove, { passive: true });
    bodyEl.addEventListener('touchend', onTouchEnd);

    return {
        state: pz,
        // Re-applies the current state.{tx,ty,scale} to containerEl's transform.
        // Exposed (beyond the internal pinch/pan/reset paths that already call
        // it) so a caller can drive the transform programmatically -- e.g.
        // Documents' page-jump, which sets state.ty directly then calls this
        // instead of relying on a touch gesture.
        apply,
        reset() {
            pz.scale = 1; pz.tx = 0; pz.ty = 0;
            containerEl.style.transform = '';
        },
        destroy() {
            bodyEl.removeEventListener('touchstart', onTouchStart);
            bodyEl.removeEventListener('touchmove', onTouchMove);
            bodyEl.removeEventListener('touchend', onTouchEnd);
        },
    };
}
