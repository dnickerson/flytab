package app.flywhere.flytab.engineml;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Adapts anomaly thresholds per flight phase based on observed scores.
 *
 * Keeps the trained model weights frozen but adjusts thresholds to track
 * the engine's current baseline. Uses a rolling exponential moving average
 * of score mean and variance per phase.
 *
 * Safety constraints:
 * - Adapted threshold can tighten (decrease) without limit — catches degradation earlier
 * - Adapted threshold can loosen (increase) at most 50% above the trained threshold
 * - Requires MIN_SAMPLES before adapting (avoids adapting to startup transients)
 * - Anomalous scores are excluded from the running stats (don't learn to ignore faults)
 */
public class ThresholdAdapter {
    private static final String TAG = "ThresholdAdapter";
    private static final String PREFS_NAME = "threshold_adapter";

    // Minimum normal samples per phase before adapting
    private static final int MIN_SAMPLES = 300;

    // Exponential moving average decay (α). Lower = more smoothing.
    // 0.005 → effective window of ~200 samples
    private static final float EMA_ALPHA = 0.005f;

    // Multiplier on std dev for threshold (mean + N*σ)
    private static final float SIGMA_MULTIPLIER = 3.0f;

    // Maximum loosening factor above trained threshold
    private static final float MAX_LOOSEN_FACTOR = 1.5f;

    // Per-phase stats
    private final Map<String, PhaseStats> phaseStats = new HashMap<>();
    private final Map<String, Float> trainedThresholds;
    private final SharedPreferences prefs;

    private static class PhaseStats {
        float emaMean;      // exponential moving average of score
        float emaVariance;  // exponential moving average of (score - mean)²
        int sampleCount;
        boolean adapted;    // true once we have enough samples

        PhaseStats(float initialMean) {
            this.emaMean = initialMean;
            this.emaVariance = 0;
            this.sampleCount = 0;
            this.adapted = false;
        }
    }

    public ThresholdAdapter(Context context, Map<String, Float> trainedThresholds) {
        this.trainedThresholds = trainedThresholds;
        this.prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        loadState();
    }

    /**
     * Record a normal (non-anomalous) score for a phase.
     * Only call this when the score is below the current threshold.
     */
    public void recordNormalScore(String phase, float score) {
        PhaseStats stats = phaseStats.get(phase);
        if (stats == null) {
            stats = new PhaseStats(score);
            phaseStats.put(phase, stats);
        }

        stats.sampleCount++;

        // Update EMA of mean and variance
        float diff = score - stats.emaMean;
        stats.emaMean += EMA_ALPHA * diff;
        stats.emaVariance = (1 - EMA_ALPHA) * stats.emaVariance + EMA_ALPHA * diff * diff;

        // Mark as adapted once we have enough samples
        if (!stats.adapted && stats.sampleCount >= MIN_SAMPLES) {
            stats.adapted = true;
            float adaptedThreshold = getAdaptedThreshold(phase);
            Log.i(TAG, String.format(Locale.US,
                    "Phase '%s' now adapting: mean=%.4f, σ=%.4f, threshold=%.4f (trained=%.4f)",
                    phase, stats.emaMean, Math.sqrt(stats.emaVariance),
                    adaptedThreshold, getTrainedThreshold(phase)));
        }

        // Persist periodically (every 100 samples)
        if (stats.sampleCount % 100 == 0) {
            saveState();
        }
    }

    /**
     * Get the effective threshold for a phase.
     * Returns adapted threshold if enough data, otherwise trained threshold.
     */
    public float getThreshold(String phase) {
        PhaseStats stats = phaseStats.get(phase);
        if (stats == null || !stats.adapted) {
            return getTrainedThreshold(phase);
        }
        return getAdaptedThreshold(phase);
    }

    /**
     * Check if a phase is using adapted thresholds.
     */
    public boolean isAdapted(String phase) {
        PhaseStats stats = phaseStats.get(phase);
        return stats != null && stats.adapted;
    }

    /**
     * Get the number of normal samples recorded for a phase.
     */
    public int getSampleCount(String phase) {
        PhaseStats stats = phaseStats.get(phase);
        return stats != null ? stats.sampleCount : 0;
    }

    /**
     * Get a status summary for display.
     */
    public String getStatusForPhase(String phase) {
        PhaseStats stats = phaseStats.get(phase);
        if (stats == null) return "no data";
        if (!stats.adapted) {
            return String.format(Locale.US, "learning (%d/%d)", stats.sampleCount, MIN_SAMPLES);
        }
        float trained = getTrainedThreshold(phase);
        float adapted = getAdaptedThreshold(phase);
        float pctChange = ((adapted - trained) / trained) * 100;
        return String.format(Locale.US, "adapted %+.0f%% (%d samples)",
                pctChange, stats.sampleCount);
    }

    /**
     * Reset all adapted thresholds (e.g., after engine maintenance).
     */
    public void resetAll() {
        phaseStats.clear();
        prefs.edit().clear().apply();
        Log.i(TAG, "All adapted thresholds reset");
    }

    /**
     * Reset adapted threshold for a single phase.
     */
    public void resetPhase(String phase) {
        phaseStats.remove(phase);
        SharedPreferences.Editor editor = prefs.edit();
        editor.remove(phase + "_mean");
        editor.remove(phase + "_variance");
        editor.remove(phase + "_count");
        editor.apply();
        Log.i(TAG, "Adapted threshold reset for phase: " + phase);
    }

    // ── Internal ────────────────────────────────────────────

    private float getTrainedThreshold(String phase) {
        Float t = trainedThresholds.get(phase);
        return t != null ? t : 0.88f; // global fallback
    }

    private float getAdaptedThreshold(String phase) {
        PhaseStats stats = phaseStats.get(phase);
        if (stats == null) return getTrainedThreshold(phase);

        float stdDev = (float) Math.sqrt(stats.emaVariance);
        float adapted = stats.emaMean + SIGMA_MULTIPLIER * stdDev;

        // Safety clamp: don't loosen beyond MAX_LOOSEN_FACTOR × trained
        float trained = getTrainedThreshold(phase);
        float maxThreshold = trained * MAX_LOOSEN_FACTOR;
        adapted = Math.min(adapted, maxThreshold);

        // No floor — allow tightening without limit
        // (a consistently low-scoring engine should have a tight threshold)

        return adapted;
    }

    private void saveState() {
        SharedPreferences.Editor editor = prefs.edit();
        for (Map.Entry<String, PhaseStats> entry : phaseStats.entrySet()) {
            String phase = entry.getKey();
            PhaseStats stats = entry.getValue();
            editor.putFloat(phase + "_mean", stats.emaMean);
            editor.putFloat(phase + "_variance", stats.emaVariance);
            editor.putInt(phase + "_count", stats.sampleCount);
        }
        editor.apply();
    }

    private void loadState() {
        for (String phase : trainedThresholds.keySet()) {
            if (prefs.contains(phase + "_count")) {
                PhaseStats stats = new PhaseStats(0);
                stats.emaMean = prefs.getFloat(phase + "_mean", 0);
                stats.emaVariance = prefs.getFloat(phase + "_variance", 0);
                stats.sampleCount = prefs.getInt(phase + "_count", 0);
                stats.adapted = stats.sampleCount >= MIN_SAMPLES;
                phaseStats.put(phase, stats);

                if (stats.adapted) {
                    Log.i(TAG, String.format(Locale.US,
                            "Restored phase '%s': mean=%.4f, σ=%.4f, threshold=%.4f, %d samples",
                            phase, stats.emaMean, Math.sqrt(stats.emaVariance),
                            getAdaptedThreshold(phase), stats.sampleCount));
                }
            }
        }
    }
}
