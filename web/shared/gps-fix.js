/**
 * FlyTab — GpsFix: is this GPS situation a real 3D position solution?
 *
 * One rule for every display of own-ship position (map marker, radar page,
 * approach plates), so none of them ever draws a position that isn't a fix.
 *
 * gps_fix_quality is Stratux's GPSFixQuality (the NMEA GGA quality field).
 * The Stratux status page (192.168.10.1, "GPS solution") labels it, in
 * stratux main/gen_gdl90.go updateStatus():
 *   0 "No Fix" · 1 "3D GPS" · 2 "3D GPS + SBAS" · 6 "Dead Reckoning"
 * GGA also defines 3 PPS, 4 RTK, 5 float RTK (real fixes); 6 is an estimate,
 * 7 manual input, 8 simulator. Stratux keeps reporting the LAST lat/lon after
 * the fix is lost, so the position is only usable together with the quality.
 *
 * Producers may also set gps_3d: false when they know the solution isn't 3D
 * (device GPS without an altitude).
 */
const GpsFix = {
    /** True for fix-quality codes that are real GPS solutions (1-5). */
    isSolution(q) {
        return Number.isInteger(q) && q >= 1 && q <= 5;
    },

    /** Finite, in range, and not the 0,0 a receiver reports with no fix. */
    hasValidPosition(sit) {
        if (!sit) return false;
        const { lat, lon } = sit;
        if (typeof lat !== 'number' || typeof lon !== 'number') return false;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
        return !(lat === 0 && lon === 0);
    },

    /** At least a 3D GPS solution with a usable position. */
    has3DFix(sit) {
        return !!sit
            && GpsFix.isSolution(sit.gps_fix_quality)
            && sit.gps_3d !== false
            && GpsFix.hasValidPosition(sit);
    },
};
