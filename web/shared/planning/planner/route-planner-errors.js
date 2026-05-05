// @ts-check
'use strict';

/**
 * Base error class for route planning failures.
 */
export class PlanError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PlanError';
    }
}

/**
 * Thrown when no valid route exists between departure and destination.
 */
export class NoRouteFoundError extends PlanError {
    constructor(message) {
        super(message);
        this.name = 'NoRouteFoundError';
    }
}

/**
 * Thrown when the destination is unreachable even with obstacle avoidance relaxed.
 */
export class DestinationUnreachableError extends PlanError {
    constructor(message) {
        super(message);
        this.name = 'DestinationUnreachableError';
    }
}

/**
 * Thrown when route planning exceeds time limit.
 */
export class TimeoutError extends PlanError {
    constructor(message) {
        super(message);
        this.name = 'TimeoutError';
    }
}
