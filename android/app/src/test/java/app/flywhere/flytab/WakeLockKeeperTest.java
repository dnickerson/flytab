package app.flywhere.flytab;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.junit.Before;
import org.junit.Test;

/**
 * A7: FlightService's CPU wake lock used to be taken once with an 8 h timeout
 * and never renewed, so a FlyTab opened in the morning lost it by an afternoon
 * flight. WakeLockKeeper renews it while the service runs.
 */
public class WakeLockKeeperTest {

    /** A non-reference-counted wake lock: acquire(timeout) re-arms the timeout (AOSP PowerManager). */
    static class FakeLock implements WakeLockKeeper.Lock {
        long now = 0, expiresAt = -1;
        boolean held = false;
        final List<Long> acquires = new ArrayList<>();
        int releases = 0;

        @Override public void acquire(long timeoutMs) { held = true; expiresAt = now + timeoutMs; acquires.add(timeoutMs); }
        @Override public void release() { held = false; releases++; }
        @Override public boolean isHeld() { return held && now < expiresAt; }
        void advance(long ms) { now += ms; if (held && now >= expiresAt) held = false; }
    }

    static class FakeScheduler implements WakeLockKeeper.Scheduler {
        Runnable pending; long delay = -1; int cancels = 0;
        @Override public void postDelayed(Runnable r, long delayMs) { pending = r; delay = delayMs; }
        @Override public void removeCallbacks(Runnable r) { if (pending == r) pending = null; cancels++; }
        void fire() { Runnable r = pending; pending = null; r.run(); }
    }

    FakeLock lock;
    FakeScheduler sched;
    List<String> lapses;
    WakeLockKeeper keeper;

    @Before
    public void setUp() {
        lock = new FakeLock();
        sched = new FakeScheduler();
        lapses = new ArrayList<>();
        keeper = new WakeLockKeeper(lock, sched, lapses::add);
    }

    @Test
    public void startTakesTheLockAndSchedulesARenewal() {
        keeper.start();
        assertTrue(lock.isHeld());
        assertEquals((Long) WakeLockKeeper.TIMEOUT_MS, lock.acquires.get(0));
        assertEquals(WakeLockKeeper.RENEW_EVERY_MS, sched.delay);
        assertTrue("renewal comes well before the timeout", WakeLockKeeper.RENEW_EVERY_MS * 2 < WakeLockKeeper.TIMEOUT_MS);
    }

    @Test
    public void heldAcrossAWholeDay() {
        // The old code: 8 h, then silently gone. 07:00 planning -> 16:00 flight is 9 h.
        keeper.start();
        for (long t = 0; t < 24 * 60 * 60 * 1000L; t += WakeLockKeeper.RENEW_EVERY_MS) {
            lock.advance(WakeLockKeeper.RENEW_EVERY_MS);
            assertTrue("held at " + (lock.now / 60000) + " min", lock.isHeld());
            sched.fire();
        }
        assertTrue(lapses.isEmpty());
    }

    @Test
    public void stopReleasesAndCancelsTheRenewal() {
        keeper.start();
        keeper.stop();
        assertFalse(lock.held);
        assertEquals(1, lock.releases);
        assertEquals(null, sched.pending);
    }

    @Test
    public void aRenewalAfterStopDoesNothing() {
        keeper.start();
        Runnable r = sched.pending;
        keeper.stop();
        r.run();                       // a callback that slipped through
        assertFalse(lock.held);
        assertEquals(1, lock.acquires.size());
    }

    @Test
    public void aLapseIsReportedAndTheLockTakenAgain() {
        keeper.start();
        lock.advance(WakeLockKeeper.TIMEOUT_MS + 1);  // e.g. the main thread was stuck past the timeout
        sched.fire();
        assertEquals(1, lapses.size());
        assertTrue(lock.isHeld());
    }

    @Test
    public void renewNowFromOnStartCommandReArmsWithoutStacking() {
        keeper.start();
        keeper.renewNow();
        keeper.renewNow();
        assertTrue(lock.isHeld());
        assertEquals(3, lock.acquires.size());
        assertEquals("only one renewal pending", WakeLockKeeper.RENEW_EVERY_MS, sched.delay);
        keeper.stop();
        assertFalse(lock.held);
    }

    @Test
    public void renewNowBeforeStartStartsIt() {
        keeper.renewNow();
        assertTrue(lock.isHeld());
        assertEquals(WakeLockKeeper.RENEW_EVERY_MS, sched.delay);
    }
}
