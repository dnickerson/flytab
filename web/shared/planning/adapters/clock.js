// @ts-check
'use strict';

/** @interface Clock */
export class Clock {
    /** @returns {number} ms since epoch */
    now() { throw new Error('not implemented'); }
}
