package app.flywhere.flytab.engineml;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class InferenceGateTest {
    private static final InferenceGate.Decision RUN = InferenceGate.Decision.RUN;
    private static final InferenceGate.Decision BUSY = InferenceGate.Decision.SKIP_BUSY;

    @Test
    public void normalOneHzSamplesAllRun() {
        InferenceGate g = new InferenceGate();
        for (long t = 0; t < 60_000; t += 1000) {
            assertEquals(RUN, g.tryBegin(t));
            g.end();                          // ~1.4 ms on the NPU
        }
        assertFalse(g.isDisabled());
    }

    @Test
    public void neverTwoRunsAtOnce() {
        // The old bug: a timed-out run keeps going natively and the next sample started another.
        InferenceGate g = new InferenceGate();
        assertEquals(RUN, g.tryBegin(0));
        assertEquals(BUSY, g.tryBegin(1000));
        assertEquals(BUSY, g.tryBegin(2000));
        assertTrue(g.isRunning());
    }

    @Test
    public void aSlowRunThatReturnsLetsTheNextSampleRun() {
        InferenceGate g = new InferenceGate();
        g.tryBegin(0);
        assertEquals(BUSY, g.tryBegin(1000));
        g.end();                              // came back after ~1.5 s
        assertEquals(RUN, g.tryBegin(2000));
        assertFalse(g.isDisabled());
    }

    @Test
    public void aRunThatNeverReturnsDisablesMlOnceThenForGood() {
        InferenceGate g = new InferenceGate();
        g.tryBegin(0);
        assertEquals(BUSY, g.tryBegin(InferenceGate.DISABLE_AFTER_MS - 1));
        assertEquals(InferenceGate.Decision.DISABLED_NOW, g.tryBegin(InferenceGate.DISABLE_AFTER_MS));
        assertEquals(InferenceGate.Decision.DISABLED, g.tryBegin(InferenceGate.DISABLE_AFTER_MS + 1000));
        assertTrue(g.isDisabled());
        g.end();                              // even if the stuck run finally returns
        assertEquals(InferenceGate.Decision.DISABLED, g.tryBegin(InferenceGate.DISABLE_AFTER_MS + 2000));
    }

    @Test
    public void theTimerStartsWhenTheRunStarts() {
        InferenceGate g = new InferenceGate();
        g.tryBegin(0); g.end();
        g.tryBegin(50_000);                   // a new run, long after the first
        assertEquals(BUSY, g.tryBegin(50_000 + InferenceGate.DISABLE_AFTER_MS - 1));
    }
}
