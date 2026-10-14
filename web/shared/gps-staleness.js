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
 * _stale marks it as "the feed stopped", not "the GPS reported no fix", so the
 * map holds own-ship (GpsFix.HOLD_MS) instead of hiding it at once.
 */
function degradeGpsSituation(stratuxTarget) {
    const lastSit = stratuxTarget.situation;
    if (!lastSit) return;
    const staleSit = { ...lastSit, gps_fix_quality: 0, _stale: true };
    stratuxTarget.situation = staleSit;
    stratuxTarget.dispatchEvent(new CustomEvent('stratux:situation', { detail: staleSit }));
}
