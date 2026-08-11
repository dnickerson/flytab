/**
 * Shared staleness-watchdog degrade logic for GPS position sources.
 * gps-source.js (internal/device GPS) and engine-gps-bridge.js (engine-GPS
 * fallback) both dim the ownship marker the same way when their respective
 * position feed goes stale — this is the one place that shape is defined
 * (issue #129; previously two independently hand-copied implementations).
 */

const GPS_STALE_TIMEOUT_MS = 15000;

/**
 * Degrade stratuxTarget.situation to zero fix quality and dispatch
 * 'stratux:situation' with it. No-op if there's no prior situation to degrade.
 */
function degradeGpsSituation(stratuxTarget) {
    const lastSit = stratuxTarget.situation;
    if (!lastSit) return;
    const staleSit = { ...lastSit, gps_fix_quality: 0 };
    stratuxTarget.situation = staleSit;
    stratuxTarget.dispatchEvent(new CustomEvent('stratux:situation', { detail: staleSit }));
}
