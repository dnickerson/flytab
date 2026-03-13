package app.flywhere.engineml;

import android.content.Context;
import android.util.Log;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Replays flight CSV data at configurable speed for testing inference pipeline.
 */
public class CsvReplayService {
    private static final String TAG = "CsvReplayService";

    // Column names matching the model's expected features
    private static final String[] FEATURE_COLS = {
        "RPM", "EGT 1", "EGT 2", "EGT 3", "EGT 4",
        "CHT 1", "CHT 2", "CHT 3", "CHT 4",
        "Oil Temp", "Oil Pressure", "Fuel Flow", "altitude_ft"
    };

    // Extra columns beyond the 13 model features
    private static final String[] EXTRA_COLS = { "MP", "Carb Temp", "Gallons Remaining" };

    public interface SampleCallback {
        void onSample(float[] features, float speedKts, float[] extras, int sampleIndex, int totalSamples);
        void onReplayComplete();
        void onError(String message);
    }

    private final List<float[]> samples = new ArrayList<>();
    private final List<Float> speeds = new ArrayList<>();
    private final List<float[]> extras = new ArrayList<>(); // [MP, CarbTemp, GalRemaining]
    private ScheduledExecutorService executor;
    private ScheduledFuture<?> replayTask;
    private int currentIndex = 0;
    private int speedMultiplier = 1;
    private SampleCallback callback;
    private boolean paused = false;

    /**
     * Load the bundled test flight CSV from assets.
     */
    public int loadFromAssets(Context context, String filename) {
        samples.clear();
        speeds.clear();
        extras.clear();
        currentIndex = 0;
        try (InputStream is = context.getAssets().open(filename);
             BufferedReader reader = new BufferedReader(new InputStreamReader(is))) {
            return parseCSV(reader);
        } catch (Exception e) {
            Log.e(TAG, "Failed to load CSV from assets: " + filename, e);
            return 0;
        }
    }

    /**
     * Load a CSV from an InputStream (for file picker results).
     */
    public int loadFromStream(InputStream inputStream) {
        samples.clear();
        speeds.clear();
        extras.clear();
        currentIndex = 0;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(inputStream))) {
            return parseCSV(reader);
        } catch (Exception e) {
            Log.e(TAG, "Failed to load CSV from stream", e);
            return 0;
        }
    }

    private int parseCSV(BufferedReader reader) throws Exception {
        String headerLine = reader.readLine();
        if (headerLine == null) return 0;

        String[] headers = headerLine.split(",");
        Map<String, Integer> colIndex = new HashMap<>();
        for (int i = 0; i < headers.length; i++) {
            colIndex.put(headers[i].trim(), i);
        }

        // Map feature columns to CSV column indices
        int[] featureIndices = new int[FEATURE_COLS.length];
        for (int i = 0; i < FEATURE_COLS.length; i++) {
            Integer idx = colIndex.get(FEATURE_COLS[i]);
            if (idx == null) {
                Log.w(TAG, "Missing column: " + FEATURE_COLS[i] + ", will use 0.0");
                featureIndices[i] = -1;
            } else {
                featureIndices[i] = idx;
            }
        }

        // Also look for speed_kts and extra columns
        Integer speedIdx = colIndex.get("speed_kts");
        int[] extraIndices = new int[EXTRA_COLS.length];
        for (int i = 0; i < EXTRA_COLS.length; i++) {
            Integer idx = colIndex.get(EXTRA_COLS[i]);
            extraIndices[i] = idx != null ? idx : -1;
        }

        String line;
        while ((line = reader.readLine()) != null) {
            String[] parts = line.split(",");
            float[] features = new float[FEATURE_COLS.length];

            for (int i = 0; i < FEATURE_COLS.length; i++) {
                if (featureIndices[i] < 0 || featureIndices[i] >= parts.length) {
                    features[i] = 0f;
                    continue;
                }
                try {
                    features[i] = Float.parseFloat(parts[featureIndices[i]].trim());
                } catch (NumberFormatException e) {
                    features[i] = 0f;
                }
            }

            // Extract ground speed
            float speed = 0f;
            if (speedIdx != null && speedIdx < parts.length) {
                try {
                    speed = Float.parseFloat(parts[speedIdx].trim());
                } catch (NumberFormatException e) {
                    speed = 0f;
                }
            }

            // Extract extra columns: MP, Carb Temp, Gallons Remaining
            float[] extra = new float[EXTRA_COLS.length];
            for (int i = 0; i < EXTRA_COLS.length; i++) {
                if (extraIndices[i] >= 0 && extraIndices[i] < parts.length) {
                    try {
                        extra[i] = Float.parseFloat(parts[extraIndices[i]].trim());
                    } catch (NumberFormatException e) {
                        extra[i] = 0f;
                    }
                }
            }

            samples.add(features);
            speeds.add(speed);
            extras.add(extra);
        }

        Log.i(TAG, "Loaded " + samples.size() + " samples from CSV");
        return samples.size();
    }

    public void setCallback(SampleCallback callback) {
        this.callback = callback;
    }

    public void setSpeedMultiplier(int multiplier) {
        this.speedMultiplier = Math.max(1, Math.min(10, multiplier));
        // Restart if running
        if (replayTask != null && !replayTask.isCancelled()) {
            stop();
            start();
        }
    }

    public int getSpeedMultiplier() {
        return speedMultiplier;
    }

    public void start() {
        if (samples.isEmpty()) {
            if (callback != null) callback.onError("No CSV data loaded");
            return;
        }

        paused = false;
        executor = Executors.newSingleThreadScheduledExecutor();
        long intervalMs = 1000 / speedMultiplier;

        replayTask = executor.scheduleAtFixedRate(() -> {
            if (paused) return;

            if (currentIndex >= samples.size()) {
                if (callback != null) callback.onReplayComplete();
                stop();
                return;
            }

            if (callback != null) {
                float spd = currentIndex < speeds.size() ? speeds.get(currentIndex) : 0f;
                float[] ext = currentIndex < extras.size() ? extras.get(currentIndex) : new float[3];
                callback.onSample(samples.get(currentIndex), spd, ext, currentIndex, samples.size());
            }
            currentIndex++;
        }, 0, intervalMs, TimeUnit.MILLISECONDS);
    }

    public void stop() {
        if (replayTask != null) {
            replayTask.cancel(false);
            replayTask = null;
        }
        if (executor != null) {
            executor.shutdown();
            executor = null;
        }
    }

    public void pause() {
        paused = true;
    }

    public void resume() {
        paused = false;
    }

    public boolean isPaused() {
        return paused;
    }

    public boolean isRunning() {
        return replayTask != null && !replayTask.isCancelled();
    }

    public void reset() {
        stop();
        currentIndex = 0;
    }

    public int getTotalSamples() {
        return samples.size();
    }

    public int getCurrentIndex() {
        return currentIndex;
    }
}
