package app.flywhere.flytab.engineml;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Engine advisor for Lycoming O-360-A (180 HP, carbureted, constant-speed prop).
 *
 * Provides:
 * - Trend tracking (rate of change per feature)
 * - Correlated multi-parameter alerts
 * - %power calculation from RPM + MP + altitude
 * - Mixture optimization (LOP target, lead fouling warnings)
 * - Route-aware fuel/time tradeoff recommendations
 */
public class EngineAdvisor {

    // ── Engine constants ──────────────────────────────────────
    private static final float RATED_HP = 180f;
    private static final float FUEL_WEIGHT_LB_PER_GAL = 6.0f;
    private static final float TANK_CAPACITY_GAL = 36f;
    private static final float RESERVE_HOURS = 1.0f;

    // BSFC values (lb/hp/hr) for mixture settings
    private static final float BSFC_ROP = 0.46f;
    private static final float BSFC_PEAK = 0.43f;
    private static final float BSFC_LOP = 0.40f;
    // Carbureted engines can't go as deep LOP as injected
    private static final float BSFC_CARB_BEST_ECONOMY = 0.42f;

    // Lead fouling EGT thresholds
    private static final float EGT_LEAD_FOULING_MIN = 1100f;
    private static final float EGT_CRUISE_MIN = 1150f;

    // CHT limits
    private static final float CHT_CAUTION = 400f;
    private static final float CHT_WARNING = 460f;

    // Sticky/stuck-valve check: a cylinder whose EGT hasn't risen with the
    // others during startup is the cold-cylinder signature (design spec
    // 2026-06-21-flight-phase-detection-redesign.md §8). THIS THRESHOLD IS
    // AN UNVALIDATED PLACEHOLDER — no real sticky-valve flight data has been
    // used to calibrate it. Do not treat an alert from this check as
    // confirmed until validated against a known-good vs known-sticky
    // comparison flight.
    private static final float STICKY_VALVE_LAG_THRESHOLD_F = 150f; // PLACEHOLDER — see comment above

    // Trend tracking
    private static final int HISTORY_SIZE = 120; // 2 minutes at 1Hz
    private static final int TREND_WINDOW = 60;  // 1 minute for rate calc

    // ── Feature indices (12-feature v2 model array) ──────────
    // 0:RPM, 1-4:EGT1-4, 5-8:CHT1-4, 9:OilTemp, 10:OilPress, 11:FuelFlow
    private static final int IDX_RPM = 0;
    private static final int IDX_EGT1 = 1;
    private static final int IDX_CHT1 = 5;
    private static final int IDX_OIL_TEMP = 9;
    private static final int IDX_OIL_PRESS = 10;
    private static final int IDX_FUEL_FLOW = 11;
    // Altitude is no longer a model feature — passed separately via addSample()

    // ── History buffers ──────────────────────────────────────
    private final float[][] history;  // [HISTORY_SIZE][13]
    private int historyCount = 0;
    private int historyHead = 0;     // circular buffer write position

    // Extra parameters not in the 13-feature model array
    private final float[] mpHistory;
    private final float[] carbTempHistory;

    // Current extra values
    private float currentMP = 0;
    private float currentCarbTemp = 0;
    private float currentFuelRemaining = 0;
    private float currentAltitude = 0;

    // Sticky-valve check state
    private float[] startupEntryEgt = null; // EGT1-4 at the moment phase first became "startup" this cycle
    private String lastPhase = null;

    // ── Message output ──────────────────────────────────────
    public static final int SEVERITY_INFO = 0;
    public static final int SEVERITY_CAUTION = 1;
    public static final int SEVERITY_WARNING = 2;

    public static class Advisory {
        public final String message;
        public final int severity;  // 0=info, 1=caution, 2=warning
        public final String category; // "trend", "optimization", "route", "engine"

        Advisory(String message, int severity, String category) {
            this.message = message;
            this.severity = severity;
            this.category = category;
        }
    }

    public EngineAdvisor() {
        history = new float[HISTORY_SIZE][12];
        mpHistory = new float[HISTORY_SIZE];
        carbTempHistory = new float[HISTORY_SIZE];
    }

    /**
     * Record a new sample. Call once per second.
     */
    public void addSample(float[] features, String phase, float mp, float carbTemp, float fuelRemaining, float altitude) {
        if ("shutdown".equals(lastPhase) && !"shutdown".equals(phase)) {
            reset();
        }
        System.arraycopy(features, 0, history[historyHead], 0, Math.min(features.length, 12));
        mpHistory[historyHead] = mp;
        carbTempHistory[historyHead] = carbTemp;
        historyHead = (historyHead + 1) % HISTORY_SIZE;
        if (historyCount < HISTORY_SIZE) historyCount++;

        currentMP = mp;
        currentCarbTemp = carbTemp;
        currentFuelRemaining = fuelRemaining;
        currentAltitude = altitude;

        // Latch per-cylinder EGT the moment the phase first becomes "startup"
        // so the sticky-valve check (below) has a baseline to compare rise against.
        if ("startup".equals(phase) && !"startup".equals(lastPhase)) {
            startupEntryEgt = new float[4];
            for (int i = 0; i < 4; i++) {
                startupEntryEgt[i] = features[IDX_EGT1 + i];
            }
        }
        lastPhase = phase;
    }

    /**
     * Generate advisories based on current engine state.
     *
     * Note: the sticky-valve check is NOT included here — it lives in
     * {@link #checkStickyValve(float[], String)} so callers can run it
     * without needing an ML score/anomaly result (see Task 16: this method
     * is only invoked once the ML-inference window is full, but the
     * sticky-valve check must run from the very first "startup" samples).
     *
     * @param features     Current 12-feature array (RPM, EGT1-4, CHT1-4, OilTemp, OilPress, FuelFlow)
     * @param phase        Current flight phase
     * @param anomalyScore ML anomaly score
     * @param isAnomaly    Whether ML flagged anomaly
     * @param distRemainingNm Distance to destination (0 if unknown)
     * @param groundSpeedKts Current ground speed
     * @param stickyValveAlreadyFired Whether {@link #checkStickyValve(float[], String)} already
     *                                produced a finding for this same sample. When true, the
     *                                generic "nothing else fired" fallback below is suppressed
     *                                so the specific sticky-valve caution isn't diluted by a
     *                                simultaneous generic "monitoring" info line.
     */
    public List<Advisory> advise(float[] features, String phase,
                                  float anomalyScore, boolean isAnomaly,
                                  float distRemainingNm, float groundSpeedKts,
                                  boolean stickyValveAlreadyFired) {
        List<Advisory> advisories = new ArrayList<>();

        float rpm = features[IDX_RPM];
        float fuelFlow = features[IDX_FUEL_FLOW];
        float alt = currentAltitude;

        // Only generate optimization advisories in cruise/climb/descent with engine running
        boolean engineRunning = rpm > 500;
        boolean inFlight = "cruise".equals(phase) || "climb".equals(phase) || "descent".equals(phase);

        // ── 1. Trend alerts (all phases when engine running) ──
        if (engineRunning && historyCount >= 30) {
            addTrendAlerts(features, phase, advisories);
        }

        // ── 2. Correlated alerts ──
        if (engineRunning) {
            addCorrelatedAlerts(features, phase, advisories);
        }

        // ── 3. Lead fouling check (cruise/climb) ──
        if (inFlight && engineRunning) {
            addLeadFoulingCheck(features, advisories);
        }

        // ── 4. Power & mixture optimization (cruise) ──
        if ("cruise".equals(phase) && engineRunning && currentMP > 0) {
            addMixtureAdvisory(features, advisories);
        }

        // ── 5. Route-aware fuel optimization (cruise with route data) ──
        if ("cruise".equals(phase) && distRemainingNm > 0 && groundSpeedKts > 30) {
            addRouteAdvisory(features, distRemainingNm, groundSpeedKts, advisories);
        }

        // ── 6. Carb ice warning ──
        if (engineRunning && currentCarbTemp > 0) {
            addCarbIceCheck(advisories);
        }

        // ── 7. Phase-specific normal message if nothing else ──
        // Skip when the standalone sticky-valve check already reported something
        // for this sample — otherwise the generic "monitoring" info line would
        // appear alongside (and dilute) the specific sticky-valve caution.
        if (advisories.isEmpty() && !stickyValveAlreadyFired) {
            if (isAnomaly) {
                advisories.add(new Advisory("Engine pattern unusual — monitor closely",
                        SEVERITY_CAUTION, "engine"));
            } else {
                advisories.add(new Advisory(getNormalMessage(phase), SEVERITY_INFO, "engine"));
            }
        }

        return advisories;
    }

    /**
     * Sticky-valve check, callable independently of {@link #advise}.
     *
     * This is a pure EGT-delta comparison against the baseline latched in
     * {@link #addSample} — it does not use ML score/anomaly, so it doesn't
     * need to wait for a full ML-inference window. Callers should invoke
     * this every sample (not just when the ML window is full) so it can
     * actually observe the "startup" phase, which normally ends well
     * before the window fills.
     *
     * @param features Current 12-feature array (RPM, EGT1-4, CHT1-4, OilTemp, OilPress, FuelFlow)
     * @param phase    Current flight phase
     */
    public List<Advisory> checkStickyValve(float[] features, String phase) {
        List<Advisory> out = new ArrayList<>();
        if ("startup".equals(phase) && startupEntryEgt != null) {
            addStickyValveCheck(features, out);
        }
        return out;
    }

    // ── % Power calculation ─────────────────────────────────

    /**
     * Compute approximate %power from RPM, MAP, and pressure altitude.
     * Uses simplified Lycoming O-360 performance data.
     * Sea-level rated: 180 HP @ 2700 RPM, 29.9" MAP.
     */
    public float computePercentPower(float rpm, float mp, float altFt) {
        // Altitude correction: standard MAP drops ~1" per 1000 ft
        // But we use actual MAP, so we correct for air density
        float densityRatio = (float) Math.pow(1.0 - (altFt / 145442.0), 4.255876);

        // Normalized RPM and MAP factors
        float rpmFactor = rpm / 2700f;
        float mapFactor = mp / 29.92f;

        // Power approximation (from Lycoming chart curve fit)
        // %power ≈ (MAP/29.92) × (RPM/2700) × density_correction × 100
        // With empirical correction for the nonlinear relationship
        float rawPct = mapFactor * rpmFactor * 100f;

        // Empirical correction: the relationship isn't perfectly linear
        // At lower RPM/MAP combos, actual power is slightly less than linear
        float correction = 1.0f + 0.15f * (rpmFactor - 0.85f);
        correction = Math.max(0.9f, Math.min(1.1f, correction));

        float pctPower = rawPct * correction;

        // Clamp
        return Math.max(0f, Math.min(100f, pctPower));
    }

    /**
     * Compute fuel flow for a given %power and mixture setting.
     */
    public float computeGPH(float pctPower, float bsfc) {
        float hp = RATED_HP * pctPower / 100f;
        return (hp * bsfc) / FUEL_WEIGHT_LB_PER_GAL;
    }

    /**
     * Determine current mixture mode from EGTs and fuel flow relative to power.
     * Returns "ROP", "PEAK", or "LOP".
     */
    public String detectMixtureMode(float[] features, float pctPower) {
        float actualGPH = features[IDX_FUEL_FLOW];
        float ropGPH = computeGPH(pctPower, BSFC_ROP);
        float peakGPH = computeGPH(pctPower, BSFC_PEAK);
        float lopGPH = computeGPH(pctPower, BSFC_LOP);

        // Determine mode by comparing actual fuel flow to expected
        float midRopPeak = (ropGPH + peakGPH) / 2f;
        float midPeakLop = (peakGPH + lopGPH) / 2f;

        if (actualGPH > midRopPeak) return "ROP";
        if (actualGPH < midPeakLop) return "LOP";
        return "PEAK";
    }

    // ── Trend detection ─────────────────────────────────────

    private void addTrendAlerts(float[] features, String phase, List<Advisory> out) {
        // Compute rate of change over the last minute
        int window = Math.min(TREND_WINDOW, historyCount);
        int oldIdx = ((historyHead - window) + HISTORY_SIZE) % HISTORY_SIZE;
        float[] old = history[oldIdx];
        float minutes = window / 60f;
        if (minutes < 0.25f) return; // need at least 15 seconds

        // CHT trends — rising CHTs are concerning
        for (int i = 0; i < 4; i++) {
            float chtRate = (features[IDX_CHT1 + i] - old[IDX_CHT1 + i]) / minutes;
            if (chtRate > 10f) { // > 10°F/min rise
                out.add(new Advisory(
                        String.format(Locale.US, "CHT %d rising %.0f\u00B0F/min (%.0f\u00B0F)",
                                i + 1, chtRate, features[IDX_CHT1 + i]),
                        features[IDX_CHT1 + i] > CHT_CAUTION ? SEVERITY_WARNING : SEVERITY_CAUTION,
                        "trend"));
            }
        }

        // Oil pressure dropping
        float oilPressRate = (features[IDX_OIL_PRESS] - old[IDX_OIL_PRESS]) / minutes;
        if (oilPressRate < -3f) { // dropping > 3 psi/min
            out.add(new Advisory(
                    String.format(Locale.US, "Oil pressure dropping %.0f psi/min (%.0f psi)",
                            Math.abs(oilPressRate), features[IDX_OIL_PRESS]),
                    SEVERITY_WARNING, "trend"));
        }

        // Oil temp rising fast
        float oilTempRate = (features[IDX_OIL_TEMP] - old[IDX_OIL_TEMP]) / minutes;
        if (oilTempRate > 5f) {
            out.add(new Advisory(
                    String.format(Locale.US, "Oil temp rising %.0f\u00B0F/min (%.0f\u00B0F)",
                            oilTempRate, features[IDX_OIL_TEMP]),
                    SEVERITY_CAUTION, "trend"));
        }

        // EGT spread widening
        float currentSpread = egtSpread(features);
        float oldSpread = egtSpread(old);
        float spreadRate = (currentSpread - oldSpread) / minutes;
        if (spreadRate > 20f && currentSpread > 80f) {
            out.add(new Advisory(
                    String.format(Locale.US, "EGT spread widening (%.0f\u00B0F, +%.0f/min)",
                            currentSpread, spreadRate),
                    SEVERITY_CAUTION, "trend"));
        }

        // Fuel flow sudden change (not during phase transition)
        if ("cruise".equals(phase)) {
            float ffRate = (features[IDX_FUEL_FLOW] - old[IDX_FUEL_FLOW]) / minutes;
            if (Math.abs(ffRate) > 2f) {
                out.add(new Advisory(
                        String.format(Locale.US, "Fuel flow %s %.1f GPH/min (%.1f GPH)",
                                ffRate > 0 ? "increasing" : "decreasing",
                                Math.abs(ffRate), features[IDX_FUEL_FLOW]),
                        SEVERITY_INFO, "trend"));
            }
        }

        // MP drop in cruise (engine issue, not pilot throttle change)
        if ("cruise".equals(phase) && currentMP > 0) {
            float oldMP = mpHistory[oldIdx];
            float mpRate = (currentMP - oldMP) / minutes;
            if (mpRate < -1f && oldMP > 0) {
                out.add(new Advisory(
                        String.format(Locale.US, "MP dropping %.1f\"/min (%.1f\")",
                                Math.abs(mpRate), currentMP),
                        SEVERITY_CAUTION, "trend"));
            }
        }
    }

    // ── Correlated alerts ───────────────────────────────────

    private void addCorrelatedAlerts(float[] features, String phase, List<Advisory> out) {
        float oilTemp = features[IDX_OIL_TEMP];
        float oilPress = features[IDX_OIL_PRESS];

        // Oil pressure low + oil temp high = serious
        if (oilPress < 25 && oilTemp > 220) {
            out.add(new Advisory(
                    String.format(Locale.US, "Low oil press (%.0f psi) + high oil temp (%.0f\u00B0F) — consider landing",
                            oilPress, oilTemp),
                    SEVERITY_WARNING, "engine"));
        } else if (oilPress < 40 && oilTemp > 200) {
            // Marginal combination
            int window = Math.min(TREND_WINDOW, historyCount);
            if (window > 15) {
                int oldIdx = ((historyHead - window) + HISTORY_SIZE) % HISTORY_SIZE;
                float oilPressRate = (oilPress - history[oldIdx][IDX_OIL_PRESS]) / (window / 60f);
                float oilTempRate = (oilTemp - history[oldIdx][IDX_OIL_TEMP]) / (window / 60f);
                if (oilPressRate < 0 && oilTempRate > 0) {
                    out.add(new Advisory(
                            String.format(Locale.US, "Oil press dropping + oil temp rising — monitor closely"),
                            SEVERITY_CAUTION, "engine"));
                }
            }
        }

        // High CHT + high EGT on same cylinder
        for (int i = 0; i < 4; i++) {
            float cht = features[IDX_CHT1 + i];
            float egt = features[IDX_EGT1 + i];
            if (cht > CHT_WARNING) {
                out.add(new Advisory(
                        String.format(Locale.US, "CHT %d high (%.0f\u00B0F) — enrich mixture or reduce power",
                                i + 1, cht),
                        SEVERITY_WARNING, "engine"));
            } else if (cht > CHT_CAUTION && egt > 1400) {
                out.add(new Advisory(
                        String.format(Locale.US, "Cyl %d running hot — CHT %.0f\u00B0F, EGT %.0f\u00B0F",
                                i + 1, cht, egt),
                        SEVERITY_CAUTION, "engine"));
            }
        }

        // EGT spread check
        float spread = egtSpread(features);
        if (spread > 150) {
            out.add(new Advisory(
                    String.format(Locale.US, "EGT spread %.0f\u00B0F — check mixture distribution", spread),
                    SEVERITY_CAUTION, "engine"));
        }
    }

    // ── Lead fouling check ──────────────────────────────────

    private void addLeadFoulingCheck(float[] features, List<Advisory> out) {
        int lowCount = 0;
        float lowestEGT = Float.MAX_VALUE;
        for (int i = 0; i < 4; i++) {
            float egt = features[IDX_EGT1 + i];
            if (egt > 0 && egt < EGT_LEAD_FOULING_MIN) lowCount++;
            if (egt > 0 && egt < lowestEGT) lowestEGT = egt;
        }

        if (lowCount > 0 && lowestEGT < EGT_CRUISE_MIN) {
            out.add(new Advisory(
                    String.format(Locale.US, "EGT %.0f\u00B0F — lean mixture to avoid lead fouling (target >%.0f\u00B0F)",
                            lowestEGT, EGT_LEAD_FOULING_MIN),
                    SEVERITY_CAUTION, "optimization"));
        }
    }

    // ── Mixture optimization ────────────────────────────────

    private void addMixtureAdvisory(float[] features, List<Advisory> out) {
        float rpm = features[IDX_RPM];
        float fuelFlow = features[IDX_FUEL_FLOW];
        float alt = currentAltitude;
        float pctPower = computePercentPower(rpm, currentMP, alt);

        String mode = detectMixtureMode(features, pctPower);
        float bestEconGPH = computeGPH(pctPower, BSFC_CARB_BEST_ECONOMY);
        float saving = fuelFlow - bestEconGPH;

        if ("ROP".equals(mode) && saving > 0.5f) {
            out.add(new Advisory(
                    String.format(Locale.US, "%.0f%% power at %.1f GPH (ROP) — lean to %.1f GPH saves %.1f GPH",
                            pctPower, fuelFlow, bestEconGPH, saving),
                    SEVERITY_INFO, "optimization"));
        } else if ("LOP".equals(mode)) {
            out.add(new Advisory(
                    String.format(Locale.US, "%.0f%% power, %.1f GPH — LOP, good economy",
                            pctPower, fuelFlow),
                    SEVERITY_INFO, "optimization"));
        } else {
            out.add(new Advisory(
                    String.format(Locale.US, "%.0f%% power, %.1f GPH — near peak EGT",
                            pctPower, fuelFlow),
                    SEVERITY_INFO, "optimization"));
        }
    }

    // ── Route-aware fuel/time tradeoffs ─────────────────────

    private void addRouteAdvisory(float[] features, float distNm, float gsKts,
                                   List<Advisory> out) {
        float rpm = features[IDX_RPM];
        float alt = currentAltitude;
        float currentGPH = features[IDX_FUEL_FLOW];
        float fuelRemaining = currentFuelRemaining > 0 ? currentFuelRemaining : TANK_CAPACITY_GAL;
        float pctPower = currentMP > 0 ? computePercentPower(rpm, currentMP, alt) : 65f;

        // Time and fuel to destination at current settings
        float timeHrs = distNm / gsKts;
        float fuelNeeded = timeHrs * currentGPH;
        float reserveGal = fuelRemaining - fuelNeeded;
        float reserveHrs = currentGPH > 0 ? reserveGal / currentGPH : 0;

        // Fuel warning
        if (reserveHrs < RESERVE_HOURS && reserveGal > 0) {
            out.add(new Advisory(
                    String.format(Locale.US, "%.1f gal reserve at dest (%.0f min) — below 1 hr minimum",
                            reserveGal, reserveHrs * 60),
                    SEVERITY_WARNING, "route"));
        } else if (reserveGal <= 0) {
            out.add(new Advisory(
                    String.format(Locale.US, "Insufficient fuel — need %.1f gal, have %.1f gal",
                            fuelNeeded, fuelRemaining),
                    SEVERITY_WARNING, "route"));
        }

        // Compare current settings vs economy option
        // Economy: lean to best economy fuel flow for current power
        float econGPH = computeGPH(pctPower, BSFC_CARB_BEST_ECONOMY);
        if (currentGPH - econGPH > 0.5f) {
            float econFuelNeeded = timeHrs * econGPH;
            float econSaving = fuelNeeded - econFuelNeeded;
            out.add(new Advisory(
                    String.format(Locale.US, "Lean to %.1f GPH: saves %.1f gal over %.0f NM",
                            econGPH, econSaving, distNm),
                    SEVERITY_INFO, "route"));
        }

        // Compare current power vs reduced power option
        if (pctPower > 55) {
            // What if we flew at 55% power instead?
            float reducedGPH = computeGPH(55f, BSFC_CARB_BEST_ECONOMY);
            // TAS roughly proportional to cube root of power ratio
            float tasRatio = (float) Math.pow(55f / pctPower, 1.0 / 3.0);
            float reducedGS = gsKts * tasRatio;
            float reducedTimeHrs = distNm / reducedGS;
            float reducedFuel = reducedTimeHrs * reducedGPH;
            float timeDiffMin = (reducedTimeHrs - timeHrs) * 60f;
            float fuelDiffGal = fuelNeeded - reducedFuel;

            if (fuelDiffGal > 1.0f && timeDiffMin < 30f) {
                float reducedReserve = fuelRemaining - reducedFuel;
                float reducedReserveHrs = reducedGPH > 0 ? reducedReserve / reducedGPH : 0;
                out.add(new Advisory(
                        String.format(Locale.US, "55%% power: +%.0f min, saves %.1f gal (%.0f min reserve)",
                                timeDiffMin, fuelDiffGal, reducedReserveHrs * 60),
                        SEVERITY_INFO, "route"));
            }
        }
    }

    // ── Carb ice check ──────────────────────────────────────

    private void addCarbIceCheck(List<Advisory> out) {
        // High probability carb ice zone: carb temp 40-60°F with visible moisture
        if (currentCarbTemp >= 30 && currentCarbTemp <= 70) {
            int severity = (currentCarbTemp >= 40 && currentCarbTemp <= 60)
                    ? SEVERITY_CAUTION : SEVERITY_INFO;
            out.add(new Advisory(
                    String.format(Locale.US, "Carb temp %.0f\u00B0F — carb ice conditions, apply carb heat",
                            currentCarbTemp),
                    severity, "engine"));
        }
    }

    // ── Sticky-valve check ──────────────────────────────────

    private void addStickyValveCheck(float[] features, List<Advisory> out) {
        // See STICKY_VALVE_LAG_THRESHOLD_F declaration above for the
        // unvalidated-placeholder caveat — do not tighten or "fix" this
        // threshold without real sticky-valve flight data to calibrate against.
        float[] currentEgt = new float[4];
        for (int i = 0; i < 4; i++) {
            currentEgt[i] = features[IDX_EGT1 + i];
        }

        float maxRise = 0f;
        for (int i = 0; i < 4; i++) {
            maxRise = Math.max(maxRise, currentEgt[i] - startupEntryEgt[i]);
        }

        for (int i = 0; i < 4; i++) {
            float rise = currentEgt[i] - startupEntryEgt[i];
            if (maxRise > 100f && (maxRise - rise) > STICKY_VALVE_LAG_THRESHOLD_F) {
                out.add(new Advisory(
                        String.format(Locale.US,
                                "Cylinder %d EGT rise lagging others during startup (possible sticky valve) — UNVALIDATED CHECK, confirm on ground",
                                i + 1),
                        SEVERITY_CAUTION, "engine"));
            }
        }
    }

    // ── Helpers ─────────────────────────────────────────────

    private float egtSpread(float[] features) {
        float min = Float.MAX_VALUE, max = Float.MIN_VALUE;
        for (int i = 0; i < 4; i++) {
            float v = features[IDX_EGT1 + i];
            if (v > 0) {
                min = Math.min(min, v);
                max = Math.max(max, v);
            }
        }
        return max > min ? max - min : 0;
    }

    private String getNormalMessage(String phase) {
        switch (phase) {
            case "startup": return "Engine starting — monitoring";
            case "warmup":  return "Warming up — parameters normal";
            case "runup":   return "Run-up checks — in range";
            case "takeoff": return "Takeoff power — engine normal";
            case "climb":   return "Climb — engine normal";
            case "cruise":  return "Cruise — engine normal";
            case "descent": return "Descent — engine normal";
            case "landing": return "Approach — engine normal";
            default:        return "Engine normal";
        }
    }

    public void reset() {
        historyCount = 0;
        historyHead = 0;
        currentMP = 0;
        currentCarbTemp = 0;
        currentFuelRemaining = 0;
        startupEntryEgt = null;
        lastPhase = null;
    }
}
