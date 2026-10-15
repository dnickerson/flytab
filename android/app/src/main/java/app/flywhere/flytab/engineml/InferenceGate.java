package app.flywhere.flytab.engineml;

/**
 * At most one TFLite run at a time, and give up on a run that never returns.
 *
 * TFLite's Interpreter is not thread-safe. InferenceEngine used to start a new
 * thread per sample and, after its 500 ms timeout, call future.cancel(), which
 * can't stop a native interpreter.run(). The next sample a second later then
 * ran the same Interpreter on a second thread while the first was still in it:
 * a native-memory crash risk in FlyTab's own process, plus a leaked thread per
 * timeout. Now:
 *  - idle: RUN;
 *  - a run still in progress: SKIP_BUSY (that sample gets no ML score);
 *  - a run in progress for DISABLE_AFTER_MS: DISABLED_NOW once, then DISABLED
 *    for good. ML inference stays off until FlyTab restarts; EngineAdvisor's
 *    rule-based advisories don't need it.
 * No Android types, so JUnit tests it (InferenceGateTest).
 */
final class InferenceGate {
    static final long DISABLE_AFTER_MS = 10_000;

    enum Decision { RUN, SKIP_BUSY, DISABLED_NOW, DISABLED }

    /** Thrown by InferenceEngine.runInference when a sample is not run. */
    static final class SkippedException extends Exception {
        final boolean disabled;
        SkippedException(boolean disabled) {
            super(disabled ? "ML inference disabled (a run never returned)" : "previous inference still running");
            this.disabled = disabled;
        }
    }

    private boolean running = false;
    private long runningSince = 0;
    private boolean disabled = false;

    synchronized Decision tryBegin(long nowMs) {
        if (disabled) return Decision.DISABLED;
        if (running) {
            if (nowMs - runningSince >= DISABLE_AFTER_MS) {
                disabled = true;
                return Decision.DISABLED_NOW;
            }
            return Decision.SKIP_BUSY;
        }
        running = true;
        runningSince = nowMs;
        return Decision.RUN;
    }

    /** The run started by the last RUN has returned (called on the inference thread). */
    synchronized void end() {
        running = false;
    }

    synchronized boolean isRunning() { return running; }

    synchronized boolean isDisabled() { return disabled; }
}
