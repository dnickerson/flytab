package app.flywhere.flytab;

/**
 * Keeps FlightService's CPU wake lock held for as long as the service runs.
 *
 * It used to be acquired once with an 8 h timeout and never renewed. FlyTab
 * opened at 07:00 for planning had no CPU lock for a 16:00 flight, so with the
 * screen off the CPU could sleep and FlyTab's JavaScript (engine alerts,
 * recording) stop.
 *
 * The lock must be NON-reference-counted (setReferenceCounted(false)). AOSP
 * PowerManager.WakeLock: then each acquire(timeout) cancels the pending timed
 * release and posts a new one, and one release() fully releases. A
 * reference-counted lock would stack a hold per renewal and outlive the
 * service. TIMEOUT_MS is only a backstop if renewal ever stops; while the
 * service runs the lock is renewed every RENEW_EVERY_MS. No Android types,
 * so JUnit tests it (WakeLockKeeperTest).
 */
final class WakeLockKeeper {
    static final long TIMEOUT_MS = 60 * 60 * 1000L;
    static final long RENEW_EVERY_MS = 20 * 60 * 1000L;

    interface Lock {
        void acquire(long timeoutMs);
        void release();
        boolean isHeld();
    }

    interface Scheduler {
        void postDelayed(Runnable r, long delayMs);
        void removeCallbacks(Runnable r);
    }

    interface LapseListener {
        void onLapse(String message);
    }

    private final Lock lock;
    private final Scheduler scheduler;
    private final LapseListener lapses;
    private final Runnable renewal = this::renew;
    private boolean running = false;

    WakeLockKeeper(Lock lock, Scheduler scheduler, LapseListener lapses) {
        this.lock = lock;
        this.scheduler = scheduler;
        this.lapses = lapses;
    }

    void start() {
        running = true;
        lock.acquire(TIMEOUT_MS);
        schedule();
    }

    /** Re-arm now (FlightService.onStartCommand); starts the keeper if needed. */
    void renewNow() {
        if (!running) { start(); return; }
        lock.acquire(TIMEOUT_MS);
        schedule();
    }

    void stop() {
        running = false;
        scheduler.removeCallbacks(renewal);
        lock.release();
    }

    private void renew() {
        if (!running) return;
        if (!lock.isHeld()) lapses.onLapse("CPU wake lock had lapsed before renewal; taken again");
        lock.acquire(TIMEOUT_MS);
        schedule();
    }

    private void schedule() {
        scheduler.removeCallbacks(renewal);
        scheduler.postDelayed(renewal, RENEW_EVERY_MS);
    }
}
