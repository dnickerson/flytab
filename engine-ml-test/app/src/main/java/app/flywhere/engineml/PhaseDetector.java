package app.flywhere.engineml;

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

    // Ground speed (set externally, 0 if unavailable)
    private float groundSpeed = 0f;

    /**
     * Detect the current flight phase.
     *
     * @param rpm       Engine RPM (feature index 0)
     * @param altFt     Altitude in feet (feature index 12)
     * @param speedKts  Ground speed in knots (from GPS or CSV)
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

        // Engine off
        if (rpm < 100) {
            return WARMUP; // treat as warmup for display purposes
        }

        // Startup: first 60s after engine start, low RPM
        if (engineStartDetected && samplesSinceStart <= 60 && rpm < 1400) {
            return STARTUP;
        }

        // Run-up: RPM 1700-1950, nearly stationary
        if (rpm >= 1700 && rpm <= 1950 && speedKts < 10) {
            return RUNUP;
        }

        // Warmup/taxi: low RPM, slow
        if (rpm < 1300 && speedKts < 30) {
            return WARMUP;
        }

        // Takeoff: high power AND either climbing (altRate > 300 fpm) OR rolling (speedKts > 20).
        // 20 kts catches the ground roll from throttle advance; 50 kts was too late.
        if (rpm > 2400 && (altRate > 300 || speedKts > 20)) {
            return TAKEOFF;
        }

        // Climb: moderate-high RPM, positive altitude rate
        if (rpm > 2100 && altRate > 200) {
            return CLIMB;
        }

        // Cruise: moderate RPM, level flight
        if (rpm >= 2100 && rpm <= 2500 && Math.abs(altRate) <= 200) {
            return CRUISE;
        }

        // Descent: negative altitude rate
        if (altRate < -200) {
            return DESCENT;
        }

        // Landing: low altitude, slow, moderate power
        if (rpm < 2200 && altFt < 1500 && (altRate < -100 || speedKts < 80)) {
            return LANDING;
        }

        // Default
        if (rpm >= 2100) return CRUISE;
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
        groundSpeed = 0f;
    }
}
