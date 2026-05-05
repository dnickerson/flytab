// @ts-check
'use strict';

/**
 * @interface NetworkStatus
 * Reports the current connectivity tier. Emits 'mode:changed' events with
 * detail: { mode, previous }.
 *
 * IMPORTANT: this interface matches the EXISTING NetworkMode class at
 * web/shared/network-mode.js. flytab passes app.networkMode as-is; do NOT
 * wrap it.
 */
export class NetworkStatus extends EventTarget {
    /** @returns {'flight'|'home'|'internet'|'offline'} */
    get mode() { throw new Error('not implemented'); }
}
