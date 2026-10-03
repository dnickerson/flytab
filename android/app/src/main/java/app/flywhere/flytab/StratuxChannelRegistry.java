package app.flywhere.flytab;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Which socket owns each StratuxWS channel. Thread-safe: the plugin thread
 * claims/attaches/closes, OkHttp listener threads check/release.
 *
 * Ownership is a token claimed BEFORE the socket is created, not the socket
 * instance stored after — OkHttp starts connecting inside newWebSocket(), so
 * a fast open/failure can run before the plugin thread could store the
 * socket. Comparing against the stored instance dropped those events and left
 * the JS channel in CONNECTING forever.
 */
final class StratuxChannelRegistry<S> {

    static final class Claim<S> {
        final long token;
        /** Socket that previously owned the channel (caller should cancel it), or null. */
        final S previous;
        Claim(long token, S previous) { this.token = token; this.previous = previous; }
    }

    private final Map<String, Long> tokens = new HashMap<>();
    private final Map<String, S> sockets = new HashMap<>();
    private long nextToken = 1;

    /** Take ownership of a channel for a socket about to be created. */
    synchronized Claim<S> claim(String channel) {
        long token = nextToken++;
        tokens.put(channel, token);
        return new Claim<>(token, sockets.remove(channel));
    }

    /** Record the created socket. False if the channel was released meanwhile
     *  (socket already failed/closed) — it is then not registered. */
    synchronized boolean attach(String channel, long token, S socket) {
        if (!isCurrent(channel, token)) return false;
        sockets.put(channel, socket);
        return true;
    }

    synchronized boolean isCurrent(String channel, long token) {
        Long t = tokens.get(channel);
        return t != null && t == token;
    }

    /** Listener saw its socket close/fail. True exactly once, and only if it
     *  still owned the channel — i.e. the close should be reported to JS. */
    synchronized boolean release(String channel, long token) {
        if (!isCurrent(channel, token)) return false;
        tokens.remove(channel);
        sockets.remove(channel);
        return true;
    }

    /** JS asked to close the channel. Returns its socket (caller closes it), or null. */
    synchronized S releaseChannel(String channel) {
        tokens.remove(channel);
        return sockets.remove(channel);
    }

    synchronized List<S> releaseAll() {
        List<S> all = new ArrayList<>(sockets.values());
        tokens.clear();
        sockets.clear();
        return all;
    }
}
