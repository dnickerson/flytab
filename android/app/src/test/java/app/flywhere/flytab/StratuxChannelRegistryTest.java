package app.flywhere.flytab;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.List;

import org.junit.Test;

/**
 * Channel ownership for StratuxWsPlugin. The plugin used to decide "is this
 * listener's socket still current?" by comparing against the socket stored in a
 * map AFTER client.newWebSocket() returned — but OkHttp starts connecting on
 * its own thread inside newWebSocket(), so a fast failure (Stratux refusing the
 * connect while rebooting) ran before the put(), failed the check, and was
 * dropped. JS never got a close event and the channel sat in CONNECTING
 * forever. Ownership is now a token claimed BEFORE the socket is created.
 */
public class StratuxChannelRegistryTest {

    @Test
    public void failureBeforeAttachIsStillDeliveredAndNotResurrected() {
        StratuxChannelRegistry<String> reg = new StratuxChannelRegistry<>();
        StratuxChannelRegistry.Claim<String> c = reg.claim("traffic");

        // OkHttp thread: connect refused before the plugin thread attaches.
        assertTrue("listener must be current before attach", reg.isCurrent("traffic", c.token));
        assertTrue("failure must be reported to JS", reg.release("traffic", c.token));

        // Plugin thread resumes: attaching a socket whose channel was already
        // released must not leave it registered as live.
        assertFalse(reg.attach("traffic", c.token, "ws1"));
        assertNull(reg.releaseChannel("traffic"));
    }

    @Test
    public void openBeforeAttachIsCurrent() {
        StratuxChannelRegistry<String> reg = new StratuxChannelRegistry<>();
        StratuxChannelRegistry.Claim<String> c = reg.claim("situation");
        assertTrue(reg.isCurrent("situation", c.token));
        assertTrue(reg.attach("situation", c.token, "ws1"));
        assertTrue(reg.isCurrent("situation", c.token));
    }

    @Test
    public void reclaimReturnsPreviousSocketAndStalesOldListener() {
        StratuxChannelRegistry<String> reg = new StratuxChannelRegistry<>();
        StratuxChannelRegistry.Claim<String> c1 = reg.claim("weather");
        reg.attach("weather", c1.token, "ws1");

        StratuxChannelRegistry.Claim<String> c2 = reg.claim("weather");
        assertEquals("ws1", c2.previous);
        assertFalse("old listener events must be ignored", reg.isCurrent("weather", c1.token));
        assertFalse("old listener close must not be reported", reg.release("weather", c1.token));
        assertTrue(reg.isCurrent("weather", c2.token));
    }

    @Test
    public void staleReleaseDoesNotRemoveNewSocket() {
        StratuxChannelRegistry<String> reg = new StratuxChannelRegistry<>();
        StratuxChannelRegistry.Claim<String> c1 = reg.claim("jsonio");
        reg.attach("jsonio", c1.token, "ws1");
        StratuxChannelRegistry.Claim<String> c2 = reg.claim("jsonio");
        reg.attach("jsonio", c2.token, "ws2");

        reg.release("jsonio", c1.token);
        assertSame("ws2", reg.releaseChannel("jsonio"));
    }

    @Test
    public void releaseChannelMakesListenerStale() {
        StratuxChannelRegistry<String> reg = new StratuxChannelRegistry<>();
        StratuxChannelRegistry.Claim<String> c = reg.claim("traffic");
        reg.attach("traffic", c.token, "ws1");
        assertEquals("ws1", reg.releaseChannel("traffic"));
        assertFalse(reg.isCurrent("traffic", c.token));
        assertFalse(reg.release("traffic", c.token));
    }

    @Test
    public void releaseAllReturnsEverySocket() {
        StratuxChannelRegistry<String> reg = new StratuxChannelRegistry<>();
        reg.attach("traffic", reg.claim("traffic").token, "a");
        reg.attach("situation", reg.claim("situation").token, "b");
        List<String> all = reg.releaseAll();
        assertEquals(2, all.size());
        assertTrue(all.contains("a") && all.contains("b"));
        assertNull(reg.releaseChannel("traffic"));
    }

    @Test
    public void concurrentFailuresAndReclaimsNeverReportTwiceOrLeak() throws Exception {
        StratuxChannelRegistry<Integer> reg = new StratuxChannelRegistry<>();
        for (int i = 0; i < 2000; i++) {
            StratuxChannelRegistry.Claim<Integer> c = reg.claim("traffic");
            final long token = c.token;
            final int[] reported = {0};
            Thread okhttp = new Thread(() -> { if (reg.release("traffic", token)) reported[0]++; });
            okhttp.start();
            reg.attach("traffic", token, i);
            if (reg.release("traffic", token)) reported[0]++;
            okhttp.join();
            assertEquals("close reported exactly once", 1, reported[0]);
        }
        assertNull("no socket left registered", reg.releaseChannel("traffic"));
    }
}
