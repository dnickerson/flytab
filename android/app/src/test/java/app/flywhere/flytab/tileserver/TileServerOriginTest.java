package app.flywhere.flytab.tileserver;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The tile server writes the FAA data, flight recordings and logbook files. Only
 * FlyTab's own WebView (origin http://localhost) may change them: binding to
 * 127.0.0.1 kept the LAN out, but any app on the tablet -- or a web page in the
 * browser -- could still PUT, DELETE, unzip, or point fetch-zip at its own zip,
 * which now also prunes plates (final review 2026-10-17).
 */
public class TileServerOriginTest {

    @Test
    public void readsAreOpenToAll() {
        assertTrue(TileServer.allowed("GET", null));
        assertTrue(TileServer.allowed("GET", "https://evil.example"));
        assertTrue(TileServer.allowed("OPTIONS", null));
    }

    @Test
    public void writesOnlyFromTheAppsOwnOrigin() {
        for (String m : new String[]{"POST", "PUT", "DELETE"}) {
            assertTrue(m, TileServer.allowed(m, "http://localhost"));
            assertFalse(m, TileServer.allowed(m, null));                    // another app, raw HTTP
            assertFalse(m, TileServer.allowed(m, "null"));                  // sandboxed page / file://
            assertFalse(m, TileServer.allowed(m, "https://evil.example"));  // a web page in the browser
            assertFalse(m, TileServer.allowed(m, "http://localhost:8080"));
            assertFalse(m, TileServer.allowed(m, "http://localhost.evil.example"));
        }
    }

    @Test
    public void fetchUrlsMustBeHttpOrHttps() {
        assertTrue(TileServer.fetchUrlAllowed("http://192.168.1.81:8090/plates/state_zips/plates_NC.zip"));
        assertTrue(TileServer.fetchUrlAllowed("https://flytab-home.tail1234.ts.net/nasr/nasr.zip"));
        assertFalse(TileServer.fetchUrlAllowed("file:///sdcard/Documents/evil.zip"));
        assertFalse(TileServer.fetchUrlAllowed("jar:http://x/y.zip!/"));
        assertFalse(TileServer.fetchUrlAllowed("not a url"));
        assertFalse(TileServer.fetchUrlAllowed(null));
    }
}
