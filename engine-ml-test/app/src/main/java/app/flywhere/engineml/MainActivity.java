package app.flywhere.engineml;

import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import com.github.mikephil.charting.charts.LineChart;
import com.github.mikephil.charting.components.LimitLine;
import com.github.mikephil.charting.components.XAxis;
import com.github.mikephil.charting.components.YAxis;
import com.github.mikephil.charting.data.Entry;
import com.github.mikephil.charting.data.LineData;
import com.github.mikephil.charting.data.LineDataSet;
import com.google.android.material.button.MaterialButton;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public class MainActivity extends AppCompatActivity {
    private static final String TAG = "EngineMLMain";
    private static final int MAX_CHART_POINTS = 300;

    // Core components
    private InferenceEngine engine;
    private RollingBuffer buffer;
    private PhaseDetector phaseDetector;
    private EngineAdvisor advisor;
    private CsvReplayService csvReplay;
    private EngineWebSocket liveWs;
    private final Handler uiHandler = new Handler(Looper.getMainLooper());

    // UI elements
    private TextView tvAnomalyScore, tvThreshold, tvAnomalyLabel;
    private TextView tvLatency, tvSamples, tvBuffer, tvStatus, tvDelegate;
    private TextView tvPhase, tvPilotMessage;
    private LineChart chartAnomaly;
    private LinearLayout featureErrorContainer, rawValueContainer, speedControls;
    private MaterialButton btnCsv, btnLive, btnPlay, btnPause, btn1x, btn5x, btn10x;

    // State
    private boolean modelReady = false;
    private int totalSamplesProcessed = 0;
    private final List<Entry> chartEntries = new ArrayList<>();
    private float[] lastRawFeatures;
    private float[] lastExtras = new float[3]; // MP, CarbTemp, GalRemaining
    private String currentPhase = "warmup";

    // Feature views
    private TextView[] featureErrorViews;
    private TextView[] rawValueViews;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        bindViews();
        setupChart();
        setButtonsEnabled(false);

        tvStatus.setText("Loading model...");
        Log.i(TAG, "Starting model load...");
        new Thread(() -> {
            try {
                long t0 = System.currentTimeMillis();
                engine = new InferenceEngine(this, delegate ->
                    uiHandler.post(() -> tvDelegate.setText(delegate)));
                buffer = new RollingBuffer(engine.getWindowSize(), engine.getNFeatures());
                phaseDetector = new PhaseDetector();
                advisor = new EngineAdvisor();
                long elapsed = System.currentTimeMillis() - t0;

                Log.i(TAG, "Model loaded in " + elapsed + "ms, delegate=" + engine.getActiveDelegate());
                Log.i(TAG, "Phase thresholds: " + engine.getPhaseThresholds());

                uiHandler.post(() -> {
                    modelReady = true;
                    buildFeatureRows();
                    setButtonsEnabled(true);
                    setupCsvMode();
                });
            } catch (Exception e) {
                Log.e(TAG, "Model load failed", e);
                uiHandler.post(() -> tvStatus.setText("ERROR: " + e.getMessage()));
            }
        }).start();
    }

    private void setButtonsEnabled(boolean enabled) {
        btnCsv.setEnabled(enabled);
        btnLive.setEnabled(enabled);
        btnPlay.setEnabled(enabled);
        btnPause.setEnabled(enabled);
        btn1x.setEnabled(enabled);
        btn5x.setEnabled(enabled);
        btn10x.setEnabled(enabled);
    }

    private void bindViews() {
        tvAnomalyScore = findViewById(R.id.tvAnomalyScore);
        tvThreshold = findViewById(R.id.tvThreshold);
        tvAnomalyLabel = findViewById(R.id.tvAnomalyLabel);
        tvLatency = findViewById(R.id.tvLatency);
        tvSamples = findViewById(R.id.tvSamples);
        tvBuffer = findViewById(R.id.tvBuffer);
        tvStatus = findViewById(R.id.tvStatus);
        tvDelegate = findViewById(R.id.tvDelegate);
        tvPhase = findViewById(R.id.tvPhase);
        tvPilotMessage = findViewById(R.id.tvPilotMessage);
        chartAnomaly = findViewById(R.id.chartAnomaly);
        featureErrorContainer = findViewById(R.id.featureErrorContainer);
        rawValueContainer = findViewById(R.id.rawValueContainer);
        speedControls = findViewById(R.id.speedControls);
        btnCsv = findViewById(R.id.btnCsv);
        btnLive = findViewById(R.id.btnLive);
        btnPlay = findViewById(R.id.btnPlay);
        btnPause = findViewById(R.id.btnPause);
        btn1x = findViewById(R.id.btn1x);
        btn5x = findViewById(R.id.btn5x);
        btn10x = findViewById(R.id.btn10x);

        btnCsv.setOnClickListener(v -> { if (modelReady) setupCsvMode(); });
        btnLive.setOnClickListener(v -> { if (modelReady) setupLiveMode(); });

        btnPlay.setOnClickListener(v -> {
            if (csvReplay == null) return;
            if (csvReplay.isPaused()) csvReplay.resume();
            else if (!csvReplay.isRunning()) csvReplay.start();
        });
        btnPause.setOnClickListener(v -> { if (csvReplay != null) csvReplay.pause(); });
        btn1x.setOnClickListener(v -> setSpeed(1));
        btn5x.setOnClickListener(v -> setSpeed(5));
        btn10x.setOnClickListener(v -> setSpeed(10));
    }

    private void buildFeatureRows() {
        String[] cols = engine.getFeatureCols();
        featureErrorViews = new TextView[cols.length];
        rawValueViews = new TextView[cols.length];

        featureErrorContainer.removeAllViews();
        rawValueContainer.removeAllViews();

        for (int i = 0; i < cols.length; i++) {
            LinearLayout errorRow = makeRow();
            errorRow.addView(makeLabel(cols[i]));
            featureErrorViews[i] = makeValue("—");
            errorRow.addView(featureErrorViews[i]);
            featureErrorContainer.addView(errorRow);

            LinearLayout rawRow = makeRow();
            rawRow.addView(makeLabel(cols[i]));
            rawValueViews[i] = makeValue("—");
            rawRow.addView(rawValueViews[i]);
            rawValueContainer.addView(rawRow);
        }
    }

    private LinearLayout makeRow() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        row.setPadding(0, 2, 0, 2);
        return row;
    }

    private TextView makeLabel(String text) {
        TextView tv = new TextView(this);
        tv.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        tv.setText(text);
        tv.setTextColor(Color.parseColor("#9E9E9E"));
        tv.setTextSize(12f);
        return tv;
    }

    private TextView makeValue(String text) {
        TextView tv = new TextView(this);
        tv.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        tv.setText(text);
        tv.setTextColor(Color.WHITE);
        tv.setTextSize(12f);
        tv.setTypeface(Typeface.MONOSPACE);
        tv.setGravity(Gravity.END);
        return tv;
    }

    private void setupChart() {
        chartAnomaly.setDescription(null);
        chartAnomaly.setDrawGridBackground(false);
        chartAnomaly.setTouchEnabled(false);
        chartAnomaly.getLegend().setEnabled(false);
        chartAnomaly.setNoDataText("Waiting for data...");
        chartAnomaly.setNoDataTextColor(Color.parseColor("#757575"));

        XAxis xAxis = chartAnomaly.getXAxis();
        xAxis.setPosition(XAxis.XAxisPosition.BOTTOM);
        xAxis.setTextColor(Color.parseColor("#757575"));
        xAxis.setDrawGridLines(false);
        xAxis.setTextSize(10f);

        YAxis leftAxis = chartAnomaly.getAxisLeft();
        leftAxis.setTextColor(Color.parseColor("#757575"));
        leftAxis.setGridColor(Color.parseColor("#333333"));
        leftAxis.setAxisMinimum(0f);
        leftAxis.setTextSize(10f);

        chartAnomaly.getAxisRight().setEnabled(false);
    }

    // ── CSV Mode ────────────────────────────────────────────────
    private void setupCsvMode() {
        if (liveWs != null) { liveWs.disconnect(); liveWs = null; }

        btnCsv.setStrokeColorResource(android.R.color.holo_blue_light);
        btnLive.setStrokeColorResource(android.R.color.darker_gray);
        speedControls.setVisibility(View.VISIBLE);
        resetState();

        csvReplay = new CsvReplayService();
        int loaded = csvReplay.loadFromAssets(this, "test_flight.csv");
        Log.i(TAG, "CSV loaded: " + loaded + " samples (all phases)");
        tvStatus.setText("CSV loaded: " + loaded + " samples. Press ▶ Play.");

        if (loaded == 0) {
            tvStatus.setText("ERROR: CSV loaded 0 samples");
            return;
        }

        csvReplay.setCallback(new CsvReplayService.SampleCallback() {
            @Override
            public void onSample(float[] features, float speedKts, float[] extras, int idx, int total) {
                processSample(features, speedKts, extras);
                uiHandler.post(() -> tvStatus.setText(String.format(Locale.US,
                        "CSV: %d / %d  [%dx]", idx + 1, total, csvReplay.getSpeedMultiplier())));
            }

            @Override
            public void onReplayComplete() {
                uiHandler.post(() -> tvStatus.setText("Replay complete — " + totalSamplesProcessed + " samples"));
            }

            @Override
            public void onError(String message) {
                uiHandler.post(() -> tvStatus.setText("Error: " + message));
            }
        });
    }

    // ── Live WebSocket Mode ────────────────────────────────────
    private void setupLiveMode() {
        if (csvReplay != null) { csvReplay.stop(); csvReplay = null; }

        btnLive.setStrokeColorResource(android.R.color.holo_blue_light);
        btnCsv.setStrokeColorResource(android.R.color.darker_gray);
        speedControls.setVisibility(View.GONE);
        resetState();

        tvStatus.setText("Connecting to Pi...");
        liveWs = new EngineWebSocket(EngineWebSocket.URL_HOME, new EngineWebSocket.LiveDataCallback() {
            @Override
            public void onSample(float[] features) {
                processSample(features, 0f, new float[3]);
            }

            @Override
            public void onConnected() {
                uiHandler.post(() -> tvStatus.setText("Live: Connected to Pi"));
            }

            @Override
            public void onDisconnected(String reason) {
                uiHandler.post(() -> tvStatus.setText("Disconnected: " + reason));
            }

            @Override
            public void onError(String error) {
                uiHandler.post(() -> tvStatus.setText("WS Error: " + error));
            }
        });
        liveWs.connect();
    }

    // ── Inference Pipeline ─────────────────────────────────────
    private void processSample(float[] features, float speedKts, float[] extras) {
        if (engine == null || buffer == null) return;

        lastRawFeatures = features;
        lastExtras = extras;
        buffer.addSample(features);
        totalSamplesProcessed++;

        // Detect phase: RPM = features[0], altitude = features[12]
        currentPhase = phaseDetector.detect(features[0], features[12], speedKts);

        // Feed advisor: extras = [MP, CarbTemp, GalRemaining]
        advisor.addSample(features, extras[0], extras[1], extras[2]);

        float[][] window = buffer.getWindow();
        if (window != null) {
            try {
                float score = engine.runInference(window);
                boolean anomaly = engine.isAnomaly(score, currentPhase);
                float phaseThreshold = engine.getThresholdForPhase(currentPhase);

                // Get advisories
                List<EngineAdvisor.Advisory> advisories = advisor.advise(
                        features, currentPhase, score, anomaly,
                        0f, speedKts); // distRemaining=0 for test app

                if (totalSamplesProcessed % 60 == 0) {
                    Log.i(TAG, String.format(Locale.US,
                            "Sample %d: score=%.4f threshold=%.4f phase=%s anomaly=%b latency=%.1fms RPM=%.0f MP=%.1f",
                            totalSamplesProcessed, score, phaseThreshold, currentPhase,
                            anomaly, engine.getLastLatencyMs(), features[0], extras[0]));
                }

                final String phase = currentPhase;
                final float thr = phaseThreshold;
                final List<EngineAdvisor.Advisory> advs = advisories;
                uiHandler.post(() -> updateUI(score, phase, thr, anomaly, advs));
            } catch (Exception e) {
                Log.e(TAG, "Inference error at sample " + totalSamplesProcessed, e);
            }
        } else {
            final String phase = currentPhase;
            uiHandler.post(() -> {
                tvBuffer.setText(buffer.getCount() + "/" + engine.getWindowSize());
                tvSamples.setText(String.valueOf(totalSamplesProcessed));
                tvPhase.setText(phase.toUpperCase());
                tvPilotMessage.setVisibility(View.VISIBLE);
                tvPilotMessage.setText("Filling buffer \u2014 " + buffer.getCount() + "s of data");
                tvPilotMessage.setTextColor(Color.parseColor("#9E9E9E"));
                updateRawValues();
            });
        }
    }

    private void updateUI(float score, String phase, float threshold, boolean anomaly,
                          List<EngineAdvisor.Advisory> advisories) {
        // Score display
        tvAnomalyScore.setText(String.format(Locale.US, "%.4f", score));

        if (anomaly) {
            tvAnomalyScore.setTextColor(Color.parseColor("#F44336"));
            tvAnomalyLabel.setText("ANOMALY");
            tvAnomalyLabel.setTextColor(Color.parseColor("#F44336"));
        } else if (score > threshold * 0.67f) {
            tvAnomalyScore.setTextColor(Color.parseColor("#FF9800"));
            tvAnomalyLabel.setText("ELEVATED");
            tvAnomalyLabel.setTextColor(Color.parseColor("#FF9800"));
        } else {
            tvAnomalyScore.setTextColor(Color.parseColor("#4CAF50"));
            tvAnomalyLabel.setText("NORMAL");
            tvAnomalyLabel.setTextColor(Color.parseColor("#4CAF50"));
        }

        // Phase + threshold
        tvPhase.setText(phase.toUpperCase());
        tvThreshold.setText(String.format(Locale.US, "%s threshold: %.4f", phase, threshold));

        // Phase badge color
        switch (phase) {
            case "startup": tvPhase.setTextColor(Color.parseColor("#FF9800")); break;
            case "warmup":  tvPhase.setTextColor(Color.parseColor("#FFC107")); break;
            case "runup":   tvPhase.setTextColor(Color.parseColor("#FF5722")); break;
            case "takeoff": tvPhase.setTextColor(Color.parseColor("#E91E63")); break;
            case "climb":   tvPhase.setTextColor(Color.parseColor("#9C27B0")); break;
            case "cruise":  tvPhase.setTextColor(Color.parseColor("#4CAF50")); break;
            case "descent": tvPhase.setTextColor(Color.parseColor("#2196F3")); break;
            case "landing": tvPhase.setTextColor(Color.parseColor("#00BCD4")); break;
            default:        tvPhase.setTextColor(Color.parseColor("#757575")); break;
        }

        // Stats
        tvLatency.setText(String.format(Locale.US, "%.1f ms", engine.getLastLatencyMs()));
        tvSamples.setText(String.valueOf(totalSamplesProcessed));
        tvBuffer.setText(buffer.getCount() + "/" + engine.getWindowSize());

        // Chart
        chartEntries.add(new Entry(totalSamplesProcessed, score));
        if (chartEntries.size() > MAX_CHART_POINTS) chartEntries.remove(0);
        updateChart(threshold);

        // Feature errors
        float[] errors = engine.getLastFeatureErrors();
        if (featureErrorViews != null && errors != null) {
            for (int i = 0; i < errors.length && i < featureErrorViews.length; i++) {
                featureErrorViews[i].setText(String.format(Locale.US, "%.4f", errors[i]));
                if (errors[i] > 0.5f) {
                    featureErrorViews[i].setTextColor(Color.parseColor("#F44336"));
                } else if (errors[i] > 0.2f) {
                    featureErrorViews[i].setTextColor(Color.parseColor("#FF9800"));
                } else {
                    featureErrorViews[i].setTextColor(Color.parseColor("#4CAF50"));
                }
            }
        }

        // Advisor messages
        updateAdvisorDisplay(advisories);

        updateRawValues();
    }

    private void updateAdvisorDisplay(List<EngineAdvisor.Advisory> advisories) {
        if (advisories == null || advisories.isEmpty()) {
            tvPilotMessage.setVisibility(View.GONE);
            return;
        }

        tvPilotMessage.setVisibility(View.VISIBLE);

        // Find highest severity
        int maxSeverity = EngineAdvisor.SEVERITY_INFO;
        for (EngineAdvisor.Advisory a : advisories) {
            if (a.severity > maxSeverity) maxSeverity = a.severity;
        }

        // Build display: show top advisory + count of others
        // Warnings first, then cautions, then info
        StringBuilder sb = new StringBuilder();
        int shown = 0;
        for (int sev = EngineAdvisor.SEVERITY_WARNING; sev >= EngineAdvisor.SEVERITY_INFO; sev--) {
            for (EngineAdvisor.Advisory a : advisories) {
                if (a.severity == sev && shown < 3) {
                    if (shown > 0) sb.append("\n");
                    sb.append(a.message);
                    shown++;
                }
            }
        }

        int remaining = advisories.size() - shown;
        if (remaining > 0) {
            sb.append(String.format(Locale.US, "\n+%d more", remaining));
        }

        tvPilotMessage.setText(sb.toString());

        switch (maxSeverity) {
            case EngineAdvisor.SEVERITY_WARNING:
                tvPilotMessage.setTextColor(Color.parseColor("#F44336"));
                break;
            case EngineAdvisor.SEVERITY_CAUTION:
                tvPilotMessage.setTextColor(Color.parseColor("#FF9800"));
                break;
            default:
                tvPilotMessage.setTextColor(Color.parseColor("#4CAF50"));
                break;
        }
    }

    private void updateRawValues() {
        if (lastRawFeatures == null || rawValueViews == null) return;
        String[] cols = engine.getFeatureCols();
        for (int i = 0; i < lastRawFeatures.length && i < rawValueViews.length; i++) {
            String formatted;
            if (cols[i].equals("Fuel Flow")) {
                formatted = String.format(Locale.US, "%.1f", lastRawFeatures[i]);
            } else {
                formatted = String.format(Locale.US, "%.0f", lastRawFeatures[i]);
            }
            rawValueViews[i].setText(formatted);
        }
    }

    private void updateChart(float currentThreshold) {
        LineDataSet dataSet = new LineDataSet(chartEntries, "Anomaly Score");
        dataSet.setColor(Color.parseColor("#2196F3"));
        dataSet.setDrawCircles(false);
        dataSet.setDrawValues(false);
        dataSet.setLineWidth(1.5f);
        dataSet.setMode(LineDataSet.Mode.CUBIC_BEZIER);

        LineData lineData = new LineData(dataSet);
        chartAnomaly.setData(lineData);

        YAxis leftAxis = chartAnomaly.getAxisLeft();
        leftAxis.removeAllLimitLines();
        LimitLine thresholdLine = new LimitLine(currentThreshold, "threshold");
        thresholdLine.setLineColor(Color.parseColor("#F44336"));
        thresholdLine.setLineWidth(1f);
        thresholdLine.setTextColor(Color.parseColor("#F44336"));
        thresholdLine.setTextSize(10f);
        thresholdLine.enableDashedLine(10f, 10f, 0f);
        leftAxis.addLimitLine(thresholdLine);

        chartAnomaly.invalidate();
    }

    private void setSpeed(int multiplier) {
        if (csvReplay != null) csvReplay.setSpeedMultiplier(multiplier);
    }

    private void resetState() {
        totalSamplesProcessed = 0;
        chartEntries.clear();
        lastRawFeatures = null;
        currentPhase = "warmup";
        if (buffer != null) buffer.clear();
        if (phaseDetector != null) phaseDetector.reset();
        if (advisor != null) advisor.reset();
        tvAnomalyScore.setText("—");
        tvAnomalyScore.setTextColor(Color.parseColor("#4CAF50"));
        tvAnomalyLabel.setText("");
        tvPhase.setText("—");
        tvLatency.setText("— ms");
        tvSamples.setText("0");
        tvBuffer.setText("0/60");
        tvThreshold.setText("");
        tvPilotMessage.setText("");
        tvPilotMessage.setVisibility(View.GONE);
        chartAnomaly.clear();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (csvReplay != null) csvReplay.stop();
        if (liveWs != null) liveWs.disconnect();
        if (engine != null) engine.close();
    }
}
