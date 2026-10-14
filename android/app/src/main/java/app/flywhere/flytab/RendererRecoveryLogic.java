package app.flywhere.flytab;

/**
 * What MainActivity does when the WebView's renderer process dies, and the
 * small record it leaves for the next launch. No Android APIs, so JUnit can
 * test it (see MainActivity.handleRendererGone).
 *
 * Stored in SharedPreferences PREFS:
 *   KEY_RESTARTS  "t1,t2,..."  automatic restarts (ms) inside WINDOW_MS
 *   KEY_PENDING   one line per event, "atMs,didCrash(1/0),rendererPriority,ACTION",
 *                 handed to JS (AppHealth.takeRendererEvents) on the next launch
 */
final class RendererRecoveryLogic {
    static final String PREFS = "flytab_renderer";
    static final String KEY_RESTARTS = "restarts";
    static final String KEY_PENDING = "pending";

    /** At most this many automatic restarts inside WINDOW_MS; more means a crash loop. */
    static final int MAX_RESTARTS = 2;
    static final long WINDOW_MS = 5 * 60_000L;
    static final int MAX_PENDING = 20;

    enum Action {
        /** On screen: start FlyTab afresh in a new process. */
        RESTART,
        /** Off screen: Android won't let FlyTab relaunch itself; end the process cleanly. */
        CLOSE_IN_BACKGROUND,
        /** Restarted MAX_RESTARTS times inside WINDOW_MS already: stop, don't loop. */
        GIVE_UP,
    }

    private RendererRecoveryLogic() {}

    static Action decide(boolean visible, long now, long[] recentRestarts) {
        if (!visible) return Action.CLOSE_IN_BACKGROUND;
        int n = 0;
        for (long t : recentRestarts) {
            if (t <= now && now - t < WINDOW_MS) n++;
        }
        return n < MAX_RESTARTS ? Action.RESTART : Action.GIVE_UP;
    }

    /** Comma-separated ms timestamps; anything unparseable is skipped. */
    static long[] parseTimes(String s) {
        if (s == null || s.isEmpty()) return new long[0];
        String[] parts = s.split(",");
        long[] out = new long[parts.length];
        int n = 0;
        for (String p : parts) {
            try {
                out[n] = Long.parseLong(p.trim());
                n++;
            } catch (NumberFormatException ignored) {
                // skip
            }
        }
        long[] trimmed = new long[n];
        System.arraycopy(out, 0, trimmed, 0, n);
        return trimmed;
    }

    /** Adds `now`, keeping only times inside WINDOW_MS of it. */
    static String addTime(String s, long now) {
        StringBuilder sb = new StringBuilder();
        for (long t : parseTimes(s)) {
            if (t <= now && now - t < WINDOW_MS) sb.append(t).append(',');
        }
        return sb.append(now).toString();
    }

    /** Appends one event line, keeping the newest MAX_PENDING. */
    static String appendEvent(String pending, long at, boolean didCrash, int priority, Action action) {
        String line = at + "," + (didCrash ? 1 : 0) + "," + priority + "," + action.name();
        String all = (pending == null || pending.isEmpty()) ? line : pending + "\n" + line;
        String[] lines = all.split("\n");
        if (lines.length <= MAX_PENDING) return all;
        StringBuilder sb = new StringBuilder();
        for (int i = lines.length - MAX_PENDING; i < lines.length; i++) {
            if (sb.length() > 0) sb.append('\n');
            sb.append(lines[i]);
        }
        return sb.toString();
    }
}
