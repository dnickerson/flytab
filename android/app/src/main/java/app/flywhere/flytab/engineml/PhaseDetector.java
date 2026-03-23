package app.flywhere.flytab.engineml;

/**
 * Detects current flight phase from engine and GPS data.
 * Uses a rolling altitude buffer to compute altitude rate.
 */
public class PhaseDetector {

    public static final String STARTUP = "startup";
    public static final String WARMUP = "warmup";
    public static final String RUNUP = "runup";
    public static final String TAKEOFF = "takeoff";
    public static final String CLIMB = "climb";
    public static final String CRUISE = "cruise";
    public static final String DESCENT = "descent";
    public static final String LANDING = "landing";

    // Altitude rate buffer (10 samples for ±5 sample window)
    private final float[] altBuffer = new float[10];
    private int altIdx = 0;
    private int altCount = 0;

    // Startup tracking
    private boolean engineStartDetected = false;
    private int samplesSinceStart = 0;
    private float lastRpm = 0f;

    // Departure altitude — set from ground samples (speed < 5 kts, rpm < 1500).
    // Used to compute AGL-relative threshold for landing detection.
    private float departureAltFt = Float.NaN;

    // Ground speed (set externally, 0 if unavailable)
    private float groundSpeed = 0f;

    /**
     * Detect the current flight phase.
     *
     * @param rpm       Engine RPM
     * @param altFt     GPS altitude in feet (ellipsoidal, not MSL)
     * @param speedKts  Ground speed in knots
     * @return Phase name string
     */
    public String detect(float rpm, float altFt, float speedKts) {
        this.groundSpeed = speedKts;

        // Update altitude rate buffer
        altBuffer[altIdx % 10] = altFt;
        altIdx++;
        altCount = Math.min(altCount + 1, 10);

        float altRate = computeAltRate(); // fpm

        // Track engine start
        if (!engineStartDetected && rpm > 300 && lastRpm < 100) {
            engineStartDetected = true;
            samplesSinceStart = 0;
        }
        if (engineStartDetected) {
            samplesSinceStart++;
        }
        lastRpm = rpm;

        // Track departure altitude from ground samples (on the ground = slow + low RPM)
        if (speedKts < 5 && rpm < 1500 && rpm > 100) {
            departureAltFt = altFt;
        }

        // Engine off / shutdown
        if (rpm < 100) {
            return STARTUP;
        }

        // Startup: first 60s after engine start, low RPM
        if (engineStartDetected && samplesSinceStart <= 60 && rpm < 1400) {
            return STARTUP;
        }

        // Run-up: RPM 1700–1950, nearly stationary
        if (rpm >= 1700 && rpm <= 1950 && speedKts < 10) {
            return RUNUP;
        }

        // Warmup/taxi: low RPM, slow
        if (rpm < 1300 && speedKts < 30) {
            return WARMUP;
        }

        // Takeoff: full power AND climbing fast (ground roll → initial climb).
        // No altitude cap — altRate > 300 is the reliable signal; cruise altRate ≈ 0.
        if (rpm > 2400 && altRate > 300) {
            return TAKEOFF;
        }

        // Climb: moderate-high RPM, positive altitude rate
        if (rpm > 2100 && altRate > 200) {
            return CLIMB;
        }

        // Cruise: moderate-high RPM, level flight.
        // Upper bound is redline (2700) — O-320 can cruise above 2500 RPM.
        if (rpm >= 2100 && rpm <= 2700 && Math.abs(altRate) <= 200) {
            return CRUISE;
        }

        // Descent: negative altitude rate (any power setting)
        if (altRate < -200) {
            return DESCENT;
        }

        // Landing/pattern: reduced power, within 1500 ft of departure altitude.
        // Uses departure altitude (GPS-relative) so the threshold works at any airport elevation.
        float agl = Float.isNaN(departureAltFt) ? altFt : (altFt - departureAltFt);
        if (rpm < 2200 && agl < 1500 && (altRate < -100 || speedKts < 80)) {
            return LANDING;
        }

        // Default — distinguish in-flight from ground ops.
        // WARMUP is only valid on the ground (low speed). If the aircraft is moving at
        // approach/pattern speed but no other phase matched (e.g. gentle -150 fpm descent
        // at 1800 RPM), LANDING is far more accurate than WARMUP.
        if (rpm >= 2100) return CRUISE;
        if (speedKts > 30) return LANDING;
        return WARMUP;
    }

    /**
     * Simplified detect for CSV data without ground speed.
     */
    public String detect(float rpm, float altFt) {
        return detect(rpm, altFt, groundSpeed);
    }

    private float computeAltRate() {
        if (altCount < 10) return 0f;
        // Rate = (newest - oldest) / 10 seconds * 60 = fpm
        int newest = (altIdx - 1) % 10;
        int oldest = altIdx % 10;
        return (altBuffer[newest] - altBuffer[oldest]) / 10f * 60f;
    }

    public void setGroundSpeed(float speedKts) {
        this.groundSpeed = speedKts;
    }

    public void reset() {
        altIdx = 0;
        altCount = 0;
        engineStartDetected = false;
        samplesSinceStart = 0;
        lastRpm = 0f;
        departureAltFt = Float.NaN;
        groundSpeed = 0f;
    }
}
