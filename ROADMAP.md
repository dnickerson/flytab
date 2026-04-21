# FlyTab UI Roadmap

## What Was Attempted: M1 UI Foundation (FAILED)

### Goal
Single-pass refactor across 40+ files:
- Light cockpit theme (CSS variables)
- Centralized touch handlers (`CockpitUtils`)
- Standardized panel show/hide (`.visible` class toggle)
- Consistent close buttons (`.btn-close` class)

### Why It Failed

**1. CSS cascade with embedded `<style>` tags**
Several panels (`engine-page.js`, `preflight-brief.js`) inject a `<style>` tag into `document.body` via `_css()` / `_injectStyles()`. These tags appear *after* the external `style.css` in document order. When M1 removed the inline `style.display = 'none'` guards (to standardize on `.visible`), the embedded CSS `display: flex` rules won the cascade and kept those full-screen panels permanently visible at z-index 9000. The app was unusable on first launch.

**2. `btn-close` class causes full-width stretch in flex-column parents**
`.btn-close` uses `display: inline-flex` with `min-height: 80px` (cockpit). In panels whose root container is `flex-direction: column`, adding `btn-close` to a button makes it stretch to 100% width (default `align-self: stretch` in flex). The thermal status close button became a full-width red bar.

**3. Canvas CSS changes broke chart rendering**
Changing `max-height: 200px` to `height: 200px` + `flex-shrink: 0` on the thermal history canvas caused the chart to stop displaying. The original CSS was exactly calibrated for the WebView's canvas rendering behavior.

**4. Too many files changed at once, no incremental testing**
40+ JS files and `style.css` were all changed in a single commit. There is no way to verify correctness by reading code alone — many bugs only surface on the device. Each cascading fix introduced new regressions.

### What Was Salvaged
- ✅ **Light cockpit theme** — CSS variables only in `style.css`. No JS touched. Works correctly.
- ✅ **Thermal status close button layout** — `headerRow` wrapper puts title and button side by side. Canvas CSS untouched.

---

## New Approach: One Change, One Build, One Test

### Rules (non-negotiable)
1. **One file per build.** Never batch changes across multiple files before testing.
2. **CSS-only changes preferred.** A CSS rule change cannot break JS logic.
3. **Never touch show/hide mechanisms.** Every panel's show/hide works. Leave it.
4. **Never add `btn-close` to a button without first confirming its parent is flex-row.** If the parent is flex-column, the button will stretch full-width.
5. **Before changing any existing CSS on a canvas or chart element, verify the effect.** Canvas pixel coordinates, CSS dimensions, and flex layout interact in non-obvious ways in Android WebView.
6. **Read the embedded CSS** (`_css()`, `_injectStyles()`) before touching any panel. Embedded CSS loads after `style.css` and wins ties in the cascade.

### Remaining Work (user-visible improvements only)

#### Close button touch targets
The `.ep-close` class (used by engine-page, fuel overlay, IFR clearance, thermal status) has `height: 36px` — below the 56px minimum. The right fix is a **CSS-only override in `style.css`**:

```css
/* Cockpit mode: increase ep-close touch target without changing layout */
[data-mode="cockpit"] .ep-close {
    min-height: 56px;
    min-width: 56px;
}
```

`min-height` wins over `height` regardless of cascade order, so this beats the `height: 36px` in the embedded CSS. No JS changes. No flex-stretch risk (`.ep-close` already has `display: flex; align-items: center; justify-content: center`).

**Risk: Low.** CSS-only. Additive. Does not change any layout or visibility logic.

#### Hardcoded dark colors visible in light theme
Some panels have hardcoded hex colors (e.g. `#0a1628`, `#0f1f3a`) that were calibrated for the dark theme and are now wrong on the light background. These are **cosmetic only** — they do not break functionality. Address per-panel as reported.

#### Touch handler unification (`CockpitUtils`)
**Deferred indefinitely.** This is code quality only — zero user-visible benefit. The risk of breaking 13 panels outweighs the benefit.

#### Show/hide standardization
**Abandoned.** Every panel's existing show/hide mechanism works correctly. There is no user-visible benefit to standardizing them.

---

## Issue Log

| # | Description | Status | Notes |
|---|-------------|--------|-------|
| 1 | Cockpit theme too dark for direct sunlight | ✅ Fixed v5.11 | CSS variables only |
| 2 | Thermal status close button full-width | ✅ Fixed v5.11 | headerRow layout |
| 3 | ep-close touch target too small (36px) | Open | CSS fix proposed above |
| 4 | Help overlay hardcoded dark colors (#0a1628) | Open | Cosmetic only |
| 5 | M1: engine-page permanently visible | Resolved by revert | Embedded CSS cascade bug |
| 6 | M1: preflight-brief permanently visible | Resolved by revert | Embedded CSS cascade bug |
| 7 | M1: thermal status shows instead of map | Resolved by revert | Touch handler side-effect |
