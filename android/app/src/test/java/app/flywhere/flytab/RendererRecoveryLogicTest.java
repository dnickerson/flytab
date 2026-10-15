package app.flywhere.flytab;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class RendererRecoveryLogicTest {
    private static final long T = 1_791_994_313_000L;   // 2026-10-14 12:11:53 EDT
    private static final long MIN = 60_000L;

    @Test
    public void onScreenRendererCrashRestartsFlyTab() {
        assertEquals(RendererRecoveryLogic.Action.RESTART, RendererRecoveryLogic.decide(true, T, new long[0]));
    }

    @Test
    public void offScreenItClosesInsteadOfRestarting() {
        // Android doesn't let an app start an activity from the background
        // (a foreground service doesn't count), so FlyTab can't relaunch itself.
        assertEquals(RendererRecoveryLogic.Action.CLOSE_IN_BACKGROUND, RendererRecoveryLogic.decide(false, T, new long[0]));
    }

    @Test
    public void crashLoopStopsAfterTwoRestartsInFiveMinutes() {
        long[] one = { T - 4 * MIN };
        long[] two = { T - 4 * MIN, T - 1 * MIN };
        assertEquals(RendererRecoveryLogic.Action.RESTART, RendererRecoveryLogic.decide(true, T, one));
        assertEquals(RendererRecoveryLogic.Action.GIVE_UP, RendererRecoveryLogic.decide(true, T, two));
    }

    @Test
    public void oldRestartsAndFutureTimestampsDontCount() {
        long[] old = { T - 6 * MIN, T - 5 * MIN };            // outside the 5 min window
        long[] future = { T + 10 * MIN, T + 20 * MIN };       // clock went backwards
        assertEquals(RendererRecoveryLogic.Action.RESTART, RendererRecoveryLogic.decide(true, T, old));
        assertEquals(RendererRecoveryLogic.Action.RESTART, RendererRecoveryLogic.decide(true, T, future));
    }

    @Test
    public void restartTimesRoundTripAndDropExpiredOnes() {
        String s = RendererRecoveryLogic.addTime("", T - 10 * MIN);
        s = RendererRecoveryLogic.addTime(s, T - 2 * MIN);
        s = RendererRecoveryLogic.addTime(s, T);
        assertArrayEquals(new long[] { T - 2 * MIN, T }, RendererRecoveryLogic.parseTimes(s));
    }

    @Test
    public void garbageInStorageIsIgnored() {
        assertArrayEquals(new long[0], RendererRecoveryLogic.parseTimes(null));
        assertArrayEquals(new long[0], RendererRecoveryLogic.parseTimes(""));
        assertArrayEquals(new long[] { 5L }, RendererRecoveryLogic.parseTimes("x,5,,7y"));
    }

    @Test
    public void eventsAreKeptForTheNextLaunchNewestLast() {
        String p = RendererRecoveryLogic.appendEvent("", T, true, 2, RendererRecoveryLogic.Action.RESTART);
        assertEquals(T + ",1,2,RESTART", p);
        p = RendererRecoveryLogic.appendEvent(p, T + 1, false, 0, RendererRecoveryLogic.Action.CLOSE_IN_BACKGROUND);
        assertEquals(T + ",1,2,RESTART\n" + (T + 1) + ",0,0,CLOSE_IN_BACKGROUND", p);
    }

    @Test
    public void pendingEventsAreCapped() {
        String p = "";
        for (int i = 0; i < RendererRecoveryLogic.MAX_PENDING + 5; i++) {
            p = RendererRecoveryLogic.appendEvent(p, i, true, 2, RendererRecoveryLogic.Action.RESTART);
        }
        String[] lines = p.split("\n");
        assertEquals(RendererRecoveryLogic.MAX_PENDING, lines.length);
        assertEquals("5,1,2,RESTART", lines[0]);   // oldest five dropped
    }
}
