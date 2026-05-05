// @ts-check
'use strict';

/**
 * flywhere-planning — flight planning library.
 *
 * In flytab (Capacitor / browser): loaded once via <script type="module"
 * src="shared/planning/index.js">. This file attaches the public API to
 * `window.FlyTabPlanning` so plain-<script> consumers can use it.
 *
 * In flywhere (Next.js): consumed via `import { RoutePlanner } from
 * 'flywhere-planning'` after the file: dependency resolves.
 */

// Public exports — populated by Tasks 5-13.
export const VERSION = '0.1.0';

// Browser global for non-module consumers (flytab pattern).
if (typeof window !== 'undefined') {
    window.FlyTabPlanning = Object.assign(window.FlyTabPlanning || {}, { VERSION });
}
